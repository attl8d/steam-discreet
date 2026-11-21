import type { AccountId } from '../domain/accountId';
import type { AppId } from '../domain/appId';
import {
	type BackupList,
	type Failure,
	type ImportPreview,
	parseListReply,
	parsePreview,
	parseReadReply,
	parseSaveReply,
} from './backupFiles';
import { tagRows, type TagRow } from '../domain/tagList';
import {
	type Environment,
	parseEnvironment,
	parseRollbackResult,
	parseUpdateStatus,
	type RollbackResult,
	type UpdateStatus,
} from './backendInfo';
import { buildDiagnosticReport } from './diagnostics';
import type { SelfCheck } from './hookStatus';
import type { LibraryService, LibraryState } from './library';
import type { ImportMode, TagSnapshot, TagStorage } from './tagStorage';

/**
 * Everything the settings page does, kept out of the React components so it
 * can be tested without Steam. It needs no hook: the tag list, export, import,
 * the updater and the report all work when every Library hook has failed.
 */

/** The backend functions in backend/main.lua. Replies are untrusted. */
export interface SettingsBackend {
	updateStatus(): Promise<unknown>;
	rollback(): Promise<unknown>;
	environment(): Promise<unknown>;
	/** Removes the real folder and login names (backend/redact.lua). */
	redact(text: string): Promise<unknown>;
	/** Parses import text without saving (`tags_preview_import`); `account` may be "". */
	previewImport(text: string, account: string): Promise<unknown>;
	/** Writes a backup file of the account's tags (`backup_save`). */
	saveBackup(account: string): Promise<unknown>;
	/** Backup files found, newest first (`backup_list`). */
	listBackups(account: string): Promise<unknown>;
	/** One listed backup's text (`backup_read`). Changes nothing. */
	readBackup(id: string): Promise<unknown>;
}

/** Read-only facts from the Steam client (frontend/integrations/steam/clientInfo.ts). */
export interface SettingsSteam {
	steamBuild(): string | null;
	appName(appId: AppId): string | null;
}

/** The list as it was before Remove all or Replace, kept for this session only. */
export interface UndoBackup {
	readonly text: string;
	readonly count: number;
	readonly action: 'clear' | 'replace';
	/** Dropped when another account signs in, so it can never land on the wrong list. */
	readonly account: AccountId;
}

export interface SettingsView {
	readonly library: LibraryState;
	readonly tags: TagSnapshot;
	readonly undo: UndoBackup | null;
}

export type ActionResult = { readonly ok: true; readonly message: string } | { readonly ok: false; readonly message: string };

export function millenniumSettingsBackend(): SettingsBackend {
	return {
		updateStatus: () => backend.steam_discreet_update_status(),
		rollback: () => backend.steam_discreet_update_rollback(),
		environment: () => backend.steam_discreet_environment(),
		redact: (text) => backend.steam_discreet_redact(text),
		previewImport: (text, account) => backend.tags_preview_import(text, account),
		saveBackup: (account) => backend.backup_save(account),
		listBackups: (account) => backend.backup_list(account),
		readBackup: (id) => backend.backup_read(id),
	};
}

export class SettingsService {
	private view: SettingsView;
	private undo: UndoBackup | null = null;
	private readonly listeners = new Set<() => void>();

	constructor(
		private readonly storage: TagStorage,
		private readonly library: LibraryService,
		private readonly backend: SettingsBackend,
		private readonly steam: SettingsSteam,
		private readonly now: () => Date = () => new Date(),
	) {
		this.view = { library: library.getState(), tags: storage.snapshot, undo: null };
		const update = () => {
			this.refreshView();
		};
		library.subscribe(update);
		storage.subscribe(update);
	}

	getView(): SettingsView {
		return this.view;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	selfCheck(): SelfCheck {
		return this.library.selfCheck();
	}

	/** The tagged games matching `query`, by name. */
	rows(query: string): TagRow[] {
		return tagRows(this.view.tags.tags, (id) => this.steam.appName(id), query);
	}

	/** A one-time message from tag storage, such as "restored from a backup". */
	takeNotice(): string | null {
		return this.storage.takeNotice();
	}

	async removeTag(appId: AppId): Promise<ActionResult> {
		const name = this.steam.appName(appId) ?? `App ${String(appId)}`;
		try {
			await this.library.untagGames([appId]);
			return { ok: true, message: `Removed ${name}.` };
		} catch (error) {
			return { ok: false, message: `Could not remove ${name}: ${describe(error)}` };
		}
	}

	/**
	 * Removes every tag. The current list is exported first and kept for an
	 * Undo; if that export fails, nothing is removed.
	 */
	async clearAll(): Promise<ActionResult> {
		const blocked = this.editBlocked();
		if (blocked !== null) return { ok: false, message: blocked };
		const backup = await this.backup('clear');
		if (!backup.ok) return { ok: false, message: `Nothing was removed, because the current list could not be saved first: ${backup.message}` };
		const result = await this.storage.clear();
		if (!result.ok) return { ok: false, message: `Nothing was removed: ${result.message}` };
		this.setUndo(backup.undo);
		return { ok: true, message: 'All tags removed. Undo puts them back.' };
	}

	async exportText(): Promise<{ readonly ok: true; readonly text: string } | { readonly ok: false; readonly message: string }> {
		const result = await this.storage.exportText();
		return result.ok ? result : { ok: false, message: `Export failed: ${result.message}` };
	}

	/**
	 * How many App IDs pasted text holds, without saving anything. For a backup
	 * file also when it was saved and whether it comes from this Steam account.
	 */
	async previewImport(text: string): Promise<ImportPreview | Failure> {
		if (text.trim() === '') return { ok: false, message: 'Paste an exported tag list first.' };
		try {
			return parsePreview(await this.backend.previewImport(text, this.storage.snapshot.account ?? ''));
		} catch (error) {
			return { ok: false, message: describe(error) };
		}
	}

	/** Saves a backup file of this account's tag list. */
	async saveBackup(): Promise<ActionResult> {
		const account = this.storage.snapshot.account;
		if (!this.view.library.ready || account === null) return { ok: false, message: 'Tags are not loaded yet.' };
		let reply;
		try {
			reply = parseSaveReply(await this.backend.saveBackup(account));
		} catch (error) {
			reply = { ok: false, message: describe(error) } as const;
		}
		if (!reply.ok) return { ok: false, message: `No backup was saved: ${reply.message}` };
		const saved = `Saved a backup of ${games(reply.count)} to ${reply.path}.`;
		const why =
			reply.fallbackReason !== null
				? ` Your Documents folder could not be used (${reply.fallbackReason}), so it went to the plugin's own folder.`
				: reply.location === 'fallback'
					? ' No Documents folder was found, so it went to the plugin\'s own folder.'
					: '';
		return { ok: true, message: `${saved}${why} It lists your tagged games, so keep it private.` };
	}

	/** The backup files found, newest first. */
	async listBackups(): Promise<BackupList | Failure> {
		try {
			const reply = parseListReply(await this.backend.listBackups(this.storage.snapshot.account ?? ''));
			return reply.ok ? reply : { ok: false, message: `Could not look for backups: ${reply.message}` };
		} catch (error) {
			return { ok: false, message: `Could not look for backups: ${describe(error)}` };
		}
	}

	/**
	 * Restores a listed backup into this account's tags, through the same path
	 * as a pasted import: Replace saves the current list first for an Undo.
	 */
	async restoreBackup(id: string, mode: ImportMode): Promise<ActionResult> {
		let read;
		try {
			read = parseReadReply(await this.backend.readBackup(id));
		} catch (error) {
			read = { ok: false, message: describe(error) } as const;
		}
		if (!read.ok) return { ok: false, message: `Nothing was restored: ${read.message}` };
		return this.importText(read.text, mode);
	}

	/**
	 * Imports pasted text. Replace exports the current list first and keeps it
	 * for an Undo; if that export fails, nothing is replaced.
	 */
	async importText(text: string, mode: ImportMode): Promise<ActionResult> {
		if (text.trim() === '') return { ok: false, message: 'Paste an exported tag list first.' };
		const blocked = this.editBlocked();
		if (blocked !== null) return { ok: false, message: blocked };
		let undo: UndoBackup | null = null;
		if (mode === 'replace') {
			const backup = await this.backup('replace');
			if (!backup.ok) {
				return { ok: false, message: `Nothing was replaced, because the current list could not be saved first: ${backup.message}` };
			}
			undo = backup.undo;
		}
		const before = this.storage.snapshot.tags.size;
		const result = await this.storage.importText(text, mode);
		if (!result.ok) return { ok: false, message: `Nothing was imported: ${result.message}` };
		if (undo !== null) this.setUndo(undo);
		const after = result.snapshot.tags.size;
		const message =
			mode === 'merge'
				? `Imported. ${games(after - before)} added; ${games(after)} tagged in total.`
				: `Replaced. ${games(after)} tagged now. Undo puts the previous list back.`;
		return { ok: true, message: result.warning === null ? message : `${message} ${result.warning}` };
	}

	/** Puts back the list saved before the last Remove all or Replace. */
	async undoLast(): Promise<ActionResult> {
		const undo = this.undo;
		if (undo === null) return { ok: false, message: 'There is nothing to undo.' };
		const blocked = this.editBlocked();
		if (blocked !== null) return { ok: false, message: blocked };
		// An empty saved list cannot be imported ("no App IDs"), so it is restored by clearing.
		const result = undo.count === 0 ? await this.storage.clear() : await this.storage.importText(undo.text, 'replace');
		if (!result.ok) return { ok: false, message: `Undo failed; the saved list is still here: ${result.message}` };
		this.setUndo(null);
		const n = result.snapshot.tags.size;
		return { ok: true, message: `Restored. ${String(n)} game${n === 1 ? '' : 's'} tagged.` };
	}

	async updateStatus(): Promise<UpdateStatus | null> {
		try {
			return parseUpdateStatus(await this.backend.updateStatus());
		} catch {
			return null;
		}
	}

	async rollback(): Promise<RollbackResult> {
		try {
			return parseRollbackResult(await this.backend.rollback());
		} catch (error) {
			return { ok: false, message: describe(error) };
		}
	}

	async diagnosticReport(): Promise<string> {
		const [environment, update] = await Promise.all([this.environment(), this.updateStatus()]);
		const tags = this.storage.snapshot;
		const report = buildDiagnosticReport({
			generatedAt: this.now(),
			environment,
			steamBuild: safely(() => this.steam.steamBuild(), null),
			library: this.library.getState(),
			selfCheck: this.library.selfCheck(),
			storage: tags.state === 'unloaded' ? null : { state: tags.state, writable: tags.writable, reason: tags.reason },
			update,
			account: tags.account,
		});
		// Second pass in the backend, with the real folder and login names.
		try {
			const redacted: unknown = await this.backend.redact(report);
			if (typeof redacted === 'string' && redacted !== '') return redacted;
		} catch {
			// Keep the report cleaned by shape and account.
		}
		return report;
	}

	private async backup(
		action: UndoBackup['action'],
	): Promise<{ readonly ok: true; readonly undo: UndoBackup } | { readonly ok: false; readonly message: string }> {
		const { account, tags } = this.storage.snapshot;
		if (account === null) return { ok: false, message: 'No account is loaded' };
		const count = tags.size;
		const exported = await this.storage.exportText();
		if (!exported.ok) return { ok: false, message: exported.message };
		return { ok: true, undo: { text: exported.text, count, action, account } };
	}

	private setUndo(undo: UndoBackup | null): void {
		this.undo = undo;
		this.refreshView(true);
	}

	private async environment(): Promise<Environment | null> {
		try {
			return parseEnvironment(await this.backend.environment());
		} catch {
			return null;
		}
	}

	private editBlocked(): string | null {
		const { library, tags } = this.view;
		if (!library.ready) return 'Tags are not loaded yet.';
		if (!tags.writable) return tags.reason ?? 'Tags cannot be changed right now.';
		return null;
	}

	private refreshView(force = false): void {
		const library = this.library.getState();
		const tags = this.storage.snapshot;
		if (this.undo !== null && tags.account !== this.undo.account) {
			this.undo = null;
			force = true;
		}
		if (!force && library === this.view.library && tags === this.view.tags) return;
		this.view = { library, tags, undo: this.undo };
		for (const listener of this.listeners) {
			try {
				listener();
			} catch {
				// A broken listener must not stop the others.
			}
		}
	}
}

function games(n: number): string {
	return `${String(n)} game${n === 1 ? '' : 's'}`;
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function safely<T>(fn: () => T, fallback: T): T {
	try {
		return fn();
	} catch {
		return fallback;
	}
}

let instance: SettingsService | null = null;

/** Set by frontend/index.tsx. */
export function installSettings(service: SettingsService | null): void {
	instance = service;
}

export function installedSettings(): SettingsService | null {
	return instance;
}
