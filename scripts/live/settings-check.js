// Live check for the settings page and diagnostic report, evaluated in
// SharedJSContext with this branch's plugin built and Steam restarted:
//
//   bun scripts/cdp.ts eval @scripts/live/settings-check.js > settings-check.json
//
// Read-only: it calls no plugin or Steam write path. It confirms the values
// the page reads from Steam (PACKAGE_CL, appStore display_name), the backend
// functions behind the report, and prints the report itself. Game names are
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
	} catch (e) {
		fail(`report failed: ${String(e)}`);
	}
	out.clipboardApi = typeof navigator.clipboard?.writeText === 'function';
	return out;
})();
