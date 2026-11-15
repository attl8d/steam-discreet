import { describe, expect, test } from 'bun:test';
import { translateRustRegex } from './lib/rustRegex';
import { applyPatch, expandRustReplacement, expandSelf, re2ToRustRep } from './lib/millennium';

describe('translateRustRegex', () => {
	const accepted: [string, string, number][] = [
		['abc', 'abc', 0],
		['a.b', 'a[^\\n]b', 0],
		['[A-Za-z_$][A-Za-z0-9_$.]*', '[A-Za-z_$][A-Za-z0-9_$.]*', 0],
		['\\{\\}\\[\\]', '\\{\\}\\[\\]', 0],
		['a{2,3}?b+?c*', 'a{2,3}?b+?c*', 0],
		['(?:x|y)+(z)', '(?:x|y)+(z)', 1],
		['\\#\\&\\~\\-', '#&~-', 0],
		['[\\-\\]a]', '[\\-\\]a]', 0],
		['\\x41\\n', '\\x41\\n', 0],
		['chunk~[0-9a-f]+\\.js', 'chunk~[0-9a-f]+\\.js', 0],
	];
	test.each(accepted)('accepts /%s/', (pattern, js, groups) => {
		expect(translateRustRegex(pattern)).toEqual({ ok: true, js, groups });
	});

	const rejected: [string, string][] = [
		['\\w+', 'not portable'],
		['\\d', 'not portable'],
		['\\s', 'not portable'],
		['\\bx', 'not portable'],
		['a(?=b)', 'only (?: )'],
		['a(?<!b)', 'only (?: )'],
		['(?i)a', 'only (?: )'],
		['(?P<n>a)', 'only (?: )'],
		['(a)\\1', 'backreferences'],
		['a*+', 'possessive'],
		['a**', 'cannot follow'],
		['{', 'literal {'],
		['a{', 'literal {'],
		['a}', 'literal }'],
		['a]', 'literal ]'],
		['[]a]', 'cannot start with ]'],
		['[a[b]', 'nested class'],
		['[a&&b]', 'set operation'],
		['[a--b]', 'set operation'],
		['[ab', 'unclosed character class'],
		['(a', 'unclosed ('],
		['a)', 'unbalanced )'],
		['*a', 'nothing to repeat'],
		['\\x{41}', 'two hex digits'],
		['\\pL', 'not portable'],
		['', 'empty pattern'],
	];
	test.each(rejected)('rejects /%s/', (pattern, message) => {
		const t = translateRustRegex(pattern);
		expect(t.ok).toBe(false);
		if (!t.ok) expect(t.error).toContain(message);
	});
});

// Mirrors the tests in Millennium's engine.rs.
describe('re2ToRustRep', () => {
	test('passes through plain text', () => {
		expect(re2ToRustRep('hello world')).toBe('hello world');
	});
	test('converts backreferences', () => {
		expect(re2ToRustRep('wrap(\\1, \\2)')).toBe('wrap($1, $2)');
		expect(re2ToRustRep('wrap(\\0)')).toBe('wrap($0)');
	});
	test('escapes literal dollar signs', () => {
		expect(re2ToRustRep('price: $5 total')).toBe('price: $$5 total');
		expect(re2ToRustRep('template ${foo}bar')).toBe('template $${foo}bar');
		expect(re2ToRustRep('$5 -> \\1')).toBe('$$5 -> $1');
	});
});

describe('expandRustReplacement', () => {
	const groups = ['whole', 'one', 'two'];
	test('numbered groups, literal dollars and missing groups', () => {
		expect(expandRustReplacement('[$1|$2|$0]', groups)).toBe('[one|two|whole]');
		expect(expandRustReplacement('$$1', groups)).toBe('$1');
		expect(expandRustReplacement('${1}x', groups)).toBe('onex');
		expect(expandRustReplacement('$9', groups)).toBe('');
		expect(expandRustReplacement('a$', groups)).toBe('a$');
	});
	test('a word character after $N changes the group name, which is why the loader rejects \\1a', () => {
		expect(expandRustReplacement('$1a', groups)).toBe('');
		expect(expandRustReplacement('$12', groups)).toBe('');
		expect(expandRustReplacement('$1.a', groups)).toBe('one.a');
	});
});

describe('applyPatch', () => {
	const patch = {
		file: 'chunk~[0-9]+\\.js',
		find: 'f\\(([a-z])\\)\\{[^}]*\\}',
		transforms: [
			{ match: 'x', replace: 'y' },
			{ match: 'return ([a-z])', replace: 'return #{{self}}?.w?.(\\1)??\\1' },
		],
	};
	const code = 'function f(a){x;x;return a}function g(b){x;return b}';

	test('patches only inside the first find match, transforms in order', () => {
		const r = applyPatch(patch, 'demo', code, 'chunk~12.js');
		expect(r.applied).toBe(true);
		expect(r.transformCounts).toEqual([2, 1]);
		expect(r.output).toBe("function f(a){y;y;return window.PLUGIN_LIST['demo']?.w?.(a)??a}function g(b){x;return b}");
	});

	test('leaves the file alone when find or file does not match', () => {
		expect(applyPatch(patch, 'demo', 'nothing here', 'chunk~12.js').output).toBe('nothing here');
		expect(applyPatch(patch, 'demo', code, 'other.js').fileMatched).toBe(false);
	});

	test('expandSelf names the plugin', () => {
		expect(expandSelf('#{{self}}?.a', 'p')).toBe("window.PLUGIN_LIST['p']?.a");
	});
});
