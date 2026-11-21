/**
 * Clears the per-collection count caches Steam keeps outside mobx.
 *
 * Read from Steam's sp.js, build 1794536281 (module 59671): each collection
 * caches `GetAppCountWithToolsFilter` results in a plain Map that only
 * `ClearAppCounts()` empties. Steam calls ClearAppCounts itself whenever a
 * collection's membership changes. It clears a derived number cache only; it
 * does not change any collection, Hidden or Private state.
 *
 * `collectionStore.GetCollection(id)` and `userCollections` were confirmed on
 * the live client in M1. `collectionsFromStorage` and `ClearAppCounts` are
 * read from source and await live confirmation (docs/research.md, M3). Every
 * value is checked before use, so a renamed member only skips that cache.
 */

/** Collection ids Steam's GetCollection resolves to built-in collections (sp.js, build 1794536281). */
export const SYSTEM_COLLECTION_IDS = [
	'all-apps-alpha',
	'all-apps-recent',
	'recent',
	'uncategorized',
	'my-games',
	'all-games',
	'local-install',
	'local-played',
	'recent-purchased',
	'deck-games',
	'frame-games',
	'site-license',
	'deck-desktop-apps',
	'remote-play',
	'remote-play-active',
	'ready-to-play-active',
	'vr',
	'nonvrgames',
	'xbox',
	'ps4',
	'ps5',
	'steamos',
	'machine-games',
	'favorite',
	'hidden',
] as const;

type Fn = (...args: unknown[]) => unknown;

function get(obj: unknown, key: string): unknown {
	if ((typeof obj !== 'object' && typeof obj !== 'function') || obj === null) return undefined;
	try {
		return (obj as Record<string, unknown>)[key];
	} catch {
		return undefined;
	}
}

function call(obj: unknown, key: string, ...args: unknown[]): unknown {
	const fn = get(obj, key);
	if (typeof fn !== 'function') return undefined;
	try {
		return (fn as Fn).apply(obj, args);
	} catch {
		return undefined;
	}
}

function isMapLike(value: unknown): boolean {
	return value instanceof Map || (typeof value === 'object' && value !== null && typeof get(value, 'values') === 'function');
}

function iterate(value: unknown): unknown[] {
	if (Array.isArray(value)) return value as unknown[];
	if (value instanceof Map) return Array.from((value as Map<unknown, unknown>).values());
	if (isMapLike(value)) {
		try {
			return Array.from((value as { values(): Iterable<unknown> }).values());
		} catch {
			return [];
		}
	}
	return [];
}

/**
 * Returns how many caches were cleared; 0 means none could be reached.
 *
 * Runs only on a tag or toggle change. `GetCollection` evaluates some getters
 * that are not cached (for example the uncategorized collection, a pass over
 * all apps), which is acceptable at that rate.
 */
export function clearCollectionCounts(root: unknown = globalThis): number {
	const store = get(root, 'collectionStore');
	if (store === undefined) return 0;
	// Before Steam has read the collections from cloud storage, its map is
	// undefined, and reading `userCollections` (a keepAlive computed) or other
	// collection getters throws. mobx then caches that error with no
	// dependency to recompute on, so Steam's own later reads keep throwing
	// until the UI reloads (seen live on the Mac, 21 November 2026). Steam
	// guards its own reads the same way (`OnAppOverviewChange`). Nothing can
	// have cached counts yet, so there is nothing to clear.
	const fromStorage = get(store, 'collectionsFromStorage');
	if (!isMapLike(fromStorage)) return 0;
	const seen = new Set<unknown>();
	const add = (c: unknown): void => {
		if (typeof c === 'object' && c !== null) seen.add(c);
	};
	for (const id of SYSTEM_COLLECTION_IDS) add(call(store, 'GetCollection', id));
	for (const c of iterate(get(store, 'userCollections'))) add(c);
	for (const c of iterate(fromStorage)) add(c);
	let cleared = 0;
	for (const c of seen) {
		if (typeof get(c, 'ClearAppCounts') !== 'function') continue;
		call(c, 'ClearAppCounts');
		cleared += 1;
	}
	return cleared;
}
