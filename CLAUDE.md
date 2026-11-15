# Steam Discreet: working notes

Read `docs/PLAN.md` first, then `docs/research.md`. The repair guide (M5) will be added here.

## Rules

- Do not guess Steam API names. Confirm each one in the live client over CDP, and record it in `docs/research.md` with the Steam build it was seen on, before writing code that depends on it.
- Never call anything that writes to Steam's collections, Hidden or Private state, even to test.
- Steam values are `unknown` until validated in `frontend/integrations/steam/`. Nothing outside that folder reads Steam globals.
- The tag list must never be lost. Visibility state is never written to disk.

## Hooks

- Hook definitions are data in `backend/hook_definitions.lua`. Format, regex rules and the fixture contract are in `tests/hooks/README.md`; read it before changing a hook.
- Every hook needs fixtures in `tests/hooks/fixtures/<id>/`. A passing fixture is not proof: confirm the behaviour in the live client.
- Mark anything not taken from the live client `placeholder = true`, so it is never sent to Millennium.

## Checks

Run `bun run check` before pushing, and `bun run test:hooks:rust` after changing a hook or the harness. CI runs both on every push and pull request. Backend code must stay loadable under plain LuaJIT with the stubs in `tests/lua/helpers.lua`, so file logic can be tested outside Steam.
