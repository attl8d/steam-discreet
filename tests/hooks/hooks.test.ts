/**
 * Contract for every hook in backend/hook_definitions.lua, run against its
 * fixtures in tests/hooks/fixtures/<hook id>/. See tests/hooks/README.md.
 */
import { describe, expect, test } from 'bun:test';
import { loadHookDump, checkPatterns, pluginName, readFixture, readManifest, runCase, unrelatedFixtures, parseError } from './lib/harness';
import { applyPatch } from './lib/millennium';

const dump = loadHookDump();

test('the definitions file loads with no rejected hooks', () => {
	expect(dump.error).toBeUndefined();
	expect(dump.rejected).toEqual([]);
	expect(dump.hooks.length).toBeGreaterThan(0);
});

for (const hook of dump.hooks) {
	describe(`hook ${hook.id}`, () => {
		const manifest = readManifest(hook.id);

		test('patterns stay inside the Rust/JavaScript portable subset', () => {
			expect(checkPatterns(hook)).toEqual([]);
		});

		test('has fixtures, with at least one attached and one absent case', () => {
			expect(manifest).not.toBeNull();
			const kinds = new Set(manifest?.cases.map((c) => c.expect));
			expect(kinds.has('attached')).toBe(true);
			expect(kinds.has('absent')).toBe(true);
		});
		if (manifest === null) return;

		for (const c of manifest.cases) {
			test(`${c.fixture}: ${c.expect}`, () => {
				const content = readFixture(hook.id, c.fixture);
				expect(runCase(dump, hook, content, manifest.filename, c.expect, c.transformMatches).problems).toEqual([]);
			});
		}

		for (const c of manifest.cases.filter((x) => x.expect === 'attached')) {
			test(`${c.fixture} doubled: an ambiguous anchor is reported and patched at most once`, () => {
				const content = readFixture(hook.id, c.fixture);
				const doubled = `${content}\n${content}`;
				const report = runCase(dump, hook, doubled, manifest.filename, 'attached', c.transformMatches);
				expect(report.findCount).toBeGreaterThan(1);
				expect(report.problems.some((p) => p.includes('ambiguous'))).toBe(true);
				// Millennium patches only the first match: the second copy is untouched
				// and the result still parses.
				expect(report.output.endsWith(`\n${content}`)).toBe(true);
				expect(parseError(report.output)).toBeNull();
			});
		}

		for (const u of unrelatedFixtures()) {
			test(`unrelated ${u.name} is left unchanged`, () => {
				expect(runCase(dump, hook, u.content, manifest.filename, 'absent').problems).toEqual([]);
			});
		}

		test('a file the pattern does not select is never touched', () => {
			const attached = manifest.cases.find((c) => c.expect === 'attached');
			if (attached === undefined) return;
			const content = readFixture(hook.id, attached.fixture);
			const result = applyPatch(hook, pluginName(), content, 'unrelated-file.css');
			expect(result.fileMatched).toBe(false);
			expect(result.output).toBe(content);
		});
	});
}
