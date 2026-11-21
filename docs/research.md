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
