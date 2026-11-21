/**
 * Writes every fixture case, with the bun harness's output, to a JSON file
 * for tools/patch-crosscheck, which repeats them with the real Rust regex
 * crate. Run with `bun run test:hooks:rust`.
 *
 * Usage: bun tests/hooks/crosscheck.ts <out.json>
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadHookDump, pluginName, readFixture, readManifest, unrelatedFixtures } from './lib/harness';
import type { PatchDef } from './lib/millennium';
import { applyPatch } from './lib/millennium';
import { compileRustRegex } from './lib/rustRegex';

const out = process.argv[2];
if (out === undefined) throw new Error('usage: bun tests/hooks/crosscheck.ts <out.json>');

const plugin = pluginName();
const dump = loadHookDump();
const patches: PatchDef[] = dump.hooks.map((h) => ({ file: h.file, find: h.find, transforms: h.transforms }));
const cases: { label: string; patch: number; filename: string; input: string; expected: string }[] = [];

function addCase(label: string, patch: number, filename: string, input: string): void {
	const p = patches[patch];
	if (p === undefined) throw new Error(`no patch ${String(patch)}`);
	cases.push({ label, patch, filename, input, expected: applyPatch(p, plugin, input, filename).output });
}

dump.hooks.forEach((hook, i) => {
	const manifest = readManifest(hook.id);
	if (manifest === null) return;
	for (const c of manifest.cases) {
		const content = readFixture(hook.id, c.fixture);
		addCase(`${hook.id}/${c.fixture}`, i, manifest.filename, content);
		addCase(`${hook.id}/${c.fixture} doubled`, i, manifest.filename, `${content}\n${content}`);
		addCase(`${hook.id}/${c.fixture} other file`, i, 'unrelated-file.css', content);
	}
	for (const u of unrelatedFixtures()) addCase(`${hook.id}/_unrelated/${u.name}`, i, manifest.filename, u.content);
});

// Replacement edge cases that the loader or harness rely on.
const demo = patches.length;
patches.push({
	file: 'demo\\.js',
	find: 'f\\(([a-z])\\)\\{[^}]*\\}',
	transforms: [
		{ match: 'x', replace: 'y$1' },
		{ match: 'return ([a-z])', replace: 'return #{{self}}?.w?.(\\1)??\\1.v' },
		{ match: '(y)', replace: '\\1\\1a' },
	],
});
addCase('replacement edge cases', demo, 'demo.js', 'function f(a){x;x;return a}function g(b){x;return b}');

// Places where JavaScript and Rust regexes could disagree.
const patterns = [
	'a.b',
	'[^a]+',
	'[A-Za-z_$][A-Za-z0-9_$.]*',
	'\\{[^}]*\\}',
	'(?:x|xy)z?',
	'a{2,3}?',
	'\\#\\&\\~\\-',
	'[\\-\\]x]+',
	'\\x41',
	'a\\/b',
	'é+',
	'[^\\n]',
	'^ab|cd$',
];
const texts = ['a\rb a\nb a\u2028b aéb', 'xyz xz xyzz', 'aaaa', '{a}{b}}', '#&~- ]x-', 'Aé éé', 'ab cd', 'été', 'a/b'];
const matches = patterns.flatMap((pattern) =>
	texts.map((text) => ({ pattern, text, expected: Array.from(text.matchAll(compileRustRegex(pattern).re), (m) => m[0]) })),
);

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ plugin, patches, cases, matches }, null, '\t'));
console.log(`wrote ${String(cases.length)} patch case(s) and ${String(matches.length)} match case(s) to ${out}`);
