import { describe, expect, test } from 'bun:test';
import { type AccountId, parseAccountId } from '../../frontend/domain/accountId';
import type { ReactiveSignal } from '../../frontend/integrations/steam/reactiveSignal';
import {
	type Clock,
	type LibraryPort,
	LibraryService,
	VISIBILITY_HOOK_ID,
} from '../../frontend/services/library';
import { TagStorage, type TagStorageRpc } from '../../frontend/services/tagStorage';

const ACCOUNT = parseAccountId('76561198000000001') as AccountId;

/** Minimal in-memory backend with the reply shape of backend/tagstore/rpc.lua. */
class Backend implements TagStorageRpc {
	readonly tags = new Set<number>();
	readonly calls: string[] = [];
	failWrites = false;
	/** Number of upcoming open calls that throw (a transient RPC failure). */
	failOpens = 0;
	state = 'ok';
	private reply(name: string, change: () => void): Promise<unknown> {
		this.calls.push(name);
		const base = () => ({
			state: this.state,
			writable: this.state === 'ok',
			ids: [...this.tags].sort((a, b) => a - b).join(','),
		});
		if (this.failWrites && name !== 'open') {
			return Promise.resolve({ ok: false, error: 'write_failed', message: 'disk full', ...base() });
		}
		change();
		return Promise.resolve({ ok: true, ...base() });
	}
	open(account: string) {
		if (this.failOpens > 0) {
			this.failOpens -= 1;
			this.calls.push('open-failed');
			return Promise.reject(new Error('backend not ready'));
		}
		return this.reply('open', () => {
			this.calls.push(`account:${account}`);
		});
	}
	add(_: string, ids: string) {
		return this.reply(`add:${ids}`, () => {
			for (const x of ids.split(',')) this.tags.add(Number(x));
		});
	}
	remove(_: string, ids: string) {
		return this.reply(`remove:${ids}`, () => {
			for (const x of ids.split(',')) this.tags.delete(Number(x));
		});
	}
	clear() {
		return this.reply('clear', () => {
			this.tags.clear();
		});
	}
	exportText() {
		return this.reply('export', () => undefined);
	}
	importText() {
		return this.reply('import', () => undefined);
	}
}

class FakeClock implements Clock {
	t = 0;
	fn: (() => void) | null = null;
	now() {
		return this.t;
	}
	setInterval(fn: () => void) {
		this.fn = fn;
		return 1;
	}
	clearInterval() {
		this.fn = null;
	}
	advance(ms: number) {
		this.t += ms;
		this.fn?.();
	}
}

class FakePort implements LibraryPort {
	account: AccountId | null = ACCOUNT;
	seen = new Set<string>();
	events: string[] = [];
	signalAvailable = true;
	reads = 0;
	currentAccount() {
		return this.account;
	}
	createSignal(): ReactiveSignal | null {
		if (!this.signalAvailable) return null;
		return {
			read: () => {
				this.reads += 1;
			},
			bump: () => {
				this.events.push('bump');
			},
		};
	}
	clearCounts() {
		this.events.push('clearCounts');
		return 3;
	}
	seenHooks() {
		return this.seen;
	}
	manifest: unknown = JSON.stringify({
		version: 1,
		expected: [{ id: VISIBILITY_HOOK_ID, description: 'd', runs: 'startup', file: 'f', find: 'x' }],
		rejected: {},
	});
	hookManifest(): Promise<unknown> {
		return Promise.resolve(this.manifest);
	}
}

const flush = () => new Promise((r) => setTimeout(r, 0));

async function setup(initialTags: number[] = []) {
	const backend = new Backend();
	for (const t of initialTags) backend.tags.add(t);
	const port = new FakePort();
	const clock = new FakeClock();
	const lib = new LibraryService(new TagStorage(backend), port, clock, { pollMs: 1000, graceMs: 10_000 });
	lib.start();
	await flush();
	return { backend, port, clock, lib };
}

describe('hiding', () => {
	test('a tagged game is hidden while the toggle is off, shown while on', async () => {
		const { lib } = await setup([570]);
		expect(lib.getState().ready).toBe(true);
		expect(lib.shouldHide(570)).toBe(true);
		expect(lib.shouldHide(730)).toBe(false);
		lib.setRevealed(true);
		expect(lib.shouldHide(570)).toBe(false);
		lib.setRevealed(false);
		expect(lib.shouldHide(570)).toBe(true);
	});

	test('the toggle starts off', async () => {
		const { lib } = await setup([570]);
		expect(lib.isRevealed()).toBe(false);
		expect(lib.getState().revealed).toBe(false);
	});

	test('fails open: nothing is hidden before the tags load', () => {
		const backend = new Backend();
		backend.tags.add(570);
		const port = new FakePort();
		port.account = null;
		const lib = new LibraryService(new TagStorage(backend), port, new FakeClock());
		lib.start();
		expect(lib.shouldHide(570)).toBe(false);
		expect(lib.getState().ready).toBe(false);
	});

	test('fails open on bad input and on a throwing signal', async () => {
		const { lib, port } = await setup([570]);
		for (const bad of [null, undefined, {}, -1, 1.5, Number.NaN]) {
			expect(lib.shouldHide(bad)).toBe(false);
		}
		void port;
		const broken = new LibraryService(new TagStorage(new Backend()), {
			currentAccount: () => ACCOUNT,
			seenHooks: () => new Set(),
			clearCounts: () => 0,
			hookManifest: () => Promise.resolve(null),
			createSignal: () => ({
				read: () => {
					throw new Error('boom');
				},
				bump: () => undefined,
			}),
		});
		broken.start();
		expect(broken.shouldHide(570)).toBe(false);
		broken.stop();
	});

	test('the hide check reads the signal on every call, even when revealed', async () => {
		const { lib, port } = await setup([570]);
		const before = port.reads;
		lib.shouldHide(730);
		lib.setRevealed(true);
		lib.shouldHide(570);
		expect(port.reads).toBe(before + 2);
	});
});

describe('refreshing Steam', () => {
	test('a toggle change clears counts, then bumps the signal', async () => {
		const { lib, port } = await setup([570]);
		port.events.length = 0;
		lib.setRevealed(true);
		expect(port.events).toEqual(['clearCounts', 'bump']);
		lib.setRevealed(true);
		expect(port.events).toEqual(['clearCounts', 'bump']);
	});

	test('a tag change refreshes after the save is confirmed', async () => {
		const { lib, port } = await setup();
		port.events.length = 0;
		await lib.tagGames([570]);
		expect(port.events).toEqual(['clearCounts', 'bump']);
		expect(lib.shouldHide(570)).toBe(true);
		await lib.untagGames([570]);
		expect(lib.shouldHide(570)).toBe(false);
		expect(port.events).toEqual(['clearCounts', 'bump', 'clearCounts', 'bump']);
	});

	test('listeners hear toggle and tag changes', async () => {
		const { lib } = await setup();
		let n = 0;
		const off = lib.subscribe(() => (n += 1));
		lib.setRevealed(true);
		await lib.tagGames([10]);
		expect(n).toBe(2);
		off();
		lib.setRevealed(false);
		expect(n).toBe(2);
	});
});

describe('tagging', () => {
	test('tagGames rejects when the save fails, and nothing is shown as tagged', async () => {
		const { lib, backend } = await setup();
		backend.failWrites = true;
		let error: unknown;
		await lib.tagGames([570]).catch((e: unknown) => (error = e));
		expect((error as Error).message).toBe('disk full');
		expect(lib.isTagged(570)).toBe(false);
		expect(lib.shouldHide(570)).toBe(false);
	});

	test('tagGames rejects before the tags are loaded', async () => {
		const port = new FakePort();
		port.account = null;
		const lib = new LibraryService(new TagStorage(new Backend()), port, new FakeClock());
		lib.start();
		let error: unknown;
		await lib.tagGames([570]).catch((e: unknown) => (error = e));
		expect((error as { code: string }).code).toBe('not_ready');
	});

	test('tagGames rejects invalid App IDs without saving anything', async () => {
		const { lib, backend } = await setup();
		const before = backend.calls.length;
		let error: unknown;
		await lib.tagGames([570, 0]).catch((e: unknown) => (error = e));
		expect((error as { code: string }).code).toBe('bad_request');
		expect(backend.calls.length).toBe(before);
	});

	test('a read-only store refuses edits with its reason', async () => {
		const backend = new Backend();
		backend.state = 'newer';
		const lib = new LibraryService(new TagStorage(backend), new FakePort(), new FakeClock());
		lib.start();
		await flush();
		let error: unknown;
		await lib.untagGames([570]).catch((e: unknown) => (error = e));
		expect((error as { code: string }).code).toBe('read_only');
	});

	test('the reveal toggle never reaches the backend', async () => {
		const { lib, backend } = await setup([570]);
		lib.setRevealed(true);
		lib.setRevealed(false);
		await lib.tagGames([730]);
		expect(backend.calls.every((c) => c === 'open' || c.startsWith('account:') || /^add:[0-9,]+$/.test(c))).toBe(true);
	});
});

describe('account', () => {
	test('tags load once Steam reports the signed-in account', async () => {
		const backend = new Backend();
		backend.tags.add(570);
		const port = new FakePort();
		port.account = null;
		const clock = new FakeClock();
		const lib = new LibraryService(new TagStorage(backend), port, clock);
		lib.start();
		clock.advance(1000);
		expect(backend.calls).toEqual([]);
		port.account = ACCOUNT;
		clock.advance(1000);
		await flush();
		expect(backend.calls).toContain(`account:${ACCOUNT}`);
		expect(lib.shouldHide(570)).toBe(true);
		clock.advance(1000);
		expect(backend.calls.filter((c) => c === 'open').length).toBe(1);
	});
});

describe('seam status', () => {
	test('checking until the hook is seen, then ok', async () => {
		const { lib, port, clock } = await setup();
		expect(lib.getState().seamStatus).toBe('checking');
		port.seen.add(VISIBILITY_HOOK_ID);
		clock.advance(1000);
		expect(lib.getState().seamStatus).toBe('ok');
		clock.advance(60_000);
		expect(lib.getState().seamStatus).toBe('ok');
	});

	test('warning when the hook stays unseen after the grace period', async () => {
		const { lib, clock } = await setup();
		clock.advance(11_000);
		expect(lib.getState().seamStatus).toBe('warning');
		expect(lib.getState().warning).toContain('did not attach');
	});

	test('warning when lists cannot refresh live', () => {
		const backend = new Backend();
		const port = new FakePort();
		port.signalAvailable = false;
		port.seen.add(VISIBILITY_HOOK_ID);
		const lib = new LibraryService(new TagStorage(backend), port, new FakeClock());
		lib.start();
		expect(lib.getState().seamStatus).toBe('warning');
	});
});

describe('loading tags', () => {
	test('a failed first open is retried with backoff, and warns until it loads', async () => {
		const backend = new Backend();
		backend.tags.add(570);
		backend.failOpens = 2;
		const clock = new FakeClock();
		const lib = new LibraryService(new TagStorage(backend), new FakePort(), clock, { retryMs: 1000, maxRetryMs: 4000 });
		lib.start();
		await flush();
		expect(backend.calls).toEqual(['open-failed']);
		expect(lib.getState().ready).toBe(false);
		expect(lib.getState().warning).toContain('could not be loaded');
		expect(lib.shouldHide(570)).toBe(false);

		clock.advance(500); // before the first retry is due
		await flush();
		expect(backend.calls).toEqual(['open-failed']);
		clock.advance(500); // 1 s: retry, fails again; next in 2 s
		await flush();
		expect(backend.calls).toEqual(['open-failed', 'open-failed']);
		clock.advance(1000);
		await flush();
		expect(backend.calls.filter((c) => c.startsWith('open')).length).toBe(2);
		clock.advance(1000); // 2 s after the second failure
		await flush();
		expect(lib.getState().ready).toBe(true);
		expect(lib.getState().warning).toBeNull();
		expect(lib.shouldHide(570)).toBe(true);
		clock.advance(10_000);
		await flush();
		expect(backend.calls.filter((c) => c === 'open').length).toBe(1);
	});

	test('an unusable reply also counts as a failure', async () => {
		const backend = new Backend();
		const original = backend.open.bind(backend);
		let first = true;
		backend.open = (account: string) => {
			if (first) {
				first = false;
				return Promise.resolve({ nonsense: true });
			}
			return original(account);
		};
		const clock = new FakeClock();
		const lib = new LibraryService(new TagStorage(backend), new FakePort(), clock, { retryMs: 1000 });
		lib.start();
		await flush();
		expect(lib.getState().warning).toContain('could not be loaded');
		clock.advance(1000);
		await flush();
		expect(lib.getState().ready).toBe(true);
	});
});

describe('hook status from the backend manifest', () => {
	test('a rejected library hook warns at once, with the reason', async () => {
		const { lib, port } = await setup();
		port.manifest = { version: 1, expected: [], rejected: [{ id: VISIBILITY_HOOK_ID, reason: 'bad regex' }] };
		const lib2 = new LibraryService(new TagStorage(new Backend()), port, new FakeClock());
		lib2.start();
		await flush();
		expect(lib2.getState().seamStatus).toBe('warning');
		expect(lib2.getState().warning).toContain('rejected (bad regex)');
		lib.stop();
	});

	test('hooks disabled by a broken definitions file warn with the load error', async () => {
		const port = new FakePort();
		port.manifest = JSON.stringify({ version: 1, expected: {}, rejected: {}, error: 'syntax error' });
		const lib = new LibraryService(new TagStorage(new Backend()), port, new FakeClock());
		lib.start();
		await flush();
		expect(lib.getState().seamStatus).toBe('warning');
		expect(lib.getState().warning).toContain('syntax error');
	});

	test('an unreadable manifest falls back to the declared hook', async () => {
		const port = new FakePort();
		port.manifest = 'not json';
		const clock = new FakeClock();
		const lib = new LibraryService(new TagStorage(new Backend()), port, clock, { graceMs: 1000 });
		lib.start();
		await flush();
		expect(lib.getState().seamStatus).toBe('checking');
		port.seen.add(VISIBILITY_HOOK_ID);
		clock.advance(1000);
		expect(lib.getState().seamStatus).toBe('ok');
	});
});
