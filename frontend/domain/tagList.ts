import type { AppId } from './appId';

/** One row of the tagged-games list on the settings page. */
export interface TagRow {
	readonly appId: AppId;
	/** Null when Steam does not know the game (not owned any more, metadata not loaded). */
	readonly name: string | null;
}

/**
 * Builds the list: named games by name, then unknown ones by App ID. The
 * query matches part of the name (ignoring case and accents) or the App ID.
 */
export function tagRows(
	ids: Iterable<AppId>,
	nameOf: (id: AppId) => string | null,
	query: string,
): TagRow[] {
	const q = fold(query.trim());
	const rows: TagRow[] = [];
	for (const appId of ids) {
		const name = nameOf(appId);
		if (q === '' || String(appId).includes(q) || (name !== null && fold(name).includes(q))) {
			rows.push({ appId, name });
		}
	}
	return rows.sort(compareRows);
}

function compareRows(a: TagRow, b: TagRow): number {
	if (a.name !== null && b.name !== null) {
		const byName = a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
		if (byName !== 0) return byName;
	} else if (a.name !== null) {
		return -1;
	} else if (b.name !== null) {
		return 1;
	}
	return a.appId - b.appId;
}

function fold(s: string): string {
	return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}
