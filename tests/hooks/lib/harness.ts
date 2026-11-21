/**
 * Fixture harness for backend/hook_definitions.lua. See tests/hooks/README.md.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { applyPatch, countMatches } from './millennium';
import { translateRustRegex } from './rustRegex';

export const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
export const FIXTURES_DIR = join(REPO_ROOT, 'tests', 'hooks', 'fixtures');
export const UNRELATED_DIR = join(FIXTURES_DIR, '_unrelated');

export interface HookDefinition {
	readonly id: string;
	readonly description: string;
	readonly placeholder: boolean;
	readonly runs: 'startup' | 'on_demand';
	readonly file: string;
	readonly find: string;
	readonly transforms: readonly { readonly match: string; readonly replace: string }[];
}

export interface HookDump {
	readonly hooks: readonly HookDefinition[];
	readonly rejected: readonly { readonly id: string; readonly reason: string }[];
	readonly error?: string;
	readonly marker_global: string;
}

/** The plugin id Millennium puts into #{{self}}. */
export function pluginName(): string {
	const toml = readFileSync(join(REPO_ROOT, 'millennium.toml'), 'utf8');
	const m = /^id\s*=\s*"([^"]+)"/m.exec(toml);
	if (m?.[1] === undefined) throw new Error('millennium.toml has no [plugin] id');
	return m[1];
}

/** Runs the real Lua loader, so the harness sees exactly what Millennium gets. */
export function loadHookDump(): HookDump {
	const proc = Bun.spawnSync(['luajit', 'scripts/dump-hooks.lua'], { cwd: REPO_ROOT });
	if (proc.exitCode !== 0) {
		throw new Error(`luajit scripts/dump-hooks.lua failed: ${proc.stderr.toString()}`);
	}
	return JSON.parse(proc.stdout.toString()) as HookDump;
}

export function markerFor(dump: HookDump, id: string): string {
	return `((window.${dump.marker_global}||={})["${id}"]=1)`;
}

export type CaseExpectation = 'attached' | 'absent';

export interface FixtureCase {
	readonly fixture: string;
	readonly expect: CaseExpectation;
	/** How many times each transform must match inside the `find` match. */
	readonly transformMatches?: readonly number[];
}

export interface FixtureManifest {
	readonly filename: string;
	readonly cases: readonly FixtureCase[];
}

export function readManifest(id: string): FixtureManifest | null {
	const path = join(FIXTURES_DIR, id, 'fixtures.json');
	if (!existsSync(path)) return null;
	return JSON.parse(readFileSync(path, 'utf8')) as FixtureManifest;
}

export function readFixture(id: string, name: string): string {
	return readFileSync(join(FIXTURES_DIR, id, name), 'utf8');
}

export function unrelatedFixtures(): { name: string; content: string }[] {
	return readdirSync(UNRELATED_DIR)
		.filter((n) => n.endsWith('.js'))
		.map((name) => ({ name, content: readFileSync(join(UNRELATED_DIR, name), 'utf8') }));
}

const transpiler = new Bun.Transpiler({ loader: 'js' });

/** Null when the code parses as JavaScript, otherwise the parser's message. */
export function parseError(code: string): string | null {
	try {
		transpiler.transformSync(code);
		return null;
	} catch (e) {
		return String(e);
	}
}

/** Problems in the patterns themselves, independent of any fixture. */
export function checkPatterns(hook: HookDefinition): string[] {
	const problems: string[] = [];
	const check = (label: string, pattern: string): number => {
		const t = translateRustRegex(pattern);
		if (!t.ok) {
			problems.push(`${label}: ${t.error}`);
			return -1;
		}
		return t.groups;
	};
	check('file', hook.file);
	check('find', hook.find);
	hook.transforms.forEach((t, i) => {
		const groups = check(`transform ${String(i + 1)} match`, t.match);
		if (groups < 0) return;
		for (const ref of t.replace.matchAll(/\\([0-9])/g)) {
			if (Number(ref[1]) > groups) {
				problems.push(`transform ${String(i + 1)} replace: \\${String(ref[1])} but the match has ${String(groups)} group(s)`);
			}
		}
	});
	return problems;
}

export interface CaseReport {
	readonly problems: string[];
	readonly findCount: number;
	readonly output: string;
}

/** Runs one fixture through the Millennium copy and checks the hook's contract. */
export function runCase(
	dump: HookDump,
	hook: HookDefinition,
	content: string,
	filename: string,
	expectation: CaseExpectation,
	transformMatches: readonly number[] = [],
): CaseReport {
	const problems: string[] = [];
	const plugin = pluginName();
	const inputError = parseError(content);
	if (inputError !== null) problems.push(`fixture itself does not parse: ${inputError}`);

	const findCount = countMatches(hook.find, content);
	const result = applyPatch(hook, plugin, content, filename);
	if (!result.fileMatched) problems.push(`file pattern /${hook.file}/ does not match "${filename}"`);

	if (expectation === 'absent') {
		if (findCount !== 0) problems.push(`find matched ${String(findCount)} time(s); expected the anchor to be absent`);
		if (result.output !== content) problems.push('input changed although the anchor is absent');
		return { problems, findCount, output: result.output };
	}

	if (findCount === 0) problems.push('find did not match: the anchor is missing');
	if (findCount > 1) {
		problems.push(`find matched ${String(findCount)} times: the anchor is ambiguous and Millennium would patch only the first`);
	}
	if (!result.applied || result.scope === null || result.scopeBefore === null) {
		return { problems, findCount, output: result.output };
	}

	if (transformMatches.length !== hook.transforms.length) {
		problems.push(`fixtures.json lists ${String(transformMatches.length)} transform count(s) for ${String(hook.transforms.length)} transform(s)`);
	}
	result.transformCounts.forEach((n, i) => {
		const want = transformMatches[i];
		if (n !== want) problems.push(`transform ${String(i + 1)} matched ${String(n)} time(s) in the find match, expected ${String(want)}`);
	});

	const { from, to } = result.scope;
	const before = content.slice(0, result.scopeBefore.from);
	const after = content.slice(result.scopeBefore.to);
	if (!result.output.startsWith(before) || !result.output.endsWith(after) || result.output.length !== before.length + (to - from) + after.length) {
		problems.push('code outside the find match changed');
	}
	if (result.output === content) problems.push('transforms changed nothing');

	const scope = result.output.slice(from, to);
	if (!scope.includes(markerFor(dump, hook.id))) problems.push('the self-check marker is not in the patched code');
	const self = `window.PLUGIN_LIST['${plugin}']`;
	if (scope.split(self).length !== scope.split(`${self}?.`).length) {
		problems.push(`${self} is used without ?. in the patched code`);
	}

	const outputError = parseError(result.output);
	if (outputError !== null) problems.push(`patched code does not parse: ${outputError}`);

	return { problems, findCount, output: result.output };
}
