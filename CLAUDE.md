# Steam Discreet: working notes

Read `docs/PLAN.md` first, then `docs/research.md`. The repair guide (M5) will be added here.

## Rules

- Do not guess Steam API names. Confirm each one in the live client over CDP, and record it in `docs/research.md` with the Steam build it was seen on, before writing code that depends on it.
- Never call anything that writes to Steam's collections, Hidden or Private state, even to test.
- Steam values are `unknown` until validated in `frontend/integrations/steam/`. Nothing outside that folder reads Steam globals.
- The tag list must never be lost. Visibility state is never written to disk.

## Checks

Run `bun run check` before pushing. CI runs the same steps on every push and pull request. Backend code must stay loadable under plain LuaJIT with the stubs in `tests/lua/helpers.lua`, so file logic can be tested outside Steam.
