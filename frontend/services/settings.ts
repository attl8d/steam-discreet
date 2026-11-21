import type { AppId } from '../domain/appId';
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
}

/** Read-only facts from the Steam client (frontend/integrations/steam/clientInfo.ts). */
export interface SettingsSteam {
	steamBuild(): string | null;
	appName(appId: AppId): string | null;
}

export interface SettingsView {
	readonly library: LibraryState;
	readonly tags: TagSnapshot;
}

export type ActionResult = { readonly ok: true; readonly message: string } | { readonly ok: false; readonly message: string };

export function millenniumSettingsBackend(): SettingsBackend {
	return {
		updateStatus: () => backend.steam_discreet_update_status(),
		rollback: () => backend.steam_discreet_update_rollback(),
		environment: () => backend.steam_discreet_environment(),
	};
}

export class SettingsService {
	private view: SettingsView;
	private readonly listeners = new Set<() => void>();

	constructor(
		private readonly storage: TagStorage,
		private readonly library: LibraryService,
		private readonly backend: SettingsBackend,
		private readonly steam: SettingsSteam,
		private readonly now: () => Date = () => new Date(),
	) {
		this.view = { library: library.getState(), tags: storage.snapshot };
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

	async clearAll(): Promise<ActionResult> {
		const blocked = this.editBlocked();
		if (blocked !== null) return { ok: false, message: blocked };
		const result = await this.storage.clear();
		if (!result.ok) return { ok: false, message: `Nothing was removed: ${result.message}` };
		return { ok: true, message: 'All tags removed. The previous list is kept in the tag backups.' };
	}

	async exportText(): Promise<{ readonly ok: true; readonly text: string } | { readonly ok: false; readonly message: string }> {
		const result = await this.storage.exportText();
		return result.ok ? result : { ok: false, message: `Export failed: ${result.message}` };
	}

	async importText(text: string, mode: ImportMode): Promise<ActionResult> {
		if (text.trim() === '') return { ok: false, message: 'Paste an exported tag list first.' };
		const blocked = this.editBlocked();
		if (blocked !== null) return { ok: false, message: blocked };
		const before = this.view.tags.tags.size;
		const result = await this.storage.importText(text, mode);
		if (!result.ok) return { ok: false, message: `Nothing was imported: ${result.message}` };
		const after = result.snapshot.tags.size;
		const games = (n: number) => `${String(n)} game${n === 1 ? '' : 's'}`;
		const message =
			mode === 'merge'
				? `Imported. ${games(after - before)} added; ${games(after)} tagged in total.`
				: `Replaced. ${games(after)} tagged now.`;
		return { ok: true, message: result.warning === null ? message : `${message} ${result.warning}` };
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
		const tags = this.view.tags;
		return buildDiagnosticReport({
			generatedAt: this.now(),
			environment,
			steamBuild: safely(() => this.steam.steamBuild(), null),
			library: this.library.getState(),
			selfCheck: this.library.selfCheck(),
			storage: tags.state === 'unloaded' ? null : { state: tags.state, writable: tags.writable, reason: tags.reason },
			update,
		});
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

	private refreshView(): void {
		const library = this.library.getState();
		const tags = this.storage.snapshot;
		if (library === this.view.library && tags === this.view.tags) return;
		this.view = { library, tags };
		for (const listener of this.listeners) {
			try {
				listener();
			} catch {
				// A broken listener must not stop the others.
			}
		}
	}
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
