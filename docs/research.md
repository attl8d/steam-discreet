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

### Account

`App.m_CurrentUser.strSteamID` (confirmed live in M1) is read every second until it holds a valid SteamID64, then the tag file for that account is opened. Until then nothing is hidden (fail open).

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

The script tags the game through the plugin (`PLUGIN_LIST['steam-discreet'].sdLibrary`), and after each of: tagged, revealed, hidden again, untagged, it checks `BIsVisible`, membership and visible counts of All, Installed, Favorites and the game's user collections, that native Hidden and Favorites are unchanged, and that the filter state is unchanged. It untags the game at the end even if a step fails. Also to check by eye: the sidebar row and the counts in the collection headers, exact-name Library search, and Home shelves.
