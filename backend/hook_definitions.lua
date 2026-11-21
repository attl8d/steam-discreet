-- luacheck: no max line length
-- Hook definitions: data only. Repairing a hook after a Steam update means
-- editing the strings in this file and running `bun run check`.
--
-- This file is loaded by backend/hooks.lua in an empty environment: no globals
-- and no library functions, so keep it to tables and strings. A load error, or
-- a `hooks` list with gaps or named keys, disables every hook (they fail open
-- and the self-check warns); it never stops the plugin.
--
-- It lives in backend/ rather than hooks/ because Millennium packs only
-- `backend/**/*.lua` into the .star file and loads each one as a module.
--
-- Field reference (full rules in tests/hooks/README.md):
--   id           kebab-case, unique. Used by the self-check and fixtures.
--   description  what the hook targets, in words; shown in the diagnostic report.
--   placeholder  true for a synthetic example. Never sent to Millennium.
--   runs         "startup" if the patched code runs on every Steam start, or
--                "on_demand" if it runs only when the user opens something.
--                Only an unseen startup hook counts as broken.
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
            id = "library-visibility",
            runs = "startup",
            description = "collectionStore.BIsVisible in sp.js: Steam's own 'show this game in the Library' check. "
                .. "Every collection's visible list and count, Library search and Home What's New read it. "
                .. "The patch adds 'and not hidden by Steam Discreet'. Seen on Steam build 1794536281.",
            file = [=[(^|[\\/])sp\.js([?]|$)]=],
            find = [=[BIsVisible\([A-Za-z_$][A-Za-z0-9_$]*\)\{const [A-Za-z_$][A-Za-z0-9_$]*=typeof [A-Za-z_$][A-Za-z0-9_$]*=="number"\?[A-Za-z_$][A-Za-z0-9_$.]*\.GetAppOverviewByAppID\([A-Za-z_$][A-Za-z0-9_$]*\):[A-Za-z_$][A-Za-z0-9_$]*;return [^}]*&&!this\.BIsHidden\([A-Za-z_$][A-Za-z0-9_$]*\.appid\)\}]=],
            transforms = {
                {
                    match = [=[&&!this\.BIsHidden\(([A-Za-z_$][A-Za-z0-9_$]*)\.appid\)\}]=],
                    replace = [=[&&!this.BIsHidden(\1.appid)&&!(#{{marker}},#{{self}}?.sdShouldHide?.(\1.appid)===!0)}]=],
                },
            },
        },
        {
            id = "game-context-menu",
            runs = "on_demand",
            description = "The game context menu's render() in sp.js (webpack module 43394, the class with GetTargetApps). "
                .. "Steam uses this one menu for the sidebar (with multi-select), grid tiles, the game page gear button, "
                .. "Downloads and update events. The patch adds Steam Discreet's Mark/Unmark as adult item after "
                .. "the primary action. Seen on Steam build 1794536281.",
            file = [=[(^|[\\/])sp\.js([?]|$)]=],
            find = [=[render\(\)\{const ([A-Za-z_$][A-Za-z0-9_$]*)=this\.GetTargetApps\(\),[^;]*;return\(0,[A-Za-z_$][A-Za-z0-9_$]*\.jsxs\)\([A-Za-z_$][A-Za-z0-9_$.]*,\{label:[^,]*,children:\[!this\.props\.omitPrimaryAction&&this\.GetPrimaryActionMenuItem\([A-Za-z_$][A-Za-z0-9_$]*,[A-Za-z_$][A-Za-z0-9_$]*\),this\.props\.additionalActions,]=],
            transforms = {
                {
                    match = [=[render\(\)\{const ([A-Za-z_$][A-Za-z0-9_$]*)=this\.GetTargetApps\(\),([^;]*;return\(0,[A-Za-z_$][A-Za-z0-9_$]*\.jsxs\)\([A-Za-z_$][A-Za-z0-9_$.]*,\{label:[^,]*,children:\[!this\.props\.omitPrimaryAction&&this\.GetPrimaryActionMenuItem\([A-Za-z_$][A-Za-z0-9_$]*,[A-Za-z_$][A-Za-z0-9_$]*\),this\.props\.additionalActions,)]=],
                    replace = [=[render(){const \1=this.GetTargetApps(),\2(#{{marker}},#{{self}}?.sdTagMenuItem?.(\1)??null),]=],
                },
            },
        },
        {
            id = "reveal-toggle",
            runs = "on_demand",
            description = "The Library sidebar header in sp.js: the row of icon filters under the Games dropdown "
                .. "(ViewFiltersBar > Filters, next to sort-by-recent and ready-to-play). The patch adds Steam Discreet's "
                .. "show/hide adult games eye and the show-only-adult-games icon (18+) as the first icons, "
                .. "styled with Steam's own CheckboxWithImage classes. "
                .. "Seen on Steam build 1794536281.",
            file = [=[(^|[\\/])sp\.js([?]|$)]=],
            find = [=[\(0,[A-Za-z_$][A-Za-z0-9_$]*\.jsx\)\("div",\{className:[A-Za-z_$][A-Za-z0-9_$]*\(\)\.ViewFiltersBar,children:\(0,[A-Za-z_$][A-Za-z0-9_$]*\.jsxs\)\("div",\{className:\(0,[A-Za-z_$][A-Za-z0-9_$]*\.A\)\([A-Za-z_$][A-Za-z0-9_$]*\(\)\.Filters,[A-Za-z_$][A-Za-z0-9_$]*&&[A-Za-z_$][A-Za-z0-9_$]*\(\)\.Disabled\),children:\[]=],
            transforms = {
                {
                    match = [=[(\(0,[A-Za-z_$][A-Za-z0-9_$]*\.jsx\)\("div",\{className:)([A-Za-z_$][A-Za-z0-9_$]*)(\(\)\.ViewFiltersBar,children:\(0,[A-Za-z_$][A-Za-z0-9_$]*\.jsxs\)\("div",\{className:\(0,[A-Za-z_$][A-Za-z0-9_$]*\.A\)\([A-Za-z_$][A-Za-z0-9_$]*\(\)\.Filters,[A-Za-z_$][A-Za-z0-9_$]*&&[A-Za-z_$][A-Za-z0-9_$]*\(\)\.Disabled\),children:\[)]=],
                    replace = [=[\0(#{{marker}},#{{self}}?.sdRevealToggle?.({button:\2().CheckboxWithImage,active:\2().Active,disabled:\2().Disabled})??null),]=],
                },
            },
        },
        {
            id = "placeholder-example",
            placeholder = true,
            runs = "startup",
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
