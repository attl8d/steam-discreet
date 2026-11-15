# Steam Discreet

A [Millennium](https://github.com/SteamClientHomebrew/Millennium) plugin for the Windows Steam client. You tag games, and they stay out of ordinary Library browsing until one toggle reveals them. Tagged games keep their collections, Favorites and play history.

Status: scaffold only. No hiding logic exists yet. See [docs/PLAN.md](docs/PLAN.md) for the plan and [docs/research.md](docs/research.md) for findings from the live client.

## Requirements

- Millennium >= 3.4.0 (developed against 3.6.3)
- [Bun](https://bun.com/) >= 1.3
- For backend tests: LuaJIT, [busted](https://lunarmodules.github.io/busted/) and [luacheck](https://github.com/lunarmodules/luacheck)

## Commands

| Command | What it does |
| --- | --- |
| `bun install` | Installs dependencies and generates Millennium types into `.millennium/` |
| `bun run dev` | Builds, installs into Millennium and reloads Steam on change |
| `bun run build` | Packs the plugin (`output_path` in `millennium.toml`) |
| `bun run typecheck` | Strict TypeScript check of frontend, webview and tests |
| `bun run lint` | ESLint (typescript-eslint strict, type-checked) |
| `bun run test` | Frontend unit tests (`bun test`) |
| `bun run lint:lua` | luacheck on the backend and Lua specs |
| `bun run test:lua` | Backend specs with busted under LuaJIT, outside Steam |
| `bun run check` | All of the above |

Lua specs live in `tests/lua/*_spec.lua`. `tests/lua/helpers.lua` stubs the `logger` and `millennium` modules that Millennium injects, so backend modules can be required directly.

## Layout

```text
frontend/
  components/              Toggle and settings page
  domain/                  IDs, tag set, session visibility (pure logic)
  integrations/steam/      The only code that touches Steam globals
  services/                Storage bridge, self-check, diagnostics
backend/                   Lua lifecycle, tag file, updater, patch loading
hooks/                     Hook definitions as data
tests/frontend/            bun tests
tests/lua/                 busted specs
scripts/                   CDP helper
docs/                      Plan and research notes
CLAUDE.md                  Working rules and (later) the repair guide
```

Scaffolded from [PluginTemplate](https://github.com/SteamClientHomebrew/PluginTemplate) at `af0a07c`.
