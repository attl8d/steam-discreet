# Research notes

Findings that later sessions build on. Each entry says where it was seen: a
Steam build on the live client, or Millennium source at a given commit.
Source reading is not live verification; entries marked **unverified live**
still need a check on the Windows PC (M1/M7).

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
| `fs.create_directories(path)` | `api/filesystem.cc` | Returns `false` if it already exists, `nil, err` on error. |
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
- `on_unload` runs on `SHUTDOWN`; the parent waits 5 s. It is not called if
  Steam is killed or crashes.

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
6. Paths with non-ASCII characters: `io.open` and the `fs` module both take
   narrow strings, so a non-ASCII Millennium install path may fail on Windows.
