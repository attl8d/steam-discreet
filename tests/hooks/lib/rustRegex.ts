/**
 * Millennium runs hook patterns with the Rust `regex` crate. The fixture
 * harness runs them with JavaScript RegExp. This file accepts only the part of
 * Rust's syntax where both engines agree, and translates it to an equivalent
 * JavaScript pattern (compiled with the `u` flag, so both work on code points).
 *
 * Anything outside the subset is rejected with a message saying what to write
 * instead. tools/patch-crosscheck re-runs every fixture through the real Rust
 * crate in CI, so a gap in this list shows up there rather than in Steam.
 *
 * Allowed:
 *   literals; `.`; `^` `$`; `|`; groups `( )` and `(?: )`;
 *   `* + ? {n} {n,} {n,m}` with optional lazy `?`;
 *   classes `[...]` / `[^...]` with ranges;
 *   escapes \n \t \r \xHH and `\` before any of  . + * ? ( ) | [ ] { } ^ $ # & - ~ \ /
 * Rejected, and why:
 *   \d \w \s \b \B and friends   Unicode-aware in Rust, ASCII in JS. Write [0-9], [A-Za-z0-9_$].
 *   lookaround, backreferences   Not supported by Rust's regex crate.
 *   inline flags (?i) etc.       Not portable. Spell out both cases.
 *   named groups                 Millennium's `replace` only understands \0..\9.
 *   possessive `*+`              Not supported by Rust.
 *   unescaped { } ] outside a class, [ inside a class, && -- ~~ inside a class
 *                                Parsed differently (nested classes and set operations in Rust).
 */

export type TranslateResult =
	| { readonly ok: true; readonly js: string; readonly groups: number }
	| { readonly ok: false; readonly error: string };

const META_ESCAPES = new Set(['.', '+', '*', '?', '(', ')', '|', '[', ']', '{', '}', '^', '$', '#', '&', '-', '~', '\\', '/']);
// Characters that must stay escaped in a JavaScript `u` pattern.
const JS_SYNTAX = new Set(['^', '$', '\\', '.', '*', '+', '?', '(', ')', '[', ']', '{', '}', '|', '/']);
const ESCAPE_HINT: Readonly<Record<string, string>> = {
	d: 'write [0-9]',
	D: 'write [^0-9]',
	w: 'write [A-Za-z0-9_] (add $ for JavaScript identifiers)',
	W: 'write a negated class such as [^A-Za-z0-9_]',
	s: 'write the characters you mean, such as [ \\t\\n]',
	S: 'write a negated class such as [^ \\t\\n]',
	b: 'word boundaries differ between the engines; match the neighbouring character instead',
	B: 'word boundaries differ between the engines; match the neighbouring character instead',
	A: 'write ^',
	z: 'write $',
	p: 'Unicode classes differ between the engines; list the characters',
	P: 'Unicode classes differ between the engines; list the characters',
	k: 'backreferences are not supported by Rust regex',
};

function fail(pattern: string, at: number, message: string): TranslateResult {
	return { ok: false, error: `${message} (at offset ${String(at)} in /${pattern}/)` };
}

interface Escape {
	readonly js: string;
	readonly next: number;
}

// `i` points just past the backslash.
function readEscape(pattern: string, i: number, inClass: boolean): Escape | string {
	const c = pattern[i];
	if (c === undefined) return 'pattern ends with a lone backslash';
	if (c === 'n' || c === 't' || c === 'r') return { js: `\\${c}`, next: i + 1 };
	if (c === 'x') {
		const hex = pattern.slice(i + 1, i + 3);
		if (!/^[0-9A-Fa-f]{2}$/.test(hex)) return '\\x must be followed by exactly two hex digits (\\x{...} is not portable)';
		return { js: `\\x${hex}`, next: i + 3 };
	}
	if (META_ESCAPES.has(c)) {
		const needsEscape = JS_SYNTAX.has(c) || (inClass && c === '-');
		return { js: needsEscape ? `\\${c}` : c, next: i + 1 };
	}
	if (/[1-9]/.test(c)) return 'backreferences are not supported by Rust regex';
	const hint = ESCAPE_HINT[c];
	return hint === undefined ? `escape \\${c} is not in the portable subset` : `\\${c} is not portable: ${hint}`;
}

function readClass(pattern: string, start: number): Escape | string {
	// `start` points at '['.
	let i = start + 1;
	let js = '[';
	if (pattern[i] === '^') {
		js += '^';
		i++;
	}
	if (pattern[i] === ']') return 'a class cannot start with ]; write \\] (Rust and JavaScript read [] differently)';
	while (i < pattern.length) {
		const c = pattern.charAt(i);
		if (c === ']') return { js: `${js}]`, next: i + 1 };
		if (c === '[') return 'unescaped [ inside a class starts a nested class in Rust; write \\[';
		const pair = pattern.slice(i, i + 2);
		if (pair === '&&' || pair === '--' || pair === '~~') return `${pair} inside a class is a set operation in Rust; escape one of them`;
		if (c === '\\') {
			const esc = readEscape(pattern, i + 1, true);
			if (typeof esc === 'string') return esc;
			js += esc.js;
			i = esc.next;
			continue;
		}
		js += c;
		i++;
	}
	return 'unclosed character class';
}

export function translateRustRegex(pattern: string): TranslateResult {
	if (pattern === '') return { ok: false, error: 'empty pattern' };
	let js = '';
	let groups = 0;
	let depth = 0;
	// Whether the previous token can take a quantifier.
	let canRepeat = false;
	let i = 0;
	while (i < pattern.length) {
		const c = pattern.charAt(i);
		const at = i;
		switch (c) {
			case '\\': {
				const esc = readEscape(pattern, i + 1, false);
				if (typeof esc === 'string') return fail(pattern, at, esc);
				js += esc.js;
				i = esc.next;
				canRepeat = true;
				break;
			}
			case '[': {
				const cls = readClass(pattern, i);
				if (typeof cls === 'string') return fail(pattern, at, cls);
				js += cls.js;
				i = cls.next;
				canRepeat = true;
				break;
			}
			case '(': {
				if (pattern[i + 1] === '?') {
					if (pattern[i + 2] !== ':') {
						return fail(pattern, at, 'only (?: ) groups are portable; no lookaround, inline flags or named groups');
					}
					js += '(?:';
					i += 3;
				} else {
					js += '(';
					groups++;
					i++;
				}
				depth++;
				canRepeat = false;
				break;
			}
			case ')': {
				if (depth === 0) return fail(pattern, at, 'unbalanced )');
				depth--;
				js += ')';
				i++;
				canRepeat = true;
				break;
			}
			case '*':
			case '+':
			case '?':
			case '{': {
				if (!canRepeat) {
					return fail(pattern, at, c === '{' ? 'literal { must be written \\{' : `nothing to repeat before ${c}`);
				}
				let q = c;
				i++;
				if (c === '{') {
					const m = /^(\d+)(,(\d*))?\}/.exec(pattern.slice(i));
					if (m === null) return fail(pattern, at, 'literal { must be written \\{; repetition is {n}, {n,} or {n,m}');
					const [whole, min, , max] = m;
					if (max !== undefined && max !== '' && Number(max) < Number(min)) {
						return fail(pattern, at, 'repetition {n,m} needs n <= m');
					}
					q += whole;
					i += whole.length;
				}
				if (pattern[i] === '?') {
					q += '?';
					i++;
				}
				if (pattern[i] === '+') return fail(pattern, i, 'possessive quantifiers are not supported by Rust regex');
				js += q;
				canRepeat = false;
				const next = pattern[i];
				if (next === '*' || next === '+' || next === '?' || next === '{') {
					return fail(pattern, i, 'a quantifier cannot follow another quantifier; use a group');
				}
				break;
			}
			case '}':
				return fail(pattern, at, 'literal } must be written \\}');
			case ']':
				return fail(pattern, at, 'literal ] must be written \\]');
			case '.':
				// Rust's `.` excludes only \n; JavaScript's also excludes \r and the Unicode line/paragraph separators.
				js += '[^\\n]';
				i++;
				canRepeat = true;
				break;
			case '|':
			case '^':
			case '$':
				js += c;
				i++;
				canRepeat = false;
				break;
			default:
				// '/' is fine inside new RegExp(); '-', '#', '&', '~' are plain literals here.
				js += c;
				i++;
				canRepeat = true;
		}
	}
	if (depth !== 0) return fail(pattern, pattern.length, 'unclosed (');
	try {
		new RegExp(js, 'gu');
	} catch (e) {
		return fail(pattern, 0, `translated pattern does not compile: ${String(e)}`);
	}
	return { ok: true, js, groups };
}

/** Compiles a portable Rust pattern for use in the harness, or throws. */
export function compileRustRegex(pattern: string): { readonly re: RegExp; readonly groups: number } {
	const t = translateRustRegex(pattern);
	if (!t.ok) throw new Error(t.error);
	return { re: new RegExp(t.js, 'gu'), groups: t.groups };
}
