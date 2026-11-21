import type { AccountId } from '../domain/accountId';
import { parseAppId, type AppId } from '../domain/appId';
import type { ReactiveSignal } from '../integrations/steam/reactiveSignal';
import { evaluateSelfCheck, type HookManifest, parseManifest } from './hookStatus';
import type { TagSnapshot, TagStorage } from './tagStorage';

/**
 * Library hiding (M3): the session's reveal toggle, the active account's tag
 * set, and the hide check the patched Steam code calls.
 *
 * - The patched `collectionStore.BIsVisible` (hook `library-visibility` in
 *   backend/hook_definitions.lua) asks `shouldHide(appid)` for every game.
 * - The toggle is a module-level flag. It is never saved, so it is off after
 *   every Steam start, UI reload or plugin reload.
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

export interface LibraryState {
	/** The active account's tags are loaded. */
	readonly ready: boolean;
	readonly revealed: boolean;
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
	private revealed = false;
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
			if (this.revealed) return false;
			const id = parseAppId(appId);
			return id !== null && this.snapshot.tags.has(id);
		} catch {
			return false;
		}
	}

	isTagged(appId: number): boolean {
		const id = parseAppId(appId);
		return id !== null && this.snapshot.tags.has(id);
	}

	isRevealed(): boolean {
		return this.revealed;
	}

	setRevealed(on: boolean): void {
		if (this.revealed === on) return;
		this.revealed = on;
		this.refreshSteam();
		this.emit();
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
			this.account = account;
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
		return { ready, revealed: this.revealed, seamStatus, warning };
	}

	/** The library hook's state, from the backend manifest and the marker (services/hookStatus.ts). */
	private seamState(): { seamStatus: SeamStatus; warning: string | null } {
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
			prev.revealed === next.revealed &&
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

const NOT_LOADED: LibraryState = { ready: false, revealed: false, seamStatus: 'checking', warning: null };

export function getState(): LibraryState {
	return instance?.getState() ?? NOT_LOADED;
}

export function subscribe(listener: () => void): () => void {
	return instance?.subscribe(listener) ?? (() => undefined);
}
