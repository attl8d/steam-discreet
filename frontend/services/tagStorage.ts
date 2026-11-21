import type { AccountId } from '../domain/accountId';
import type { AppId } from '../domain/appId';
import { decodeAppIdList, encodeAppIdList } from '../domain/appIdList';

/**
 * Storage bridge to the Lua tag store (backend/tagstore/).
 *
 * - Every change is confirmed by the backend before the in-memory set changes,
 *   so a failed save is reported and never shown as saved.
 * - Calls run one at a time in the order they were made, so a rapid add then
 *   remove cannot land out of order.
 * - IDs are stored as given. Nothing here consults the library, so a game that
 *   is temporarily missing from Steam's metadata keeps its tag.
 * - Only App IDs are sent. Visibility (the reveal toggle) is not part of this
 *   module and never reaches disk.
 */

export type StorageState = 'unloaded' | 'ok' | 'recovered' | 'newer' | 'unreadable' | 'unavailable';

export interface TagSnapshot {
	readonly account: AccountId | null;
	readonly state: StorageState;
	/** False when the backend refuses edits (newer or unreadable file, no storage folder). */
	readonly writable: boolean;
	readonly tags: ReadonlySet<AppId>;
	/** Why the store is not writable, in words for the user. */
	readonly reason: string | null;
}

export type StorageErrorCode =
	| 'not_open'
	| 'rpc_failed'
	| 'bad_response'
	| 'bad_account'
	| 'bad_request'
	| 'unavailable'
	| 'newer'
	| 'unreadable'
	| 'write_failed'
	| 'import_invalid'
	| 'import_newer'
	| 'import_empty'
	| 'internal'
	| 'unknown';

export type StorageResult =
	| { readonly ok: true; readonly snapshot: TagSnapshot; readonly warning: string | null }
	| { readonly ok: false; readonly error: StorageErrorCode; readonly message: string; readonly snapshot: TagSnapshot };

export type ExportResult =
	| { readonly ok: true; readonly text: string }
	| { readonly ok: false; readonly error: StorageErrorCode; readonly message: string };

export type ImportMode = 'merge' | 'replace';

/** The backend functions in backend/tagstore/rpc.lua. Results are untrusted. */
export interface TagStorageRpc {
	open(account: string): Promise<unknown>;
	add(account: string, ids: string): Promise<unknown>;
	remove(account: string, ids: string): Promise<unknown>;
	clear(account: string): Promise<unknown>;
	exportText(account: string): Promise<unknown>;
	importText(account: string, text: string, mode: ImportMode): Promise<unknown>;
}

/** The real backend, through Millennium's generated `backend` FFI object. */
export function millenniumTagRpc(): TagStorageRpc {
	return {
		open: (account) => backend.tags_open(account),
		add: (account, ids) => backend.tags_add(account, ids),
		remove: (account, ids) => backend.tags_remove(account, ids),
		clear: (account) => backend.tags_clear(account),
		exportText: (account) => backend.tags_export(account),
		importText: (account, text, mode) => backend.tags_import(account, text, mode),
	};
}

const STATES: readonly StorageState[] = ['ok', 'recovered', 'newer', 'unreadable', 'unavailable'];
const ERROR_CODES: readonly StorageErrorCode[] = [
	'bad_account',
	'bad_request',
	'unavailable',
	'newer',
	'unreadable',
	'write_failed',
	'import_invalid',
	'import_newer',
	'import_empty',
	'internal',
];

const EMPTY: TagSnapshot = { account: null, state: 'unloaded', writable: false, tags: new Set(), reason: null };

interface ParsedResponse {
	readonly ok: boolean;
	readonly error: StorageErrorCode;
	readonly message: string;
	/** Present when the response carried a valid store state. */
	readonly store: { state: StorageState; writable: boolean; tags: AppId[]; reason: string | null } | null;
	readonly notice: string | null;
	readonly warning: string | null;
	readonly text: string | null;
}

function field(obj: object, key: string): unknown {
	return (obj as Record<string, unknown>)[key];
}

function optionalString(value: unknown): string | null {
	return typeof value === 'string' && value !== '' ? value : null;
}

function parseResponse(raw: unknown): ParsedResponse | null {
	if (typeof raw !== 'object' || raw === null) return null;
	const ok = field(raw, 'ok');
	if (typeof ok !== 'boolean') return null;

	let store: ParsedResponse['store'] = null;
	const state = field(raw, 'state');
	if (typeof state === 'string' && (STATES as readonly string[]).includes(state)) {
		const tags = decodeAppIdList(field(raw, 'ids'));
		const writable = field(raw, 'writable');
		if (tags === null || typeof writable !== 'boolean') return null;
		store = { state: state as StorageState, writable, tags, reason: optionalString(field(raw, 'reason')) };
	} else if (ok) {
		return null; // a success must carry the resulting state
	}

	const error = field(raw, 'error');
	return {
		ok,
		error:
			typeof error === 'string' && (ERROR_CODES as readonly string[]).includes(error)
				? (error as StorageErrorCode)
				: 'unknown',
		message: optionalString(field(raw, 'message')) ?? 'Tag storage failed',
		store,
		notice: optionalString(field(raw, 'notice')),
		warning: optionalString(field(raw, 'warning')),
		text: typeof field(raw, 'text') === 'string' ? (field(raw, 'text') as string) : null,
	};
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class TagStorage {
	private current: TagSnapshot = EMPTY;
	private queue: Promise<unknown> = Promise.resolve();
	private readonly listeners = new Set<(snapshot: TagSnapshot) => void>();
	private pendingNotice: string | null = null;

	constructor(private readonly rpc: TagStorageRpc) {}

	get snapshot(): TagSnapshot {
		return this.current;
	}

	isTagged(id: AppId): boolean {
		return this.current.tags.has(id);
	}

	/** Called with every new snapshot. Returns an unsubscribe function. */
	subscribe(listener: (snapshot: TagSnapshot) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** A one-time message for the user, e.g. "restored from a backup". Returns null once taken. */
	takeNotice(): string | null {
		const notice = this.pendingNotice;
		this.pendingNotice = null;
		return notice;
	}

	/** Load an account's tags. Switching account replaces the whole snapshot. */
	open(account: AccountId): Promise<StorageResult> {
		return this.enqueue(async () => {
			if (this.current.account !== account) {
				this.publish({ ...EMPTY, account });
			}
			return this.handle(account, () => this.rpc.open(account));
		});
	}

	add(ids: readonly AppId[]): Promise<StorageResult> {
		return this.edit((account) => this.rpc.add(account, encodeAppIdList(ids)));
	}

	remove(ids: readonly AppId[]): Promise<StorageResult> {
		return this.edit((account) => this.rpc.remove(account, encodeAppIdList(ids)));
	}

	clear(): Promise<StorageResult> {
		return this.edit((account) => this.rpc.clear(account));
	}

	importText(text: string, mode: ImportMode): Promise<StorageResult> {
		return this.edit((account) => this.rpc.importText(account, text, mode));
	}

	exportText(): Promise<ExportResult> {
		return this.enqueue(async () => {
			const account = this.current.account;
			if (account === null) return { ok: false, error: 'not_open', message: 'No account is loaded' } as const;
			let raw: unknown;
			try {
				raw = await this.rpc.exportText(account);
			} catch (error) {
				return { ok: false, error: 'rpc_failed', message: describe(error) } as const;
			}
			const parsed = parseResponse(raw);
			if (parsed === null) return { ok: false, error: 'bad_response', message: 'Unexpected reply from tag storage' } as const;
			if (!parsed.ok) return { ok: false, error: parsed.error, message: parsed.message } as const;
			if (parsed.text === null) return { ok: false, error: 'bad_response', message: 'Export returned no text' } as const;
			return { ok: true, text: parsed.text } as const;
		});
	}

	private edit(call: (account: AccountId) => Promise<unknown>): Promise<StorageResult> {
		return this.enqueue(async () => {
			const account = this.current.account;
			if (account === null) return this.fail('not_open', 'No account is loaded');
			return this.handle(account, () => call(account));
		});
	}

	private enqueue<T>(task: () => Promise<T>): Promise<T> {
		const run = this.queue.then(task);
		this.queue = run.catch(() => undefined);
		return run;
	}

	private async handle(account: AccountId, call: () => Promise<unknown>): Promise<StorageResult> {
		let raw: unknown;
		try {
			raw = await call();
		} catch (error) {
			return this.fail('rpc_failed', describe(error));
		}
		const parsed = parseResponse(raw);
		if (parsed === null) return this.fail('bad_response', 'Unexpected reply from tag storage');

		if (parsed.store !== null && this.current.account === account) {
			this.publish({ account, ...parsed.store, tags: new Set(parsed.store.tags) });
		}
		if (parsed.notice !== null) this.pendingNotice = parsed.notice;
		if (!parsed.ok) return this.fail(parsed.error, parsed.message);
		return { ok: true, snapshot: this.current, warning: parsed.warning };
	}

	private fail(error: StorageErrorCode, message: string): StorageResult {
		return { ok: false, error, message, snapshot: this.current };
	}

	private publish(next: TagSnapshot): void {
		this.current = next;
		for (const listener of this.listeners) listener(next);
	}
}
