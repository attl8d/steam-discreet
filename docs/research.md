# Research notes (M1)

Every finding here names the Steam build it was seen on. Later sessions start from this file.
All live findings below were made on 15 November 2026, Steam client build **1794536281** (stable), Millennium **v3.6.3**, unless noted.

## Summary

| Item | Result |
| --- | --- |
| Experiment 1, shared seam | **Proven** for the data layer: one patch to `collectionStore.BIsVisible` removes a game from All, Installed, Favorites, user collections and their counts, and from exact-name Library search, without touching Hidden. **Open:** turning it on and off live does not recompute Steam's cached lists (see "Reactivity"). Home shelves not yet checked on screen. |
| Experiment 2, context menu | **In progress.** The game context menu can be opened over CDP and read. No item injected yet. |
| Experiment 3, toggle control | **Not started.** |
| Experiment 4, What's New | **Partly answered from source:** the Library Home "What's New" list is filtered through the same `BIsVisible(appid)`, one App ID per event. Multi-game posts, pagination and caching not traced. |
| Open question 5 (writable locations) | **Answered:** the backend can create, write, rename and replace files in `%APPDATA%\SteamDiscreet`, and in the Steam folder. |
| Open question 6 (HTTPS, self-replace) | **Answered:** `http.get` to api.github.com works. There is no plugin folder to replace: the plugin is one `.star` file, and that folder is writable. |
| Open question 7 (disable reloads UI) | Not tested. |

## Environment

| Item | Value | How it was checked |
| --- | --- | --- |
| Windows | 11 Pro, 10.0.26200 | `Win32_OperatingSystem` |
| Steam install | `C:\Program Files (x86)\Steam` | `HKCU\Software\Valve\Steam\SteamPath` |
| Steam client build | `1794536281` (win64), `PACKAGE_CL=1794536281` in the SharedJSContext URL | `package\steam_client_win64.manifest`, CDP |
| Steam channel | Stable (no `package\beta`). The client showed "This beta has ended", so it was on a beta earlier. | |
| Millennium | `v3.6.3` (`millennium.dll` version info, `millennium.version()` from Lua). Frontend and browser libs `1.1.2`, loader built 2026-11-13. | |
| Millennium layout | `<Steam>\wsock32.dll` loader, `<Steam>\millennium\{bin,config,lib,plugins,themes}` | directory listing |
| Bun | `1.4.4`, installed with `winget install Oven-sh.Bun` | |
| Template revision | PluginTemplate `af0a07c` | scaffold commit `54c7038` |
| Starlight | `@steambrew/starlight` `1.1.7` (exact pin) | `package.json` |

## Build and install (M1 step 2)

- `bun run build` (`starlight pack`) writes one packed file, `<Steam>\millennium\plugins\steam-discreet.star`, and hot-restarts the plugin.
- `output_path` in `millennium.toml` names the **file**, not the folder. Pointing it at the folder fails with "Access is denied (os error 5)". It is now set explicitly to `C:/Program Files (x86)/Steam/millennium/plugins/steam-discreet.star`; `"auto"` resolves the same file from the registry.
- The plugins folder is writable without elevation after the Millennium installer ran.
- The plugin was active right after the first build (it appeared in `PLUGIN_LIST`), without enabling it in Millennium settings.
- The `.star` bundle is served to the page as `https://millennium.ftp/star/steam-discreet/bundle.js`.

## CDP access

- `<Steam>\.cef-enable-remote-debugging` exposes CDP on `127.0.0.1:8080`.
- **Millennium deletes this file on every Steam start** (its health check lists it as a deprecated file; string in `millennium.dll` next to "Failed to remove deprecated file"). Steam has already read it by then, so CDP still works for that session. It must be recreated before each start. `scripts/restart-steam.ps1` does that, restarts Steam and waits for CDP.
- After the Millennium installer ran, the Steam folder was writable without elevation, so the flag no longer needs admin rights.
- `scripts/cdp.ts` (Bun, no dependencies):
  - `bun scripts/cdp.ts targets` lists every Steam window.
  - `bun scripts/cdp.ts eval "<expr>"` or `eval @file.js` evaluates in `SharedJSContext` (or `--target <title>`), awaiting promises.
  - `bun scripts/cdp.ts find "<anchor>"` prints source around each match in every loaded script (`--regex`, `--context N`, `--max N`). Steam's main bundle is `https://steamloopback.host/sp.js?contenthash=ecfb6699297d77d920fd` (about 16 MB).
- Main window: `g_PopupManager.GetPopups()` entry named `SP Desktop_uid0`; its DOM is `popup.m_popup.document`. Opening the Library: `SteamClient.URL.ExecuteSteamURL('steam://open/games')`.

## Globals confirmed in SharedJSContext

`collectionStore`, `appStore`, `uiStore`, `g_PopupManager`, `App`, `SteamClient` exist. `App.m_CurrentUser.strSteamID` is a string. `PLUGIN_LIST` keys: `steam-discreet`, `core`.

- `collectionStore` methods include `BIsHidden`, `BIsVisible`, `BIsFavorite`, `GetCollection(id)`, `SetAppsAsHidden` (never call), and collections `allGamesCollection` (`my-games`), `localGamesCollection` (`local-install`), `recentAppsCollection`, `userCollections`, `GetCollection('favorite')`, `GetCollection('hidden')`.
- `appStore`: `allApps` (334 entries here), `GetAppOverviewByAppID`, `BIsAppPrivate(appid)` (`m_setPrivateApps.has`).
- `uiStore` keys include `m_gameListSelection`, `m_currentAppFilter`, `m_collectionsAppFilter`.
- **`collectionStore.BIsVisible` and `BIsHidden` are own, non-writable, non-configurable properties** (bound mobx actions). Assigning to them silently does nothing, so they cannot be overridden at runtime. Patching the source is the only route.

## Experiment 1: the shared seam

### What Steam's code does (sp.js, build 1794536281)

```js
BIsHidden(Z){const te=typeof Z=="number"?Z:Z.appid,Q=this.collectionsFromStorage.get("hidden");return Q&&Q.apps.has(te)}
BIsVisible(Z){const te=typeof Z=="number"?o.tw.GetAppOverviewByAppID(Z):Z;return te&&(te.app_type==j.bs||!te.visible_in_game_list)?!1:te&&!te.BIsAppBlocked()&&!this.BIsHidden(te.appid)}
```

`BIsVisible` is the better seam than `BIsHidden`. `BIsHidden` also drives the "Hidden" badge, the Manage > Hide/Unhide menu entries and the Properties > Privacy "Hide this game" checkbox; overriding it would make tagged games look natively hidden and offer "Remove from Hidden", whose click calls `SetAppsAsHidden`. `BIsVisible` is read-only and its callers are presentation:

- every collection's `visibleApps` (`this.allApps.filter(Z=>he.BIsVisible(Z))`; the Hidden collection uses its own filter) and `GetAppCountWithToolsFilter`, so lists and counts;
- Library Home What's New and takeover events (`GetLibraryHomeBestEventsForUser`, `GetTakeOverEvents`: `B.md.BIsVisible(z.appid)`);
- Play Next suggestions (`GetSuggestionsToShow`);
- a major-update event context menu (`Gr.md.BIsVisible(Ui)`).

Library search does its own `BIsHidden` filtering (`pn=en.filter(...!G.md.BIsHidden(...))`) on `appStore.allApps`, but it still lost the game with only `BIsVisible` patched (below), so its results go through a visible collection too.

### The patch (backend/main.lua)

- file `sp\.js`, find `BIsVisible\(\w+\)\{const \w+=typeof \w+=="number"\?[\w.]+\.GetAppOverviewByAppID\(\w+\):\w+;return [^}]*&&!this\.BIsHidden\(\w+\.appid\)\}`
- transform appends `&&!(#{{self}}?.sdIsTagged?.(te.appid)??!1)` before the closing brace.
- Verified in the live `sp.js`: `...&&!this.BIsHidden(te.appid)&&!(window.PLUGIN_LIST['steam-discreet']?.sdIsTagged?.(te.appid)??!1)}`.
- Patches only took effect after a full Steam restart; the hot plugin restart from `bun run build` did not re-patch `sp.js`.

### Live result with one test App ID (427520, Factorio: installed, a Favorite, in one user collection)

| Check | Before | With the patch |
| --- | --- | --- |
| `collectionStore.BIsVisible(427520)` | true | false |
| All (`my-games`) visible / all | 202 / 202 | 201 / 202 |
| Locally installed visible / all | — | 51 / 52 |
| Favorites visible / all | — | 17 / 18 |
| User collection "Base building / simulation" visible / all | — | 10 / 11 |
| Library search, exact name "Factorio" | — | no result (control "Battle Brothers": found) |
| Library search, partial "Factor" | — | no result |
| `BIsHidden(427520)`, Hidden collection size | false, 1 | false, 1 (unchanged) |
| `BIsFavorite(427520)` | true | true (membership kept) |
| Rendered main-window text containing "Factorio" | — | 0 |

Fail open was seen by accident: with `sdIsTagged` removed from the plugin object, `BIsVisible(427520)` went back to true.

Not yet checked: Home shelves and Recent Games on screen (Factorio is not in the recent collection), long virtualised lists while scrolling, the sidebar row itself on screen.

### Reactivity (blocker for "turning it off hides them immediately")

`visibleApps` is a cached mobx computed. Changing what `sdIsTagged` returns changes `BIsVisible` immediately, but `allGamesCollection.visibleApps.length` stayed at 201 after one second. Making `sdIsTagged` read a mobx `observable.box` from Steam's own mobx (webpack module `89193` in `webpackChunksteamui`, found by an export with `.box` and `.array`) did not help either, because the cached computation never read that box; a dependency only registers on the next recompute.

Candidates for M3, none tried yet: have the tag check read a Steam-mobx observable from the first UI load (the frontend must be ready before the collections first compute), or find a read-only way to invalidate collection caches (`collectionStore.OnAppOverviewChange` exists but updates collection membership, so it needs reading before use).

## Experiment 2: context menu (in progress)

- Dispatching a `contextmenu` MouseEvent on a sidebar game's name span (main window DOM) opens Steam's real game context menu, rendered inline in the main window (not as a `contextmenu_*` popup). Seen items: INSTALL, Remove from Favorites, Add to, Remove from, Manage, Properties...
- The Manage submenu code filters selected apps by `E.md.BIsHidden(cr)` (sp.js around offset 13302508), next to `BIsAppInBlockList`; a candidate anchor for adding an item.
- Not yet done: injecting a test item, checking Home tile, collection grid and detail page, duplicates on reopen.

## Open question 5: writable locations (answered)

Measured through the plugin's own Lua backend (`sd_diag_probe` in `backend/diagnostics.lua`, called over CDP):

| Location | mkdir | write | rename | rename over an existing file | read back |
| --- | --- | --- | --- | --- | --- |
| `%APPDATA%\SteamDiscreet` (`C:\Users\<user>\AppData\Roaming\SteamDiscreet`) | ok | ok | ok | ok (target replaced) | ok |
| Steam folder (`<Steam>\steam-discreet-probe`) | ok | ok | ok | ok | ok |
| Relative path (resolves against the cwd, `C:\Program Files (x86)\Steam`) | ok | ok | ok | ok | ok |

APIs used: `utils.getenv("APPDATA")`, `fs.create_directories`, `utils.write_file`, `fs.rename(tmp, final)`, `utils.read_file`, `fs.remove`. `fs.rename` replaces an existing target, so the temp-file-then-rename atomic save in M2 works.

## Open question 6: HTTPS and self-replacement (answered)

- `http.get("https://api.github.com/repos/attl8d/steam-discreet/releases", {headers=...})` returned HTTP 200 with `[]` (no releases yet). A first try minutes earlier returned 404, and an unauthenticated check of the repo from PowerShell also returned 404 then, so the repo was probably private at that time. If the repo is private, the updater needs a token.
- `utils.get_backend_path()` returns an empty string: there is no unpacked plugin folder. Self-update means replacing `<Steam>\millennium\plugins\steam-discreet.star`, which is writable. Whether Millennium tolerates replacing the `.star` while the plugin runs, or needs a swap at next start, is not tested.

## Millennium backend API (from `.millennium/lsp/lua-types`, Starlight 1.1.7)

- `millennium`: `ready`, `version`, `steam_path`, `get_install_path`, `call_frontend_method`, `is_plugin_enabled`, `config.{get,set,delete,get_all,on_change}`, `assets.{read,size,list}`, `add_browser_css/js`.
- `fs`: `exists`, `create_directories`, `remove`, `remove_all`, `list`, `copy`, `rename`, `file_size`, `last_write_time`, `join`, `parent_path`, and more.
- `utils`: `read_file`, `write_file`, `append_file`, `getenv`, `exec`, `time_ms`, `base64_*`, `hash`, `uuid`.
- `http`: `request`, `get`, `post`, `put`, `delete`; response `{status, body, headers}`.
- RPC: a global Lua function marked `---@ffi` is callable from the frontend with `callable('<name>')` from `millennium`; a frontend export marked `/** @ffi */` appears on `window.PLUGIN_LIST['<id>']`.

## Next steps

1. Solve reactivity (above), then re-run Experiment 1 with a live toggle.
2. Check Home shelves, Recent Games and a long sidebar scroll on screen. Screen control of Steam was declined in this session, so this needs either that permission or more CDP/DOM checks.
3. Experiment 2: inject a test item into the game context menu.
4. Experiment 3: locate the Games filter dropdown and attach a control.
5. Experiment 4: trace What's New entries with several App IDs, pagination and caching.
6. Open question 7: disable the plugin and see whether the UI reloads.
