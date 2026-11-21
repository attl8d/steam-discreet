import { describe, expect, test } from 'bun:test';
import type { AppId } from '../../frontend/domain/appId';
import { tagRows } from '../../frontend/domain/tagList';
import { readAppName, readSteamBuild } from '../../frontend/integrations/steam/clientInfo';
import { copyText } from '../../frontend/integrations/steam/clipboard';
import { canRollBack, compareVersions, parseEnvironment, parseUpdateStatus } from '../../frontend/services/backendInfo';
import {
	type BackupEntry,
	describeEntry,
	importQuestion,
	parseListReply,
	parsePreview,
	parseReadReply,
	parseSaved,
	parseSaveReply,
} from '../../frontend/services/backupFiles';
import { clean } from '../../frontend/services/diagnostics';

describe('readSteamBuild', () => {
	test('reads PACKAGE_CL from the SharedJSContext URL', () => {
		expect(readSteamBuild({ location: { search: '?IN_STEAMUI=1&PACKAGE_CL=1794536281&x=y' } })).toBe('1794536281');
	});
	test('null when missing or not a number', () => {
		for (const root of [{}, { location: {} }, { location: { search: '?PACKAGE_CL=abc' } }, { location: { search: '' } }, null]) {
			expect(readSteamBuild(root)).toBeNull();
		}
	});
});

describe('readAppName', () => {
	const root = {
		appStore: {
			apps: new Map<number, unknown>([
				[570, { display_name: 'Dota 2' }],
				[1, { display_name: '  ' }],
			]),
			GetAppOverviewByAppID(this: { apps: Map<number, unknown> }, id: number) {
				return this.apps.get(id) ?? null;
			},
		},
	};
	test('reads display_name through Steam\'s own lookup, called on the store', () => {
		expect(readAppName(570, root)).toBe('Dota 2');
	});
	test('null for unknown games, blank names, bad IDs and a missing store', () => {
		expect(readAppName(730, root)).toBeNull();
		expect(readAppName(1, root)).toBeNull();
		expect(readAppName(-5, root)).toBeNull();
		expect(readAppName(570, {})).toBeNull();
	});
	test('a throwing lookup is treated as unknown', () => {
		const broken = {
			appStore: {
				GetAppOverviewByAppID() {
					throw new Error('boom');
				},
			},
		};
		expect(readAppName(570, broken)).toBeNull();
	});
});

describe('copyText', () => {
	test('uses the window\'s clipboard when it works', async () => {
		const written: string[] = [];
		const win = { navigator: { clipboard: { writeText: (t: string) => Promise.resolve(void written.push(t)) } } };
		expect(await copyText('report', win)).toBe(true);
		expect(written).toEqual(['report']);
	});

	test('falls back to a selected textarea and execCommand', async () => {
		const events: string[] = [];
		const area = {
			value: '',
			style: {} as Record<string, string>,
			setAttribute: () => undefined,
			select: () => events.push(`select:${area.value}`),
			remove: () => events.push('remove'),
		};
		const doc = {
			createElement: () => area,
			body: { appendChild: () => events.push('append') },
			execCommand: (cmd: string) => {
				events.push(`exec:${cmd}`);
				return true;
			},
		};
		const win = { navigator: { clipboard: { writeText: () => Promise.reject(new Error('not focused')) } }, document: doc };
		expect(await copyText('report', win)).toBe(true);
		expect(events).toEqual(['append', 'select:report', 'exec:copy', 'remove']);
	});

	test('false when nothing can copy', async () => {
		expect(await copyText('report', {})).toBe(false);
	});
});

describe('tagRows', () => {
	const names: Record<number, string> = { 1: 'Éclair', 2: 'apple', 3: 'Banana' };
	const ids = [3, 4, 2, 1] as AppId[];
	test('sorts by name ignoring case, unknown names last', () => {
		expect(tagRows(ids, (id) => names[id] ?? null, '').map((r) => r.appId)).toEqual([2, 3, 1, 4] as AppId[]);
	});
	test('search ignores accents and case', () => {
		expect(tagRows(ids, (id) => names[id] ?? null, 'ECL').map((r) => r.appId)).toEqual([1] as AppId[]);
	});
});

describe('backend replies', () => {
	test('update status from JSON, with missing fields as null', () => {
		const s = parseUpdateStatus('{"current_version":"0.2.0","last_applied":{"from":"0.1.0","to":"0.2.0","at":5}}');
		expect(s?.currentVersion).toBe('0.2.0');
		expect(s?.lastApplied).toEqual({ from: '0.1.0', to: '0.2.0', at: 5, rollback: false });
		expect(s?.lastError).toBeNull();
		expect(parseUpdateStatus('[]')).toBeNull();
		expect(parseUpdateStatus(42)).toBeNull();
	});
	test('updater start failure is carried as error', () => {
		expect(parseUpdateStatus('{"error":"boom"}')?.error).toBe('boom');
	});
	test('environment', () => {
		expect(parseEnvironment('{"plugin_version":"0.1.0","os":"OSX"}')).toEqual({
			pluginVersion: '0.1.0',
			millenniumVersion: null,
			os: 'OSX',
			arch: null,
		});
	});
	test('rollback is offered only for an older saved version with nothing staged', () => {
		const base = parseUpdateStatus('{"current_version":"0.2.0","previous_version":"0.1.0"}');
		expect(canRollBack(base)).toBe(true);
		expect(canRollBack(parseUpdateStatus('{"current_version":"0.2.0","previous_version":"0.2.0"}'))).toBe(false);
		expect(canRollBack(parseUpdateStatus('{"current_version":"0.2.0","previous_version":"0.1.0","staged_version":"0.1.0"}'))).toBe(
			false,
		);
		expect(canRollBack(parseUpdateStatus('{"current_version":"0.2.0"}'))).toBe(false);
		expect(canRollBack(null)).toBe(false);
	});
	test('compareVersions', () => {
		expect(compareVersions('0.1.0', '0.2.0')).toBe(-1);
		expect(compareVersions('v1.0.10', '1.0.9')).toBe(1);
		expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
		expect(compareVersions('junk', '1.0.0')).toBe(0);
	});
});

describe('clean', () => {
	test('removes user folder names and SteamID64s from error text', () => {
		expect(clean('cannot open C:\\Users\\Someone\\AppData\\Roaming\\SteamDiscreet\\tags-76561198000000001.txt')).toBe(
			'cannot open C:\\Users\\<user>\\AppData\\Roaming\\SteamDiscreet\\tags-<steamid>.txt',
		);
		expect(clean('at /Users/someone/Library/x and /home/me/y')).toBe('at /Users/<user>/Library/x and /home/<user>/y');
		expect(clean('line one\n  line two')).toBe('line one line two');
	});
	test('folder names with spaces, doubled backslashes and newer SteamID64s', () => {
		expect(clean('C:\\Users\\John Smith\\AppData\\Roaming\\SteamDiscreet')).toBe('C:\\Users\\<user>\\AppData\\Roaming\\SteamDiscreet');
		expect(clean('/Users/Attila Daczo/Library/x')).toBe('/Users/<user>/Library/x');
		expect(clean('open "C:\\\\Users\\\\daczo\\\\AppData\\\\x" failed')).toBe('open "C:\\\\Users\\\\<user>\\\\AppData\\\\x" failed');
		expect(clean('\\\\?\\C:\\Users\\daczo\\x')).toBe('\\\\?\\C:\\Users\\<user>\\x');
		expect(clean('id 76561202000000001 and 76561198000000001')).toBe('id <steamid> and <steamid>');
	});
	test('a storage reason built the way store.lua builds it', () => {
		const reason = 'Cannot create storage folder (APPDATA): C:\\Users\\Jane Doe\\AppData\\Roaming\\SteamDiscreet: Access is denied';
		expect(clean(reason)).toBe('Cannot create storage folder (APPDATA): C:\\Users\\<user>\\AppData\\Roaming\\SteamDiscreet: Access is denied');
	});
});

describe('backup file replies', () => {
	test('preview: counts, kind, saved time and account check; anything else is unknown', () => {
		expect(parsePreview({ ok: true, count: 3, kind: 'backup', saved: '2026-11-21T19:40:00Z', same_account: 'no' })).toEqual({
			ok: true,
			count: 3,
			kind: 'backup',
			saved: new Date('2026-11-21T19:40:00Z'),
			sameAccount: 'no',
		});
		expect(parsePreview({ ok: true, count: 1, kind: 'weird', saved: 'yesterday', same_account: 'maybe' })).toEqual({
			ok: true,
			count: 1,
			kind: 'list',
			saved: null,
			sameAccount: 'unknown',
		});
		expect(parsePreview({ ok: true, count: -1 }).ok).toBe(false);
		expect(parsePreview({ ok: false, message: 'newer' })).toEqual({ ok: false, message: 'newer' });
		expect(parsePreview('x').ok).toBe(false);
	});

	test('saved times must be the backend shape', () => {
		expect(parseSaved('2026-11-21T19:40:00Z')).toEqual(new Date('2026-11-21T19:40:00Z'));
		for (const v of ['2026-11-21', '2026-13-45T99:99:99Z', 5, null]) expect(parseSaved(v)).toBeNull();
	});

	test('save reply needs a name, path, count and known location', () => {
		const good = { ok: true, name: 'a.txt', path: 'p/a.txt', count: 2, kind: 'override' };
		expect(parseSaveReply(good)).toEqual({ ok: true, name: 'a.txt', path: 'p/a.txt', count: 2, location: 'override', fallbackReason: null });
		expect(parseSaveReply({ ...good, kind: 'desktop' }).ok).toBe(false);
		expect(parseSaveReply({ ...good, count: '2' }).ok).toBe(false);
	});

	test('list reply skips malformed lines and keeps counts only for good backups', () => {
		const reply = parseListReply({
			ok: true,
			folder: 'F',
			entries: ['1:a.txt\ta.txt\tok\t4\t\tno\tdocuments', 'junk', '1:b.txt\tb.txt\tbogus\t1\t\tyes\tdocuments', '2:c.txt\tc.txt\tnewer\t9\t\tyes\tfallback', ''].join('\n'),
		});
		if (!reply.ok) throw new Error(reply.message);
		expect(reply.entries.map((e) => [e.id, e.status, e.count, e.sameAccount])).toEqual([
			['1:a.txt', 'ok', 4, 'no'],
			['2:c.txt', 'newer', null, 'yes'],
		]);
		expect(parseListReply({ ok: true, folder: 'F', entries: '' })).toEqual({ ok: true, folder: 'F', entries: [] });
		expect(parseListReply({ ok: true, entries: {} }).ok).toBe(false);
	});

	test('read reply carries the text', () => {
		expect(parseReadReply({ ok: true, text: 'x' })).toEqual({ ok: true, text: 'x' });
		expect(parseReadReply({ ok: true }).ok).toBe(false);
	});
});

describe('backup wording', () => {
	const entry: BackupEntry = {
		id: '1:a.txt',
		name: 'a.txt',
		status: 'ok',
		count: 1,
		saved: new Date('2026-11-21T19:40:00Z'),
		sameAccount: 'yes',
		location: 'documents',
	};
	const fmt = (d: Date) => d.toISOString().slice(0, 10);

	test('describes each backup', () => {
		expect(describeEntry(entry, fmt)).toBe('1 game, saved 2026-11-21');
		expect(describeEntry({ ...entry, count: 3, sameAccount: 'no', location: 'fallback', saved: null }, fmt)).toBe(
			"3 games, from another Steam account, in the plugin's own folder",
		);
		expect(describeEntry({ ...entry, status: 'newer' }, fmt)).toContain('newer version');
		expect(describeEntry({ ...entry, status: 'invalid' }, fmt)).toContain('cannot be restored');
	});

	test('the confirmation names both counts, the Undo and another account', () => {
		expect(importQuestion('replace', { count: 2, sameAccount: 'yes' }, 5, 'backup')).toBe(
			'Replace your 5 games with the 2 games in this backup? Games not in this backup are untagged. The current list is saved first, and an Undo button puts it back until Steam restarts.',
		);
		expect(importQuestion('merge', { count: 1, sameAccount: 'no' }, 0, 'paste')).toBe(
			'This backup is from another Steam account. Add the 1 game in the paste to your 0 games? Your current tags stay.',
		);
	});
});
