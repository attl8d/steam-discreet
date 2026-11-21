// Live check for the settings page and diagnostic report, evaluated in
// SharedJSContext with this branch's plugin built and Steam restarted:
//
//   bun scripts/cdp.ts eval @scripts/live/settings-check.js > settings-check.json
//
// Read-only: it calls no plugin or Steam write path. It confirms the values
// the page reads from Steam (PACKAGE_CL, appStore display_name), the backend
// functions behind the report, and checks that the report holds none of the
// tagged App IDs, the account or a user folder name. It prints the report only
// when those checks pass. Game names are
// not included in the output, only whether one could be read.
(async () => {
	const out = { ok: true, errors: [] };
	const fail = (msg) => {
		out.ok = false;
		out.errors.push(msg);
	};
	const plugin = window.PLUGIN_LIST?.['steam-discreet'];
	out.pluginExports = plugin ? Object.keys(plugin) : null;
	out.packageCl = new URLSearchParams(location.search).get('PACKAGE_CL');
	if (!/^\d+$/.test(out.packageCl ?? '')) fail('PACKAGE_CL not found in the SharedJSContext URL');

	const apps = globalThis.appStore?.allApps ?? [];
	const first = apps.find((a) => typeof a?.appid === 'number');
	if (first) {
		const overview = appStore.GetAppOverviewByAppID(first.appid);
		out.displayNameType = typeof overview?.display_name;
		if (out.displayNameType !== 'string') fail('GetAppOverviewByAppID(id).display_name is not a string');
	} else {
		fail('appStore.allApps is empty or missing');
	}

	if (!plugin?.sdDiagnostics) {
		fail('plugin not loaded (PLUGIN_LIST["steam-discreet"].sdDiagnostics missing)');
		return out;
	}
	try {
		out.report = await plugin.sdDiagnostics.report();
		for (const want of ['- Plugin: ', '- Millennium: ', '- Steam client build: ', '## Hooks', '## Updates']) {
			if (!out.report.includes(want)) fail(`report has no "${want}"`);
		}
		if (/- (Plugin|Millennium|Steam client build): unknown/.test(out.report)) fail('report has an unknown version');
		// Privacy: pass or fail only, never the values themselves.
		const report = out.report;
		const word = (v) => new RegExp(`(^|[^0-9])${v}([^0-9]|$)`).test(report);
		const tagged = (globalThis.appStore?.allApps ?? []).map((a) => a?.appid).filter((id) => plugin.sdLibrary?.isTagged?.(id));
		out.privacy = {
			taggedChecked: tagged.length,
			noTaggedIds: !tagged.some((id) => word(id)),
			noAccount: true,
			noUserFolders: !/[\\/](Users|home)[\\/]+(?!<user>)[^\\/<]/i.test(report),
		};
		const steamId = globalThis.App?.m_CurrentUser?.strSteamID;
		if (typeof steamId === 'string' && /^\d{17}$/.test(steamId)) {
			const accountId = (BigInt(steamId) - 76561197960265728n).toString();
			out.privacy.noAccount = !report.includes(steamId) && !word(accountId);
		}
		// A very small tagged App ID can match a time or version digit by chance;
		// that is a false failure, never a missed leak.
		let leaked = false;
		for (const [k, v] of Object.entries(out.privacy)) {
			if (v === false) {
				leaked = true;
				fail(`privacy check failed: ${k}`);
			}
		}
		// Keep the output free of the report when a privacy check failed.
		if (leaked) delete out.report;
	} catch (e) {
		fail(`report failed: ${String(e)}`);
	}
	out.clipboardApi = typeof navigator.clipboard?.writeText === 'function';
	return out;
})();
