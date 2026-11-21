// M4 live check for the tag menu item and the reveal toggle, evaluated in
// SharedJSContext with this branch's plugin built and Steam restarted (hooks
// only apply on a full restart):
//
//   bun scripts/cdp.ts eval @scripts/live/m4-menu-check.js > m4-menu-check.json
//   bun scripts/cdp.ts eval "globalThis.SD_CHECK_CLICK = true"
//   bun scripts/cdp.ts eval @scripts/live/m4-menu-check.js > m4-menu-cycle.json
//
// Open the Library first (steam://open/games). Without SD_CHECK_CLICK it only
// reads: hook markers, the toggle in the sidebar, and the context menu of the
// first game row on screen (opened with a synthetic right-click, closed with
// Escape). With SD_CHECK_CLICK it also clicks the plugin's own menu item twice
// (Mark, then Unmark, on that game) and the toggle twice (on, then off), and
// untags the game at the end even after a failure. It never clicks one of
// Steam's own menu items and never calls a Steam write path; the only write is
// the plugin's tag file. Game names are not included in the output.
(async () => {
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const out = { ok: true, errors: [], steps: [] };
	const fail = (msg) => {
		out.ok = false;
		out.errors.push(msg);
	};
	const click = globalThis.SD_CHECK_CLICK === true;
	const plugin = window.PLUGIN_LIST?.['steam-discreet'];
	const lib = plugin?.sdLibrary;
	out.build = /PACKAGE_CL=(\d+)/.exec(location.href)?.[1] ?? null;
	out.pluginExports = plugin ? Object.keys(plugin) : null;
	if (!lib) {
		fail('plugin not loaded (PLUGIN_LIST["steam-discreet"].sdLibrary missing)');
		return out;
	}
	out.state = lib.getState();
	out.markersBefore = { ...(window.__steamDiscreetHooks ?? {}) };

	const popups = () => [...(globalThis.g_PopupManager?.GetPopups?.() ?? [])];
	const main = popups().find((p) => (p.m_strName ?? '').startsWith('SP Desktop'));
	const doc = main?.m_popup?.document;
	if (!doc) {
		fail('main window document not found');
		return out;
	}
	const win = doc.defaultView;
	const docs = () => popups().map((p) => p.m_popup?.document).filter((d) => d);

	// --- Toggle ------------------------------------------------------------
	const findToggle = () => doc.querySelector('[aria-label*="adult games"], [aria-label*="loading your tags"]');
	const toggleInfo = () => {
		const t = findToggle();
		if (!t) return null;
		const r = t.getBoundingClientRect();
		return {
			label: t.getAttribute('aria-label').split('\n')[0],
			pressed: t.getAttribute('aria-pressed'),
			disabled: t.getAttribute('aria-disabled'),
			className: String(t.className),
			parentClass: String(t.parentElement?.className ?? ''),
			siblings: t.parentElement?.childElementCount ?? null,
			rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
		};
	};
	out.toggle = toggleInfo();
	if (!out.toggle) fail('toggle not found in the main window');

	// --- Context menu ------------------------------------------------------
	const names = new Map();
	for (const a of globalThis.collectionStore?.allGamesCollection?.visibleApps ?? []) names.set(a.display_name, a.appid);
	const row = [...doc.querySelectorAll('div, span')].find(
		(e) => e.childElementCount === 0 && names.has(e.textContent) && e.getBoundingClientRect().height > 0,
	);
	if (!row) {
		fail('no game row with a known name is on screen; open the Library first');
		return out;
	}
	const appid = names.get(row.textContent);
	out.appid = appid;
	const findItem = () => {
		for (const d of docs()) {
			const el = [...d.querySelectorAll('div')].find(
				(e) => /^(Mark|Unmark) as adult$/.test((e.textContent ?? '').trim()) && e.querySelector('div') === null,
			);
			if (el) return el;
		}
		return null;
	};
	const openMenu = async () => {
		const r = row.getBoundingClientRect();
		row.dispatchEvent(
			new win.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.x + 5, clientY: r.y + 5, button: 2 }),
		);
		await sleep(600);
		const item = findItem();
		const info = item
			? {
					label: item.textContent.trim(),
					className: String(item.className),
					disabled: /disabled/i.test(String(item.className)) || item.getAttribute('aria-disabled') === 'true',
					inWindow: item.ownerDocument === doc ? 'main' : 'popup',
					siblingItems: [...(item.parentElement?.children ?? [])].map((c) => (names.has(c.textContent) ? '<game>' : c.textContent.trim().slice(0, 30))),
				}
			: null;
		return { item, info };
	};
	const closeMenu = async (item) => {
		const d = item?.ownerDocument ?? doc;
		d.dispatchEvent(new d.defaultView.KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
		await sleep(300);
	};

	const startTagged = lib.isTagged(appid);
	const first = await openMenu();
	out.menu = first.info;
	out.markersAfterMenu = { ...(window.__steamDiscreetHooks ?? {}) };
	if (!first.info) fail('Mark/Unmark as adult item not found in any window after right-click');
	else if (first.info.label !== (startTagged ? 'Unmark as adult' : 'Mark as adult')) fail(`unexpected label ${first.info.label}`);

	if (!click || !first.item) {
		await closeMenu(first.item);
		out.menuClosed = findItem() === null;
		return out;
	}
	if (startTagged) {
		await closeMenu(first.item);
		fail('picked game is already tagged; untag it or pick another and rerun');
		return out;
	}

	// --- Click cycle (plugin's own controls only) ---------------------------
	try {
		first.item.click();
		await sleep(800);
		out.steps.push({ step: 'clicked Mark', tagged: lib.isTagged(appid), menuClosed: findItem() === null });
		if (!lib.isTagged(appid)) fail('Mark did not tag the game');

		const toggle = findToggle();
		if (toggle) {
			toggle.click();
			await sleep(400);
			out.steps.push({ step: 'toggle on', revealed: lib.isRevealed(), toggle: toggleInfo(), visible: globalThis.collectionStore.BIsVisible(appid) });
			if (!lib.isRevealed()) fail('toggle click did not reveal');
		}

		const again = await openMenu();
		out.steps.push({ step: 'reopened menu while tagged and revealed', menu: again.info });
		if (again.info?.label !== 'Unmark as adult') fail('menu did not switch to Unmark');
		if (again.item) {
			again.item.click();
			await sleep(800);
		}
		out.steps.push({ step: 'clicked Unmark', tagged: lib.isTagged(appid) });
		if (lib.isTagged(appid)) fail('Unmark did not untag the game');

		const toggle2 = findToggle();
		if (toggle2) {
			toggle2.click();
			await sleep(400);
			out.steps.push({ step: 'toggle off', revealed: lib.isRevealed(), toggle: toggleInfo() });
			if (lib.isRevealed()) fail('toggle click did not hide again');
		}
	} catch (e) {
		fail(String(e));
	} finally {
		if (lib.isTagged(appid)) {
			try {
				await lib.untagGames([appid]);
			} catch (e) {
				fail(`cleanup untag failed: ${e}`);
			}
		}
		lib.setRevealed(false);
		const left = findItem();
		if (left) await closeMenu(left);
	}
	out.final = { tagged: lib.isTagged(appid), revealed: lib.isRevealed(), visible: globalThis.collectionStore.BIsVisible(appid) };
	return out;
})();
