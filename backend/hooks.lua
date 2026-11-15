-- Loads backend/hook_definitions.lua, validates it, and turns it into the
-- static patch table Millennium reads from the plugin definition.
--
-- Pure Lua with no Millennium modules, so it runs under plain LuaJIT for the
-- specs and for scripts/dump-hooks.lua (which feeds the fixture harness).
--
-- What Millennium does with the table (src/instrumentation/loopback/src/engine.rs
-- at v3.6.3, see docs/research.md): `file` patterns of every plugin are compiled
-- into one Rust RegexSet, and one invalid `file` pattern discards ALL plugins'
-- patches. `find` takes the first match only; each transform's `match` is
-- replace_all'd inside that match. In `replace`, `\N` becomes Rust `$N` and a
-- literal `$` is escaped. Regex syntax itself cannot be checked here; the
-- fixture harness (tests/hooks) does that in CI.

local M = {}

M.FORMAT_VERSION = 1
M.MARKER_GLOBAL = "__steamDiscreetHooks"

local HOOK_KEYS = { id = true, description = true, placeholder = true, file = true, find = true, transforms = true }
local TRANSFORM_KEYS = { match = true, replace = true }

-- JavaScript the `#{{marker}}` token expands to: records in the page that this
-- hook's patched code ran. The frontend self-check reads it. It does not touch
-- window.PLUGIN_LIST, so it works even if Steam's code runs before ours.
function M.marker_js(id)
    return '((window.' .. M.MARKER_GLOBAL .. '||={})["' .. id .. '"]=1)'
end

local function is_nonempty_string(v)
    return type(v) == "string" and v ~= ""
end

local function unknown_key(t, allowed)
    for k in pairs(t) do
        if not allowed[k] then return tostring(k) end
    end
    return nil
end

local function count_plain(s, needle)
    local n, i = 0, 1
    while true do
        local a, b = s:find(needle, i, true)
        if not a then return n end
        n, i = n + 1, b + 1
    end
end

-- Problems with a `replace` string that Millennium would accept silently but
-- that do the wrong thing in Steam.
local function check_replace(replace)
    -- `\1a` becomes Rust `$1a`, which Rust reads as a group named "1a": empty.
    local bad_ref = replace:match("\\%d[%w_]")
    if bad_ref then
        return "backreference " .. bad_ref:sub(1, 2) .. " is followed by '" .. bad_ref:sub(3)
            .. "'; Rust would read a different group. Put a non-word character after it"
    end
    -- Without `?.` the patched Steam code throws when the plugin is not loaded.
    if count_plain(replace, "#{{self}}") ~= count_plain(replace, "#{{self}}?.") then
        return "#{{self}} must always be followed by ?. so Steam keeps working without the plugin"
    end
    for token in replace:gmatch("#{{(.-)}}") do
        if token ~= "self" and token ~= "marker" then
            return "unknown token #{{" .. token .. "}}"
        end
    end
    return nil
end

local function validate_hook(h, index, seen_ids)
    if type(h) ~= "table" then return nil, "hook #" .. index .. " is not a table" end
    local label = is_nonempty_string(h.id) and h.id or ("#" .. index)

    local extra = unknown_key(h, HOOK_KEYS)
    if extra then return nil, "unknown field '" .. extra .. "'", label end
    if not (is_nonempty_string(h.id) and h.id:match("^[a-z][a-z0-9%-]*$")) then
        return nil, "id must be kebab-case", label
    end
    if seen_ids[h.id] then return nil, "duplicate id", label end
    if not is_nonempty_string(h.description) then return nil, "description is required", label end
    if h.placeholder ~= nil and type(h.placeholder) ~= "boolean" then
        return nil, "placeholder must be true or false", label
    end
    if not is_nonempty_string(h.file) then return nil, "file pattern is required", label end
    if not is_nonempty_string(h.find) then return nil, "find pattern is required", label end
    if type(h.transforms) ~= "table" or #h.transforms == 0 then
        return nil, "at least one transform is required", label
    end

    local transforms, markers = {}, 0
    for j, t in ipairs(h.transforms) do
        if type(t) ~= "table" then return nil, "transform " .. j .. " is not a table", label end
        local extra_t = unknown_key(t, TRANSFORM_KEYS)
        if extra_t then return nil, "transform " .. j .. ": unknown field '" .. extra_t .. "'", label end
        if not is_nonempty_string(t.match) then return nil, "transform " .. j .. ": match is required", label end
        if type(t.replace) ~= "string" then return nil, "transform " .. j .. ": replace is required", label end
        local problem = check_replace(t.replace)
        if problem then return nil, "transform " .. j .. ": " .. problem, label end
        markers = markers + count_plain(t.replace, "#{{marker}}")
        local marker = M.marker_js(h.id)
        transforms[j] = {
            match = t.match,
            replace = (t.replace:gsub("#{{marker}}", function() return marker end)),
        }
    end
    if markers == 0 then
        return nil, "no transform contains #{{marker}}, so the self-check could never see this hook", label
    end

    return {
        id = h.id,
        description = h.description,
        placeholder = h.placeholder == true,
        file = h.file,
        find = h.find,
        transforms = transforms,
    }
end

-- Runs the data file with an empty environment so it can hold nothing but data.
local function run_definitions(chunk)
    if setfenv then setfenv(chunk, {}) end
    local ok, result = pcall(chunk)
    if not ok then return nil, tostring(result) end
    return result
end

local function load_chunk(module_name)
    -- Inside a .star package Millennium registers each backend file as a
    -- preload function; on disk (specs, scripts) it is a normal file.
    local chunk = package.preload[module_name]
    if chunk then return chunk end
    local path, search_err = package.searchpath(module_name, package.path)
    if not path then return nil, search_err end
    local loaded, load_err = loadfile(path)
    if not loaded then return nil, load_err end
    return loaded
end

-- Returns { hooks = { validated... }, rejected = { { id, reason }... }, error = string|nil }.
-- Never raises: a broken data file yields no hooks, and the plugin carries on.
function M.load(definitions)
    local result = { hooks = {}, rejected = {}, error = nil }

    if definitions == nil then
        local chunk, err = load_chunk("hook_definitions")
        if not chunk then
            result.error = "cannot load hook_definitions: " .. tostring(err)
            return result
        end
        definitions, err = run_definitions(chunk)
        if not definitions then
            result.error = "hook_definitions failed: " .. tostring(err)
            return result
        end
    end

    if type(definitions) ~= "table" or type(definitions.hooks) ~= "table" then
        result.error = "hook_definitions must return { version = ..., hooks = { ... } }"
        return result
    end
    if definitions.version ~= M.FORMAT_VERSION then
        result.error = "hook_definitions version " .. tostring(definitions.version)
            .. " is not supported (expected " .. M.FORMAT_VERSION .. ")"
        return result
    end

    local seen_ids = {}
    for i, h in ipairs(definitions.hooks) do
        local hook, reason, label = validate_hook(h, i, seen_ids)
        if hook then
            seen_ids[hook.id] = true
            result.hooks[#result.hooks + 1] = hook
        else
            result.rejected[#result.rejected + 1] = { id = label or ("#" .. i), reason = reason }
        end
    end
    return result
end

-- The table Millennium reads. Placeholder hooks are never included.
function M.patches(loaded)
    local out = {}
    for _, h in ipairs(loaded.hooks) do
        if not h.placeholder then
            local transforms = {}
            for j, t in ipairs(h.transforms) do
                transforms[j] = { match = t.match, replace = t.replace }
            end
            out[#out + 1] = { file = h.file, find = h.find, transforms = transforms }
        end
    end
    return out
end

-- What the frontend self-check should expect, and what the diagnostic report
-- says each hook was looking for. Contains no game names or tags.
function M.manifest(loaded)
    local expected = {}
    for _, h in ipairs(loaded.hooks) do
        if not h.placeholder then
            expected[#expected + 1] = { id = h.id, description = h.description, file = h.file, find = h.find }
        end
    end
    local rejected = {}
    for i, r in ipairs(loaded.rejected) do
        rejected[i] = { id = r.id, reason = r.reason }
    end
    return { version = M.FORMAT_VERSION, expected = expected, rejected = rejected, error = loaded.error }
end

return M
