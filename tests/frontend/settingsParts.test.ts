import { describe, expect, test } from 'bun:test';
import type { AppId } from '../../frontend/domain/appId';
import { tagRows } from '../../frontend/domain/tagList';
import { readAppName, readSteamBuild } from '../../frontend/integrations/steam/clientInfo';
import { copyText } from '../../frontend/integrations/steam/clipboard';
import { canRollBack, compareVersions, parseEnvironment, parseUpdateStatus } from '../../frontend/services/backendInfo';
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
});
