# Research notes

Findings that later sessions build on. Each entry says where it came from and, for anything seen in the live client, the Steam build. Nothing here has been checked against the live Steam client unless it says so.

## Millennium patch engine (read from source)

Source: Millennium v3.6.3, commit `6522c24`, read on 15 November 2026. Files: `src/lua_host/main.cc`, `src/instrumentation/loopback/src/engine.rs`. Not yet observed in a running Steam.

- **How patches reach Millennium.** The Lua host reads `patches` from the table the backend entry file returns, right after the file runs. Each entry has `file`, `find` and `transforms` (`match`, `replace`). Non-string fields become empty strings.
- **Packaging.** In a `.star` plugin, every file under `backend/` that matches `[backend] sources` is registered in `package.preload` under its path relative to `backend/`, with `/` turned into `.` (a path with `..` is skipped). Files outside `backend/` cannot be `require`d. This is why the hook definitions are `backend/hook_definitions.lua`. `backend/hooks/init.lua` would register as `hooks.init`, not `hooks`.
- **Preloaded modules** available to the backend: `json` (cjson), `millennium`, `http`, `utils`, `logger`, `fs`, `regex`, `datetime`. Their APIs have not been checked.
- **Regex engine.** Rust `regex` crate, version 1.12.4 in Millennium's `Cargo.lock`. No lookaround or backreferences.
- **A bad `file` pattern breaks every plugin.** All plugins' `file` patterns are compiled into one `RegexSet`; if any fails to compile, the whole patch list is discarded. A bad `find` skips that patch; a bad transform `match` skips only that transform, so the rest of the patch still applies. The fixture harness and `tools/patch-crosscheck` exist to stop all three from shipping.
- **`file`** is searched (unanchored) in the script's file name. What exactly that string looks like (full URL or path) has not been observed; fixtures use `https://steamloopback.host/chunk~<hash>.js` as a guess, and the `file` pattern must not depend on the prefix.
- **`find`** applies to its first match in the current buffer only. Transforms run in order, each `replace_all` inside that match, and the match region grows or shrinks with each transform.
- **`replace`** goes through `expand_self` (`#{{self}}` to `window.PLUGIN_LIST['<plugin id>']`) and then `re2_to_rust_rep`: `\N` (one digit) becomes `$N` and every `$` becomes `$$`. Rust then reads `$N` followed by a letter, digit or `_` as a group name, so `\1a` and `\12` expand to nothing. `backend/hooks.lua` rejects that.
- **Several plugins on one file** are applied in alphabetical order of plugin name; overlapping `find` matches are logged as a conflict.
- **Frontend exports.** The plugin's frontend module exports are assigned to `window.PLUGIN_LIST['<id>']` after the frontend loads (`starlight/src/bundler/shim.js`), so Steam code patched to call into the plugin can run before that object has those exports. Hence the `?.` guard. Whether `window.PLUGIN_LIST` itself always exists before Steam's chunks run is not known; the self-check marker avoids depending on it.

## Open questions for the live client

- What string the `file` pattern is matched against.
- Whether patched chunk code runs in `SharedJSContext` (where the self-check marker global is read) or in each popup window.
