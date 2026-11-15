/**
 * The harness must catch the ways a hook goes wrong after a Steam update.
 * These hooks are deliberately broken and exist only in this file.
 */
import { describe, expect, test } from 'bun:test';
import { checkPatterns, loadHookDump, markerFor, runCase } from './lib/harness';
import type { HookDefinition } from './lib/harness';

const dump = loadHookDump();
const FILE = 'chunk~abc.js';
const CODE = 'var a=1;function f(t){return t.ok(t.id)}var b=2;';
const MARKER = markerFor(dump, 'broken');

function hook(overrides: Partial<HookDefinition>): HookDefinition {
	return {
		id: 'broken',
		description: 'test',
		placeholder: true,
		file: 'chunk~[a-z]+\\.js',
		find: 'return t\\.ok\\(t\\.id\\)',
		transforms: [{ match: 'return (t)', replace: `return ${MARKER},\\1` }],
		...overrides,
	};
}

function problems(h: HookDefinition, code = CODE, counts: number[] = [1]): string {
	return runCase(dump, h, code, FILE, 'attached', counts).problems.join('\n');
}

describe('fixture harness', () => {
	test('a correct hook passes', () => {
		expect(problems(hook({}))).toBe('');
	});

	test('a missing anchor is reported and the code is left unchanged', () => {
		const report = runCase(dump, hook({ find: 'return t\\.gone\\(' }), CODE, FILE, 'attached', [1]);
		expect(report.problems).toContain('find did not match: the anchor is missing');
		expect(report.output).toBe(CODE);
	});

	test('an ambiguous anchor is reported', () => {
		expect(problems(hook({ find: 'var [a-z]=', transforms: [{ match: 'var', replace: `${MARKER};var` }] }))).toContain('ambiguous');
	});

	test('a wrong transform count is reported', () => {
		expect(problems(hook({}), CODE, [2])).toContain('matched 1 time(s)');
	});

	test('output that no longer parses is reported', () => {
		expect(problems(hook({ transforms: [{ match: 'return (t)', replace: `return ${MARKER},(\\1` }] }))).toContain('does not parse');
	});

	test('a transform without the self-check marker is reported', () => {
		expect(problems(hook({ transforms: [{ match: 'return', replace: 'return  ' }] }))).toContain('marker');
	});

	test('#{{self}} without ?. is reported', () => {
		expect(problems(hook({ transforms: [{ match: 'return (t)', replace: `return ${MARKER},#{{self}}.x,\\1` }] }))).toContain('without ?.');
	});

	test('a file pattern that does not select the fixture is reported', () => {
		expect(problems(hook({ file: 'library\\.js' }))).toContain('does not match');
	});

	test('non-portable patterns and missing groups are reported', () => {
		expect(checkPatterns(hook({ find: '\\w+' })).join()).toContain('not portable');
		expect(checkPatterns(hook({ transforms: [{ match: 'return', replace: '\\1' }] })).join()).toContain('0 group(s)');
	});
});
