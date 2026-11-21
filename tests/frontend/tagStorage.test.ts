import { describe, expect, test } from 'bun:test';
import { type AccountId, parseAccountId } from '../../frontend/domain/accountId';
import type { AppId } from '../../frontend/domain/appId';
import { type ImportMode, TagStorage, type TagStorageRpc } from '../../frontend/services/tagStorage';

const A = parseAccountId('76561198000000001') as AccountId;
const B = parseAccountId('76561198000000002') as AccountId;
const ids = (...n: number[]) => n as AppId[];
const tagsOf = (storage: TagStorage) => [...storage.snapshot.tags].sort((a, b) => a - b);

/**
 * In-memory stand-in for backend/tagstore/rpc.lua with the same reply shape.
 * The Lua side is tested against real files in tests/lua/tagstore_spec.lua.
 */
class FakeBackend implements TagStorageRpc {
	readonly accounts = new Map<string, Set<number>>();
	readonly calls: string[] = [];
	failNext: Record<string, unknown> | null = null;
	throwNext: Error | null = null;
	replyNext: unknown = undefined;
	delays: number[] = [];
	state = 'ok';

	private async reply(name: string, account: string, apply: (set: Set<number>) => void, extra = {}): Promise<unknown> {
		this.calls.push(name);
		const delay = this.delays.shift() ?? 0;
		if (delay > 0) await new Promise((r) => setTimeout(r, delay));
		if (this.throwNext) {
			const e = this.throwNext;
			this.throwNext = null;
			throw e;
		}
		if (this.replyNext !== undefined) {
			const r = this.replyNext;
			this.replyNext = undefined;
			return r;
		}
		const set = this.accounts.get(account) ?? new Set<number>();
		this.accounts.set(account, set);
		const base = () => ({
			state: this.state,
			writable: this.state === 'ok' || this.state === 'recovered',
			ids: [...set].sort((a, b) => a - b).join(','),
			count: set.size,
		});
		if (this.failNext) {
			const f = this.failNext;
			this.failNext = null;
			return { ok: false, ...base(), ...f };
		}
		apply(set);
		return { ok: true, ...base(), ...extra };
	}

	open(account: string) {
		return this.reply('open', account, () => undefined);
	}
	add(account: string, list: string) {
		return this.reply(`add:${list}`, account, (s) => {
			for (const x of list.split(',')) s.add(Number(x));
		});
	}
	remove(account: string, list: string) {
		return this.reply(`remove:${list}`, account, (s) => {
			for (const x of list.split(',')) s.delete(Number(x));
		});
	}
	clear(account: string) {
		return this.reply('clear', account, (s) => {
			s.clear();
		});
	}
	exportText(account: string) {
		const set = this.accounts.get(account) ?? new Set();
		return this.reply('export', account, () => undefined, { text: `ids:${[...set].join(',')}` });
	}
	importText(account: string, text: string, mode: ImportMode) {
		return this.reply(`import:${mode}`, account, (s) => {
			if (mode === 'replace') s.clear();
			for (const x of text.split(',')) s.add(Number(x));
		});
	}
}

async function opened(backend = new FakeBackend(), account = A) {
	const storage = new TagStorage(backend);
	await storage.open(account);
	return { storage, backend };
}

describe('TagStorage', () => {
	test('refuses edits before an account is open', async () => {
		const storage = new TagStorage(new FakeBackend());
		const r = await storage.add(ids(730));
		expect(r.ok).toBe(false);
		expect(r.ok ? null : r.error).toBe('not_open');
		expect(storage.snapshot.state).toBe('unloaded');
	});

	test('adds, deduplicates and removes', async () => {
		const { storage, backend } = await opened();
		await storage.add(ids(730, 570, 730));
		expect(backend.calls).toContain('add:570,730');
		expect(tagsOf(storage)).toEqual(ids(570, 730));
		await storage.remove(ids(570));
		expect(tagsOf(storage)).toEqual(ids(730));
		expect(storage.isTagged(730 as AppId)).toBe(true);
		expect(storage.isTagged(570 as AppId)).toBe(false);
	});

	test('keeps IDs regardless of whether the game is in the library', async () => {
		const { storage } = await opened();
		await storage.add(ids(4294967295));
		expect(tagsOf(storage)).toEqual(ids(4294967295));
	});

	test('a failed save is reported and the tag is not shown as saved', async () => {
		const { storage, backend } = await opened();
		await storage.add(ids(1));
		backend.failNext = { error: 'write_failed', message: 'Could not save the tag list: disk full' };
		const r = await storage.add(ids(2));
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.error).toBe('write_failed');
			expect(r.message).toContain('disk full');
		}
		expect(tagsOf(storage)).toEqual(ids(1));
	});

	test('a backend that throws or replies garbage changes nothing', async () => {
		const { storage, backend } = await opened();
		await storage.add(ids(1));
		const seen: unknown[] = [];
		storage.subscribe((s) => seen.push(s));

		backend.throwNext = new Error('ipc closed');
		const thrown = await storage.add(ids(2));
		expect(thrown.ok ? null : thrown.error).toBe('rpc_failed');

		for (const reply of [null, 'yes', { ok: true }, { ok: true, state: 'ok', writable: true, ids: '1,x' }, { ok: 1 }]) {
			backend.replyNext = reply;
			const r = await storage.add(ids(2));
			expect(r.ok ? null : r.error).toBe('bad_response');
		}
		expect(tagsOf(storage)).toEqual(ids(1));
		expect(seen).toEqual([]);
	});

	test('serialises calls so a rapid add then remove lands in order', async () => {
		const { storage, backend } = await opened();
		backend.delays = [30, 0];
		const add = storage.add(ids(730));
		const remove = storage.remove(ids(730));
		await Promise.all([add, remove]);
		expect(backend.calls.slice(-2)).toEqual(['add:730', 'remove:730']);
		expect(tagsOf(storage)).toEqual([]);
		expect([...(backend.accounts.get(A) ?? [])]).toEqual([]);
	});

	test('a failure does not break the queue for later calls', async () => {
		const { storage, backend } = await opened();
		backend.throwNext = new Error('boom');
		const first = storage.add(ids(1));
		const second = storage.add(ids(2));
		expect((await first).ok).toBe(false);
		expect((await second).ok).toBe(true);
		expect(tagsOf(storage)).toEqual(ids(2));
	});

	test('exposes read-only states and the reason', async () => {
		const backend = new FakeBackend();
		backend.state = 'newer';
		backend.replyNext = {
			ok: true,
			state: 'newer',
			writable: false,
			ids: '',
			count: 0,
			reason: 'written by a newer version',
		};
		const { storage } = await opened(backend);
		expect(storage.snapshot.state).toBe('newer');
		expect(storage.snapshot.writable).toBe(false);
		expect(storage.snapshot.reason).toBe('written by a newer version');
	});

	test('passes a recovery notice on once', async () => {
		const backend = new FakeBackend();
		backend.replyNext = { ok: true, state: 'ok', writable: true, ids: '5', count: 1, notice: 'restored from a backup' };
		const { storage } = await opened(backend);
		expect(tagsOf(storage)).toEqual(ids(5));
		expect(storage.takeNotice()).toBe('restored from a backup');
		expect(storage.takeNotice()).toBeNull();
	});

	test('keeps accounts separate and ignores replies for a previous account', async () => {
		const backend = new FakeBackend();
		const storage = new TagStorage(backend);
		await storage.open(A);
		await storage.add(ids(1));
		backend.delays = [20];
		const pending = storage.add(ids(2)); // queued for A
		const switched = storage.open(B);
		await Promise.all([pending, switched]);
		expect(storage.snapshot.account).toBe(B);
		expect(tagsOf(storage)).toEqual([]);
		await storage.add(ids(3));
		expect([...(backend.accounts.get(A) ?? [])].sort()).toEqual([1, 2]);
		expect([...(backend.accounts.get(B) ?? [])]).toEqual([3]);
	});

	test('exports and imports through the backend', async () => {
		const { storage } = await opened();
		await storage.add(ids(1, 2));
		const exported = await storage.exportText();
		expect(exported).toEqual({ ok: true, text: 'ids:1,2' });
		await storage.importText('3', 'merge');
		expect(tagsOf(storage)).toEqual(ids(1, 2, 3));
		await storage.importText('9', 'replace');
		expect(tagsOf(storage)).toEqual(ids(9));
	});

	test('notifies subscribers and stops after unsubscribe', async () => {
		const { storage } = await opened();
		const sizes: number[] = [];
		const off = storage.subscribe((s) => sizes.push(s.tags.size));
		await storage.add(ids(1));
		off();
		await storage.add(ids(2));
		expect(sizes).toEqual([1]);
	});
});
