// Read-only probe for the tag menu and reveal toggle attach points, evaluated
// in SharedJSContext:
//
//   bun scripts/cdp.ts eval @scripts/live/m4-attach-probe.js > m4-probe.json
//
// Needs the Library open in the main window (steam://open/games) with at least
// one game in the sidebar. It:
//   1. records the Steam build and the shape of uiStore's game list selection;
//   2. opens Steam's real game context menu on the first sidebar game (the same
//      synthetic right-click M1 used), reads its items and the React components
//      above them, then closes it with Escape;
//   3. finds the "Games" filter dropdown at the top of the sidebar and records
//      its DOM and React ancestry;
//   4. prints sp.js source around candidate anchors.
// It never clicks a menu item and never calls a Steam method that writes.
// Output is JSON: game names are replaced by "<game>" and App IDs are kept.
(async () => {
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const out = { ok: true, errors: [] };
	const guard = (name, fn) => {
		try {
			return fn();
		} catch (e) {
			out.errors.push(`${name}: ${e}`);
			return undefined;
		}
	};

	// --- 1. Build and selection -------------------------------------------
	const spScript = [...document.scripts].find((s) => /\/sp\.js/.test(s.src));
	out.build = {
		url: location.href,
		spJs: spScript?.src ?? null,
		packageCl: /PACKAGE_CL=(\d+)/.exec(location.href)?.[1] ?? null,
		millenniumVersion: guard('version', () => window.MILLENNIUM_API?.version ?? null),
	};
	const describe = (v, depth = 0) => {
		if (v === null || v === undefined) return String(v);
		const t = typeof v;
		if (t !== 'object') return t === 'function' ? 'function' : `${t}:${t === 'string' ? JSON.stringify(v).slice(0, 40) : v}`;
		if (v instanceof Set) return { Set: [...v].slice(0, 5).map((x) => describe(x, depth + 1)), size: v.size };
		if (v instanceof Map) return { Map: [...v.keys()].slice(0, 5).map(String), size: v.size };
		if (Array.isArray(v)) return { Array: v.slice(0, 5).map((x) => describe(x, depth + 1)), length: v.length };
		if (depth >= 2) return `object{${Object.keys(v).slice(0, 12).join(',')}}`;
		const o = {};
		for (const k of Object.keys(v).slice(0, 25)) o[k] = guard(`describe ${k}`, () => describe(v[k], depth + 1));
		return o;
	};
	const ui = globalThis.uiStore;
	out.selection = {
		uiStoreKeysMatchingSelect: ui ? Object.keys(ui).filter((k) => /select/i.test(k)) : null,
		protoMatchingSelect: ui
			? Object.getOwnPropertyNames(Object.getPrototypeOf(ui)).filter((k) => /select/i.test(k))
			: null,
		m_gameListSelection: guard('m_gameListSelection', () => describe(ui?.m_gameListSelection)),
		currentGameListSelection: guard('currentGameListSelection', () => describe(ui?.currentGameListSelection)),
	};

	// --- Main window -------------------------------------------------------
	const popups = guard('popups', () => [...(globalThis.g_PopupManager?.GetPopups?.() ?? [])]) ?? [];
	out.popups = popups.map((p) => guard('popup name', () => p.m_strName ?? p.strName ?? null));
	const main = popups.find((p) => guard('name', () => (p.m_strName ?? '').startsWith('SP Desktop')));
	const doc = main?.m_popup?.document;
	if (!doc) {
		out.ok = false;
		out.errors.push('main window document not found');
		return out;
	}
	const win = doc.defaultView;

	const fiberOf = (el) => {
		const k = Object.keys(el).find((x) => x.startsWith('__reactFiber$'));
		return k ? el[k] : null;
	};
	const appIds = new Set(guard('allApps', () => globalThis.appStore.allApps.map((a) => a.appid)) ?? []);
	const looksLikeApp = (v) => {
		if (typeof v === 'number' && appIds.has(v)) return `appid ${v}`;
		if (v && typeof v === 'object') {
			if (typeof v.appid === 'number' && appIds.has(v.appid)) return `overview-like {appid:${v.appid}}`;
			if (Array.isArray(v) && v.length && v.every((x) => appIds.has(x?.appid ?? x))) return `array of ${v.length} apps`;
			if (v instanceof Set && v.size && [...v].every((x) => appIds.has(x?.appid ?? x))) return `Set of ${v.size} apps`;
		}
		return null;
	};
	const ancestry = (el, levels) => {
		const rows = [];
		let f = fiberOf(el);
		for (let i = 0; f && i < levels; i++, f = f.return) {
			if (typeof f.type === 'string') continue;
			const type = f.type;
			const name = type?.displayName ?? type?.name ?? type?.render?.name ?? (type?.$$typeof ? String(type.$$typeof) : typeof type);
			const props = f.memoizedProps ?? {};
			const appProps = {};
			for (const k of Object.keys(props)) {
				const hit = guard('prop', () => looksLikeApp(props[k]));
				if (hit) appProps[k] = hit;
			}
			rows.push({
				depth: i,
				name,
				propKeys: Object.keys(props).slice(0, 20),
				appProps,
				source: guard('src', () => (typeof type === 'function' ? type.toString().slice(0, 160) : null)),
			});
		}
		return rows;
	};
	const domPath = (el, levels) => {
		const rows = [];
		for (let i = 0; el && i < levels; i++, el = el.parentElement) {
			rows.push({ tag: el.tagName, cls: String(el.className).slice(0, 80), role: el.getAttribute('role'), children: el.childElementCount });
		}
		return rows;
	};

	// --- 2. Game context menu ---------------------------------------------
	const first = guard('first game', () => globalThis.collectionStore.allGamesCollection.visibleApps[0]);
	out.menu = { appid: first?.appid ?? null };
	const target = first
		? [...doc.querySelectorAll('div, span')].find((e) => e.childElementCount === 0 && e.textContent === first.display_name)
		: null;
	if (!target) {
		out.menu.error = 'sidebar row for the first visible game not found; open the Library first';
	} else {
		out.menu.rowAncestry = ancestry(target, 25);
		const before = new Set(doc.querySelectorAll('*'));
		const r = target.getBoundingClientRect();
		target.dispatchEvent(
			new win.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.x + 5, clientY: r.y + 5, button: 2 }),
		);
		await sleep(500);
		const added = [...doc.querySelectorAll('*')].filter((e) => !before.has(e));
		const roots = added.filter((e) => !before.has(e) && (!e.parentElement || before.has(e.parentElement)));
		const leaves = added.filter((e) => e.childElementCount === 0 && (e.textContent ?? '').trim() !== '');
		out.menu.newRoots = roots.slice(0, 5).map((e) => ({ path: domPath(e, 4) }));
		out.menu.items = leaves.slice(0, 40).map((e) => (e.textContent === first.display_name ? '<game>' : e.textContent.trim()));
		const item = leaves.find((e) => /propert/i.test(e.textContent)) ?? leaves[0];
		if (item) {
			out.menu.itemDom = domPath(item, 8);
			out.menu.itemAncestry = ancestry(item, 40);
		}
		out.menu.contextMenuPopups = guard('popups after', () =>
			[...globalThis.g_PopupManager.GetPopups()].map((p) => p.m_strName).filter((n) => /context/i.test(n ?? '')),
		);
		doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
		await sleep(300);
		out.menu.closedAfterEscape = added.filter((e) => e.isConnected).length === 0;
	}

	// --- 3. Games filter dropdown -----------------------------------------
	const gamesLabels = [...doc.querySelectorAll('div, span')].filter(
		(e) => e.childElementCount === 0 && /^\s*games\s*$/i.test(e.textContent ?? ''),
	);
	out.toggle = gamesLabels.slice(0, 3).map((e) => {
		const r = e.getBoundingClientRect();
		return { rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], dom: domPath(e, 8), ancestry: ancestry(e, 20) };
	});

	// --- 4. sp.js anchors --------------------------------------------------
	if (spScript) {
		const src = await (await fetch(spScript.src)).text();
		out.spJsLength = src.length;
		const anchors = ['BIsAppInBlockList', 'ShowGameContextMenu', 'GameContextMenu', 'AppContextMenu', 'm_gameListSelection', '#Library_SectionHeader_Games'];
		out.anchors = {};
		for (const a of anchors) {
			const hits = [];
			for (let i = src.indexOf(a); i >= 0 && hits.length < 4; i = src.indexOf(a, i + a.length)) {
				hits.push({ offset: i, text: src.slice(Math.max(0, i - 400), i + 400) });
			}
			out.anchors[a] = hits;
		}
	}
	return out;
})();
