# Steam Discreet

A [Millennium](https://github.com/SteamClientHomebrew/Millennium) plugin for the Windows Steam client. You tag games, and they stay out of ordinary Library browsing until one toggle reveals them. Tagged games keep their collections, Favorites and play history.

Status: scaffold only. No hiding logic exists yet. See [docs/PLAN.md](docs/PLAN.md) for the plan and [docs/research.md](docs/research.md) for findings from the live client.

## Requirements

- Millennium >= 3.4.0 (developed against 3.6.3)
- [Bun](https://bun.com/) >= 1.3
- For backend and hook tests: LuaJIT, [busted](https://lunarmodules.github.io/busted/) and [luacheck](https://github.com/lunarmodules/luacheck)
- Optional, for `test:hooks:rust`: a Rust toolchain (`cargo`)

## Commands

| Command | What it does |
| --- | --- |
| `bun install` | Installs dependencies and generates Millennium types into `.millennium/` |
| `bun run dev` | Builds, installs into Millennium and reloads Steam on change |
| `bun run build` | Packs the plugin (`output_path` in `millennium.toml`) |
| `bun run typecheck` | Strict TypeScript check of frontend, webview and tests |
| `bun run lint` | ESLint (typescript-eslint strict, type-checked) |
| `bun run test` | Frontend unit tests and hook fixture tests (`bun test`; the hook tests call `luajit`) |
| `bun run lint:lua` | luacheck on the backend and Lua specs |
| `bun run test:lua` | Backend specs with busted under LuaJIT, outside Steam |
| `bun run test:hooks:rust` | Repeats the hook fixtures with the Rust `regex` crate Millennium uses (needs `cargo`) |
| `bun run check` | Everything above except `test:hooks:rust`, which CI runs separately |

Lua specs live in `tests/lua/*_spec.lua`. `tests/lua/helpers.lua` stubs the `logger` and `millennium` modules that Millennium injects, so backend modules can be required directly.

## Releases and self-update

Bump `version` in `millennium.toml` and `backend/version.lua` (a test keeps them equal), merge, then push a matching tag:

```sh
git tag v0.2.0 && git push origin v0.2.0
```

`.github/workflows/release.yml` runs the CI checks, packs `steam-discreet.star` with `starlight pack --release`, writes `steam-discreet.star.sha256` and publishes both on a GitHub release.

The installed plugin checks this repo's latest release in the background after each Steam start (`backend/updater.lua`). A newer release is downloaded to `<Millennium plugins>/steam-discreet.update/`, checked against its size, the `.star` header, the `.sha256` file and GitHub's own asset digest, and staged. When Steam shuts down, the running file is copied to `previous.star` and the staged file is renamed over `steam-discreet.star`, so the update loads at the next start. A failed check changes nothing and is recorded in `state.json`. The updater never reads or writes the tag file.

The check calls the GitHub API without a token, so it only works while this repo is public.

### Rolling back

The settings page (T8) will call the backend method `steam_discreet_update_rollback`. It stages the saved previous version, which replaces the current one at the next Steam shutdown, and the current version is then skipped by future checks. A later, higher release is installed as usual.

By hand: quit Steam, copy `<Millennium plugins>/steam-discreet.update/previous.star` over `<Millennium plugins>/steam-discreet.star`, and start Steam. At startup the plugin sees it is older than the version it last installed and skips that version, so the rollback sticks.

To allow a skipped version again, delete `skip_version` from `steam-discreet.update/state.json`.

## Layout

```text
frontend/
  components/              Toggle and settings page
  domain/                  IDs, tag set, session visibility (pure logic)
  integrations/steam/      The only code that touches Steam globals
  services/                Storage bridge, self-check, diagnostics
backend/                   Lua lifecycle, tag file, updater, patch loading
  hook_definitions.lua     Hook definitions as data (see tests/hooks/README.md)
tests/frontend/            bun tests
tests/lua/                 busted specs
tests/hooks/               Hook fixture harness and fixtures
tools/patch-crosscheck/    Repeats the hook fixtures with the real Rust regex crate
scripts/                   CDP helper
docs/                      Plan and research notes
CLAUDE.md                  Working rules and (later) the repair guide
```

Scaffolded from [PluginTemplate](https://github.com/SteamClientHomebrew/PluginTemplate) at `af0a07c`.
