import { parseAppId } from '../../domain/appId';

/**
 * Read-only facts about the running Steam client for the settings page and
 * the diagnostic report. Nothing here writes to Steam.
 */

/**
 * The Steam client build, from the `PACKAGE_CL` query parameter of the
 * SharedJSContext URL. Confirmed on the live client, build 1794536281
 * (docs/research.md, "Environment"); Steam's own code reads it the same way.
 */
export function readSteamBuild(root: unknown = globalThis): string | null {
	try {
		const search = prop(prop(root, 'location'), 'search');
		if (typeof search !== 'string') return null;
		const build = new URLSearchParams(search).get('PACKAGE_CL');
		return build !== null && /^\d{1,12}$/.test(build) ? build : null;
	} catch {
		return null;
	}
}

/**
 * A game's display name, from `appStore.GetAppOverviewByAppID(appid).display_name`.
 * Both confirmed live, build 1794536281 (`display_name` on the Mac; see
 * docs/research.md, "Settings page and diagnostic report").
 * Null when Steam does not know the game, for example one no longer owned.
 */
export function readAppName(appId: number, root: unknown = globalThis): string | null {
	const id = parseAppId(appId);
	if (id === null) return null;
	try {
		const store = prop(root, 'appStore');
		const lookup = prop(store, 'GetAppOverviewByAppID');
		if (typeof lookup !== 'function') return null;
		const overview: unknown = (lookup as (this: unknown, appid: number) => unknown).call(store, id);
		const name = prop(overview, 'display_name');
		return typeof name === 'string' && name.trim() !== '' ? name : null;
	} catch {
		return null;
	}
}

function prop(obj: unknown, key: string): unknown {
	if ((typeof obj !== 'object' && typeof obj !== 'function') || obj === null) return undefined;
	try {
		return (obj as Record<string, unknown>)[key];
	} catch {
		return undefined;
	}
}
