import { type AppId, parseAppId } from '../../domain/appId';

/**
 * Turns a selection value read from Steam into App IDs, all or nothing.
 * Anything that is not a non-empty list of valid App IDs gives `null`, which
 * the menu shows as a disabled item rather than guessing.
 *
 * Where the value comes from (which Steam object and field) is recorded in
 * docs/research.md once confirmed in the live client; this only validates.
 */
export function parseSelection(value: unknown): AppId[] | null {
	const list: unknown[] | null = Array.isArray(value) ? (value as unknown[]) : null;
	if (list === null || list.length === 0) return null;
	const ids: AppId[] = [];
	for (const entry of list) {
		const id = parseAppId(entry);
		if (id === null) return null;
		ids.push(id);
	}
	return [...new Set(ids)];
}

/**
 * The games a context menu acts on, from the `rgApps` argument the
 * `game-context-menu` hook passes in: the array GetTargetApps() returns, app
 * overviews with a numeric `appid` (sp.js build 1794536281, see
 * docs/research.md). Non-Steam shortcuts and mods are unsupported in v1
 * (PLAN.md), so any of them makes the selection unknown and the item disabled.
 */
export function selectionFromMenuApps(rgApps: unknown): AppId[] | null {
	if (!Array.isArray(rgApps)) return null;
	const ids: unknown[] = [];
	for (const app of rgApps as unknown[]) {
		if (typeof app !== 'object' || app === null) return null;
		const overview = app as { appid?: unknown; BIsModOrShortcut?: unknown };
		if (typeof overview.BIsModOrShortcut !== 'function') return null;
		const isShortcut: unknown = (overview.BIsModOrShortcut as () => unknown).call(app);
		if (isShortcut !== false) return null;
		ids.push(overview.appid);
	}
	return parseSelection(ids);
}
