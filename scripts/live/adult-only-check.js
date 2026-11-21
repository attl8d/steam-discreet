// "Adult only" mode live check, evaluated in SharedJSContext:
//
//   bun scripts/cdp.ts eval "globalThis.SD_CHECK_APPID = 427520"
//   bun scripts/cdp.ts eval @scripts/live/adult-only-check.js
//
// Pick an owned game that is in at least one user collection and has some
// recent activity. If it is not tagged yet, the script tags it and untags it
// at the end, even after a failure; games you tagged yourself stay tagged.
//
// With the mode on it checks, without changing any Steam setting:
// - the game is visible and a game that is not tagged is not;
// - every game in the views the sidebar draws from is tagged: All, the
//   collection groups (`userCollections`) and the recent-activity groups
//   (`recentAppCollections`), whatever the current sort and grouping;
// - the game is still in each of its collections and in a recent-activity group;
// - the "18+" icon is in the sidebar icon row and pressed;
// - native Hidden, Favorites and the filter state are unchanged.
// Then it switches back to hidden and checks the counts are as before.
(async () => {
	const appid = globalThis.SD_CHECK_APPID;
	const plugin = window.PLUGIN_LIST?.['steam-discreet'];
	const lib = plugin?.sdLibrary;
	const cs = globalThis.collectionStore;
	const report = { appid, build: /PACKAGE_CL=(\d+)/.exec(location.href)?.[1] ?? null, steps: [], ok: true };
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const fail = (msg) => {
		report.ok = false;
		(report.errors ??= []).push(msg);
	};
	const filterState = () => {
		try {
			return JSON.stringify(globalThis.uiStore?.m_currentAppFilter?.ToStorageFormat?.() ?? null);
		} catch (e) {
			return `unreadable: ${e}`;
		}
	};
	const mainDoc = () =>
		[...(globalThis.g_PopupManager?.GetPopups?.() ?? [])].find((p) => (p.m_strName ?? '').startsWith('SP Desktop'))?.m_popup
			?.document ?? null;
	const icon = () => {
		const el = mainDoc()?.querySelector('[aria-label^="Show only adult games"], [aria-label^="Show all games except adult games"]');
		if (!el) return null;
		return {
			label: el.getAttribute('aria-label').split('\n')[0],
			pressed: el.getAttribute('aria-pressed'),
			disabled: el.getAttribute('aria-disabled'),
			afterEye: /adult games/.test(el.previousElementSibling?.getAttribute('aria-label') ?? ''),
			siblings: el.parentElement?.childElementCount ?? null,
		};
	};
	const ids = (c) => (c?.visibleApps ?? []).map((a) => a.appid);
	const snap = () => {
		const all = cs.GetCollection('all-games');
		const groups = [...(cs.userCollections ?? [])];
		const recent = [...(cs.recentAppCollections ?? [])];
		const shown = new Set([...ids(all), ...groups.flatMap(ids), ...recent.flatMap(ids)]);
		return {
			mode: lib.getMode(),
			isVisible: cs.BIsVisible(appid),
			isHidden: cs.BIsHidden(appid),
			isFavorite: cs.BIsFavorite(appid),
			hiddenSize: cs.GetCollection('hidden')?.apps?.size,
			allVisible: all?.visibleApps?.length ?? null,
			shown: shown.size,
			untaggedShown: [...shown].filter((id) => !lib.isTagged(id)).length,
			inGroups: groups.filter((c) => c?.apps?.has?.(appid)).map((c) => ({ id: c.id, listed: ids(c).includes(appid) })),
			inRecentGroup: (() => {
				const c = recent.find((r) => ids(r).includes(appid));
				return c ? String(c.displayName ?? c.id) : null;
			})(),
			sortedByRecent: globalThis.uiStore?.bIsGameListSortedByRecent ?? null,
			groupedByCollection: globalThis.uiStore?.bIsGameListGroupedByCollection ?? null,
			filter: filterState(),
			icon: icon(),
		};
	};

	if (typeof appid !== 'number') return { ok: false, error: 'set globalThis.SD_CHECK_APPID first' };
	if (!lib?.setMode || !cs) return { ok: false, error: 'plugin (with setMode) or collectionStore missing', plugin: !!plugin };
	lib.setMode('hidden');
	const weTagged = !lib.isTagged(appid);
	const base = snap();
	report.base = base;
	try {
		if (weTagged) await lib.tagGames([appid]);
		await sleep(300);
		const other = cs.GetCollection('all-games')?.visibleApps?.find((a) => !lib.isTagged(a.appid))?.appid ?? null;
		report.otherAppid = other;

		if (lib.setMode('only') !== true) fail('setMode("only") was refused');
		await sleep(500);
		const on = snap();
		report.steps.push({ name: 'adult only', snapshot: on });
		if (!on.isVisible) fail('tagged game not visible in adult-only mode');
		if (other !== null && cs.BIsVisible(other)) fail(`untagged game ${other} still visible`);
		if (on.untaggedShown !== 0) fail(`${on.untaggedShown} untagged games still in the sidebar views`);
		for (const g of on.inGroups) if (!g.listed) fail(`missing from its collection ${g.id}`);
		if (on.inRecentGroup === null) fail('not in any recent-activity group');
		if (!on.icon) fail('18+ icon not found in the main window (open the Library)');
		else if (on.icon.pressed !== 'true') fail('18+ icon not pressed');

		lib.setMode('hidden');
		await sleep(500);
		const off = snap();
		report.steps.push({ name: 'back to hidden', snapshot: off });
		if (off.isVisible) fail('tagged game visible after switching back');
		if (other !== null && !cs.BIsVisible(other)) fail(`untagged game ${other} not visible after switching back`);

		for (const s of [on, off]) {
			if (s.isHidden !== base.isHidden || s.hiddenSize !== base.hiddenSize) fail('native Hidden changed');
			if (s.isFavorite !== base.isFavorite) fail('Favorite changed');
			if (s.filter !== base.filter) fail('filter state changed');
		}
	} catch (e) {
		fail(String(e));
	} finally {
		lib.setMode('hidden');
		if (weTagged) {
			try {
				await lib.untagGames([appid]);
			} catch (e) {
				fail(`untag failed: ${e}`);
			}
		}
		await sleep(300);
		const end = snap();
		report.end = end;
		if (end.allVisible !== base.allVisible) fail(`All count ${end.allVisible}, start ${base.allVisible}`);
	}
	return report;
})();
