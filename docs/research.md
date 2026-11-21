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
