// M4 full-coverage check, evaluated in SharedJSContext:
//
//   bun scripts/cdp.ts eval @scripts/live/m4-surfaces.js
//   bun scripts/cdp.ts eval "globalThis.SD_CHECK_APPIDS = [813780]"   # optional: pick the games
//
// Checks each Library Home surface separately for one or more games: the
// Recent Games shelf, Play Next, What's New (ordinary and takeover events),
// the user's collection shelves and collection tiles, and what the main
// window renders (images and name labels, counted separately for Home and
// the sidebar). For each game it runs: untagged (baseline), tagged with the
// toggle off, toggle on, toggle off again, untagged. Then it runs the same
// cycle on an exact-name Library search for the first game, and clears the
// search again.
//
// Without SD_CHECK_APPIDS it picks up to three games itself: the first
// untagged game among the first four of Recent Games (rendered on Home
// without scrolling), the first untagged game with a What's New entry, and
// the first untagged Play Next suggestion.
//
// It opens Library Home with steam://open/library (which does not change the
// Games filter). The search step types into the sidebar search through
// uiStore.SetSearchText, as the search box does, and clears it at the end;
// the report says whether the filter state matches the start. It never calls
// Steam's collection, Hidden or Private write paths; the only stored write is
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

	// The sidebar column: the highest ancestor of our reveal toggle that is
	// narrower than 60% of the window and taller than half of it. Hashed class
	// names are never used.
	const sidebarRoot = (doc) => {
		const t = doc.querySelector('[aria-label*="adult games"], [aria-label*="loading your tags"]');
		if (!t) return null;
		const w = doc.defaultView?.innerWidth ?? 0;
		const h = doc.defaultView?.innerHeight ?? 0;
		let best = null;
		for (let el = t; el && el !== doc.body; el = el.parentElement) {
			const r = el.getBoundingClientRect();
			if (r.width < w * 0.6 && r.height > h * 0.5) best = el;
		}
		return best;
	};
	// Images whose URL carries the App ID, and leaf elements whose text is the
	// game's exact name, counted separately inside and outside the sidebar.
	const domCounts = (appid, name) => {
		const doc = mainDoc();
		if (!doc) return null;
		const side = sidebarRoot(doc);
		const re = new RegExp(`[/_]${appid}[/._]`);
		const out = { sidebarFound: !!side, home: { imgs: 0, labels: 0 }, sidebar: { imgs: 0, labels: 0 } };
		for (const i of doc.querySelectorAll('img')) {
			if (re.test(i.currentSrc || i.src || '')) out[side?.contains(i) ? 'sidebar' : 'home'].imgs++;
		}
		if (name) {
			for (const el of doc.querySelectorAll('div,span,a')) {
				if (el.childElementCount === 0 && el.textContent?.trim() === name) out[side?.contains(el) ? 'sidebar' : 'home'].labels++;
			}
		}
		return out;
	};

	// What one game looks like on every surface right now.
	const snap = (appid) => {
		const name = apps.GetAppOverviewByAppID(appid)?.display_name ?? '';
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
			dom: domCounts(appid, name),
			hidden: cs.BIsHidden(appid),
			favorite: cs.BIsFavorite(appid),
			hiddenSize: cs.GetCollection('hidden')?.apps?.size,
			filter: filterState(),
		};
	};

	const compareDom = (d, b, expectShown) => {
		const problems = [];
		if (!d || !b) return problems;
		for (const area of ['home', 'sidebar']) {
			for (const k of ['imgs', 'labels']) {
				if (b[area][k] > 0 && (expectShown ? d[area][k] === 0 : d[area][k] !== 0)) problems.push(`${area} ${k}: ${d[area][k]}, baseline ${b[area][k]}`);
			}
		}
		return problems;
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
		problems.push(...compareDom(s.dom, base.dom, expectShown));
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
		const next = playNext ? safe(() => playNext.GetSuggestionsToShow(false).apps) : [];
		const pn = Array.isArray(next) ? next.find((id) => typeof id === 'number' && !ids.includes(id) && !lib.isTagged(id)) : undefined;
		if (pn !== undefined) ids.push(pn);
		else report.notes.push('no untagged game in Play Next (the shelf may not be on Home, or Steam has no suggestions)');
	}
	if (ids.length === 0) return { ...report, ok: false, error: 'no game to check; set SD_CHECK_APPIDS' };

	globalThis.SteamClient?.URL?.ExecuteSteamURL?.('steam://open/library');
	await sleep(1500);
	if (!mainDoc()) report.notes.push('main window document not found; DOM checks skipped');

	// Exact-name Library search (the sidebar search box): Steam's own
	// uiStore.SetSearchText, the call the box makes on every keystroke. It
	// swaps the sidebar to a search filter; SetSearchText('') restores the
	// Games filter. Results are read the way the sidebar builds its rows.
	const ui = globalThis.uiStore;
	const searchActive = () => safe(() => ui?.BIsSearchActive?.() === true) === true;
	const inSearchResults = (appid) =>
		safe(() => (ui.GetCollectionList() ?? []).some((c) => c.visibleApps.filter(ui.currentAppFilter.Matches).some((a) => a.appid === appid)));
	const searchCycle = async (appid) => {
		const name = apps.GetAppOverviewByAppID(appid)?.display_name ?? '';
		const g = { appid, search: name ? '<exact name>' : null, steps: [] };
		report.search = g;
		if (!name || typeof ui?.SetSearchText !== 'function' || typeof ui?.GetCollectionList !== 'function') {
			g.error = 'search API or game name missing; skipped';
			report.ok = false;
			return;
		}
		if (searchActive()) {
			g.error = 'a search was already active; skipped';
			return;
		}
		ui.SetSearchText(name);
		await sleep(1000);
		const look = () => ({ visible: cs.BIsVisible(appid), found: inSearchResults(appid), dom: domCounts(appid, name), filter: filterState() });
		const base = look();
		g.base = base;
		if (base.found !== true) {
			g.error = 'game not in its own exact-name search results to start with';
			report.ok = false;
			return;
		}
		const run = async (stepName, fn, expectShown) => {
			await fn();
			await sleep(800);
			const s = look();
			const problems = [];
			if (s.found !== expectShown) problems.push(`search result: found=${s.found}`);
			if (s.filter !== base.filter) problems.push('search filter changed');
			if (s.dom && base.dom && base.dom.sidebar.labels > 0 && (expectShown ? s.dom.sidebar.labels === 0 : s.dom.sidebar.labels !== 0)) problems.push(`sidebar labels: ${s.dom.sidebar.labels}, baseline ${base.dom.sidebar.labels}`);
			g.steps.push({ name: stepName, problems, snapshot: s });
			if (problems.length) report.ok = false;
		};
		await run('tagged, toggle off', async () => {
			tagged.push(appid);
			await lib.tagGames([appid]);
		}, false);
		await run('toggle on', () => lib.setRevealed(true), true);
		await run('toggle off again', () => lib.setRevealed(false), false);
		await run('untagged', () => lib.untagGames([appid]), true);
		ui.SetSearchText('');
		await sleep(500);
	};
	const searchId = ids.find((id) => !lib.isTagged(id));
	const startFilter = filterState();

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
				tagged.push(appid);
				await lib.tagGames([appid]);
			}, false);
			await run('toggle on', () => lib.setRevealed(true), true);
			await run('toggle off again', () => lib.setRevealed(false), false);
			await run('untagged', () => lib.untagGames([appid]), true);
		}
		if (searchId !== undefined) await searchCycle(searchId);
	} catch (e) {
		report.ok = false;
		report.error = String(e);
	} finally {
		lib.setRevealed(false);
		if (searchActive()) {
			try {
				ui.SetSearchText('');
			} catch (e) {
				report.ok = false;
				report.searchRestoreError = String(e);
			}
			await sleep(300);
		}
		report.filterRestored = filterState() === startFilter;
		if (!report.filterRestored) report.ok = false;
		const left = [...new Set(tagged)].filter((id) => lib.isTagged(id));
		if (left.length) {
			try {
				await lib.untagGames(left);
			} catch (e) {
				report.ok = false;
				report.untagError = String(e);
			}
		}
	}
	report.state = lib.getState();
	return report;
})();
