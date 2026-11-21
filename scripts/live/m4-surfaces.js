// M4 full-coverage check, evaluated in SharedJSContext:
//
//   bun scripts/cdp.ts eval @scripts/live/m4-surfaces.js
//   bun scripts/cdp.ts eval "globalThis.SD_CHECK_APPIDS = [813780]"   # optional: pick the games
//
// Checks each Library Home surface separately for one or more games: the
// Recent Games shelf, Play Next, What's New (ordinary and takeover events),
// the user's collection shelves and collection tiles, and what the main
// window actually renders on Home. For each game it runs: untagged (baseline),
// tagged with the toggle off, toggle on, toggle off again, untagged.
//
// Without SD_CHECK_APPIDS it picks up to two games itself: the first untagged
// game among the first four of Recent Games (rendered on Home without
// scrolling), and the first untagged game with a What's New entry.
//
// It opens Library Home with steam://open/library (which does not change the
// Games filter). It never calls Steam's own write paths; the only write is
// the plugin's tag file, and every game it tagged is untagged at the end,
// even after a failure.
(async () => {
	const plugin = window.PLUGIN_LIST?.['steam-discreet'];
	const lib = plugin?.sdLibrary;
	const cs = globalThis.collectionStore;
	const apps = globalThis.appStore;
	const playNext = globalThis.playNextStore;
	const events = globalThis.libraryEventStore;
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const report = { ok: true, build: null, games: [], notes: [] };

	try {
		report.build = /PACKAGE_CL=(\d+)/.exec(String(location.href))?.[1] ?? null;
	} catch {
		/* ignore */
	}
	if (!lib || !cs || !apps) return { ok: false, error: 'plugin, collectionStore or appStore missing' };
	report.stores = { playNextStore: !!playNext, libraryEventStore: !!events };

	const mainDoc = () => {
		const popups = globalThis.g_PopupManager?.GetPopups?.() ?? [];
		const main = popups.find((p) => String(p?.m_strName ?? '').startsWith('SP Desktop'));
		return main?.m_popup?.document ?? null;
	};
	const filterState = () => {
		try {
			return JSON.stringify(globalThis.uiStore?.m_currentAppFilter?.ToStorageFormat?.() ?? null);
		} catch (e) {
			return `unreadable: ${e}`;
		}
	};
	const safe = (fn) => {
		try {
			return fn();
		} catch (e) {
			return `error: ${e}`;
		}
	};
	const eventApps = (list) => (Array.isArray(list) ? list.map((e) => e?.appid) : []);
	// Steam's own news apps, which What's New always shows (module 4257, build 1794536281).
	const special = (id) => id === 593110 || id === 1675200 || id === 1675180;

	// What one game looks like on every surface right now.
	const snap = (appid) => {
		const name = apps.GetAppOverviewByAppID(appid)?.display_name ?? '';
		const doc = mainDoc();
		let imgs = null;
		let textHits = null;
		if (doc) {
			const re = new RegExp(`[/_]${appid}[/._]`);
			imgs = [...doc.querySelectorAll('img')].filter((i) => re.test(i.currentSrc || i.src || '')).length;
			textHits = name ? [...doc.querySelectorAll('div,span,a')].filter((el) => el.childElementCount === 0 && el.textContent?.trim() === name).length : null;
		}
		const shelves = {};
		for (const c of cs.userCollections ?? []) {
			if (c?.apps?.has?.(appid)) shelves[c.id] = c.visibleApps.some((a) => a.appid === appid);
		}
		return {
			visible: cs.BIsVisible(appid),
			recent: cs.GetCollection('recent')?.visibleApps?.some((a) => a.appid === appid) ?? null,
			playNext: playNext ? safe(() => playNext.GetSuggestionsToShow(false).apps.includes(appid)) : null,
			whatsNew: events ? safe(() => eventApps(events.GetLibraryHomeBestEventsForUser()).filter((id) => id === appid).length) : null,
			takeover: events ? safe(() => eventApps(events.GetTakeOverEvents()).filter((id) => id === appid).length) : null,
			collections: shelves,
			dom: { imgs, textHits },
			hidden: cs.BIsHidden(appid),
			favorite: cs.BIsFavorite(appid),
			hiddenSize: cs.GetCollection('hidden')?.apps?.size,
			filter: filterState(),
		};
	};

	// Compare a step against the baseline. expectShown: should the game be wherever it was at baseline?
	const compare = (s, base, expectShown) => {
		const problems = [];
		const want = (b) => (expectShown ? b : false);
		if (s.visible !== expectShown) problems.push(`BIsVisible ${s.visible}`);
		if (base.recent && s.recent !== want(true)) problems.push(`Recent Games: listed=${s.recent}`);
		if (base.playNext === true && s.playNext !== want(true)) problems.push(`Play Next: listed=${s.playNext}`);
		if (typeof base.whatsNew === 'number' && base.whatsNew > 0 && s.whatsNew !== (expectShown ? base.whatsNew : 0)) problems.push(`What's New: ${s.whatsNew} entries, baseline ${base.whatsNew}`);
		if (typeof base.takeover === 'number' && base.takeover > 0 && s.takeover !== (expectShown ? base.takeover : 0)) problems.push(`takeover: ${s.takeover}, baseline ${base.takeover}`);
		for (const [id, has] of Object.entries(base.collections)) if (has && s.collections[id] !== want(true)) problems.push(`collection ${id}: listed=${s.collections[id]}`);
		if (base.dom.imgs > 0 && (expectShown ? s.dom.imgs === 0 : s.dom.imgs !== 0)) problems.push(`Home images: ${s.dom.imgs}, baseline ${base.dom.imgs}`);
		if (base.dom.textHits > 0 && (expectShown ? s.dom.textHits === 0 : s.dom.textHits !== 0)) problems.push(`Home name labels: ${s.dom.textHits}, baseline ${base.dom.textHits}`);
		if (s.hidden !== base.hidden || s.hiddenSize !== base.hiddenSize) problems.push('native Hidden changed');
		if (s.favorite !== base.favorite) problems.push('Favorite changed');
		if (s.filter !== base.filter) problems.push('filter state changed');
		return problems;
	};

	// Pick games.
	let ids = Array.isArray(globalThis.SD_CHECK_APPIDS) ? globalThis.SD_CHECK_APPIDS.filter((n) => typeof n === 'number') : [];
	if (ids.length === 0) {
		const recent = (cs.GetCollection('recent')?.visibleApps ?? []).slice(0, 4).map((a) => a.appid);
		const r = recent.find((id) => !lib.isTagged(id));
		if (r !== undefined) ids.push(r);
		else report.notes.push('no untagged game in the first four of Recent Games');
		const news = events ? safe(() => eventApps(events.GetLibraryHomeBestEventsForUser())) : [];
		const n = Array.isArray(news) ? news.find((id) => typeof id === 'number' && !special(id) && !ids.includes(id) && !lib.isTagged(id)) : undefined;
		if (n !== undefined) ids.push(n);
		else report.notes.push("no untagged game with a What's New entry");
	}
	if (ids.length === 0) return { ...report, ok: false, error: 'no game to check; set SD_CHECK_APPIDS' };

	globalThis.SteamClient?.URL?.ExecuteSteamURL?.('steam://open/library');
	await sleep(1500);
	if (!mainDoc()) report.notes.push('main window document not found; DOM checks skipped');

	lib.setRevealed(false);
	const tagged = [];
	try {
		for (const appid of ids) {
			const g = { appid, name: apps.GetAppOverviewByAppID(appid)?.display_name ?? null, steps: [] };
			report.games.push(g);
			if (lib.isTagged(appid)) {
				g.error = 'already tagged; skipped';
				continue;
			}
			const base = snap(appid);
			g.base = base;
			if (!base.visible) {
				g.error = 'not visible to start with; skipped';
				continue;
			}
			const run = async (name, fn, expectShown) => {
				await fn();
				await sleep(800);
				const s = snap(appid);
				const problems = compare(s, base, expectShown);
				g.steps.push({ name, problems, snapshot: s });
				if (problems.length) report.ok = false;
			};
			await run('tagged, toggle off', async () => {
				await lib.tagGames([appid]);
				tagged.push(appid);
			}, false);
			await run('toggle on', () => lib.setRevealed(true), true);
			await run('toggle off again', () => lib.setRevealed(false), false);
			await run('untagged', async () => {
				await lib.untagGames([appid]);
				tagged.splice(tagged.indexOf(appid), 1);
			}, true);
		}
	} catch (e) {
		report.ok = false;
		report.error = String(e);
	} finally {
		lib.setRevealed(false);
		if (tagged.length) {
			try {
				await lib.untagGames(tagged.slice());
			} catch (e) {
				report.ok = false;
				report.untagError = String(e);
			}
		}
	}
	report.state = lib.getState();
	return report;
})();
