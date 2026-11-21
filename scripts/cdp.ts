// CDP helper for inspecting the live Steam client (M1, repair loop).
//
// Needs `<Steam>\.cef-enable-remote-debugging` and a Steam restart, which
// exposes the Chrome DevTools Protocol on localhost:8080.
//
//   bun scripts/cdp.ts targets
//   bun scripts/cdp.ts eval   [--target <title>] <expression | @file.js>
//   bun scripts/cdp.ts find   [--target <title>] [--context N] [--regex] [--max N] <anchor>
//
// --target matches a target title by substring (default "SharedJSContext").
// `eval` awaits promises and prints the JSON value.
// `find` lists every script loaded in the target and prints N characters
// (default 300) of source around each match of the anchor.
//
// Never evaluate anything that writes to Steam collections, Hidden or Private
// state. This script only reads unless the expression you pass writes.

export {};

const PORT = Number(process.env.CDP_PORT ?? 8080);

interface Target {
	id: string;
	title: string;
	type: string;
	url: string;
	webSocketDebuggerUrl?: string;
}

async function listTargets(): Promise<Target[]> {
	const res = await fetch(`http://127.0.0.1:${String(PORT)}/json`);
	if (!res.ok) throw new Error(`CDP /json returned ${String(res.status)}`);
	return (await res.json()) as Target[];
}

class Session {
	private nextId = 1;
	private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	private listeners: ((method: string, params: Record<string, unknown>) => void)[] = [];

	private constructor(private ws: WebSocket) {
		ws.onmessage = (ev) => {
			const msg = JSON.parse(String(ev.data)) as {
				id?: number;
				result?: unknown;
				error?: { message: string };
				method?: string;
				params?: Record<string, unknown>;
			};
			if (msg.id !== undefined) {
				const p = this.pending.get(msg.id);
				if (!p) return;
				this.pending.delete(msg.id);
				if (msg.error) p.reject(new Error(msg.error.message));
				else p.resolve(msg.result);
			} else if (msg.method) {
				for (const l of this.listeners) l(msg.method, msg.params ?? {});
			}
		};
	}

	static open(url: string): Promise<Session> {
		return new Promise((resolve, reject) => {
			const ws = new WebSocket(url);
			ws.onopen = () => {
				resolve(new Session(ws));
			};
			ws.onerror = () => {
				reject(new Error(`could not open ${url}`));
			};
		});
	}

	send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
		const id = this.nextId++;
		this.ws.send(JSON.stringify({ id, method, params }));
		return new Promise((resolve, reject) => this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject }));
	}

	on(l: (method: string, params: Record<string, unknown>) => void) {
		this.listeners.push(l);
	}

	close() {
		this.ws.close();
	}
}

function parseArgs(argv: string[]) {
	const opts = { target: 'SharedJSContext', context: 300, regex: false, max: 20 };
	const rest: string[] = [];
	const args = [...argv];
	for (let a = args.shift(); a !== undefined; a = args.shift()) {
		if (a === '--target') opts.target = args.shift() ?? opts.target;
		else if (a === '--context') opts.context = Number(args.shift());
		else if (a === '--max') opts.max = Number(args.shift());
		else if (a === '--regex') opts.regex = true;
		else rest.push(a);
	}
	return { opts, rest };
}

async function connect(title: string): Promise<Session> {
	const targets = await listTargets();
	const t = targets.find((x) => x.title === title) ?? targets.find((x) => x.title.includes(title));
	if (!t?.webSocketDebuggerUrl) {
		throw new Error(`no target matching "${title}". Titles: ${targets.map((x) => x.title).join(' | ')}`);
	}
	return Session.open(t.webSocketDebuggerUrl);
}

async function cmdEval(title: string, exprArg: string) {
	const expression = exprArg.startsWith('@') ? await Bun.file(exprArg.slice(1)).text() : exprArg;
	const s = await connect(title);
	try {
		const r = await s.send<{ result: { value?: unknown; description?: string }; exceptionDetails?: unknown }>(
			'Runtime.evaluate',
			{ expression, awaitPromise: true, returnByValue: true, allowUnsafeEvalBlockedByCSP: true },
		);
		if (r.exceptionDetails) {
			console.error(JSON.stringify(r.exceptionDetails, null, 2));
			process.exitCode = 1;
		} else {
			const v = r.result.value;
			console.log(v === undefined ? r.result.description : typeof v === 'string' ? v : JSON.stringify(v, null, 2));
		}
	} finally {
		s.close();
	}
}

async function cmdFind(title: string, anchor: string, context: number, useRegex: boolean, max: number) {
	const s = await connect(title);
	const scripts: { id: string; url: string }[] = [];
	s.on((method, params) => {
		if (method === 'Debugger.scriptParsed') scripts.push({ id: String(params.scriptId), url: String(params.url) });
	});
	try {
		await s.send('Debugger.enable');
		// scriptParsed events for already loaded scripts arrive right after enable.
		await new Promise((r) => setTimeout(r, 1500));
		const re = useRegex ? new RegExp(anchor, 'g') : null;
		let hits = 0;
		for (const sc of scripts) {
			if (!sc.url) continue;
			const { scriptSource: src } = await s.send<{ scriptSource: string }>('Debugger.getScriptSource', { scriptId: sc.id });
			const positions: number[] = [];
			if (re) {
				re.lastIndex = 0;
				for (let m = re.exec(src); m; m = re.exec(src)) {
					positions.push(m.index);
					if (m[0].length === 0) re.lastIndex++;
				}
			} else {
				for (let i = src.indexOf(anchor); i !== -1; i = src.indexOf(anchor, i + 1)) positions.push(i);
			}
			if (positions.length === 0) continue;
			console.log(`\n=== ${sc.url}  (${String(positions.length)} match${positions.length === 1 ? '' : 'es'}, ${String(src.length)} chars)`);
			for (const pos of positions.slice(0, max)) {
				console.log(`--- @${String(pos)}`);
				console.log(src.slice(Math.max(0, pos - context), pos + context));
			}
			hits += positions.length;
		}
		console.log(`\n${String(hits)} match(es) in ${String(scripts.length)} scripts`);
		await s.send('Debugger.disable');
	} finally {
		s.close();
	}
}

const [cmd, ...argv] = process.argv.slice(2);
const { opts, rest } = parseArgs(argv);
if (cmd === 'targets') {
	for (const t of await listTargets()) console.log(`${t.type.padEnd(8)} ${t.title}  ${t.url}`);
} else if (cmd === 'eval' && rest[0]) {
	await cmdEval(opts.target, rest[0]);
} else if (cmd === 'find' && rest[0]) {
	await cmdFind(opts.target, rest[0], opts.context, opts.regex, opts.max);
} else {
	console.error('usage: bun scripts/cdp.ts targets | eval [--target t] <expr|@file> | find [--target t] [--context N] [--regex] [--max N] <anchor>');
	process.exitCode = 2;
}
