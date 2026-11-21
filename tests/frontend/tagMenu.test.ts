import { describe, expect, test } from 'bun:test';
import type { AppId } from '../../frontend/domain/appId';
import { revealToggleView } from '../../frontend/domain/revealToggle';
import { decideTagMenu, failureMessage, MARK_LABEL, UNMARK_LABEL } from '../../frontend/domain/tagMenu';
import { filterIconClasses } from '../../frontend/integrations/steam/filterIconClasses';
import { parseSelection, selectionFromMenuApps } from '../../frontend/integrations/steam/selection';
import { menuActionFor, runMenuAction, type TagLibrary } from '../../frontend/services/tagMenuController';

const ids = (...n: number[]) => n as AppId[];
const taggedSet = (...n: number[]) => {
	const s = new Set<number>(n);
	return (id: AppId) => s.has(id);
};

describe('decideTagMenu', () => {
	test('unknown selection is disabled, never guessed', () => {
		expect(decideTagMenu({ selection: null, isTagged: taggedSet(), ready: true })).toEqual({
			kind: 'disabled',
			label: MARK_LABEL,
			reason: 'unknown_selection',
		});
	});

	test('empty selection is disabled', () => {
		expect(decideTagMenu({ selection: [], isTagged: taggedSet(), ready: true }).kind).toBe('disabled');
	});

	test('untagged single game offers Mark', () => {
		expect(decideTagMenu({ selection: ids(570), isTagged: taggedSet(), ready: true })).toEqual({
			kind: 'mark',
			label: MARK_LABEL,
			ids: ids(570),
		});
	});

	test('tagged single game offers Unmark', () => {
		expect(decideTagMenu({ selection: ids(570), isTagged: taggedSet(570), ready: true })).toEqual({
			kind: 'unmark',
			label: UNMARK_LABEL,
			ids: ids(570),
		});
	});

	test('mixed selection marks only the untagged ones', () => {
		expect(decideTagMenu({ selection: ids(570, 730, 440), isTagged: taggedSet(730), ready: true })).toEqual({
			kind: 'mark',
			label: MARK_LABEL,
			ids: ids(570, 440),
		});
	});

	test('all-tagged multi-selection unmarks all, deduplicated', () => {
		expect(decideTagMenu({ selection: ids(570, 730, 570), isTagged: taggedSet(570, 730), ready: true })).toEqual({
			kind: 'unmark',
			label: UNMARK_LABEL,
			ids: ids(570, 730),
		});
	});

	test('not ready keeps the right label but is disabled', () => {
		expect(decideTagMenu({ selection: ids(570), isTagged: taggedSet(570), ready: false })).toEqual({
			kind: 'disabled',
			label: UNMARK_LABEL,
			reason: 'not_ready',
		});
	});
});

describe('parseSelection', () => {
	test('accepts numbers and numeric strings, deduplicates', () => {
		expect(parseSelection([570, '730', 570])).toEqual(ids(570, 730));
	});

	test.each([[undefined], [null], [570], [[]], [[570, 0]], [[570, 'x']], [[1.5]], [{ 0: 570, length: 1 }]])(
		'rejects %p',
		(value) => {
			expect(parseSelection(value)).toBeNull();
		},
	);
});

describe('failureMessage', () => {
	test('says nothing was changed', () => {
		expect(failureMessage('mark', 1, 'Disk full.')).toBe(
			'Steam Discreet could not mark this game as adult. Nothing was changed. Disk full.',
		);
		expect(failureMessage('unmark', 3, '')).toBe(
			'Steam Discreet could not unmark 3 games as adult. Nothing was changed.',
		);
	});
});

class FakeLibrary implements TagLibrary {
	readonly tags = new Set<number>();
	ready = true;
	fail: Error | null = null;
	readonly calls: string[] = [];

	tagGames(list: readonly AppId[]): Promise<void> {
		this.calls.push(`tag ${list.join(',')}`);
		if (this.fail) return Promise.reject(this.fail);
		for (const id of list) this.tags.add(id);
		return Promise.resolve();
	}

	untagGames(list: readonly AppId[]): Promise<void> {
		this.calls.push(`untag ${list.join(',')}`);
		if (this.fail) return Promise.reject(this.fail);
		for (const id of list) this.tags.delete(id);
		return Promise.resolve();
	}

	isTagged(id: AppId): boolean {
		return this.tags.has(id);
	}

	getState() {
		return { ready: this.ready };
	}
}

describe('runMenuAction', () => {
	test('mark then unmark round trip', async () => {
		const lib = new FakeLibrary();
		const reports: string[] = [];
		expect(await runMenuAction(lib, menuActionFor(lib, ids(570)), (m) => reports.push(m))).toBe(true);
		expect(lib.isTagged(570 as AppId)).toBe(true);
		expect(menuActionFor(lib, ids(570)).label).toBe(UNMARK_LABEL);
		expect(await runMenuAction(lib, menuActionFor(lib, ids(570)), (m) => reports.push(m))).toBe(true);
		expect(lib.isTagged(570 as AppId)).toBe(false);
		expect(lib.calls).toEqual(['tag 570', 'untag 570']);
		expect(reports).toEqual([]);
	});

	test('failed save is reported, not shown as saved', async () => {
		const lib = new FakeLibrary();
		lib.fail = new Error('Could not write the tag file.');
		const reports: string[] = [];
		expect(await runMenuAction(lib, menuActionFor(lib, ids(570, 730)), (m) => reports.push(m))).toBe(false);
		expect(lib.tags.size).toBe(0);
		expect(reports).toEqual([
			'Steam Discreet could not mark 2 games as adult. Nothing was changed. Could not write the tag file.',
		]);
	});

	test('disabled action does nothing', async () => {
		const lib = new FakeLibrary();
		lib.ready = false;
		expect(await runMenuAction(lib, menuActionFor(lib, ids(570)), () => undefined)).toBe(false);
		expect(lib.calls).toEqual([]);
	});
});

describe('revealToggleView', () => {
	test('off by default and labelled for the next action', () => {
		expect(revealToggleView({ ready: true, revealed: false, seamStatus: 'ok' })).toEqual({
			pressed: false,
			disabled: false,
			title: 'Show adult games',
			warning: null,
		});
		expect(revealToggleView({ ready: true, revealed: true, seamStatus: 'ok' }).title).toBe('Hide adult games');
	});

	test('disabled while loading, warning survives every state', () => {
		const loading = revealToggleView({ ready: false, revealed: true, seamStatus: 'warning' });
		expect(loading.disabled).toBe(true);
		expect(loading.pressed).toBe(false);
		expect(loading.warning).not.toBeNull();
	});
});

describe('selectionFromMenuApps', () => {
	const app = (appid: unknown, shortcut: unknown = false) => ({ appid, BIsModOrShortcut: () => shortcut });

	test('reads App IDs from overviews', () => {
		expect(selectionFromMenuApps([app(570), app(730), app(570)])).toEqual(ids(570, 730));
	});

	test('a shortcut or mod makes the selection unknown', () => {
		expect(selectionFromMenuApps([app(570), app(2147483649, true)])).toBeNull();
	});

	test.each([
		['not an array', { length: 1 }],
		['empty', []],
		['undefined overview from a stale multi-select', [app(570), undefined]],
		['missing BIsModOrShortcut', [{ appid: 570 }]],
		['non-boolean shortcut answer', [app(570, 'no')]],
		['bad appid', [app('x')]],
	])('%s gives null', (_, value) => {
		expect(selectionFromMenuApps(value)).toBeNull();
	});

	test('a throwing overview method propagates, for tagMenuItem to catch', () => {
		expect(() =>
			selectionFromMenuApps([
				{
					appid: 570,
					BIsModOrShortcut: () => {
						throw new Error('boom');
					},
				},
			]),
		).toThrow('boom');
	});
});

describe('filterIconClasses', () => {
	test('keeps strings, drops anything else', () => {
		expect(filterIconClasses({ button: 'a', active: 'b', disabled: 'c' })).toEqual({ button: 'a', active: 'b', disabled: 'c' });
		expect(filterIconClasses({ button: 1, active: null })).toEqual({ button: '', active: '', disabled: '' });
		expect(filterIconClasses(undefined)).toEqual({ button: '', active: '', disabled: '' });
	});
});
