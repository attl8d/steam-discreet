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
