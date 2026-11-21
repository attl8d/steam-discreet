import { describe, expect, test } from 'bun:test';
import { type AccountId, parseAccountId } from '../../frontend/domain/accountId';
import type { AppId } from '../../frontend/domain/appId';
import { type Clock, type LibraryPort, LibraryService, MENU_HOOK_ID, REVEAL_HOOK_ID, VISIBILITY_HOOK_ID } from '../../frontend/services/library';
import { type SettingsBackend, SettingsService } from '../../frontend/services/settings';
import { TagStorage, type TagStorageRpc } from '../../frontend/services/tagStorage';

const ACCOUNT = parseAccountId('76561198000000001') as AccountId;

/** In-memory backend with the reply shape of backend/tagstore/rpc.lua. */
class TagBackend implements TagStorageRpc {
	readonly tags = new Set<number>();
	readonly calls: string[] = [];
	state = 'ok';
	failWrites = false;
	private reply(name: string, change: () => void, extra: Record<string, unknown> = {}): Promise<unknown> {
		this.calls.push(name);
		const base = () => ({
			state: this.state,
			writable: this.state === 'ok',
			ids: [...this.tags].sort((a, b) => a - b).join(','),
			...(this.state === 'ok' ? {} : { reason: 'The tag file was written by a newer version.' }),
		});
		if (this.failWrites && name !== 'open') return Promise.resolve({ ok: false, error: 'write_failed', message: 'disk full', ...base() });
		change();
		return Promise.resolve({ ok: true, ...base(), ...extra });
	}
	open() {
		return this.reply('open', () => undefined);
	}
	add(_: string, ids: string) {
		return this.reply(`add:${ids}`, () => {
			for (const x of ids.split(',')) this.tags.add(Number(x));
		});
	}
	remove(_: string, ids: string) {
		return this.reply(`remove:${ids}`, () => {
			for (const x of ids.split(',')) this.tags.delete(Number(x));
		});
	}
	clear() {
		return this.reply('clear', () => {
			this.tags.clear();
		});
	}
	failExport = false;
	exportText() {
		if (this.failExport) return Promise.resolve({ ok: false, error: 'unreadable', message: 'cannot read', state: 'ok', writable: true, ids: '' });
		return this.reply('export', () => undefined, { text: [...this.tags].sort((a, b) => a - b).join('\n') });
	}
	importText(_: string, text: string, mode: string) {
		return this.reply(`import:${mode}`, () => {
			if (mode === 'replace') this.tags.clear();
			for (const x of text.split(/[\s,]+/).filter((s) => /^\d+$/.test(s))) this.tags.add(Number(x));
		});
	}
}

class FakeClock implements Clock {
	t = 0;
	fn: (() => void) | null = null;
	now() {
		return this.t;
	}
	setInterval(fn: () => void) {
		this.fn = fn;
		return 1;
	}
	clearInterval() {
		this.fn = null;
	}
	advance(ms: number) {
		this.t += ms;
		this.fn?.();
	}
}

class FakePort implements LibraryPort {
	seen = new Set<string>();
	currentAccount() {
		return ACCOUNT;
	}
	createSignal() {
		return { read: () => undefined, bump: () => undefined };
	}
	clearCounts() {
		return 0;
	}
	seenHooks() {
		return this.seen;
	}
	hookManifest(): Promise<unknown> {
		return Promise.resolve(
			JSON.stringify({
				version: 1,
				expected: [
					{ id: VISIBILITY_HOOK_ID, description: 'd', runs: 'startup', file: 'sp\\.js', find: 'BIsVisible\\(' },
					{ id: MENU_HOOK_ID, description: 'd', runs: 'on_demand', file: 'sp\\.js', find: 'GetTargetApps' },
					{ id: REVEAL_HOOK_ID, description: 'd', runs: 'on_demand', file: 'sp\\.js', find: 'ViewFiltersBar' },
				],
				rejected: [{ id: 'broken-hook', reason: 'find pattern is required' }],
			}),
		);
	}
}

class FakeSettingsBackend implements SettingsBackend {
	status: unknown = JSON.stringify({
		current_version: '0.2.0',
		source: 'attl8d/steam-discreet',
		last_check_at: 1_763_700_000,
		last_result: 'error',
		last_error: 'release lookup failed: timeout reading C:\\Users\\daczo\\AppData\\x',
		previous_version: '0.1.0',
	});
	rollbackReply: unknown = JSON.stringify({ result: 'rollback_staged', to: '0.1.0' });
	env: unknown = JSON.stringify({ plugin_version: '0.2.0', millennium_version: 'v3.6.3', os: 'Windows', arch: 'x64' });
	rollbacks = 0;
	redactReply: unknown = undefined;
	redact(text: string) {
		if (this.redactReply instanceof Error) return Promise.reject(this.redactReply);
		return Promise.resolve(this.redactReply ?? text.split('daczo').join('<user>'));
	}
	previewImport(text: string) {
		const ids = new Set(text.split(/[\s,]+/).filter((x) => x !== ''));
		for (const x of ids) if (!/^\d+$/.test(x)) return Promise.resolve({ ok: false, error: 'import_invalid', message: `not an App ID: ${x}` });
		return Promise.resolve({ ok: true, count: ids.size });
	}
	updateStatus() {
		return Promise.resolve(this.status);
	}
	rollback() {
		this.rollbacks += 1;
		return Promise.resolve(this.rollbackReply);
	}
	environment() {
		return this.env instanceof Error ? Promise.reject(this.env) : Promise.resolve(this.env);
	}
}

const NAMES: Record<number, string> = { 570: 'Dota 2', 730: 'Counter-Strike 2', 440: 'Team Fortress 2' };
const flush = () => new Promise((r) => setTimeout(r, 0));

async function setup(initial: number[] = []) {
	const tags = new TagBackend();
	for (const t of initial) tags.tags.add(t);
	const port = new FakePort();
	const clock = new FakeClock();
	const storage = new TagStorage(tags);
	const library = new LibraryService(storage, port, clock, { graceMs: 10_000 });
	const backend = new FakeSettingsBackend();
	const settings = new SettingsService(
		storage,
		library,
		backend,
		{ steamBuild: () => '1794536281', appName: (id: AppId) => NAMES[id] ?? null },
		() => new Date('2026-11-21T12:00:00Z'),
	);
	library.start();
	await flush();
	return { tags, port, clock, library, settings, backend };
}

describe('tag list', () => {
	test('lists tagged games by name, unknown ones last, and searches by name or App ID', async () => {
		const { settings } = await setup([730, 999999, 570]);
		expect(settings.rows('').map((r) => r.name)).toEqual(['Counter-Strike 2', 'Dota 2', null]);
		expect(settings.rows('dota').map((r) => r.appId)).toEqual([570 as AppId]);
		expect(settings.rows('9999').map((r) => r.appId)).toEqual([999999 as AppId]);
		expect(settings.rows('nothing')).toEqual([]);
	});

	test('removing one game untags only that game and updates the view', async () => {
		const { settings, tags } = await setup([570, 730]);
		let notified = 0;
		settings.subscribe(() => (notified += 1));
		const result = await settings.removeTag(570 as AppId);
		expect(result).toEqual({ ok: true, message: 'Removed Dota 2.' });
		expect([...tags.tags]).toEqual([730]);
		expect([...settings.getView().tags.tags]).toEqual([730 as AppId]);
		expect(notified).toBeGreaterThan(0);
	});

	test('a failed save is reported and the game stays tagged', async () => {
		const { settings, tags } = await setup([570]);
		tags.failWrites = true;
		const result = await settings.removeTag(570 as AppId);
		expect(result.ok).toBe(false);
		expect(result.message).toContain('disk full');
		expect(settings.getView().tags.tags.has(570 as AppId)).toBe(true);
	});

	test('clear all saves the list first, removes every tag, and Undo restores the exact list', async () => {
		const { settings, tags } = await setup([570, 730, 440]);
		const result = await settings.clearAll();
		expect(result.ok).toBe(true);
		expect(tags.tags.size).toBe(0);
		expect(tags.calls.slice(1, 3)).toEqual(['export', 'clear']);
		expect(settings.getView().undo).toMatchObject({ count: 3, action: 'clear' });
		const undone = await settings.undoLast();
		expect(undone).toEqual({ ok: true, message: 'Restored. 3 games tagged.' });
		expect([...tags.tags].sort((a, b) => a - b)).toEqual([440, 570, 730]);
		expect(settings.getView().undo).toBeNull();
	});

	test('clear all is refused when the current list cannot be exported first', async () => {
		const { settings, tags } = await setup([570]);
		tags.failExport = true;
		const result = await settings.clearAll();
		expect(result.ok).toBe(false);
		expect(result.message).toContain('could not be saved first');
		expect([...tags.tags]).toEqual([570]);
		expect(tags.calls).not.toContain('clear');
		expect(settings.getView().undo).toBeNull();
	});

	test('a failed undo keeps the saved list', async () => {
		const { settings, tags } = await setup([570]);
		await settings.clearAll();
		tags.failWrites = true;
		expect((await settings.undoLast()).ok).toBe(false);
		expect(settings.getView().undo?.text).toBe('570');
	});

	test('nothing is changed while the store is read-only', async () => {
		const tagsBackend = new TagBackend();
		tagsBackend.state = 'newer';
		tagsBackend.tags.add(570);
		const storage = new TagStorage(tagsBackend);
		const library = new LibraryService(storage, new FakePort(), new FakeClock());
		const settings = new SettingsService(storage, library, new FakeSettingsBackend(), {
			steamBuild: () => null,
			appName: () => null,
		});
		library.start();
		await flush();
		const cleared = await settings.clearAll();
		expect(cleared).toEqual({ ok: false, message: 'The tag file was written by a newer version.' });
		const imported = await settings.importText('730', 'merge');
		expect(imported.ok).toBe(false);
		expect(tagsBackend.calls).toEqual(['open']);
	});
});

describe('export and import', () => {
	test('export returns the backend text', async () => {
		const { settings } = await setup([570]);
		expect(await settings.exportText()).toEqual({ ok: true, text: '570' });
	});

	test('merge adds to the list and says how many were added', async () => {
		const { settings, tags } = await setup([570]);
		const result = await settings.importText('570\n730\n440', 'merge');
		expect(result).toEqual({ ok: true, message: 'Imported. 2 games added; 3 games tagged in total.' });
		expect(tags.calls).toContain('import:merge');
	});

	test('replace saves the list first, swaps it, and Undo restores it', async () => {
		const { settings, tags } = await setup([570, 730]);
		const result = await settings.importText('440', 'replace');
		expect(result).toEqual({ ok: true, message: 'Replaced. 1 game tagged now. Undo puts the previous list back.' });
		expect([...tags.tags]).toEqual([440]);
		expect(settings.getView().undo).toMatchObject({ count: 2, action: 'replace' });
		await settings.undoLast();
		expect([...tags.tags].sort((a, b) => a - b)).toEqual([570, 730]);
	});

	test('replace is refused when the current list cannot be exported first', async () => {
		const { settings, tags } = await setup([570]);
		tags.failExport = true;
		expect((await settings.importText('440', 'replace')).ok).toBe(false);
		expect([...tags.tags]).toEqual([570]);
	});

	test('merge needs no backup and offers no undo', async () => {
		const { settings, tags } = await setup([570]);
		tags.failExport = true;
		expect((await settings.importText('730', 'merge')).ok).toBe(true);
		expect(settings.getView().undo).toBeNull();
	});

	test('preview counts the pasted App IDs without saving', async () => {
		const { settings, tags } = await setup([570]);
		expect(await settings.previewImport('1, 2\n3')).toEqual({ ok: true, count: 3 });
		expect(await settings.previewImport('1 x')).toEqual({ ok: false, message: 'not an App ID: x' });
		expect(tags.calls).toEqual(['open']);
	});

	test('an empty paste is refused before reaching the backend', async () => {
		const { settings, tags } = await setup([570]);
		expect((await settings.importText('   ', 'replace')).ok).toBe(false);
		expect(tags.calls).toEqual(['open']);
	});
});

describe('updates', () => {
	test('reads the update status and stages a rollback', async () => {
		const { settings, backend } = await setup();
		const status = await settings.updateStatus();
		expect(status?.currentVersion).toBe('0.2.0');
		expect(status?.previousVersion).toBe('0.1.0');
		expect(await settings.rollback()).toEqual({ ok: true, to: '0.1.0' });
		expect(backend.rollbacks).toBe(1);
	});

	test('a refused rollback carries the backend reason', async () => {
		const { settings, backend } = await setup();
		backend.rollbackReply = JSON.stringify({ result: 'error', detail: 'no previous version to roll back to' });
		expect(await settings.rollback()).toEqual({ ok: false, message: 'no previous version to roll back to' });
	});

	test('a status the backend could not produce is null, not a throw', async () => {
		const { settings, backend } = await setup();
		backend.status = null;
		expect(await settings.updateStatus()).toBeNull();
	});
});

describe('diagnostic report', () => {
	test('has versions, every hook, what failed hooks look for, and update errors', async () => {
		const { settings, port, clock } = await setup([570, 730]);
		port.seen.add(VISIBILITY_HOOK_ID);
		clock.advance(11_000);
		const report = await settings.diagnosticReport();
		expect(report).toContain('Generated: 2026-11-21T12:00:00.000Z');
		expect(report).toContain('- Plugin: 0.2.0');
		expect(report).toContain('- Millennium: v3.6.3');
		expect(report).toContain('- Steam client build: 1794536281');
		expect(report).toContain('- OS: Windows (x64)');
		expect(report).toContain(`- ${VISIBILITY_HOOK_ID}: attached`);
		expect(report).toContain(`- ${MENU_HOOK_ID}: not seen yet`);
		expect(report).toContain('Looking for code: `GetTargetApps`');
		expect(report).toContain('- broken-hook: REJECTED');
		expect(report).toContain('Reason: find pattern is required');
		expect(report).toContain('- Last check error: release lookup failed: timeout reading C:\\Users\\<user>\\AppData\\x');
		expect(report).toContain('- Previous version kept for rollback: 0.1.0');
		expect(report).toContain('- Tag storage: ok, writable');
	});

	test('never contains game names, App IDs or the account', async () => {
		const { settings } = await setup([570, 730]);
		const report = await settings.diagnosticReport();
		for (const secret of ['Dota', 'Counter-Strike', '570', '730', ACCOUNT]) {
			expect(report).not.toContain(secret);
		}
	});

	test('a startup hook not seen after the grace period is MISSING with its pattern', async () => {
		const { settings, clock } = await setup();
		clock.advance(11_000);
		const report = await settings.diagnosticReport();
		expect(report).toContain(`- ${VISIBILITY_HOOK_ID}: MISSING`);
		expect(report).toContain('Looking for code: `BIsVisible\\(`');
		expect(settings.selfCheck().overall).toBe('warning');
	});

	test('the backend redaction pass runs on the report, and a failing one keeps the cleaned text', async () => {
		const { settings, backend } = await setup();
		backend.status = JSON.stringify({ current_version: '0.2.0', last_error: 'open D:\\Profiles\\daczo\\x failed' });
		expect(await settings.diagnosticReport()).toContain('D:\\Profiles\\<user>\\x');
		backend.redactReply = new Error('gone');
		expect(await settings.diagnosticReport()).toContain('Last check error');
	});

	test('the signed-in account is removed by value, also as a 32-bit account ID', async () => {
		const { settings, backend } = await setup();
		backend.status = JSON.stringify({ current_version: '0.2.0', last_error: `ids ${ACCOUNT} 39734273 [U:1:39734273]` });
		const report = await settings.diagnosticReport();
		expect(report).toContain('ids <steamid> <accountid> <steamid>');
	});

	test('still builds when the backend does not answer', async () => {
		const { settings, backend } = await setup();
		backend.env = new Error('backend gone');
		backend.status = 'not json';
		const report = await settings.diagnosticReport();
		expect(report).toContain('- Plugin: unknown');
		expect(report).toContain('Updater status unavailable');
	});
});
