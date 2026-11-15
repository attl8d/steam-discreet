# Research notes (M1)

Every finding here names the Steam build it was seen on. Later sessions start from this file.

## Environment (15 November 2026)

| Item | Value | How it was checked |
| --- | --- | --- |
| Windows | 11 Pro, 10.0.26200 | `Win32_OperatingSystem` |
| Steam install | `C:\Program Files (x86)\Steam` | `HKCU\Software\Valve\Steam\SteamPath` |
| Steam client build | `1794536281` (win64) | `package\steam_client_win64.manifest`, `logs\bootstrap_log.txt` |
| Steam channel | Stable | no `package\beta` file |
| Millennium | **Not installed** | no Millennium files in the Steam folder |
| CDP debugging | **Off** | no `.cef-enable-remote-debugging` in the Steam folder |
| Bun | **Not installed** | `bun` not on PATH |
| Node / Python | Not installed (Python is the Store stub) | |
| Template revision | PluginTemplate `af0a07c` | scaffold commit `54c7038` |
| Starlight | `@steambrew/starlight` `1.1.7` (exact pin) | `package.json` |

## CDP helper

`scripts/cdp.ts` (Bun, no dependencies):

- `bun scripts/cdp.ts targets` lists every Steam window.
- `bun scripts/cdp.ts eval "<expr>"` evaluates in `SharedJSContext` (or `--target <title>`), awaiting promises.
- `bun scripts/cdp.ts find "<anchor>"` prints source around each match of the anchor in every loaded script (`--regex`, `--context N`, `--max N`).

Status: written, not yet run (waiting on Bun and the debugging flag).

## Open items

- M1 step 2 (`output_path`) waits for Millennium to be installed.
- Step 4 and experiments 1 to 4 wait for Millennium, the debugging flag and a Steam restart.
