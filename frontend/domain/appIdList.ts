import { type AppId, parseAppId } from './appId';

/**
 * App ID lists cross the backend boundary as comma-separated decimal strings,
 * because Millennium turns an empty Lua table into `{}` rather than `[]`.
 */
export function encodeAppIdList(ids: Iterable<AppId>): string {
	return [...new Set(ids)].sort((a, b) => a - b).join(',');
}

/** All-or-nothing: one bad entry rejects the whole list. */
export function decodeAppIdList(value: unknown): AppId[] | null {
	if (typeof value !== 'string') return null;
	if (value === '') return [];
	const ids: AppId[] = [];
	for (const part of value.split(',')) {
		const id = parseAppId(part);
		if (id === null) return null;
		ids.push(id);
	}
	return ids;
}
