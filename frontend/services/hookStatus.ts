/**
 * Self-check status model for the hooks in backend/hook_definitions.lua.
 *
 * Each patched piece of Steam code sets a flag the first time it runs (the
 * `#{{marker}}` token, expanded by backend/hooks.lua). This module turns the
 * backend's hook manifest plus those flags into a per-hook status and one
 * overall state for the toggle. It is pure: the caller supplies the manifest,
 * the flags and whether the startup grace period is over.
 *
 * The marker fires only when the patched code runs, so not seeing it proves
 * nothing for code that runs on demand (a context menu, a view not opened
 * yet). Only a `startup` hook that stays unseen after the grace period counts
 * as missing. Either way, features built on a hook act only once it is
 * attached (fail open: tagged games show, nothing is blocked).
 */

/** Name of the global the markers write to. Must match hooks.MARKER_GLOBAL in backend/hooks.lua. */
export const MARKER_GLOBAL = '__steamDiscreetHooks';

/** When the patched code runs: on every Steam start, or only when the user opens something. */
export type HookRuns = 'startup' | 'on_demand';

export interface ExpectedHook {
	readonly id: string;
	readonly description: string;
	readonly runs: HookRuns;
	readonly file: string;
	readonly find: string;
}

export interface RejectedHook {
	readonly id: string;
	readonly reason: string;
}

/** What the backend reports (`hook_manifest` in backend/main.lua). */
export interface HookManifest {
	readonly version: number;
	readonly expected: readonly ExpectedHook[];
	readonly rejected: readonly RejectedHook[];
	readonly error: string | null;
}

/**
 * attached  the patched code has run, so the hook is in place.
 * checking  a startup hook not seen yet, and the grace period is still running.
 * missing   a startup hook not seen running after the grace period. Not a failure for on_demand hooks.
 * not-seen  an on_demand hook whose code has not run yet. Normal until the user opens that surface.
 * rejected  the definition was refused when the backend loaded it, so Steam was never patched.
 */
export type HookState = 'attached' | 'checking' | 'missing' | 'not-seen' | 'rejected';

export interface HookStatus {
	readonly id: string;
	readonly state: HookState;
	readonly description: string;
	/** What a failed hook was looking for, for the diagnostic report. */
	readonly lookingFor: { readonly file: string; readonly find: string } | null;
	readonly reason: string | null;
}

/** ok: everything attached. checking: nothing failed yet. warning: something failed; show it on the toggle. */
export type OverallState = 'ok' | 'checking' | 'warning';

export interface SelfCheck {
	readonly overall: OverallState;
	readonly hooks: readonly HookStatus[];
	/** Set when the definitions file could not be loaded at all. */
	readonly loadError: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
	return typeof value === 'string';
}

/** Validates the backend's manifest. Returns null when it is not the expected shape. */
export function parseManifest(value: unknown): HookManifest | null {
	if (!isRecord(value) || typeof value.version !== 'number') return null;
	const { expected, rejected, error } = value;
	// Lua's empty table may arrive as {} instead of [].
	const list = (v: unknown): unknown[] | null => (Array.isArray(v) ? v : isRecord(v) && Object.keys(v).length === 0 ? [] : null);
	const exp = list(expected);
	const rej = list(rejected);
	if (exp === null || rej === null) return null;
	const hooks: ExpectedHook[] = [];
	for (const h of exp) {
		if (!isRecord(h) || !isString(h.id) || !isString(h.description) || !isString(h.file) || !isString(h.find)) return null;
		if (h.runs !== 'startup' && h.runs !== 'on_demand') return null;
		hooks.push({ id: h.id, description: h.description, runs: h.runs, file: h.file, find: h.find });
	}
	const refused: RejectedHook[] = [];
	for (const r of rej) {
		if (!isRecord(r) || !isString(r.id) || !isString(r.reason)) return null;
		refused.push({ id: r.id, reason: r.reason });
	}
	if (error !== undefined && error !== null && !isString(error)) return null;
	return { version: value.version, expected: hooks, rejected: refused, error: error ?? null };
}

/** Reads the ids of hooks whose patched code has run, from the marker global's value. */
export function readMarkers(value: unknown): ReadonlySet<string> {
	if (!isRecord(value)) return new Set();
	return new Set(Object.keys(value).filter((id) => value[id] === 1));
}

export function evaluateSelfCheck(manifest: HookManifest, seen: ReadonlySet<string>, gracePeriodOver: boolean): SelfCheck {
	const hooks: HookStatus[] = manifest.expected.map((h) => {
		if (seen.has(h.id)) {
			return { id: h.id, state: 'attached', description: h.description, lookingFor: null, reason: null };
		}
		const lookingFor = { file: h.file, find: h.find };
		if (h.runs === 'on_demand') {
			return { id: h.id, state: 'not-seen', description: h.description, lookingFor, reason: null };
		}
		return {
			id: h.id,
			state: gracePeriodOver ? 'missing' : 'checking',
			description: h.description,
			lookingFor,
			reason: gracePeriodOver ? 'not seen running since Steam started; its find pattern may no longer match' : null,
		};
	});
	for (const r of manifest.rejected) {
		hooks.push({ id: r.id, state: 'rejected', description: '', lookingFor: null, reason: r.reason });
	}

	const failed = manifest.error !== null || hooks.some((h) => h.state === 'missing' || h.state === 'rejected');
	const checking = hooks.some((h) => h.state === 'checking');
	return {
		overall: failed ? 'warning' : checking ? 'checking' : 'ok',
		hooks,
		loadError: manifest.error,
	};
}

/** Features built on a hook may act only once it is attached. */
export function isHookAttached(check: SelfCheck, id: string): boolean {
	return check.hooks.some((h) => h.id === id && h.state === 'attached');
}
