/**
 * A line-by-line JavaScript copy of how Millennium applies patches, taken from
 * src/instrumentation/loopback/src/engine.rs at Millennium v3.6.3 (6522c24).
 * Keep it in step with that file; tools/patch-crosscheck checks the outputs
 * against the real Rust code.
 */
import { compileRustRegex } from './rustRegex';

export interface PatchTransform {
	readonly match: string;
	readonly replace: string;
}

export interface PatchDef {
	readonly file: string;
	readonly find: string;
	readonly transforms: readonly PatchTransform[];
}

/** engine.rs `expand_self`. */
export function expandSelf(replace: string, pluginName: string): string {
	return replace.split('#{{self}}').join(`window.PLUGIN_LIST['${pluginName}']`);
}

/** engine.rs `re2_to_rust_rep`: `\N` becomes `$N`, every `$` becomes `$$`. */
export function re2ToRustRep(replace: string): string {
	let out = '';
	for (let i = 0; i < replace.length; i++) {
		const c = replace.charAt(i);
		const next = replace.charAt(i + 1);
		if (c === '$') {
			out += '$$';
		} else if (c === '\\' && /[0-9]/.test(next)) {
			out += `$${next}`;
			i++;
		} else {
			out += c;
		}
	}
	return out;
}

/**
 * Rust regex `Captures::expand`: `$$` is a literal `$`; `$name` takes the
 * longest run of [0-9A-Za-z_]; `${name}` is braced; an all-digit name is a
 * group index; a missing group expands to nothing.
 */
export function expandRustReplacement(rep: string, groups: readonly (string | undefined)[]): string {
	let out = '';
	let i = 0;
	while (i < rep.length) {
		const c = rep.charAt(i);
		if (c !== '$') {
			out += c;
			i++;
			continue;
		}
		if (rep.charAt(i + 1) === '$') {
			out += '$';
			i += 2;
			continue;
		}
		let name: string | null = null;
		let end = i + 1;
		if (rep.charAt(i + 1) === '{') {
			const close = rep.indexOf('}', i + 2);
			if (close > i + 2) {
				name = rep.slice(i + 2, close);
				end = close + 1;
			}
		} else {
			const m = /^[0-9A-Za-z_]+/.exec(rep.slice(i + 1));
			if (m !== null) {
				name = m[0];
				end = i + 1 + name.length;
			}
		}
		if (name === null) {
			out += '$';
			i++;
			continue;
		}
		// Only numbered groups exist (named groups are rejected by the subset).
		out += /^[0-9]+$/.test(name) ? (groups[Number(name)] ?? '') : '';
		i = end;
	}
	return out;
}

/** Rust `Regex::replace_all` on one region. Returns the new text and the match count. */
export function replaceAll(region: string, pattern: string, rustRep: string): { text: string; count: number } {
	const { re } = compileRustRegex(pattern);
	let count = 0;
	let out = '';
	let last = 0;
	for (const m of region.matchAll(re)) {
		// Rust and JavaScript step past empty matches differently.
		if (m[0] === '') throw new Error(`/${pattern}/ can match an empty string; make it match at least one character`);
		count++;
		out += region.slice(last, m.index) + expandRustReplacement(rustRep, Array.from(m));
		last = m.index + m[0].length;
	}
	return { text: out + region.slice(last), count };
}

export interface ApplyResult {
	/** Whether the `file` pattern selected this file at all. */
	readonly fileMatched: boolean;
	/** `find` matched: Millennium reports `match`, otherwise `no_match`. */
	readonly applied: boolean;
	readonly output: string;
	/** Start and end of the `find` match in the output, after transforms. */
	readonly scope: { readonly from: number; readonly to: number } | null;
	readonly scopeBefore: { readonly from: number; readonly to: number } | null;
	readonly transformCounts: readonly number[];
}

/** engine.rs `apply_patches` for one plugin's single patch. */
export function applyPatch(patch: PatchDef, pluginName: string, content: string, filename: string): ApplyResult {
	const unchanged = { output: content, scope: null, scopeBefore: null, transformCounts: [] };
	const fileRe = compileRustRegex(patch.file).re;
	if (!fileRe.test(filename)) return { fileMatched: false, applied: false, ...unchanged };

	const findRe = compileRustRegex(patch.find).re;
	const m = findRe.exec(content);
	if (m === null) return { fileMatched: true, applied: false, ...unchanged };

	const from = m.index;
	let to = from + m[0].length;
	let buf = content;
	const transformCounts: number[] = [];
	for (const t of patch.transforms) {
		const rep = re2ToRustRep(expandSelf(t.replace, pluginName));
		const { text, count } = replaceAll(buf.slice(from, to), t.match, rep);
		transformCounts.push(count);
		buf = buf.slice(0, from) + text + buf.slice(to);
		to = from + text.length;
	}
	return {
		fileMatched: true,
		applied: true,
		output: buf,
		scope: { from, to },
		scopeBefore: { from, to: from + m[0].length },
		transformCounts,
	};
}

/** Number of non-overlapping matches, the way a `find` would see them. */
export function countMatches(pattern: string, content: string): number {
	return Array.from(content.matchAll(compileRustRegex(pattern).re)).length;
}
