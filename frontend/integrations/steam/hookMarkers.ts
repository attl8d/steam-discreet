import { MARKER_GLOBAL, readMarkers } from '../../services/hookStatus';

/** Ids of hooks whose patched Steam code has run (see backend/hooks.lua `#{{marker}}`). */
export function seenHooks(root: unknown = globalThis): ReadonlySet<string> {
	if (typeof root !== 'object' || root === null) return new Set();
	let value: unknown;
	try {
		value = (root as Record<string, unknown>)[MARKER_GLOBAL];
	} catch {
		return new Set();
	}
	return readMarkers(value);
}
