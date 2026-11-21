import type { AccountId } from '../domain/accountId';
import { parseAppId, type AppId } from '../domain/appId';
import type { ViewMode } from '../domain/revealToggle';
import type { ReactiveSignal } from '../integrations/steam/reactiveSignal';
import { evaluateSelfCheck, type HookManifest, parseManifest, type SelfCheck } from './hookStatus';
import type { TagSnapshot, TagStorage } from './tagStorage';

/**
 * Library hiding (M3): the session's reveal toggle, the active account's tag
 * set, and the hide check the patched Steam code calls.
 *
 * - The patched `collectionStore.BIsVisible` (hook `library-visibility` in
 *   backend/hook_definitions.lua) asks `shouldHide(appid)` for every game.
 * - The view mode is a module-level value: `hidden` (tagged games hidden, the
 *   default), `all` (everything shown) or `only` (only tagged games shown). It
 *   is never saved, so it is `hidden` after every Steam start, UI reload or
 *   plugin reload.
 * - `only` works through the same check, so Steam keeps its own grouping,
 *   recent-activity sort, search and filters (docs/research.md, "Adult only
 *   mode"). It never hides everything: until the tags load, or while the tag
 *   list is empty, nothing is hidden, and emptying the list in `only` mode
 *   switches back to `hidden`.
 * - Any failure here means "do not hide" (fail open): an exception, a
 *   non-number App ID, tags not loaded yet.
 * - On a tag or toggle change, Steam's cached lists are refreshed in place
 *   through a signal from Steam's own mobx, and its count caches are cleared.
 *
 * Steam globals are reached only through `LibraryPort`, implemented in
 * frontend/integrations/steam/.
 */

/** Must match the hook id in backend/hook_definitions.lua. */
export const VISIBILITY_HOOK_ID = 'library-visibility';
/** The reveal toggle in the Library sidebar. Without it nothing could reveal, so its failure means fail open. */
export const REVEAL_HOOK_ID = 'reveal-toggle';
/** The Mark/Unmark as adult item in the game context menu. Its failure only warns. */
export const MENU_HOOK_ID = 'game-context-menu';

export interface LibraryPort {
	/** The signed-in account, or null until Steam has logged in. */
	currentAccount(): AccountId | null;
	/** A signal Steam's mobx tracks, or null if it cannot be found. */
	createSignal(): ReactiveSignal | null;
	/** Clears Steam's per-collection count caches. Returns how many were cleared. */
	clearCounts(): number;
	/** Hook ids whose patched code has run. */
	seenHooks(): ReadonlySet<string>;
	/** The backend's hook manifest (`steam_discreet_hook_manifest`): a JSON string or object, untrusted. */
	hookManifest(): Promise<unknown>;
}

export interface Clock {
	now(): number;
	setInterval(fn: () => void, ms: number): unknown;
	clearInterval(handle: unknown): void;
}

export const realClock: Clock = {
	now: () => Date.now(),
	setInterval: (fn, ms) => setInterval(fn, ms),
	clearInterval: (handle) => {
		clearInterval(handle as ReturnType<typeof setInterval>);
	},
};

/**
 * ok        the hide check is running in Steam and lists refresh live.
 * checking  Steam has not run the patched code yet (shortly after start).
 * warning   the hook was not seen, or lists cannot refresh live; tagged games may show.
 */
export type SeamStatus = 'ok' | 'checking' | 'warning';

/**
 * hidden  tagged games are hidden (the default after every start).
 * all     every game is shown.
 * only    only tagged games are shown.
 */
export type { ViewMode };

export function parseViewMode(value: unknown): ViewMode | null {
	return value === 'hidden' || value === 'all' || value === 'only' ? value : null;
}

export interface LibraryState {
	/** The active account's tags are loaded. */
	readonly ready: boolean;
	readonly mode: ViewMode;
	/** True when tagged games are shown: mode `all` or `only`. */
	readonly revealed: boolean;
	/** At least one game is tagged; `only` mode is offered only then. */
	readonly hasTags: boolean;
	readonly seamStatus: SeamStatus;
	/** Why seamStatus is "warning", or why tags cannot be changed, in words for the user. */
	readonly warning: string | null;
}

export interface LibraryOptions {
	/** How often the account and the hook marker are checked. */
	readonly pollMs?: number;
	/** How long after start an unseen hook counts as "checking" rather than "warning". */
	readonly graceMs?: number;
	/** First retry delay after the account's tags failed to load; doubles up to `maxRetryMs`. */
	readonly retryMs?: number;
	readonly maxRetryMs?: number;
}

/**
 * Used until the backend's manifest arrives, or if it cannot be read: the
 * library hook as backend/hook_definitions.lua declares it.
 */
const FALLBACK_MANIFEST: HookManifest = {
	version: 1,
	expected: [{ id: VISIBILITY_HOOK_ID, description: '', runs: 'startup', file: '', find: '' }],
	rejected: [],
	error: null,
};

export class LibraryError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = 'LibraryError';
	}
}

export class LibraryService {
	private mode: ViewMode = 'hidden';
	private snapshot: TagSnapshot;
	private signal: ReactiveSignal | null = null;
	private account: AccountId | null = null;
	private hookSeen = false;
	private startedAt = 0;
	private started = false;
	private manifest: HookManifest | null = null;
	private opening = false;
	private openFailures = 0;
	private nextOpenAt = 0;
	private loadError: string | null = null;
	private readonly retryMs: number;
	private readonly maxRetryMs: number;
	private timer: unknown = null;
	private readonly listeners = new Set<() => void>();
	private readonly pollMs: number;
	private readonly graceMs: number;
	private lastState: LibraryState;

	constructor(
		private readonly storage: TagStorage,
		private readonly port: LibraryPort,
		private readonly clock: Clock = realClock,
		options: LibraryOptions = {},
	) {
		this.pollMs = options.pollMs ?? 1000;
		this.graceMs = options.graceMs ?? 60_000;
		this.retryMs = options.retryMs ?? 2000;
		this.maxRetryMs = options.maxRetryMs ?? 60_000;
		this.snapshot = storage.snapshot;
		this.lastState = this.computeState();
		storage.subscribe((next) => {
			const before = this.snapshot.tags;
			this.snapshot = next;
			const changed = !sameSet(before, next.tags);
			// "Only tagged" with no tags left would be an empty Library.
			if (changed && this.mode === 'only' && next.tags.size === 0) this.mode = 'hidden';
			if (changed) this.refreshSteam();
			this.emit(changed);
		});
	}

	/** Call once, from the plugin's frontend entry. Safe to call again. */
	start(): void {
		if (this.timer !== null) return;
		this.startedAt = this.clock.now();
		this.started = true;
		this.signal = safely(() => this.port.createSignal(), null);
		void this.loadManifest();
		this.tick();
		this.timer = this.clock.setInterval(() => {
			this.tick();
		}, this.pollMs);
	}

	stop(): void {
		if (this.timer === null) return;
		this.clock.clearInterval(this.timer);
		this.timer = null;
	}

	/**
	 * Called by the patched Steam code for every game, inside Steam's mobx
	 * derivations, so it must be cheap and must never throw.
	 */
	shouldHide(appId: unknown): boolean {
		try {
			// Read first, unconditionally, so every list depends on the signal.
			this.signal?.read();
			if (this.mode === 'all') return false;
			if (this.uiHookProblems().reveal !== null) return false;
			const id = parseAppId(appId);
			if (id === null) return false;
			const tags = this.snapshot.tags;
			if (this.mode === 'only') return this.isReady() && tags.size > 0 && !tags.has(id);
			return tags.has(id);
		} catch {
			return false;
		}
	}

	isTagged(appId: number): boolean {
		const id = parseAppId(appId);
		return id !== null && this.snapshot.tags.has(id);
	}

	isRevealed(): boolean {
		return this.mode !== 'hidden';
	}

	/** On shows every game (mode `all`); off hides tagged games again. */
	setRevealed(on: boolean): void {
		this.setMode(on ? 'all' : 'hidden');
	}

	getMode(): ViewMode {
		return this.mode;
	}

	/**
	 * Switches the view mode. `only` is refused (returns false) until the tags
	 * are loaded and at least one game is tagged, so the Library is never blank.
	 */
	setMode(mode: ViewMode): boolean {
		if (mode === 'only' && !(this.isReady() && this.snapshot.tags.size > 0)) return false;
		if (this.mode === mode) return true;
		this.mode = mode;
		this.refreshSteam();
		this.emit();
		return true;
	}

	tagGames(appIds: readonly number[]): Promise<void> {
		return this.edit(appIds, (ids) => this.storage.add(ids));
	}

	untagGames(appIds: readonly number[]): Promise<void> {
		return this.edit(appIds, (ids) => this.storage.remove(ids));
	}

	getState(): LibraryState {
		return this.lastState;
	}

	/** Every hook's status, for the settings page and the diagnostic report. */
	selfCheck(): SelfCheck {
		const seen = safely(() => this.port.seenHooks(), new Set<string>());
		const graceOver = this.started && this.clock.now() - this.startedAt >= this.graceMs;
		return evaluateSelfCheck(this.manifest ?? FALLBACK_MANIFEST, seen, graceOver);
	}

	/** Called on every state change. Returns an unsubscribe function. */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	private async edit(
		appIds: readonly number[],
		call: (ids: readonly AppId[]) => ReturnType<TagStorage['add']>,
	): Promise<void> {
		const ids: AppId[] = [];
		for (const raw of appIds) {
			const id = parseAppId(raw);
			if (id === null) throw new LibraryError('bad_request', `Not a Steam App ID: ${String(raw)}`);
			ids.push(id);
		}
		if (ids.length === 0) return;
		if (!this.isReady()) throw new LibraryError('not_ready', 'Tags are not loaded yet');
		if (!this.snapshot.writable) {
			throw new LibraryError('read_only', this.snapshot.reason ?? 'Tags cannot be changed right now');
		}
		const result = await call(ids);
		if (!result.ok) throw new LibraryError(result.error, result.message);
	}

	private isReady(): boolean {
		return this.account !== null && this.snapshot.account === this.account && this.snapshot.state !== 'unloaded';
	}

	private tick(): void {
		const account = safely(() => this.port.currentAccount(), null);
		if (account !== null && account !== this.account) {
			const switched = this.account !== null;
			this.account = account;
			// A different account's tags: start hidden again, like a Steam start.
			if (switched && this.mode !== 'hidden') {
				this.mode = 'hidden';
				this.refreshSteam();
			}
			this.openFailures = 0;
			this.nextOpenAt = 0;
			this.loadError = null;
		}
		if (this.account !== null && !this.isReady() && !this.opening && this.clock.now() >= this.nextOpenAt) {
			void this.openAccount(this.account);
		}
		if (!this.hookSeen) {
			this.hookSeen = safely(() => this.port.seenHooks().has(VISIBILITY_HOOK_ID), false);
		}
		this.emit();
	}

	/**
	 * Opens the account's tag file. While it has not loaded (the call failed or
	 * the reply was unusable), later ticks retry with a doubling delay, and the
	 * state carries a warning: tagged games are visible until it loads.
	 */
	private async openAccount(account: AccountId): Promise<void> {
		this.opening = true;
		let message: string | null = null;
		try {
			const result = await this.storage.open(account);
			if (!result.ok) message = result.message;
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		} finally {
			this.opening = false;
		}
		if (account !== this.account) return;
		if (this.isReady()) {
			this.openFailures = 0;
			this.loadError = null;
		} else {
			this.openFailures += 1;
			const delay = Math.min(this.retryMs * 2 ** (this.openFailures - 1), this.maxRetryMs);
			this.nextOpenAt = this.clock.now() + delay;
			this.loadError = `Tags could not be loaded, so tagged games are visible (${message ?? 'no usable reply'}). Retrying.`;
		}
		this.emit();
	}

	private async loadManifest(): Promise<void> {
		let raw: unknown;
		try {
			raw = await this.port.hookManifest();
			if (typeof raw === 'string') raw = JSON.parse(raw) as unknown;
		} catch {
			return; // keep the fallback
		}
		this.manifest = parseManifest(raw);
		// A broken reveal toggle turns hiding off, so lists must recompute.
		if (this.uiHookProblems().reveal !== null) this.refreshSteam();
		this.emit();
	}

	private refreshSteam(): void {
		// Counts first: the recompute the bump triggers then reads fresh numbers.
		safely(() => this.port.clearCounts(), 0);
		safely(() => {
			this.signal?.bump();
		}, undefined);
	}

	private computeState(): LibraryState {
		const ready = this.isReady();
		const { seamStatus, warning: seamWarning } = this.seamState();
		let warning = this.loadError ?? seamWarning;
		if (warning === null && ready && !this.snapshot.writable) warning = this.snapshot.reason;
		const hasTags = ready && this.snapshot.tags.size > 0;
		return { ready, mode: this.mode, revealed: this.mode !== 'hidden', hasTags, seamStatus, warning };
	}

	/**
	 * Problems with the UI hooks that are known from the backend manifest alone:
	 * rejected by the loader, or not in the hook list. Before the real manifest
	 * has loaded nothing is known, so nothing is reported. An unmatched
	 * on_demand hook stays "not-seen" and cannot be told apart from "not opened
	 * yet"; the settings page keeps a reveal switch for that case.
	 */
	private uiHookProblems(): { reveal: string | null; menu: string | null } {
		const manifest = this.manifest;
		if (manifest === null) return { reveal: null, menu: null };
		const problem = (id: string): string | null => {
			const rejected = manifest.rejected.find((r) => r.id === id);
			if (rejected !== undefined) return `rejected (${rejected.reason || 'invalid definition'})`;
			if (!manifest.expected.some((h) => h.id === id)) return manifest.error ?? 'not in the plugin\'s hook list';
			return null;
		};
		return { reveal: problem(REVEAL_HOOK_ID), menu: problem(MENU_HOOK_ID) };
	}

	/** Hook state for the toggle: the library hook first, then the UI hooks. */
	private seamState(): { seamStatus: SeamStatus; warning: string | null } {
		const library = this.librarySeamState();
		if (library.seamStatus === 'warning') return library;
		const ui = this.uiHookProblems();
		if (ui.reveal !== null) {
			return {
				seamStatus: 'warning',
				warning: `The show/hide toggle hook is off (${ui.reveal}), so tagged games are visible.`,
			};
		}
		if (ui.menu !== null) {
			return {
				seamStatus: 'warning',
				warning: `The right-click menu hook is off (${ui.menu}), so games cannot be marked from the menu. Your tags are unchanged.`,
			};
		}
		return library;
	}

	/** The library hook's state, from the backend manifest and the marker (services/hookStatus.ts). */
	private librarySeamState(): { seamStatus: SeamStatus; warning: string | null } {
		const manifest = this.manifest ?? FALLBACK_MANIFEST;
		const seen = this.hookSeen ? new Set([VISIBILITY_HOOK_ID]) : new Set<string>();
		const graceOver = this.started && this.clock.now() - this.startedAt >= this.graceMs;
		const check = evaluateSelfCheck(manifest, seen, graceOver);
		const hook = check.hooks.find((h) => h.id === VISIBILITY_HOOK_ID);
		if (hook === undefined) {
			const why = check.loadError ?? 'it is not in the plugin\'s hook list';
			return { seamStatus: 'warning', warning: `The Library hook is off (${why}). Tagged games are visible.` };
		}
		switch (hook.state) {
			case 'attached':
				if (this.signal === null && this.started) {
					return {
						seamStatus: 'warning',
						warning: 'Hiding works, but the Library refreshes only after a Steam restart.',
					};
				}
				return { seamStatus: 'ok', warning: null };
			case 'rejected':
				return {
					seamStatus: 'warning',
					warning: `The Library hook was rejected (${hook.reason ?? 'invalid definition'}). Tagged games are visible.`,
				};
			case 'missing':
				return { seamStatus: 'warning', warning: 'The Library hook did not attach. Tagged games are visible.' };
			case 'checking':
			case 'not-seen':
				return { seamStatus: 'checking', warning: null };
		}
	}

	/** Notifies listeners when the state changed, or always when `force` (the tag set changed). */
	private emit(force = false): void {
		const next = this.computeState();
		const prev = this.lastState;
		this.lastState = next;
		const same =
			prev.ready === next.ready &&
			prev.mode === next.mode &&
			prev.hasTags === next.hasTags &&
			prev.seamStatus === next.seamStatus &&
			prev.warning === next.warning;
		if (same && !force) return;
		for (const listener of this.listeners) {
			try {
				listener();
			} catch {
				// A broken listener must not stop the others.
			}
		}
	}
}

function sameSet(a: ReadonlySet<AppId>, b: ReadonlySet<AppId>): boolean {
	if (a.size !== b.size) return false;
	for (const x of a) if (!b.has(x)) return false;
	return true;
}

function safely<T>(fn: () => T, fallback: T): T {
	try {
		return fn();
	} catch {
		return fallback;
	}
}

// The plugin-wide instance. Set by frontend/index.tsx; UI code uses the
// functions below so it never needs the instance itself.
let instance: LibraryService | null = null;

export function installLibrary(service: LibraryService | null): void {
	instance = service;
}

export function tagGames(appIds: readonly number[]): Promise<void> {
	return instance?.tagGames(appIds) ?? Promise.reject(new LibraryError('not_ready', 'Steam Discreet is not loaded'));
}

export function untagGames(appIds: readonly number[]): Promise<void> {
	return instance?.untagGames(appIds) ?? Promise.reject(new LibraryError('not_ready', 'Steam Discreet is not loaded'));
}

export function isTagged(appId: number): boolean {
	return instance?.isTagged(appId) ?? false;
}

export function setRevealed(on: boolean): void {
	instance?.setRevealed(on);
}

export function isRevealed(): boolean {
	return instance?.isRevealed() ?? false;
}

export function setMode(mode: ViewMode): boolean {
	return instance?.setMode(mode) ?? false;
}

const NOT_LOADED: LibraryState = {
	ready: false,
	mode: 'hidden',
	revealed: false,
	hasTags: false,
	seamStatus: 'checking',
	warning: null,
};

export function getState(): LibraryState {
	return instance?.getState() ?? NOT_LOADED;
}

export function subscribe(listener: () => void): () => void {
	return instance?.subscribe(listener) ?? (() => undefined);
}
