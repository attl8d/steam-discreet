// M3 live cycle check, evaluated in SharedJSContext:
//
//   bun scripts/cdp.ts eval "globalThis.SD_CHECK_APPID = 427520"
//   bun scripts/cdp.ts eval @scripts/live/m3-cycle.js
//
// Pick an owned game that is in the All list (ideally installed, a Favorite and
// in one user collection). The script tags it through the plugin, checks it is
// hidden, revealed, hidden again, then untags it, and checks after each step
// that Steam's lists, counts, Hidden collection, Favorites and filter state are
// as expected. It never calls Steam's own write paths; the only write is the
// plugin's tag file. It untags the game at the end, even after a failure.
(async () => {
	const appid = globalThis.SD_CHECK_APPID;
	const plugin = window.PLUGIN_LIST?.['steam-discreet'];
	const lib = plugin?.sdLibrary;
	const cs = globalThis.collectionStore;
	const report = { appid, steps: [], ok: true };
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const filterState = () => {
		try {
			return JSON.stringify(globalThis.uiStore?.m_currentAppFilter?.ToStorageFormat?.() ?? null);
		} catch (e) {
			return `unreadable: ${e}`;
		}
	};
	const snap = () => {
		const ids = ['all-games', 'local-install', 'favorite'];
		const lists = {};
		for (const id of ids) {
			const c = cs.GetCollection(id);
			lists[id] = c ? { has: c.visibleApps.some((a) => a.appid === appid), visible: c.visibleApps.length } : null;
		}
		for (const c of cs.userCollections ?? []) {
			if (c?.apps?.has?.(appid)) lists[`user:${c.id}`] = { has: c.visibleApps.some((a) => a.appid === appid), visible: c.visibleApps.length };
		}
		return {
			isVisible: cs.BIsVisible(appid),
			isHidden: cs.BIsHidden(appid),
			isFavorite: cs.BIsFavorite(appid),
			hiddenSize: cs.GetCollection('hidden')?.apps?.size,
			lists,
			filter: filterState(),
			state: lib.getState(),
			marker: globalThis.__steamDiscreetHooks?.['library-visibility'] === 1,
		};
	};
	const step = (name, s, expectVisible, base) => {
		const problems = [];
		if (s.isVisible !== expectVisible) problems.push(`BIsVisible is ${s.isVisible}`);
		for (const [id, l] of Object.entries(s.lists)) {
			const b = base.lists[id];
			if (!l || !b) continue;
			if (b.has && l.has !== expectVisible) problems.push(`${id}: listed=${l.has}`);
			if (b.has && l.visible !== b.visible - (expectVisible ? 0 : 1)) problems.push(`${id}: count ${l.visible}, start ${b.visible}`);
		}
		if (s.isHidden !== base.isHidden || s.hiddenSize !== base.hiddenSize) problems.push('native Hidden changed');
		if (s.isFavorite !== base.isFavorite) problems.push('Favorite changed');
		if (s.filter !== base.filter) problems.push('filter state changed');
		report.steps.push({ name, problems, snapshot: s });
		if (problems.length) report.ok = false;
	};

	if (typeof appid !== 'number') return { ok: false, error: 'set globalThis.SD_CHECK_APPID first' };
	if (!lib || !cs) return { ok: false, error: 'plugin or collectionStore missing', plugin: !!plugin };
	if (lib.isTagged(appid)) return { ok: false, error: 'game is already tagged; pick another' };
	lib.setRevealed(false);
	const base = snap();
	report.base = base;
	if (!base.isVisible) return { ok: false, error: 'game is not visible to start with', base };
	try {
		await lib.tagGames([appid]);
		await sleep(300);
		step('tagged, toggle off', snap(), false, base);
		lib.setRevealed(true);
		await sleep(300);
		step('toggle on', snap(), true, base);
		lib.setRevealed(false);
		await sleep(300);
		step('toggle off again', snap(), false, base);
	} catch (e) {
		report.ok = false;
		report.error = String(e);
	} finally {
		try {
			await lib.untagGames([appid]);
		} catch (e) {
			report.ok = false;
			report.untagError = String(e);
		}
		await sleep(300);
		step('untagged', snap(), true, base);
	}
	return report;
})();
