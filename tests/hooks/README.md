# Hook definitions and fixture tests

Hooks are the regex patches Millennium applies to Steam's JavaScript. They are data, kept apart from plugin code, so that repairing one after a Steam update means changing a few strings.

| File | Role |
| --- | --- |
| `backend/hook_definitions.lua` | The hook definitions. Data only. |
| `backend/hooks.lua` | Loads and validates the definitions, expands `#{{marker}}`, builds Millennium's patch table and the self-check manifest. |
| `frontend/services/hookStatus.ts` | Self-check status model: attached, checking, missing, rejected. |
| `tests/hooks/fixtures/<hook id>/` | Fixtures for one hook, with `fixtures.json`. |
| `tests/hooks/fixtures/_unrelated/` | Ordinary code no hook may change. |
| `tests/hooks/lib/` | The harness: Rust-regex subset, a copy of Millennium's patch engine, the checks. |
| `tools/patch-crosscheck/` | Re-runs every fixture through the real Rust `regex` crate. |

The definitions live in `backend/` because Millennium packs only `backend/**/*.lua` into the plugin and loads each file as a module.

## Definition format

```lua
return {
    version = 1,
    hooks = {
        {
            id = "sidebar-visibility",          -- kebab-case, unique
            description = "What it targets, in words.",
            placeholder = false,                -- true: example only, never sent to Millennium
            runs = "startup",                   -- or "on_demand"; see below
            file = [=[chunk~[0-9a-f]+\.js]=],   -- matched against the script's file name
            find = [=[...]=],                   -- the anchor; Millennium patches its FIRST match only
            transforms = {
                { match = [=[...]=], replace = [=[...]=] },  -- applied in order, inside the find match
            },
        },
    },
}
```

The file runs with no globals or library functions, so keep it to tables and strings. If it fails to load, or `hooks` has gaps or named keys, every hook is disabled, Steam runs unpatched and the self-check warns. If one hook is invalid (including gaps or named keys in its `transforms`), only that hook is left out and the self-check reports it as rejected.

### `runs` and the self-check

The `#{{marker}}` fires only when the patched code runs, so the self-check can only see a hook after its code has run.

- `startup`: the patched code runs on every Steam start (for example the Library's own filtering). If it has not been seen when the grace period ends, the hook is `missing` and the toggle warns.
- `on_demand`: the code runs only when the user opens something (a context menu, a view not opened yet). Until then it is `not-seen`, which is not a failure.

Pick `startup` only when the live client shows the code running at every start. If unsure, use `on_demand`: a wrong `startup` gives a warning at every start, and a wrong `on_demand` only hides a failure until the surface is opened.

In `replace`:

- `\0` to `\9` insert capture groups. A group number must not be followed by a letter, digit or `_` (`\1a` would become Rust's `$1a`, a group named "1a", which is empty). The loader rejects that.
- `#{{self}}?.` is the plugin's frontend exports (`window.PLUGIN_LIST['steam-discreet']`). It must always be followed by `?.`, so Steam's code keeps working when the plugin is not loaded.
- `#{{marker}}` is replaced by an expression that records that the patched code ran. Every hook needs at least one, or the self-check could never see it.
- `$` is literal.

## Regex rules

Millennium uses the Rust `regex` crate; the harness uses JavaScript. Patterns must stay in the subset where both agree, listed at the top of `tests/hooks/lib/rustRegex.ts`. In short:

- Write identifier characters out: `[A-Za-z_$][A-Za-z0-9_$]*`, not `\w+`. No `\d`, `\s`, `\b`.
- No lookaround, backreferences, inline flags, named groups or possessive quantifiers.
- Escape literal `{ } ]` outside a class, and `[` inside one.
- A transform's `match` must not be able to match an empty string.
- Do not anchor on hashed CSS class names; they change with every Steam update.

## What the harness checks

For every hook, `bun run test` checks:

1. The patterns are in the portable subset, and every `\N` refers to an existing group.
2. The hook has fixtures with at least one `attached` and one `absent` case.
3. **attached** cases: `file` selects the fixture's file name; `find` matches exactly once; each transform matches the number of times listed in `transformMatches`; code outside the find match is byte-for-byte unchanged; the patched code contains the marker, uses `#{{self}}` only with `?.`, and still parses.
4. **absent** cases (the anchor moved or was renamed): `find` does not match and the file is unchanged.
5. Every attached fixture doubled: the harness reports the anchor as ambiguous, Millennium's behaviour patches only the first copy, and the result still parses.
6. Every file in `_unrelated/` stays unchanged, and a file name that `file` does not select is never touched.

`bun run test:hooks:rust` (also in CI) writes every case with the harness's output and repeats it with the real Rust crate and Millennium's own replacement code. It fails if a pattern does not compile in Rust, any output differs, or a patched file fails the oxc ES-module parse Millennium uses (which would make Millennium revert the whole file).

## Adding or repairing a hook

1. Find the anchor in the live client (see `docs/research.md` and the CDP script). Record it there with the Steam build.
2. Save a trimmed copy of the surrounding minified code as `tests/hooks/fixtures/<id>/anchor.js`, and a variant without the anchor (for example the previous Steam build's code) as an absent case.
3. Edit `backend/hook_definitions.lua` and `fixtures.json`.
4. Run `bun run check` and `bun run test:hooks:rust`.
5. A passing fixture is not proof. Confirm the behaviour in the live client.
