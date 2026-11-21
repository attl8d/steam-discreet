/**
 * Parsers for the JSON the backend returns to the settings page
 * (backend/main.lua: steam_discreet_update_status, steam_discreet_update_rollback,
 * steam_discreet_environment). Replies are untrusted until they pass here.
 */

export interface LastApplied {
	readonly from: string;
	readonly to: string;
	/** Unix seconds. */
	readonly at: number | null;
	readonly rollback: boolean;
}

/** `Updater:status()` in backend/updater.lua. */
export interface UpdateStatus {
	readonly currentVersion: string | null;
	readonly source: string | null;
	/** Unix seconds of the last finished check. */
	readonly lastCheckAt: number | null;
	/** up_to_date, skipped, already_staged, staged or error. */
	readonly lastResult: string | null;
	readonly lastError: string | null;
	readonly lastApplyError: string | null;
	readonly lastApplied: LastApplied | null;
	readonly skipVersion: string | null;
	readonly stagedVersion: string | null;
	readonly previousVersion: string | null;
	/** Set when the updater itself could not run. */
	readonly error: string | null;
}

export type RollbackResult =
	| { readonly ok: true; readonly to: string }
	| { readonly ok: false; readonly message: string };

export interface Environment {
	readonly pluginVersion: string | null;
	readonly millenniumVersion: string | null;
	readonly os: string | null;
	readonly arch: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
	return typeof value === 'string' && value !== '' ? value : null;
}

function num(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** The backend sends JSON strings; a test or future version may send the object. */
function decode(raw: unknown): Record<string, unknown> | null {
	let value = raw;
	if (typeof raw === 'string') {
		try {
			value = JSON.parse(raw) as unknown;
		} catch {
			return null;
		}
	}
	return isRecord(value) ? value : null;
}

export function parseUpdateStatus(raw: unknown): UpdateStatus | null {
	const v = decode(raw);
	if (v === null) return null;
	const applied = v.last_applied;
	let lastApplied: LastApplied | null = null;
	if (isRecord(applied)) {
		const to = str(applied.to);
		if (to !== null) {
			lastApplied = { from: str(applied.from) ?? 'unknown', to, at: num(applied.at), rollback: applied.rollback === true };
		}
	}
	return {
		currentVersion: str(v.current_version),
		source: str(v.source),
		lastCheckAt: num(v.last_check_at),
		lastResult: str(v.last_result),
		lastError: str(v.last_error),
		lastApplyError: str(v.last_apply_error),
		lastApplied,
		skipVersion: str(v.skip_version),
		stagedVersion: str(v.staged_version),
		previousVersion: str(v.previous_version),
		error: str(v.error),
	};
}

export function parseRollbackResult(raw: unknown): RollbackResult {
	const v = decode(raw);
	if (v === null) return { ok: false, message: 'Unexpected reply from the updater' };
	const to = str(v.to);
	if (v.result === 'rollback_staged' && to !== null) return { ok: true, to };
	return { ok: false, message: str(v.detail) ?? 'Rollback failed' };
}

export function parseEnvironment(raw: unknown): Environment | null {
	const v = decode(raw);
	if (v === null) return null;
	return {
		pluginVersion: str(v.plugin_version),
		millenniumVersion: str(v.millennium_version),
		os: str(v.os),
		arch: str(v.arch),
	};
}

/** A version older than the running one is saved, so a rollback can be offered. */
export function canRollBack(status: UpdateStatus | null): boolean {
	if (status === null || status.previousVersion === null || status.currentVersion === null) return false;
	if (status.stagedVersion !== null) return false;
	return compareVersions(status.previousVersion, status.currentVersion) < 0;
}

/** Compares plain x.y.z versions (a leading "v" is ignored). Unparseable ones compare equal. */
export function compareVersions(a: string, b: string): number {
	const pa = parseVersion(a);
	const pb = parseVersion(b);
	if (pa === null || pb === null) return 0;
	for (let i = 0; i < 3; i++) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (d !== 0) return d < 0 ? -1 : 1;
	}
	return 0;
}

function parseVersion(v: string): number[] | null {
	const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
	return m === null ? null : [Number(m[1]), Number(m[2]), Number(m[3])];
}
