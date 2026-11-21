/**
 * Replies from the backup functions in backend/tagstore/rpc.lua
 * (`backup_save`, `backup_list`, `backup_read`, `tags_preview_import`).
 * Replies are untrusted, so each one is checked field by field. Pure.
 */

export type SameAccount = 'yes' | 'no' | 'unknown';
export type ImportKind = 'backup' | 'tags' | 'list';
export type BackupLocation = 'documents' | 'fallback' | 'override';

export interface ImportPreview {
	readonly ok: true;
	readonly count: number;
	readonly kind: ImportKind;
	/** When a backup file was saved; null for other text. */
	readonly saved: Date | null;
	/** Whether a backup comes from the signed-in Steam account. */
	readonly sameAccount: SameAccount;
}

export interface BackupEntry {
	/** Opaque, passed back to `backup_read`. */
	readonly id: string;
	readonly name: string;
	readonly status: 'ok' | 'newer' | 'invalid';
	readonly count: number | null;
	readonly saved: Date | null;
	readonly sameAccount: SameAccount;
	readonly location: BackupLocation;
}

export interface BackupList {
	readonly ok: true;
	/** Where the next backup goes. */
	readonly folder: string;
	readonly entries: readonly BackupEntry[];
}

export interface SavedBackup {
	readonly ok: true;
	readonly name: string;
	readonly path: string;
	readonly count: number;
	readonly location: BackupLocation;
	/** Why the Documents folder was not used, when it was tried and failed. */
	readonly fallbackReason: string | null;
}

export interface Failure {
	readonly ok: false;
	readonly message: string;
}

const UNEXPECTED: Failure = { ok: false, message: 'Unexpected reply from tag storage' };

function record(raw: unknown): Record<string, unknown> | null {
	return typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : null;
}

function failure(r: Record<string, unknown>): Failure {
	return typeof r.message === 'string' && r.message !== '' ? { ok: false, message: r.message } : UNEXPECTED;
}

function count(value: unknown): number | null {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function sameAccount(value: unknown): SameAccount {
	return value === 'yes' || value === 'no' ? value : 'unknown';
}

function location(value: unknown): BackupLocation | null {
	return value === 'documents' || value === 'fallback' || value === 'override' ? value : null;
}

/** An ISO time the backend wrote ("2026-11-21T19:40:00Z"), or null. */
export function parseSaved(value: unknown): Date | null {
	if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value)) return null;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? null : date;
}

export function parsePreview(raw: unknown): ImportPreview | Failure {
	const r = record(raw);
	if (r === null) return UNEXPECTED;
	if (r.ok !== true) return failure(r);
	const n = count(r.count);
	if (n === null) return UNEXPECTED;
	const kind: ImportKind = r.kind === 'backup' || r.kind === 'tags' ? r.kind : 'list';
	return { ok: true, count: n, kind, saved: parseSaved(r.saved), sameAccount: sameAccount(r.same_account) };
}

export function parseSaveReply(raw: unknown): SavedBackup | Failure {
	const r = record(raw);
	if (r === null) return UNEXPECTED;
	if (r.ok !== true) return failure(r);
	const n = count(r.count);
	const where = location(r.kind);
	if (typeof r.name !== 'string' || typeof r.path !== 'string' || n === null || where === null) return UNEXPECTED;
	return {
		ok: true,
		name: r.name,
		path: r.path,
		count: n,
		location: where,
		fallbackReason: typeof r.fallback_reason === 'string' && r.fallback_reason !== '' ? r.fallback_reason : null,
	};
}

/** One tab-separated line per backup: id, name, status, count, saved, same account, location. */
export function parseListReply(raw: unknown): BackupList | Failure {
	const r = record(raw);
	if (r === null) return UNEXPECTED;
	if (r.ok !== true) return failure(r);
	if (typeof r.entries !== 'string' || typeof r.folder !== 'string') return UNEXPECTED;
	const entries: BackupEntry[] = [];
	for (const line of r.entries.split('\n')) {
		if (line === '') continue;
		const [id, name, status, n, saved, same, where] = line.split('\t');
		const loc = location(where);
		if (id === undefined || id === '' || name === undefined || loc === null) continue;
		if (status !== 'ok' && status !== 'newer' && status !== 'invalid') continue;
		entries.push({
			id,
			name,
			status,
			count: status === 'ok' && n !== undefined && /^\d+$/.test(n) ? Number(n) : null,
			saved: parseSaved(saved),
			sameAccount: sameAccount(same),
			location: loc,
		});
	}
	return { ok: true, folder: r.folder, entries };
}

export function parseReadReply(raw: unknown): { readonly ok: true; readonly text: string } | Failure {
	const r = record(raw);
	if (r === null) return UNEXPECTED;
	if (r.ok !== true) return failure(r);
	return typeof r.text === 'string' ? { ok: true, text: r.text } : UNEXPECTED;
}

function games(n: number): string {
	return `${String(n)} game${n === 1 ? '' : 's'}`;
}

/** "21 Nov 2026, 19:40" in the user's locale. */
export function formatSaved(date: Date): string {
	return date.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** One line under a listed backup. */
export function describeEntry(entry: BackupEntry, format: (date: Date) => string = formatSaved): string {
	if (entry.status === 'newer') return 'Made by a newer version of Steam Discreet. Update the plugin to restore it.';
	if (entry.status === 'invalid') return 'Damaged or cut short, so it cannot be restored.';
	const parts = [entry.count === null ? 'Tag list' : games(entry.count)];
	if (entry.saved !== null) parts.push(`saved ${format(entry.saved)}`);
	if (entry.sameAccount === 'no') parts.push('from another Steam account');
	if (entry.location === 'fallback') parts.push("in the plugin's own folder");
	return parts.join(', ');
}

/** What the confirmation asks before an import or restore changes the list. */
export function importQuestion(
	mode: 'merge' | 'replace',
	incoming: { readonly count: number; readonly sameAccount: SameAccount },
	current: number,
	source: 'paste' | 'backup',
): string {
	const what = source === 'backup' ? 'this backup' : 'the paste';
	const other = incoming.sameAccount === 'no' ? 'This backup is from another Steam account. ' : '';
	if (mode === 'merge') {
		return `${other}Add the ${games(incoming.count)} in ${what} to your ${games(current)}? Your current tags stay.`;
	}
	return (
		`${other}Replace your ${games(current)} with the ${games(incoming.count)} in ${what}? ` +
		`Games not in ${what} are untagged. The current list is saved first, and an Undo button puts it back until Steam restarts.`
	);
}
