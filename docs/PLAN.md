# AdultOnly implementation plan

Revised 15 November 2026 (original prepared 31 October 2026). Status: planning; no plugin code or live Steam testing has started.

## Purpose

A small Millennium plugin for the Windows Steam desktop client. The user tags games as adult, and those games stay out of ordinary Library browsing until one toggle reveals them.

**Who it hides games from: the user themself.** The goal is to browse the Library without seeing tagged games unless the toggle is on. Nobody is trying to get past it, so the plugin has to be reliable and unobtrusive, not leak-proof.

**Why not Steam's native Hidden feature:** it moves games to a separate place. Here, tagged games keep their collections, Favorites, sort position and play history, and reappear exactly where they belong when revealed.

## Principles

1. **The toggle is the source of truth.** While it is off, a tagged game does not appear in Library browsing by any route, including typing its exact name in Library search.
2. **The tag list must never be lost.** A Steam update may break the hiding; nothing may damage the list.
3. **No thinking required.** The plugin loads with Steam, updates itself, and reports its own failures in a form that can be handed to an LLM with "fix it".
4. **Presentation only.** Never change installations, ownership, licenses, saves, achievements, download settings, collections, or native Hidden/Private status. Disabling the plugin restores ordinary Steam.
5. **Few hooks.** Every hook is a place a Steam update can break. Prefer one shared seam over one hook per surface.

## Behaviour

### Tagging
- Right-click a game: "Mark as adult" / "Unmark as adult", in Steam's real context menu.
- Works on a multi-selection. If the selected App IDs cannot be determined reliably, the item is disabled rather than guessing.
- Tags are stored per Steam account.

### Toggle off (default on every Steam start)
Tagged games are absent from:
- the sidebar and Library search (including exact-name search);
- collections, Favorites and Installed views, with counts reduced accordingly;
- Home shelves and Recent Games, with other games backfilling where Steam's shelf logic allows;
- What's New: posts only about tagged games are skipped; ordinary news is untouched.

### Toggle on
- One control next to the Games filter dropdown at the top of the sidebar. A real menu item if a stable one exists, otherwise a compact native-looking control beside it.
- Tagged games reappear in place under whatever Steam filters and sorting are active. Existing filter state is never replaced.
- Optional small marker on tagged games while revealed.
- Turning it off again hides them immediately, with no reload.
- The toggle state is never saved. It is off after every Steam start, UI reload or plugin reload.

### Settings page
- Count, searchable tagged list, per-game removal, clear-all with confirmation.
- Export and import of the tag list.
- Hook status and a "Copy diagnostic report" button.
- Must stay usable even when every Library hook has failed.

### When a hook breaks
- The affected games reappear (fail open) and the toggle shows a warning.
- The tag list is untouched.
- No blank Library, no blocked navigation.

## Scope

### In v1
Sidebar, Library search, collections, Favorites, Installed, Home shelves, Recent Games, individual What's New entries, context-menu tagging, the toggle, settings, resilient storage, self-check and diagnostics, self-update.

A build missing a listed Library surface is labelled partial.

### Deliberately not in v1, and why

| Left out | Reason |
| --- | --- |
| Startup loading guard and flash measurement | A brief flash at launch does not affect browsing. Preventing it means withholding the Library until the plugin is ready, which adds a stuck-blank failure mode. |
| Blocking a tagged game's detail page | You only land there by deliberately following something that names the game. Intercepting navigation risks breaking launch, update and verify. |
| Downloads, notifications, overlay | They only show a tagged game while it is being downloaded or played. |
| Strict fail-closed coverage states | The worst failure is seeing your own games. One warning on the toggle is enough. |
| Two-account race-condition proofs | Tags are still stored per account; the dedicated test suite is skipped unless the PC is shared. |
| Schema-migration framework | A version number in the file is enough for a future format change. |
| Store and Community filtering | Outside the Library. |
| Shortcuts (non-Steam games) | Unsupported until their identities are modelled and tested. |

### Later investigation
- **Tray recent-games menu and Windows taskbar jump list.** These can show a recently played tagged game while the toggle is off, which conflicts with principle 1. The tray menu may be reachable; the jump list is Windows-native and probably is not.

## What is already established

Read from source on 15 November 2026: Millennium at commit `6522c24`, PluginTemplate at `af0a07c`, plus the Steam Librarian and HideAchievements plugins. `docs.steambrew.app` was not reachable, and no Steam client bundle has been inspected, so nothing here is verified against Steam's own JavaScript.

### Versions and tooling
- Millennium is at v3.6.3 (13 Nov 2026). The template requires >= 3.4.0. Nearly every recent release includes fixes "for the latest Steam client".
- The template uses `millennium.toml`, a TypeScript/React frontend, a Lua backend, Bun, and the Starlight compiler (`@steambrew/starlight ^1.1.3`).
- Build output is controlled by `output_path` under `[compiler]`; the default `"auto"` installs straight into Millennium. `starlight watch` restarts the backend and reloads the UI on change.
- Steam Librarian and HideAchievements use the older `plugin.json` format. They are references for technique, not for code to copy.

### Loading
- Millennium loads inside Steam on every start and loads every enabled plugin with it. Nothing has to be launched separately.
- Plugin frontends run in one headless page, `SharedJSContext`. All visible windows are popups of it. One module variable there serves as the visibility flag for every window and resets on reload.
- Millennium reloads the Steam UI with cache ignored once all backends are ready, so patches should be in place for that load.

### Patches (regex transforms of Steam's JavaScript)
- Declared as a static table returned by the Lua backend at load. They cannot depend on account or configuration.
- `find` takes only the first match per matching file; transforms apply only inside that match. The engine is the Rust `regex` crate.
- `#{{self}}` expands to `window.PLUGIN_LIST['<id>']`. The template guards it with `?.` and a fallback, which is the pattern for "plugin missing or unloaded".
- When two plugins' matches overlap, the alphabetically first plugin name wins.
- The engine emits `url_seen`, `match`, `no_match` and `conflict` events; `[patches] debug = true` surfaces them.
- Removing a plugin's backend removes its patches from the registry. Whether that also reloads the UI was not traced.

### Storage
- Millennium's native plugin config lives in its single shared `config.json`, limited to 256 keys and 256 KB per value. Writes are atomic, but a failed write is only logged.
- That is not strong enough for the tag list. Use a file the plugin owns, written through Lua, as HideAchievements does.
- The SDK types the active account as `App.m_CurrentUser.strSteamID`, a string, so no 64-bit number conversion is needed.

### Updates
- Millennium does not auto-update plugins. It only covers plugins published on the Steambrew store, shows a notification, needs a click, and refuses to update a plugin while it is running.

### Debugging
- Creating `<Steam>\.cef-enable-remote-debugging` and restarting Steam exposes the Chrome DevTools Protocol on `localhost:8080`. Every Steam window can then be scripted, and `SharedJSContext` reaches all of them.

## Open questions to settle first

1. Does one in-memory read path, the one Steam uses for native Hidden games, cover the sidebar, search, collections, Favorites, Installed and shelves?
2. Can that read path be overridden without the result ever being written back to the real Hidden collection or synced?
3. Which records tie a What's New entry to App IDs, and where can entries be filtered?
4. Where can the context-menu item and the toggle control attach?
5. Which locations outside the plugin folder can the Lua backend write to?
6. Can the Lua backend make HTTPS requests and replace its own files, or is a swap step at next startup needed?
7. Does disabling the plugin reload the UI by itself?

## Work plan

### M1. Environment and feasibility

Needs the Windows PC with Steam on the stable channel.

1. Record Steam build, Millennium version and Windows version. Confirm Bun. Pin the template revision and Starlight version.
2. Set an explicit `output_path` for development builds.
3. Enable CDP debugging and add a script that evaluates code in `SharedJSContext` and extracts code around a given anchor from the live client.
4. Load a diagnostic plugin: confirm load, settings rendering, RPC, logging, disable/re-enable.
5. **Experiment 1, the shared seam.** With a hardcoded App ID set, override the native-Hidden read path in memory. Check every Library surface, long virtualised lists, counts and search. Confirm nothing is written to the real Hidden collection.
6. **Experiment 2, context menu.** Add one test item to the real menu from the sidebar, a Home tile, a collection grid and a detail page. Confirm the App ID, no duplicates on repeated opens, native items intact.
7. **Experiment 3, toggle control.** Attach next to the Games dropdown; confirm it survives navigation and rerenders.
8. **Experiment 4, What's New.** Trace entry-to-App-ID association, including multi-game posts, pagination and caching.
9. Answer open questions 5 to 7.

If the shared seam fails for a surface, fall back in this order: a verified presentation selector or render-input transform; a narrowly scoped component wrapper; a localised DOM fallback for non-virtualised surfaces only. No broad DOM scanner, no removal of virtualised rows, no deletion from `appStore`, no native Hidden/Private mutation.

Result: `docs/research.md` with the chosen seams, their anchors and how each was found.

### M2. Tag storage

- One plain file per Steam account, holding a version number and a deduplicated App ID set.
- Kept outside the plugin's own folder so plugin updates and reinstalls do not touch it.
- Atomic writes: temporary file, then rename.
- Rotating backups of the last several versions. If the main file is unreadable, load the newest good backup and tell the user once.
- Never write an empty list over a file that could not be read or has a newer version number.
- Keep IDs of games that are missing from the library, so a temporary metadata failure deletes nothing.
- Report a save failure instead of showing a tag as saved.
- Writes are serialised so a rapid add then remove cannot land out of order.
- Export and import.
- The visibility flag is never written to disk.

Tests: add, remove, duplicates, unreadable file, backup recovery, newer version number, failed write, export/import round trip, account separation. Exercise the real Lua file path, not only frontend mocks.

### M3. End-to-end slice

1. Scaffold from the pinned template with strict TypeScript, linting and a test runner.
2. Wire storage, the context-menu action, the toggle and the shared seam.
3. Full cycle on the live client: tag, persist, hidden while off, revealed while on, untag, restored, without disturbing Steam's filters.
4. Mounted surfaces update immediately on tag or toggle, without a Library reload.

### M4. Full coverage

- Extend to every v1 surface and check each one independently, including exact-name search.
- Add What's New filtering. For entries with missing or ambiguous App IDs, leave them visible and record the gap; never guess from titles or hide the whole section.

### M5. Self-check, diagnostics and repairability

- **Hook definitions in a data file**, separate from plugin code. Most Steam breakages are a shifted pattern, so a fix is a few changed lines.
- **Self-check on every start.** Each hook reports attached or not. Any failure puts a warning on the toggle.
- **Diagnostic report**: Steam build, Millennium version, plugin version, per-hook status, and what each failed hook was looking for. No game names or tag lists.
- **Repair guide** (`CLAUDE.md` in the repo): what each hook targets, how to find it again in a new Steam build with the CDP script, how to test, how to release.
- **Fixture tests** per hook: expected match count, transformed code still parses, unrelated input unchanged, safe when the anchor is absent or ambiguous.
- Settings page as described under Behaviour.

### M6. Self-update

1. On Steam start, the Lua backend checks the user's own GitHub repo for a newer release, in the background and without blocking startup.
2. A newer release is downloaded and staged; it takes effect at the next Steam start, with no prompt.
3. Only the user's own repo is trusted as a source. Verify the download before staging and keep the previous version for rollback.
4. A failed check or download changes nothing and is noted in the diagnostic report.
5. The tag list is never part of an update.

### M7. Validation and release

- Automated: type check, lint, storage tests, hook fixture tests, production packaging.
- Live, scripted through CDP where possible: for each v1 surface run tag, reveal, hide and untag with Installed Only, search, sorting, Favorites, manual and dynamic collections.
- Also: cold start, UI reload, plugin disable/re-enable, a deliberately broken hook, a deliberately corrupted tag file, an update and a rollback.
- Confirm launching, updating and verifying a tagged game still work.
- Edge cases: free-to-play, uninstalled, family-shared, DLC, a game no longer owned.
- Record what was run and what was not. Use these statuses: Working and tested; Implemented, awaiting live verification; Partially implemented; Not implemented; Technically blocked.
- Deliver source with lockfile, the plugin artifact, README (install, where the tag file lives, export/import, uninstall), research notes and the repair guide.

## Notes for the implementing model

### Where to run
- M1, M3, M4 and M7 need a session on the Windows PC with Steam running and CDP debugging enabled. A cloud session cannot run Steam.
- M2, the fixture tests in M5 and most of M6 can be written and tested without Steam.

### Where the user must act
- Install Millennium, enable the plugin once in Millennium settings, and create `<Steam>\.cef-enable-remote-debugging`.
- Restart Steam when asked. Backend (Lua) changes need a Steam restart; frontend changes need a UI reload.
- Create the GitHub repo and say its name. The updater in M6 trusts only that repo.

### Starting points for M1 (leads from other plugins, unverified on the current client)
- Globals in `SharedJSContext`: `collectionStore`, `appStore`, `uiStore`, `g_PopupManager`, `App.m_CurrentUser`.
- Native Hidden: `collectionStore.BIsHidden(appid)` is the first candidate for the shared seam. `collectionStore.SetAppsAsHidden()` is the write path and must never be called.
- App data: `appStore.allApps`, `appStore.GetAppOverviewByAppID(appid)`.
- Current selection: `uiStore.currentGameListSelection` (`nAppId`, `strCollectionId`).
- Windows: `g_PopupManager.GetPopups()`; the main window is named `SP Desktop_uid0`, context menus `contextmenu_…`.
- Menus: the SDK exports `Menu`, `MenuItem` and `showContextMenu`, plus React tree patching helpers under `sharedjscontext/utils` (`patcher.ts`, `react/treepatcher.ts`).
- Patch example: `backend/main.lua` in the template shows a working `find`/`transforms` entry with the `#{{self}}?.` guard.
- Hashed CSS class names change with every Steam update. Do not anchor on them.

### Rules of working
- Do not guess API names. Confirm each one in the live client before writing code that depends on it.
- A regex that matches is not proof. A seam counts as proven only when the live client shows the behaviour.
- Write every finding to `docs/research.md` as it is made, with the Steam build it was seen on. Later sessions start from that file.
- Each M1 experiment ends with one of: proven, ruled out, or blocked with the reason. Move on to the next fallback without asking; ask the user only for the actions listed above.
- Never call anything that writes to Steam's collections, Hidden or Private state, even to test.
- Report honestly what was run and what was not.

## Repair loop after a Steam update

1. Steam updates and a hook stops matching. Tagged games reappear and the toggle shows a warning. Tags are untouched.
2. The user opens an LLM session on the PC and says "fix it". The LLM reads the diagnostic report and repair guide, inspects the live client through CDP, updates the hook data file, runs the fixture tests and publishes a release.
3. The plugin picks up the release at the next Steam start.

Staying on Steam's stable channel, not the beta, reduces how often this happens.

## Suggested structure

```text
frontend/
  components/              # Toggle and settings page
  domain/                  # IDs, tag set, session visibility
  integrations/steam/      # Account, menus, toggle control, visibility seams
  services/                # Storage bridge, self-check, diagnostics
backend/                   # Lua lifecycle, tag file, updater, patch loading
hooks/                     # Hook definitions as data
tests/                     # Storage and hook fixture tests
scripts/                   # CDP helper
docs/                      # Research notes
CLAUDE.md                  # Repair guide
millennium.toml
```

Keep unstable Steam values typed as `unknown` at one documented boundary and validate them there. Do not build a general plugin framework.

## Milestones

| Milestone | Result | Done when |
| --- | --- | --- |
| M1 Feasibility | Chosen seams, backed by live experiments | Shared seam, menu item, toggle and What's New path each demonstrated or ruled out |
| M2 Tag storage | Per-account file with backups | Storage tests pass through the real Lua path |
| M3 End-to-end slice | Tag, toggle and one filtered surface | Live cycle works without touching Steam's filters |
| M4 Full coverage | All v1 surfaces | Each surface passes independently; otherwise labelled partial |
| M5 Repairability | Self-check, report, repair guide, fixtures | A deliberately broken hook is detected, reported and fixable from the guide |
| M6 Self-update | Background updater | A published release installs itself and can be rolled back |
| M7 Release | Package and documentation | Checks pass; live results and remaining gaps recorded |

M1 decides the effort of M3 and M4, so no duration is promised before it. M2 can proceed alongside M1 once open question 5 is answered.

## Next action

On the Windows PC: pin the Steam and Millennium versions, enable CDP debugging, and run M1 experiment 1 (the shared seam).
