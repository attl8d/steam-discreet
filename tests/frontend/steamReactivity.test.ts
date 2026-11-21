/**
 * Models how Steam's Library caches its lists (sp.js, build 1794536281,
 * module 59671) with real mobx 6, and checks that the library service
 * refreshes them in place. The model copies the parts that matter:
 *
 * - `visibleApps` is a keepAlive computed filtering `allApps` through
 *   collectionStore.BIsVisible, which our hook extends with sdShouldHide.
 * - `GetAppCountWithToolsFilter` caches counts in a plain Map that only
 *   `ClearAppCounts()` empties.
 * - The sidebar reads them inside a mobx reaction.
 *
 * This is not proof that Steam behaves this way; the live check in
 * docs/research.md (M3) is.
 */
import { describe, expect, test } from 'bun:test';
import { autorun, computed, configure, makeObservable, observable } from 'mobx';
import { type AccountId, parseAccountId } from '../../frontend/domain/accountId';
import { signalFromObservable } from '../../frontend/integrations/steam/reactiveSignal';
import { clearCollectionCounts } from '../../frontend/integrations/steam/collectionCounts';
import { type Clock, LibraryService, type LibraryPort } from '../../frontend/services/library';
import { TagStorage, type TagStorageRpc } from '../../frontend/services/tagStorage';

configure({ enforceActions: 'never' }); // as Steam does

const ACCOUNT = parseAccountId('76561198000000001') as AccountId;

class Collection {
	m_rgApps: number[];
	m_mapFilterToAppCounts = new Map<string, number>();
	constructor(
		apps: number[],
		private readonly store: Store,
	) {
		this.m_rgApps = apps;
		makeObservable(this, { m_rgApps: observable, allApps: computed({ keepAlive: true }), visibleApps: computed({ keepAlive: true }) });
	}
	get allApps() {
		return this.m_rgApps.slice();
	}
	get visibleApps() {
		return this.allApps.filter((a) => this.store.BIsVisible(a));
	}
	GetAppCountWithToolsFilter(hash: string) {
		if (!this.m_mapFilterToAppCounts.has(hash)) {
			this.m_mapFilterToAppCounts.set(hash, this.allApps.filter((a) => this.store.BIsVisible(a)).length);
		}
		return this.m_mapFilterToAppCounts.get(hash);
	}
	ClearAppCounts() {
		this.m_mapFilterToAppCounts.clear();
	}
}

class Store {
	hidden = observable.set<number>();
	plugin: { sdShouldHide?: (id: unknown) => boolean } | undefined;
	games = new Collection([10, 20, 30], this);
	collectionsFromStorage = new Map<string, Collection>();
	BIsVisible(id: number) {
		// The patched body: ...&&!this.BIsHidden(id)&&!(marker, PLUGIN?.sdShouldHide?.(id)===!0)
		return !this.hidden.has(id) && !(this.plugin?.sdShouldHide?.(id) === true);
	}
	GetCollection(id: string) {
		return id === 'all-games' ? this.games : undefined;
	}
	get userCollections() {
		return [];
	}
}

const rpc = (tags: number[]): TagStorageRpc => {
	const set = new Set(tags);
	const reply = () => Promise.resolve({ ok: true, state: 'ok', writable: true, ids: [...set].join(',') });
	return {
		open: reply,
		add: (_a, ids) => {
			for (const x of ids.split(',')) set.add(Number(x));
			return reply();
		},
		remove: (_a, ids) => {
			for (const x of ids.split(',')) set.delete(Number(x));
			return reply();
		},
		clear: reply,
		exportText: reply,
		importText: reply,
	};
};

const clock: Clock = { now: () => 0, setInterval: () => 1, clearInterval: () => undefined };
const flush = () => new Promise((r) => setTimeout(r, 0));

function build(withSignal: boolean, tags: number[]) {
	const store = new Store();
	const root = { collectionStore: store };
	const port: LibraryPort = {
		currentAccount: () => ACCOUNT,
		createSignal: () => (withSignal ? signalFromObservable(observable) : null),
		clearCounts: () => clearCollectionCounts(root),
		seenHooks: () => new Set(),
		hookManifest: () => Promise.resolve(null),
	};
	const lib = new LibraryService(new TagStorage(rpc(tags)), port, clock);
	return { store, lib };
}

describe('live refresh of Steam-style cached lists', () => {
	test('plugin loaded before the first compute: tags, toggle and untag update lists and counts in place', async () => {
		const { store, lib } = build(true, [20]);
		lib.start();
		store.plugin = { sdShouldHide: (id) => lib.shouldHide(id) };

		const seen: Array<{ apps: number[]; count: number | undefined }> = [];
		const stop = autorun(() => {
			seen.push({ apps: store.games.visibleApps, count: store.games.GetAppCountWithToolsFilter('f') });
		});
		expect(seen.at(-1)).toEqual({ apps: [10, 20, 30], count: 3 }); // tags not loaded yet: fail open

		await flush(); // tags arrive
		expect(seen.at(-1)).toEqual({ apps: [10, 30], count: 2 });

		lib.setRevealed(true);
		expect(seen.at(-1)).toEqual({ apps: [10, 20, 30], count: 3 });

		lib.setRevealed(false);
		expect(seen.at(-1)).toEqual({ apps: [10, 30], count: 2 });

		await lib.tagGames([30]);
		expect(seen.at(-1)).toEqual({ apps: [10], count: 1 });

		await lib.untagGames([20, 30]);
		expect(seen.at(-1)).toEqual({ apps: [10, 20, 30], count: 3 });

		// Steam's own Hidden state is never touched.
		expect(store.hidden.size).toBe(0);
		stop();
	});

	test('an observer that reads only a count stays current over several changes', async () => {
		const { store, lib } = build(true, []);
		lib.start();
		store.plugin = { sdShouldHide: (id) => lib.shouldHide(id) };
		await flush();
		let count: number | undefined;
		let runs = 0;
		const stop = autorun(() => {
			runs += 1;
			count = store.games.GetAppCountWithToolsFilter('f');
		});
		expect(count).toBe(3);
		await lib.tagGames([10]);
		expect(count).toBe(2);
		await lib.tagGames([20]);
		expect(count).toBe(1);
		lib.setRevealed(true);
		expect(count).toBe(3);
		lib.setRevealed(false);
		await lib.untagGames([10, 20]);
		expect(count).toBe(3);
		expect(runs).toBeGreaterThan(4);
		stop();
	});

	test('KNOWN GAP: a second count-only reader of the same cache misses updates', async () => {
		// The first reader after ClearAppCounts recomputes (and so depends on the
		// signal); a second reader of the same collection and filter gets the
		// cached number, depends on nothing of ours, and stays stale. Recorded in
		// docs/research.md (M3) for the live check. If Steam shows it, the fix is
		// a hook on GetAppCountWithToolsFilter that reads the signal on a hit.
		const { store, lib } = build(true, []);
		lib.start();
		store.plugin = { sdShouldHide: (id) => lib.shouldHide(id) };
		await flush();
		let a: number | undefined;
		let b: number | undefined;
		const stopA = autorun(() => {
			a = store.games.GetAppCountWithToolsFilter('f');
		});
		const stopB = autorun(() => {
			b = store.games.GetAppCountWithToolsFilter('f');
		});
		await lib.tagGames([10]);
		expect(a).toBe(2);
		expect(b).toBe(3); // stale: documents the gap
		stopA();
		stopB();
	});

	test('without the signal the cached list stays stale (the M1 finding this fixes)', async () => {
		const { store, lib } = build(false, [20]);
		lib.start();
		store.plugin = { sdShouldHide: (id) => lib.shouldHide(id) };
		await flush();
		let last: number[] = [];
		const stop = autorun(() => {
			last = store.games.visibleApps;
		});
		expect(last).toEqual([10, 30]);
		lib.setRevealed(true);
		expect(last).toEqual([10, 30]); // stale
		stop();
	});
});
