import { describe, expect, test } from 'bun:test';
import { computed, makeObservable, observable } from 'mobx';
import { readCurrentAccount } from '../../frontend/integrations/steam/account';
import { clearCollectionCounts } from '../../frontend/integrations/steam/collectionCounts';
import { seenHooks } from '../../frontend/integrations/steam/hookMarkers';
import { signalFromObservable } from '../../frontend/integrations/steam/reactiveSignal';

describe('readCurrentAccount', () => {
	test('reads App.m_CurrentUser.strSteamID', () => {
		expect(readCurrentAccount({ App: { m_CurrentUser: { strSteamID: '76561198000000001' } } })).toBe(
			'76561198000000001' as never,
		);
	});
	test('null while Steam has not logged in, or for bad values', () => {
		for (const root of [{}, { App: {} }, { App: { m_CurrentUser: null } }, { App: { m_CurrentUser: { strSteamID: 765 } } }, null]) {
			expect(readCurrentAccount(root)).toBeNull();
		}
	});
	test('a throwing getter is treated as absent', () => {
		const root = {
			get App(): unknown {
				throw new Error('boom');
			},
		};
		expect(readCurrentAccount(root)).toBeNull();
	});
});

describe('clearCollectionCounts', () => {
	const collection = () => {
		const c = { cleared: 0, ClearAppCounts() { c.cleared += 1; } };
		return c;
	};
	test('clears system, user and stored collections once each', () => {
		const all = collection();
		const fav = collection();
		const user = collection();
		const root = {
			collectionStore: {
				GetCollection: (id: string) => (id === 'all-games' ? all : id === 'favorite' ? fav : null),
				userCollections: [fav, user],
				collectionsFromStorage: new Map([['favorite', fav], ['uc-1', user]]),
			},
		};
		expect(clearCollectionCounts(root)).toBe(3);
		expect([all.cleared, fav.cleared, user.cleared]).toEqual([1, 1, 1]);
	});
	test('clears the recent-activity, app-type and shared-library groups too', () => {
		const recent = collection();
		const type = collection();
		const shared = collection();
		const root = {
			collectionStore: {
				GetCollection: () => null,
				userCollections: [],
				collectionsFromStorage: new Map(),
				recentAppCollections: [recent],
				appTypeCollections: [type],
				sharedLibrariesCollections: [shared],
			},
		};
		expect(clearCollectionCounts(root)).toBe(3);
		expect([recent.cleared, type.cleared, shared.cleared]).toEqual([1, 1, 1]);
	});
	test('missing store or renamed members do nothing and never throw', () => {
		expect(clearCollectionCounts({})).toBe(0);
		expect(
			clearCollectionCounts({
				collectionStore: {
					GetCollection: () => {
						throw new Error('x');
					},
					userCollections: [{ ClearCounts: () => undefined }, { ClearAppCounts: () => { throw new Error('y'); } }],
					collectionsFromStorage: new Map(),
				},
			}),
		).toBe(1);
	});
});

describe('clearCollectionCounts before Steam has loaded its collections', () => {
	// Steam's collectionStore, sp.js build 1794536281: `m_mapCollectionsFromStorage` is a plain
	// field, undefined until the first cloud-storage change; `userCollections` is a keepAlive
	// computed over it. Reading it early makes mobx cache the error for good.
	class Store {
		m_mapCollectionsFromStorage: Map<string, { ClearAppCounts(): void }> | undefined = undefined;
		reads = 0;
		constructor() {
			makeObservable(this, { userCollections: computed({ keepAlive: true }) });
		}
		get collectionsFromStorage() {
			return this.m_mapCollectionsFromStorage;
		}
		get userCollections() {
			this.reads += 1;
			return Array.from((this.collectionsFromStorage as Map<string, { ClearAppCounts(): void }>).values());
		}
		GetCollection() {
			this.reads += 1;
			return undefined;
		}
	}

	test('touches nothing, so Steam\'s collections still compute once loaded', () => {
		const store = new Store();
		expect(clearCollectionCounts({ collectionStore: store })).toBe(0);
		expect(store.reads).toBe(0);
		let cleared = 0;
		store.m_mapCollectionsFromStorage = new Map([['uc-1', { ClearAppCounts: () => (cleared += 1) }]]);
		expect(store.userCollections.length).toBe(1);
		expect(clearCollectionCounts({ collectionStore: store })).toBe(1);
		expect(cleared).toBe(1);
	});

	test('the hazard it avoids: an early read poisons the computed', () => {
		const store = new Store();
		expect(() => store.userCollections).toThrow();
		store.m_mapCollectionsFromStorage = new Map();
		expect(() => store.userCollections).toThrow();
	});
});

describe('signalFromObservable', () => {
	test('wraps mobx observable.box', () => {
		expect(signalFromObservable(observable)).not.toBeNull();
	});
	test('rejects anything that is not shaped like observable', () => {
		for (const v of [null, {}, () => undefined, Object.assign(() => undefined, { box: () => ({}) , array: () => [] })]) {
			expect(signalFromObservable(v)).toBeNull();
		}
	});
});

describe('seenHooks', () => {
	test('reads the marker global', () => {
		expect([...seenHooks({ __steamDiscreetHooks: { 'library-visibility': 1, other: 0 } })]).toEqual(['library-visibility']);
		expect(seenHooks({}).size).toBe(0);
	});
});
