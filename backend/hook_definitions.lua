-- luacheck: no max line length
-- Hook definitions: data only. Repairing a hook after a Steam update means
-- editing the strings in this file and running `bun run check`.
--
-- This file is loaded by backend/hooks.lua in an empty environment, so it can
-- only build tables and strings: no function calls, no globals. A load error
-- here disables every hook (they fail open); it never stops the plugin.
--
-- It lives in backend/ rather than hooks/ because Millennium packs only
-- `backend/**/*.lua` into the .star file and loads each one as a module.
--
-- Field reference (full rules in tests/hooks/README.md):
--   id           kebab-case, unique. Used by the self-check and fixtures.
--   description  what the hook targets, in words; shown in the diagnostic report.
--   placeholder  true for a synthetic example. Never sent to Millennium.
--   file         Rust regex matched against the Steam script's file name.
--   find         Rust regex; Millennium patches only its FIRST match per file.
--   transforms   list of { match = <Rust regex>, replace = <text> }, applied
--                in order to every match inside the `find` match only.
--                In `replace`: \0..\9 insert capture groups, #{{self}}?. is the
--                plugin's frontend exports, #{{marker}} reports "attached".
--
-- Write regexes with [=[ ... ]=] so that `]]` inside a pattern is safe.

return {
    version = 1,
    hooks = {
        {
            id = "placeholder-example",
            placeholder = true,
            description = "PLACEHOLDER. Synthetic anchor that exists only in tests/hooks/fixtures. "
                .. "Shows the format until M1 finds real Steam seams; it is never applied to Steam.",
            file = [=[chunk~[0-9a-f]+\.js]=],
            find = [=[\.filter\(\([A-Za-z_$][A-Za-z0-9_$]*=>![A-Za-z_$][A-Za-z0-9_$.]*\.ExampleIsFiltered\([A-Za-z_$][A-Za-z0-9_$]*\.appid\)\)\)]=],
            transforms = {
                {
                    match = [=[!([A-Za-z_$][A-Za-z0-9_$.]*\.ExampleIsFiltered\(([A-Za-z_$][A-Za-z0-9_$]*)\.appid\))]=],
                    replace = [=[!(#{{marker}},\1||#{{self}}?.exampleIsTagged?.(\2.appid)===!0)]=],
                },
            },
        },
    },
}
