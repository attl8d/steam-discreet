# Research notes

Findings that later sessions build on. Each entry says how it was established
and on which build. "Read from source" means not yet seen on the live client.

## Millennium Lua backend (read from source, M2)

Millennium `main` at commit `6522c24` (same as docs/PLAN.md), read on
15 November 2026. Not yet confirmed on the Windows PC.

- `src/lua_host/main.cc`: the host calls `luaL_openlibs`, so `io` and `os` are
  available. JIT is off by default. Preloaded modules: `json` (cjson),
  `millennium`, `http`, `utils`, `logger`, `fs`, `regex`, `datetime`.
- Packed (.star v2) backends: every file under the backend folder is registered
  in `package.preload` by its relative path, with `/` turned into `.`. So
  `backend/tagstore/store.lua` is `require("tagstore.store")`, the same name the
  busted `lpath` resolves in tests. Confirmed in the packed file with
  `starlight inspect` (starlight 1.1.6 binary from `@steambrew/starlight` 1.1.7).
- Frontend to backend calls (`handle_evaluate`): the method name is looked up as
  a global function (or `table:method`). Arguments are pushed positionally; JSON
  strings, numbers, booleans, objects and arrays are supported. A returned table
  is converted with `lua_table_to_json`, which turns an **empty table into a JSON
  object**, not an array. So the tag store sends ID lists as comma-separated
  strings. Return values are capped at half the IPC frame size.
- `starlight lsp` generates `.millennium/types/backend/index.d.ts` from
  `---@ffi` annotations on global Lua functions, typed as `backend.<name>`.
  A table return is typed `Record<string, unknown>`; the bridge validates it.
- `src/lua_host/api/filesystem.cc`: `fs.rename` is `std::filesystem::rename`,
  which replaces an existing target on Windows (MoveFileExW with
  REPLACE_EXISTING). `os.rename` does not, so the store renames through `fs`.
  `fs.copy` uses `overwrite_existing`. Both return `nil, message` on failure.
  `fs.remove` and `fs.create_directories` differ: they return the std::filesystem
  boolean (`false` also means "nothing to do", e.g. the folder already exists)
  plus a message only on failure. So their failure is detected by the message,
  never by `nil`.

## Tag storage location (open question 5: partly answered)

Live on the Windows PC, Millennium v3.6.3, 15 November 2026: in
`%APPDATA%\SteamDiscreet` the backend could `fs.create_directories`,
`utils.write_file`, `utils.read_file`, and `fs.rename(tmp, final)`, and the
rename replaced an existing target. `utils.get_backend_path()` returns `""` for
packed .star plugins, so nothing may depend on it (the tag store does not).
Lua `io.open` with `"wb"` and `"rb"` round-trips byte-exact there, and
`os.getenv("APPDATA")` works. `os.rename(tmp, p)` fails with "File exists" when
`p` exists (Windows C rename does not replace), while `fs.rename` does replace;
the store swaps files only through `fs.rename` (`backend/tagstore/fsio.lua`).
Still unverified: a profile path with non-ASCII characters.

Earlier notes:

Not yet verified which folders outside the plugin folder the Lua backend can
write to on the live client. Every path comes from `root()` in
`backend/tagstore/paths.lua`. Current order:

1. A test override (`set_root_override`), never used in production.
2. The `STEAM_DISCREET_DATA_DIR` environment variable, if set.
3. `%APPDATA%\SteamDiscreet` (the expected Windows default).
4. `$XDG_DATA_HOME/SteamDiscreet`, then `~/.local/share/SteamDiscreet`.

To check during M1: that the backend sees `APPDATA`, can create the folder and
rename over an existing file there, and that a user profile path with non-ASCII
characters works (Lua `io.open` uses the ANSI code page on Windows). If APPDATA
is not usable, change only `root()` and record the reason here.

## Tag file format (M2)

One file per account, `tags-<SteamID64>.txt`, plus `.bak1` (newest) to `.bak5`
and, only after a recovery, `.unreadable` (the file that could not be read).
A later recovery never replaces an earlier one: it uses `.unreadable2`,
`.unreadable3` and so on.

```text
steam-discreet-tags 1
570
730
end 2
```

The header carries the format version. A file with a higher version is never
written to. The `end <count>` trailer detects a file that was cut short. Export
files use the same format; import also accepts a bare list of IDs.

## Self-update (M6, open question 6)

Seen in: Millennium source at commit `6522c24` (13 Nov 2026), Starlight 1.1.7
(the version pinned in `package.json`, also at `starlight/` in that commit).
Not yet run on a live client. **All entries unverified live.**

### Answer to open question 6

- **HTTPS: yes.** The Lua backend can make HTTPS requests. The child Lua
  process forwards them over RPC to Millennium in Steam, which runs libcurl
  with TLS verification on by default.
- **Replacing its own file: yes, but not during startup.** The backend can
  rename files in the plugins folder, and nothing holds the `.star` open
  between reads. The safe moment is `on_unload`, so the update is staged and
  swapped at shutdown, taking effect at the next Steam start. Reasons below.

### Lua modules (preloaded in `src/lua_host/main.cc`, `register_preloaded_module`)

`json` (lua-cjson), `millennium`, `http`, `utils`, `logger`, `fs`, `regex`,
`datetime`. Plus LuaJIT's own `bit`, `io`, `os` from `luaL_openlibs`. JIT is
off by default (`luaJIT_setmode ... LUAJIT_MODE_OFF`).

| API | Where | Notes |
| --- | --- | --- |
| `http.get(url, opts)` / `http.request` | `api/http.cc` | Returns `{status, body, headers}` or `nil, err`. opts: `headers`, `timeout` (s, default 30), `follow_redirects` (default true), `verify_ssl` (default true), `user_agent`. Body is pushed with `lua_pushstring`, so it **stops at the first NUL byte**: fine for JSON, wrong for binaries. Body capped at 64 MB. |
| `http.download(url, path, opts)` | `api/http.cc` | Streams to a file. **Not in the Lua type stubs** (`api/types/http.lua`). Returns `{success, status, bytes_written}`. Does **not** fail on HTTP 4xx/5xx (no `CURLOPT_FAILONERROR`), so the caller must check `status`. Deletes the file only on a curl error. No timeout unless one is passed. |
| `fs.rename(from, to)` | `api/filesystem.cc` | `std::filesystem::rename`, which replaces an existing target on Windows (`os.rename` does not). |
| `fs.create_directories(path)` | `api/filesystem.cc` | Returns `true` if created, `false` if it already exists, and `false, message` on error (never `nil`), so the second value is what signals failure. |
| `utils.getenv(name)` | `api/utils.cc` | `std::getenv`. |
| `utils.hash(str)` | `api/utils.cc` | Integer hash only. There is **no SHA-256** anywhere in the Lua API, so the plugin carries its own (`backend/updater/sha256.lua`, ~20 ms per 100 KB with JIT off). |
| `millennium.get_install_path()` | `api/millennium.cc` | RPC to the parent. |
| `millennium.start_coroutine(co)` | `api/millennium.cc` | **Not in the type stubs.** Queues a coroutine that the Lua host's event loop resumes once it starts (`rpc_client::run`, `drain_pending_coroutines`), which is after `on_load` returns and the init response is sent. The host stores only a raw `lua_State*`, so the plugin must keep its own reference or the coroutine can be collected. |
| `millennium.yield_readable(fd)` | `api/millennium.cc` | Not in the stubs. Not used. |

### Lifecycle and timing (`src/engine/child_process.cc`, `src/lua_host/main.cc`)

- Each plugin backend is its own child process. `on_load` runs **before** the
  child answers Millennium's init request, and Millennium waits at most **30 s**
  for that answer before giving up on the plugin. Network calls must not run
  in `on_load`.
- `on_frontend_loaded` is delivered as a notification (no reply awaited).
- RPCs are handled one at a time on the child's event loop. While an HTTP call
  is in flight, frontend calls into this backend wait. Hence the short
  timeouts (10 s API, 60 s download; the package is ~26 KB).
- `on_unload` runs on `SHUTDOWN` (the parent waits 5 s), and also when the
  backend's socket closes because Steam died (`main.cc`, `handle_shutdown`
  after `rpc.run` returns). Only a hard kill of the backend process itself
  skips it. A swap after a Steam crash is harmless: it is a single rename and
  nothing is reading the file.
- Frontend calls into the backend name a **global** Lua function, or
  `table:method` on a global table (`main.cc`, `handle_evaluate`). The
  plugin's returned module table is not searched.

### Plugin files (`src/engine/plugin_manager.cc`, `src/engine/star_parser.cc`, `src/system/environment.cc`)

- Plugins folder: env `MILLENNIUM__PLUGINS_PATH`, set by Millennium in Steam's
  process; on Windows `<install path>/plugins`. The child should inherit the
  variable; `millennium.get_install_path() .. "/plugins"` is the fallback.
- Millennium loads every `*.star` file in that folder, and every subfolder
  that has a `plugin.json`. So the update folder is a plain folder
  (`steam-discreet.update/`) and never holds a loadable plugin directly.
- Starlight writes `<id>.star`, so the installed file is
  `<plugins>/steam-discreet.star`. If the user renamed it, the updater stages
  but does not swap, and says so in its status.
- For a `.star` plugin `MILLENNIUM_PLUGIN_SECRET_BACKEND_ABSOLUTE` is empty
  (`backend_dir` is erased from the init params), so the backend cannot ask
  for its own path.
- **Why not swap at startup:** Millennium reads the frontend `bundle.js` and
  `webkit.js` from the `.star` path lazily, on first request, after all
  backends are ready (`plugin_loader.cc`, `register_virtual_resource`), and
  `millennium.assets.read` reopens the file at offsets indexed at spawn time.
  Swapping during startup would give one session the old backend with the new
  frontend and wrong asset offsets.
- `.star` layout: optional shim prefix (u32 LE length + Lua shim), then the
  `STAR` magic and a 12-byte header. Starlight's `--release` output has the
  shim. Packs are unsigned unless signed with Steambrew's key; unsigned packs
  load with `trusted = false`.
- Millennium's own updater (`bindings/plugin_mgr.cc`, `update_star_plugin`)
  only covers Steambrew-store plugins, downloads to `__tmp_<uuid>.star` and
  renames over the live file. That confirms renaming over the `.star` is the
  supported mechanism.

### Still to check on the live client

1. `utils.getenv("MILLENNIUM__PLUGINS_PATH")` returns the folder inside the child.
2. `millennium.start_coroutine` runs the check after startup without delaying it.
3. `http.get` to `api.github.com` and `http.download` from a release URL work
   through Steam's network settings (redirect to `release-assets.githubusercontent.com`).
4. `on_unload` runs on a normal Steam exit and the swap completes within 5 s.
5. After the swap, the next start loads the new version, and a rollback restores the old one.
   Also check that `steam_discreet_update_status` and `steam_discreet_update_rollback` can be called from the frontend.
6. Paths with non-ASCII characters: `io.open` and the `fs` module both take
   narrow strings, so a non-ASCII Millennium install path may fail on Windows.

## Millennium patch engine (read from source)

Source: Millennium v3.6.3, commit `6522c24`, read on 15 November 2026. Files: `src/lua_host/main.cc`, `src/instrumentation/loopback/src/{engine,lib,ipc,syntax,url}.rs`, `src/mep/mep_hooks.cc`. Corrections from the PR #3 review are included. Not yet observed in a running Steam.

- **How patches reach Millennium.** The Lua host reads `patches` from the table the backend entry file returns, right after the file runs. Each entry has `file`, `find` and `transforms` (`match`, `replace`). Non-string fields become empty strings, and `ipc.rs` `parse_patch_list` then drops any patch whose `file` or `find` is empty, without a message.
- **Packaging.** In a `.star` plugin, every file under `backend/` that matches `[backend] sources` is registered in `package.preload` under its path relative to `backend/`, with `/` turned into `.` (a path with `..` is skipped). A file that fails `luaL_loadbuffer` is silently not registered, and its error is discarded. Files outside `backend/` cannot be `require`d. This is why the hook definitions are `backend/hook_definitions.lua`. `backend/hooks/init.lua` would register as `hooks.init`, not `hooks`.
- **Preloaded modules** available to the backend: `json` (cjson), `millennium`, `http`, `utils`, `logger`, `fs`, `regex`, `datetime`. Their APIs have not been checked.
- **Regex engine.** Rust `regex` crate, version 1.12.4 in Millennium's `Cargo.lock`. No lookaround or backreferences.
- **Bad patterns hurt every plugin, not just ours.** All plugins' `file` patterns are compiled into one `RegexSet`:
  - If any `file` pattern fails to compile, the whole patch list is discarded.
  - If a `find` fails to compile, `PatchSet::build` skips that patch, but `apply_patches` still looks patches up by their `RegexSet` index. Every later patch, from every plugin, shifts by one: a patch can be applied to a file meant for another, or the index runs past the end, which panics; `catch_ffi` in `lib.rs` catches the panic and the file is served unpatched.
  - A bad transform `match` skips only that transform, so the rest of the patch still applies.

  The fixture harness and `tools/patch-crosscheck` exist to stop all three from shipping.
- **`file`** is searched (unanchored) in the local file path the `steamloopback.host` URL maps to (`lib.rs`: `local_path.to_str()`, falling back to the URL). On Windows that is a path with backslashes; fixtures use `C:\Program Files (x86)\Steam\steamui\chunk~<hash>.js`. The exact path has not been observed, so a `file` pattern should match only the file name.
- **`find`** applies to its first match in the current buffer only. Transforms run in order, each `replace_all` inside that match, and the match region grows or shrinks with each transform.
- **`replace`** goes through `expand_self` (`#{{self}}` to `window.PLUGIN_LIST['<plugin id>']`) and then `re2_to_rust_rep`: `\N` (one digit) becomes `$N` and every `$` becomes `$$`. Rust then reads `$N` followed by a letter, digit or `_` as a group name, so `\1a` and `\12` expand to nothing. `backend/hooks.lua` rejects that.
- **Syntax check after patching.** For `.js` and `.mjs` URLs, `lib.rs` parses the patched file with oxc 0.135.0 as an ES module (`SourceType::mjs()`). On any error it reverts the WHOLE file to the original, dropping every plugin's patches to it, and emits a `syntax_error` event. `tools/patch-crosscheck` runs the same parser on every patched fixture.
- **Several plugins on one file** are applied in alphabetical order of plugin name; overlapping `find` matches are logged as a conflict.
- **Frontend exports.** The plugin's frontend module exports are assigned to `window.PLUGIN_LIST['<id>']` after the frontend loads (`starlight/src/bundler/shim.js`), so Steam code patched to call into the plugin can run before that object has those exports. Hence the `?.` guard. Whether `window.PLUGIN_LIST` itself always exists before Steam's chunks run is not known; the self-check marker avoids depending on it.

## Open questions for the live client

- The exact local path the `file` pattern is matched against.
- Whether patched chunk code runs in `SharedJSContext` (where the self-check marker global is read) or in each popup window.
- Whether the CDP repair script or the plugin can reach Millennium's own patch events. `src/mep/mep_hooks.cc` serves `patch.list` and `patch.updates` with per-plugin `url_seen`, `match`, `no_match` and `syntax_error` events. That would say "find did not match" directly, including for on-demand hooks the self-check marker cannot see yet.

## M1 feasibility (live client)

Every finding here names the Steam build it was seen on. Later sessions start from this file.
All live findings below were made on 15 November 2026, Steam client build **1794536281** (stable), Millennium **v3.6.3**, unless noted.

### Summary

| Item | Result |
| --- | --- |
| Experiment 1, shared seam | **Proven** for the data layer: one patch to `collectionStore.BIsVisible` removes a game from All, Installed, Favorites, user collections and their counts, and from exact-name Library search, without touching Hidden. **Open:** turning it on and off live does not recompute Steam's cached lists (see "Reactivity"). Home shelves not yet checked on screen. |
| Experiment 2, context menu | **In progress.** The game context menu can be opened over CDP and read. No item injected yet. |
| Experiment 3, toggle control | **Not started.** |
| Experiment 4, What's New | **Partly answered from source:** the Library Home "What's New" list is filtered through the same `BIsVisible(appid)`, one App ID per event. Multi-game posts, pagination and caching not traced. |
| Open question 5 (writable locations) | **Answered:** the backend can create, write, rename and replace files in `%APPDATA%\SteamDiscreet`, and in the Steam folder. |
| Open question 6 (HTTPS, self-replace) | **Answered:** `http.get` to api.github.com works. There is no plugin folder to replace: the plugin is one `.star` file, and that folder is writable. |
| Open question 7 (disable reloads UI) | Not tested. |

### Environment

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

### Build and install (M1 step 2)

- `bun run build` (`starlight pack`) writes one packed file, `<Steam>\millennium\plugins\steam-discreet.star`, and hot-restarts the plugin.
- `output_path` in `millennium.toml` names the **file**, not the folder. Pointing it at the folder fails with "Access is denied (os error 5)". It is now set explicitly to `C:/Program Files (x86)/Steam/millennium/plugins/steam-discreet.star`; `"auto"` resolves the same file from the registry.
- The plugins folder is writable without elevation after the Millennium installer ran.
- The plugin was active right after the first build (it appeared in `PLUGIN_LIST`), without enabling it in Millennium settings.
- The `.star` bundle is served to the page as `https://millennium.ftp/star/steam-discreet/bundle.js`.

### CDP access

- `<Steam>\.cef-enable-remote-debugging` exposes CDP on `127.0.0.1:8080`.
- **Millennium deletes this file on every Steam start** (its health check lists it as a deprecated file; string in `millennium.dll` next to "Failed to remove deprecated file"). Steam has already read it by then, so CDP still works for that session. It must be recreated before each start. `scripts/restart-steam.ps1` does that, restarts Steam and waits for CDP.
- After the Millennium installer ran, the Steam folder was writable without elevation, so the flag no longer needs admin rights.
- `scripts/cdp.ts` (Bun, no dependencies):
  - `bun scripts/cdp.ts targets` lists every Steam window.
  - `bun scripts/cdp.ts eval "<expr>"` or `eval @file.js` evaluates in `SharedJSContext` (or `--target <title>`), awaiting promises.
  - `bun scripts/cdp.ts find "<anchor>"` prints source around each match in every loaded script (`--regex`, `--context N`, `--max N`). Steam's main bundle is `https://steamloopback.host/sp.js?contenthash=ecfb6699297d77d920fd` (about 16 MB).
- Main window: `g_PopupManager.GetPopups()` entry named `SP Desktop_uid0`; its DOM is `popup.m_popup.document`. Opening the Library: `SteamClient.URL.ExecuteSteamURL('steam://open/games')`.

### Globals confirmed in SharedJSContext

`collectionStore`, `appStore`, `uiStore`, `g_PopupManager`, `App`, `SteamClient` exist. `App.m_CurrentUser.strSteamID` is a string. `PLUGIN_LIST` keys: `steam-discreet`, `core`.

- `collectionStore` methods include `BIsHidden`, `BIsVisible`, `BIsFavorite`, `GetCollection(id)`, `SetAppsAsHidden` (never call), and collections `allGamesCollection` (`my-games`), `localGamesCollection` (`local-install`), `recentAppsCollection`, `userCollections`, `GetCollection('favorite')`, `GetCollection('hidden')`.
- `appStore`: `allApps` (334 entries here), `GetAppOverviewByAppID`, `BIsAppPrivate(appid)` (`m_setPrivateApps.has`).
- `uiStore` keys include `m_gameListSelection`, `m_currentAppFilter`, `m_collectionsAppFilter`.
- **`collectionStore.BIsVisible` and `BIsHidden` are own, non-writable, non-configurable properties** (bound mobx actions). Assigning to them silently does nothing, so they cannot be overridden at runtime. Patching the source is the only route.

### Experiment 1: the shared seam

#### What Steam's code does (sp.js, build 1794536281)

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

#### The patch (backend/main.lua)

_Superseded in M3 by hook `library-visibility` in `backend/hook_definitions.lua`, which calls `sdShouldHide` and carries a self-check marker. Kept as the record of what M1 ran._

- file `sp\.js`, find `BIsVisible\(\w+\)\{const \w+=typeof \w+=="number"\?[\w.]+\.GetAppOverviewByAppID\(\w+\):\w+;return [^}]*&&!this\.BIsHidden\(\w+\.appid\)\}`
- transform appends `&&!(#{{self}}?.sdIsTagged?.(te.appid)??!1)` before the closing brace.
- Verified in the live `sp.js`: `...&&!this.BIsHidden(te.appid)&&!(window.PLUGIN_LIST['steam-discreet']?.sdIsTagged?.(te.appid)??!1)}`.
- Patches only took effect after a full Steam restart; the hot plugin restart from `bun run build` did not re-patch `sp.js`.

#### Live result with one test App ID (427520, Factorio: installed, a Favorite, in one user collection)

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

#### Reactivity (blocker for "turning it off hides them immediately")

`visibleApps` is a cached mobx computed. Changing what `sdIsTagged` returns changes `BIsVisible` immediately, but `allGamesCollection.visibleApps.length` stayed at 201 after one second. Making `sdIsTagged` read a mobx `observable.box` from Steam's own mobx (webpack module `89193` in `webpackChunksteamui`, found by an export with `.box` and `.array`) did not help either, because the cached computation never read that box; a dependency only registers on the next recompute.

Candidates for M3, none tried yet: have the tag check read a Steam-mobx observable from the first UI load (the frontend must be ready before the collections first compute), or find a read-only way to invalidate collection caches (`collectionStore.OnAppOverviewChange` exists but updates collection membership, so it needs reading before use).

### Experiment 2: context menu (in progress)

- Dispatching a `contextmenu` MouseEvent on a sidebar game's name span (main window DOM) opens Steam's real game context menu, rendered inline in the main window (not as a `contextmenu_*` popup). Seen items: INSTALL, Remove from Favorites, Add to, Remove from, Manage, Properties...
- The Manage submenu code filters selected apps by `E.md.BIsHidden(cr)` (sp.js around offset 13302508), next to `BIsAppInBlockList`; a candidate anchor for adding an item.
- Not yet done: injecting a test item, checking Home tile, collection grid and detail page, duplicates on reopen.

### Open question 5: writable locations (answered)

Measured through the plugin's own Lua backend (`sd_diag_probe` in `backend/diagnostics.lua`, called over CDP):

| Location | mkdir | write | rename | rename over an existing file | read back |
| --- | --- | --- | --- | --- | --- |
| `%APPDATA%\SteamDiscreet` (`C:\Users\<user>\AppData\Roaming\SteamDiscreet`) | ok | ok | ok | ok (target replaced) | ok |
| Steam folder (`<Steam>\steam-discreet-probe`) | ok | ok | ok | ok | ok |
| Relative path (resolves against the cwd, `C:\Program Files (x86)\Steam`) | ok | ok | ok | ok | ok |

APIs used: `utils.getenv("APPDATA")`, `fs.create_directories`, `utils.write_file`, `fs.rename(tmp, final)`, `utils.read_file`, `fs.remove`. `fs.rename` replaces an existing target, so the temp-file-then-rename atomic save in M2 works.

Plain Lua in the same backend, same folder:

| Call | Result |
| --- | --- |
| `os.getenv("APPDATA")` | works |
| `io.open(p, "wb")`, `f:write(...)` with `\0` and `\r\n`, `io.open(p, "rb")`, `r:read("*a")` | byte-exact round trip |
| `os.rename(tmp, p)` with `p` already existing | **fails**: `...\probe2.txt: File exists`. C `rename` on Windows does not replace. |

So the M2 atomic save must replace the target with Millennium's `fs.rename`, not `os.rename` (or remove the target first, which leaves a window with no file).

### Open question 6: HTTPS and self-replacement (answered)

- `http.get("https://api.github.com/repos/attl8d/steam-discreet/releases", {headers=...})` returned HTTP 200 with `[]` (no releases yet). A first try minutes earlier returned 404, and an unauthenticated check of the repo from PowerShell also returned 404 then, so the repo was probably private at that time. If the repo is private, the updater needs a token.
- `utils.get_backend_path()` returns an empty string: there is no unpacked plugin folder. Self-update means replacing `<Steam>\millennium\plugins\steam-discreet.star`, which is writable. Whether Millennium tolerates replacing the `.star` while the plugin runs, or needs a swap at next start, is not tested.

### Millennium backend API (from `.millennium/lsp/lua-types`, Starlight 1.1.7)

- `millennium`: `ready`, `version`, `steam_path`, `get_install_path`, `call_frontend_method`, `is_plugin_enabled`, `config.{get,set,delete,get_all,on_change}`, `assets.{read,size,list}`, `add_browser_css/js`.
- `fs`: `exists`, `create_directories`, `remove`, `remove_all`, `list`, `copy`, `rename`, `file_size`, `last_write_time`, `join`, `parent_path`, and more.
- `utils`: `read_file`, `write_file`, `append_file`, `getenv`, `exec`, `time_ms`, `base64_*`, `hash`, `uuid`.
- `http`: `request`, `get`, `post`, `put`, `delete`; response `{status, body, headers}`.
- RPC: a global Lua function marked `---@ffi` is callable from the frontend with `callable('<name>')` from `millennium`; a frontend export marked `/** @ffi */` appears on `window.PLUGIN_LIST['<id>']`.

### Next steps

1. Solve reactivity (above), then re-run Experiment 1 with a live toggle. (M3: fix designed from source, see "M3 library hiding"; live check pending.)
2. Check Home shelves, Recent Games and a long sidebar scroll on screen. Screen control of Steam was declined in this session, so this needs either that permission or more CDP/DOM checks.
3. Experiment 2: inject a test item into the game context menu.
4. Experiment 3: locate the Games filter dropdown and attach a control.
5. Experiment 4: trace What's New entries with several App IDs, pagination and caching.
6. Open question 7: disable the plugin and see whether the UI reloads.

## M3 library hiding (read from source, live check pending)

Written 21 November 2026. The Windows PC was not reachable from the M3 session, so everything here comes from Steam's own UI code for build **1794536281**, the build M1 tested live, plus the M1 live results above. Nothing in this section has been seen in the running client yet. The live check is `scripts/live/m3-cycle.js` (below).

### Where the code came from

Valve's public client manifest `https://client-update.akamai.steamstatic.com/steam_client_win64` lists `"version" "1794536281"` and `steamui_websrc_all.zip.6b12af2378a42fe50e9fc3d8b636c5679e917581` (sha256 `c4ef0ef1…a7b69b`, matching the manifest). That zip holds `steamui/sp.js` (16,224,005 bytes) and `steamui/libraries/*`. Its `BIsVisible` body is byte-identical to the one M1 read from the live client, so it is the same code. This is a way to read a build's code without the PC; it does not replace a live check.

### The hook: `library-visibility`

- Same seam as M1 experiment 1 (`collectionStore.BIsVisible`), now in `backend/hook_definitions.lua` with portable regexes, a `#{{marker}}` and the plugin call `sdShouldHide`. Only `=== !0` (true) hides, so any other result, or a missing plugin, leaves the game visible.
- The `find` matches exactly once in the real 1794536281 `sp.js`, and the patched file parses (checked with the fixture harness against the full file; the fixture keeps a trimmed copy).
- `runs = "startup"`: every collection's `visibleApps` calls `BIsVisible` as soon as the Library computes, which M1 saw on every start.

### Why the lists did not refresh in M1, and the fix

From `sp.js` module 59671 (CollectionStore):

- Each collection class decorates `allApps` and `visibleApps` with `computed({keepAlive:true})`; `visibleApps` is `this.allApps.filter(Z=>he.BIsVisible(Z))`. The system collections themselves (`allGamesCollection`, `localGamesCollection`, `userCollections`, ...) are keepAlive computeds on the store.
- `BIsHidden` reads `collectionsFromStorage.get("hidden").apps`, an observable, which is why native Hidden refreshes lists: it is a mobx dependency of every `visibleApps`.
- So the fix is to make our check a mobx dependency too. `sdShouldHide` reads a box created with **Steam's own mobx** on every call (also while revealed, so the dependency never drops). A tag or toggle change bumps the box, and mobx recomputes exactly the lists that called `BIsVisible`, in place, with Steam's filters and sort untouched.
- Steam's mobx is webpack module `89193` in `libraries~00299a408.js` (mobx 6; export `sH` is `observable`, `EW` is `computed`). The plugin finds `observable` by shape (a function with `box` and `array`), as M1 did live, never by the minified name.
- Steam calls `configure({enforceActions:"never"})` (module `K=t(89193)`, `(0,K.jK)({enforceActions:"never"})`), so setting the box outside an action is allowed.
- Counts are cached separately: `GetAppCountWithToolsFilter(filter)` stores results in a plain `Map` (`m_mapFilterToAppCounts`), emptied only by `ClearAppCounts()`. Steam calls it itself when membership changes. The plugin calls `ClearAppCounts()` on every reachable collection before bumping the box. It clears a cache of numbers; it changes no collection, Hidden or Private state.
- The collections reached: `GetCollection(id)` for the built-in ids that `GetCollection` resolves (listed in `frontend/integrations/steam/collectionCounts.ts`), `userCollections` and `collectionsFromStorage`.
- Timing: Millennium appends plugin frontends once `App.BFinishedInitBeforeLogin()` is true (`src/typescript/sdk/src/index.ts` `startClient`, Millennium `ca8976d`), i.e. before login and before the Library has app data. The plugin creates the box when its module loads, so lists computed after that depend on it. A list computed before the plugin loaded would not refresh until Steam recomputes it; the live check shows whether that happens.
- `tests/frontend/steamReactivity.test.ts` models this with real mobx 6: keepAlive `visibleApps`, the count Map and an autorun "sidebar". It shows the lists and counts update on tag, reveal, hide and untag, and that without the box they stay stale (the M1 result).

### Count-only readers (known gap, check live)

A count is recomputed only by the first reader after `ClearAppCounts()`; that reader then depends on the signal. A second reader of the same collection and filter gets the cached number, reads nothing of ours, and would not refresh on the next change. `tests/frontend/steamReactivity.test.ts` shows both: one count-only autorun stays current over several changes, and a second one of the same cache goes stale. Whether Steam has two such readers at once (for example a collection tile count in the Collections view and the same collection's sidebar header) is for the live check. If it does, the fix is a hook on `GetAppCountWithToolsFilter` that reads the signal on a cache hit.

### Account

`App.m_CurrentUser.strSteamID` (confirmed live in M1) is read every second until it holds a valid SteamID64, then the tag file for that account is opened. Until then nothing is hidden (fail open). If opening fails (the RPC throws or the reply is unusable), it is retried with a doubling delay (2 s up to 60 s) and the toggle state carries a warning until the tags load.

### Hook status

The library service reads the backend's manifest (`steam_discreet_hook_manifest`, a JSON string) and runs it through `services/hookStatus.ts` with the marker. So a hook the backend rejected, or a definitions file that failed to load, warns at once with the reason; a startup hook not seen within 60 s warns as missing. If the manifest cannot be read, the hook is assumed to be the declared startup hook.

### Names used and their status

| Name | Status |
| --- | --- |
| `collectionStore.BIsVisible`, `BIsHidden`, `BIsFavorite`, `GetCollection`, `userCollections` | Live, M1, build 1794536281 |
| `App.m_CurrentUser.strSteamID` | Live, M1 |
| mobx `observable` found by `.box`/`.array` shape in `webpackChunksteamui` | Live, M1 |
| `collectionStore.collectionsFromStorage`, collection `ClearAppCounts()` | Source only, build 1794536281. Each is type-checked before use; a miss skips that cache. |
| `uiStore.m_currentAppFilter.ToStorageFormat()` | Source only; used by the live check script only, to prove filter state is unchanged. |

### Live check to run on the PC

```text
bun run build                       # then restart Steam (patches need a full restart)
bun scripts/cdp.ts eval "globalThis.SD_CHECK_APPID = 427520"
bun scripts/cdp.ts eval @scripts/live/m3-cycle.js
```

The script tags the game through the plugin (`PLUGIN_LIST['steam-discreet'].sdLibrary`), and after each of: tagged, revealed, hidden again, untagged, it checks `BIsVisible`, membership and visible counts of All, Installed, Favorites and the game's user collections, that native Hidden and Favorites are unchanged, and that the filter state is unchanged. It untags the game at the end even if a step fails. Also to check by eye, with the game tagged and then revealed: the sidebar row and the counts in the sidebar collection headers, the collection tiles and their counts in the Collections view (a count-only surface, see above), exact-name Library search, and Home shelves.

## M4 tag menu and reveal toggle (read from source, live check pending)

Read on 21 November 2026 from Valve's public `steamui_websrc_all.zip` for build **1794536281** (same zip and hash as in "M3 library hiding"). A first read-only probe ran on the Mac client, same build and the same sp.js contenthash `ecfb6699297d77d920fd` (branch `live-out/m4-probe`).

### Game context menu (hook `game-context-menu`)

- One class component builds the game context menu: webpack module `43394`, exported as `uU`, the class with `GetTargetApps()`. It is a mobx observer. Its `render()` starts `const Gt=this.GetTargetApps(),...;return(0,e.jsxs)(U.tz,{label:...,children:[!this.props.omitPrimaryAction&&this.GetPrimaryActionMenuItem(Gt,ot),this.props.additionalActions,...`.
- `GetTargetApps()` returns app overviews. With `includeMultiSelect` and the right-clicked game inside the current multi-selection, it is every selected app (`GetSelectedAppIds()` mapped through `GetAppOverviewByAppID`); otherwise `[this.props.overview]`. So the menu's own target list is the selection, and the item never has to read `uiStore`.
- Callers seen in sp.js: the sidebar game row (`includeMultiSelect:!0`, `strCollectionId`), grid and shelf tiles (`hasCustomArtwork`, `onChangeArtwork`), the game page gear button (`omitPrimaryAction:!0`), Downloads (`additionalActions`), major-update event cards, and a dev gallery entry. One hook covers them all.
- Steam's own "Mark as Private" item (`Ie`, `MarkAsPrivate`/`UnmarkAsPrivate`) disables itself when any target `BIsModOrShortcut()`. Steam Discreet does the same: a shortcut or mod in the selection disables the item (shortcuts are out of scope for v1).
- The hook inserts `(marker, PLUGIN_LIST['steam-discreet']?.sdTagMenuItem?.(Gt) ?? null)` right after `additionalActions`. `sdTagMenuItem` validates `Gt` in `frontend/integrations/steam/contextMenu.tsx` and never throws.
- Menu items are Steam's `U.kt` (props `onSelected`, `disabled`). The SDK's `MenuItem` rendered with Steam's `contextMenuItem` class live, and a click fired `onSelected` (below).
- `g_PopupManager` held six idle `contextmenu_*_uid0` popups on the Mac, but the game menu still rendered inline in the main window, as M1 saw on Windows. The check script searches every popup's document anyway.

### Reveal toggle (hook `reveal-toggle`)

- The sidebar header is the observer component `Pl` (props `gamelistref`, `bScrolledTop`). It renders `Bar > SearchBar > MenuHeader` (the "Games" dropdown: `ViewName` span plus `Arrow`) and then `ViewFiltersBar > Filters`, a row of icon toggles (platform, sort by recent, ready to play) styled `CheckboxWithImage` with `Active` and `Disabled`.
- The Mac probe found the `ViewName` span ("GAMES") inside `MenuHeader > SearchBar > Bar` at rect [15,135,299,19], with `Pl` four fibers up. This matches the source.
- The hook inserts the toggle as the first child of `Filters` and passes Steam's own class values for `CheckboxWithImage`, `Active` and `Disabled`, read from the CSS module at render time (keys only, never hashed values), so it looks like the neighbouring icons.
- `runs = "on_demand"`: the header renders only when the Library is shown, which is not guaranteed at every start.
- Steam's CSS fills `.Filters .CheckboxWithImage svg` (grey, blue when Active), which overrides `fill` on the `<svg>` element, so the eye sets `fill="none"` on its shapes.
- Failure handling (`services/library.ts`): if the backend manifest shows `reveal-toggle` rejected or absent, nothing could reveal, so hiding is off (fail open) with a warning. A rejected or absent `game-context-menu` only warns. An unmatched on_demand hook stays `not-seen` (it cannot be told from "not opened yet"), so the settings page has its own "Show adult games" switch as the way out.

### Live check

`scripts/live/m4-menu-check.js` reads the markers, finds the toggle and opens the menu on a game row; with `SD_CHECK_CLICK = true` it also clicks Mark, the toggle, Unmark and the toggle again.

First run, 21 November 2026, Mac client (macOS arm64), build 1794536281, plugin at d185668 (outputs on branch `live-out/m4-probe`, 100a551):

| Check | Result |
| --- | --- |
| Markers after start | `library-visibility` 1, `reveal-toggle` 1; `game-context-menu` 1 after the first right-click (on_demand, as expected) |
| Toggle | In `Filters` with 3 Steam icons (4 children), classes `CheckboxWithImage`, then `CheckboxWithImage Active` when on; label "Show adult games" / "Hide adult games" |
| Menu | Rendered inline in the main window on the Mac too (the six `contextmenu_*` popups were idle). Items: Play, **Mark as adult**, Remove from Favorites, Add to, Remove from, Manage, separator, Properties... Class `contextMenuItem`, so the SDK's `MenuItem` renders as Steam's own item |
| Click Mark | Tagged; menu closed |
| Click toggle | Revealed; game visible again (`BIsVisible` true) |
| Reopen menu, click Unmark | Not reached: the script right-clicked a sidebar row element that Steam had replaced while the game was hidden (script bug, fixed: rows are found again before each right-click) |
| Cleanup | Untagged, toggle off, game visible |
| Closing the menu | A synthetic Escape on the document did not close it (script bug, fixed: Escape on the menu, then a click outside, then the menu's `Hide()`) |

Rerun with the fixed script (450ceee, same plugin build; outputs at `live-out/m4-probe` 7c5fa86): read-only run ok, menu closed by Escape on the menu. Click run ok through the whole cycle: Mark (tagged, menu closed), toggle on (revealed, `Active`), menu reopened showing **Unmark as adult** in the same place, Unmark (untagged), toggle off. The tag file ended empty. **Working and tested on the Mac; to be re-confirmed on Windows.**

One read-only run made a few seconds after Steam started found no item and no `game-context-menu` marker, and a run 5 seconds later passed. Its output was not kept. The marker is set by the patched `render()` itself, before the plugin is called, so a menu rendered by patched code always sets it, even when the plugin frontend has not loaded yet. No marker therefore means the menu came from unpatched code (or did not open). That fits the first UI load: Millennium reloads the UI with patches once the backends are ready (see "Loading"). It is the same startup window PLAN.md accepts for the brief flash. Separately, if a menu opens after the reload but before the plugin frontend has loaded, the marker is set and that one menu has no item; the next one does. The check script now records `markersBefore` and `markersAfterMenu`, so a repeat would show which case it was.

## M4 full coverage (Library Home, live on the Mac)

Read on 21 November 2026 from Valve's public `steamui_websrc_all.zip` for build **1794536281** (same zip and sha256 as in "M3 library hiding"). The question was which desktop Library surfaces do **not** go through `collectionStore.BIsVisible`, the seam hook `library-visibility` already patches. Answer: none of the v1 surfaces. Every one reads `visibleApps` of a collection or calls `BIsVisible` itself, inside a mobx observer, so it hides and refreshes with the existing hook and the M3 signal. No new hook was added (principle 5).

### Surfaces and their data path (desktop Library Home, sp.js around offset 12.74M)

| Surface | Where the games come from | Covered by `library-visibility` | Backfill |
| --- | --- | --- | --- |
| Sidebar, Installed, Favorites, collections, Library search | collection `visibleApps` (M1, live) | yes, live on Windows and Mac | n/a |
| Recent Games shelf (showcase `recent-games`, component `T0`) | `GetCollection(Recent).visibleApps`; `recent` is `allRecentAppsCollection.allApps` with `mru_index`, wrapped like every collection | yes | yes: the shelf maps the whole filtered list |
| Collection shelves (any other showcase) | `m_fnSort(cs, gQ(eSortBy))`, a memoize-one of `cs.visibleApps.slice().sort(...)`. `gQ` returns a new comparator on every call, so the memo never hits and every render reads `visibleApps` | yes | yes: a one-row grid of the filtered list |
| "All collections" shelf and the Collections view | tiles (`at` / `dt` in the collection tile module): artwork is the top 13 of `visibleApps` by playtime; the count label (`Ue`) reads `visibleApps` and `GetAppCountWithToolsFilter` in two `useObserver` calls in one component | yes | yes |
| Play Next (`Z1`) | `playNextStore.GetSuggestionsToShow(devToggle)`: server list filtered with `BIsVisible` (the unfiltered branch is a settings-zoo developer toggle) | yes | no: the list comes from Steam's servers, so a hidden game leaves one fewer suggestion |
| What's New (`Wl`) | `libraryEventStore.GetWhatsNewEvents()`, whose `GetLibraryHomeBestEventsForUser()` and `GetTakeOverEvents()` filter by `BIsVisible(event.appid)` | yes | yes: up to 18 cards are taken after filtering |
| Empty-library message (`xl`) | `visibleApps.length` of Recent and the app-type collections | yes | n/a |

**What's New and App IDs.** Each event carries exactly one `appid` (the clan's app). `UpdateBestEventsForCurrentUser` already drops any event whose `appid` has no app overview (not in the library). Steam's own news apps 593110, 1675200 and 1675180 (module 4257) always pass, and cannot be tagged in practice. So there is no multi-game or ambiguous entry in this list to leave visible: an entry is about one game, and it is skipped only if that game is tagged and the toggle is off.

**Count-only readers (the M3 known gap).** Every desktop caller of `GetAppCountWithToolsFilter` also reads `visibleApps` in the same render: the sidebar collection headers (`nTotalCollectionSize` next to `visibleApps.filter(...)`), the collection page header, the showcase header and the collection tile label. A tag or toggle change recomputes `visibleApps`, those components re-render, and they read the count after `ClearAppCounts()` emptied it. So the stale second reader seen in the test model does not occur on desktop. The only count-only caller is the Big Picture tab bar (below).

### Not covered, outside v1

| Surface | What it does | Why left |
| --- | --- | --- |
| Big Picture search (`b4`, near offset 10.79M) | `appStore.allApps` filtered with `BIsHidden` only, so a tagged game is found by name | Big Picture and the Deck UI are not a v1 surface (PLAN covers the desktop Library). A fix would be one more hook on that filter. |
| Big Picture Home "Recently completed" downloads | download queue | Downloads are out of v1. |
| What's New settings dialog (gear icon) | lists games the user set to "show more" or "show less" (`GetAppsShowingMore/Less`, filtered only by "is in the library") | Only reachable by opening What's New settings, and only lists games the user re-prioritised there. Recorded as a gap. |
| "Raised/Lowered priority for <game>" notice in What's New | names the game the user just re-prioritised | Shown only right after the user acted on that game. |
| Marketing message dialog | a Steam store web page | Store, out of scope. |

### Live check

`scripts/live/m4-surfaces.js` opens Library Home (`steam://open/library`, which, unlike `steam://open/games`, does not change the Games filter) and, for one game from the first four of Recent Games and one game with a What's New entry (or `SD_CHECK_APPIDS`), runs untagged, tagged with the toggle off, toggle on, toggle off again, untagged. At each step it checks `BIsVisible`, Recent Games, Play Next, What's New and takeover entries, every user collection that holds the game, images in the main window whose URL carries the App ID and labels with the game's exact name, and that native Hidden, Favorites and filter state are unchanged. Globals it reads besides M1's: `playNextStore`, `libraryEventStore` (both assigned to `window` in sp.js, source only until this run).

First run, 21 November 2026, Mac client, build 1794536281, plugin at main `8bb198e` (output: branch `live-out/m4-probe` at `3cd6df5`, `live-out/m4-surfaces.json`, game names removed). `ok: true`, self-check `ok`, tag file empty at the end.

| Game | On at baseline | Tagged, toggle off | Toggle on, and after untag |
| --- | --- | --- | --- |
| 1062090 (from Recent Games) | Recent Games, Favorites, one user collection; 3 images and 2 name labels on Home | gone from all of them; 0 images, 0 labels | back everywhere; 3 images, 2 labels |
| 291650 (from What's New) | 1 What's New entry, one user collection; 1 image and 1 label on Home | 0 What's New entries; 0 images, 0 labels | 1 entry; 1 image, 1 label |

Each change showed within 800 ms with no reload, and turning the toggle off again hid both again. Native Hidden (10 games), Favorites and the filter state never changed.

So **Working and tested on the Mac:** Recent Games, collection shelves and lists, ordinary What's New entries, and what Home renders for them. **Not yet seen live:** Play Next (neither game was a suggestion; the script now also picks one) and takeover events (none were showing; these cannot be produced on demand). Windows is still to re-confirm.

## macOS (live, 21 November 2026)

MacBook with Apple Silicon (arm64), macOS 27.2.1. Steam client build **1794536281**, the same build as the Windows findings above, and `sp.js?contenthash=ecfb6699297d77d920fd` is byte-for-byte the same bundle, so the `library-visibility` find pattern matches unchanged.

### Millennium on macOS

- There is no official macOS build. Built from PR [SteamClientHomebrew/Millennium#841](https://github.com/SteamClientHomebrew/Millennium/pull/841) (head `35418d28`, reports itself as v3.5.0-beta.3) with Homebrew LLVM (`brew install llvm ninja cmake`, plus Rust and Bun): `CC=$(brew --prefix llvm)/bin/clang CXX=$(brew --prefix llvm)/bin/clang++ cmake --preset=osx-release -DMILLENNIUM_RUN_TESTS_ON_BUILD=OFF && cmake --build build/osx-release`.
- Installed with `scripts/macos/install_macos.sh --runtime-build-dir build/osx-release --wrapper-build-dir build/osx-release` (wrapper-app mode). It installs the runtime under `~/Library/Application Support/Millennium/runtime/<version>` and a launcher, `/Applications/Steam Millennium.app`. Steam's own files are not modified (checksums of `steam_osx` and `libtier0_s.dylib` unchanged). Launch through the wrapper; plain Steam.app still starts Steam without Millennium. `--uninstall` removes it.
- Plugins folder: `~/Library/Application Support/Millennium/plugins`. Config: `~/Library/Application Support/Millennium/config.json`. Millennium logs go to the launcher's stdout/stderr only; `scripts/restart-steam-mac.sh <logfile>` captures them.
- CDP: the launcher started with `-dev` passes `-devtools-port 8080` to Steam and manages `.cef-enable-remote-debugging` itself. `scripts/cdp.ts` works unchanged.

### Plugin JS patches do not apply with PR 841 alone

With PR 841 the plugin loads (backend, frontend, RPC), but no plugin patch is applied to Steam's JavaScript: no `__steamDiscreetHooks` marker, `BIsVisible` unchanged, and the self-check correctly reports "The Library hook did not attach" after the 60 s grace period (fail open, tag list untouched). Three gaps in Millennium, all macOS only:

1. `libmillennium_hhx64` never hooks `cef_browser_host_create_browser` on macOS (the hook is installed only under `_WIN32`/`__linux__` in `src/instrumentation/loopback/hook.c`), so Steam's own `steamloopback.host` handler keeps serving the files unpatched. libsnare's arm64 path cannot be used as is: it allocates its trampoline on the heap and makes it RWX, which Apple Silicon refuses (`snare_inline_new failed`).
2. The browser Helper never receives the patch list: on Windows and Linux the host passes `--millennium-loopback-ipc-{handles,fds}` and pipes; the macOS pipe bootstrap (`src/bootstrap/macos/pipe_bootstrap.h`) only passes the CDP pipes.
3. `src/instrumentation/loopback/src/url.rs` looks for `steamui` under `~/Library/Application Support/Steam`; on macOS it is under `Steam.AppBundle/Steam/Contents/MacOS/steamui`.

A local fix for all three (`tools/millennium-macos/0001-*.patch`, to apply on top of PR 841; not published upstream): an arm64 inline hook with a `MAP_JIT` trampoline and a `VM_PROT_COPY` patch of the 16-byte prologue (Steam Helper has no hardened runtime; the prologue is checked to be position independent), loopback IPC pipes on fds 5 and 6 handed over with the CDP pipes, and the corrected `steamui` path. With it the patch engine logs `sp.js: 'steam-discreet': matched [11982324, 11982642), 1 transform(s), +133 B`. Millennium's C++ and Rust tests pass; `millennium_macos_connector_tests` has the same one failure (`MillenniumAcceptPipeBroker` in "failed handoff preserves the current Helper connection") with and without the fix.

Also in `tools/millennium-macos` (`0002`): upstream commit `2c15d5ba` ("Fix Millennium sidebar menu crashing on latest beta"), cherry-picked. PR 841 predates it, and without it Millennium's own sidebar panel shows "An error occurred while rendering this content" (`TypeError: Cannot read properties of undefined (reading 'Title')`, from `quickAccessMenuClasses`) on every start. It is not related to this plugin.

### Live result with the fix

`scripts/live/m3-cycle.js` on App ID 813780 (a Favorite, in one user collection, not installed): all four steps pass. Tagged with the toggle off, it leaves All (202 to 201), Favorites (18 to 17) and its user collection (8 to 7) immediately, without a reload; it returns when revealed and again when untagged. Native Hidden, Favorites and filter state unchanged. Self-check `ok`.

Tag storage on the live client: the backend runs under LuaJIT (`jit.os == "OSX"`), so the tag file now lives in `~/Library/Application Support/SteamDiscreet/tags-<SteamID64>.txt` (`backend/tagstore/paths.lua`); writes, `.bak` rotation and untag worked. Before this change the Mac fell back to `~/.local/share/SteamDiscreet` (`XDG_DATA_HOME` is unset). Only the live test above wrote there, its list was empty after the final untag, and that folder was removed; no tags exist at the old path, so no migration is needed.

Not checked on the Mac yet: the sidebar and Home shelves by eye, the context-menu item and toggle control, the self-updater.

### Tooling

- `@steambrew/starlight` 1.1.7 ships Windows and Linux binaries only. Built from the Millennium repo at `58528aa8` ("release starlight v1.1.7"), `starlight/`, `cargo build --release`, and copied to `node_modules/@steambrew/starlight/binaries/starlight-darwin-arm64`.
- Starlight's `"auto"` output path is not implemented on macOS; `bun run build:mac` passes `--of` instead. `--of` takes a folder and appends `<id>.star`.
