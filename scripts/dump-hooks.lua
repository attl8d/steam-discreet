-- Prints the validated hook definitions as JSON, exactly as backend/hooks.lua
-- hands them to Millennium (markers expanded), including placeholder hooks.
-- Used by the fixture harness: `luajit scripts/dump-hooks.lua`.

package.path = "backend/?.lua;" .. package.path
local hooks = require("hooks")

local function encode(v)
    local t = type(v)
    if t == "string" then
        return '"' .. v:gsub('[%c"\\]', function(c)
            return string.format("\\u%04x", c:byte())
        end) .. '"'
    elseif t == "number" or t == "boolean" then
        return tostring(v)
    elseif t == "nil" then
        return "null"
    elseif t == "table" then
        if next(v) == nil or #v > 0 then
            local parts = {}
            for i, x in ipairs(v) do parts[i] = encode(x) end
            return "[" .. table.concat(parts, ",") .. "]"
        end
        local keys = {}
        for k in pairs(v) do keys[#keys + 1] = k end
        table.sort(keys)
        local parts = {}
        for i, k in ipairs(keys) do parts[i] = encode(tostring(k)) .. ":" .. encode(v[k]) end
        return "{" .. table.concat(parts, ",") .. "}"
    end
    error("cannot encode " .. t)
end

local loaded = hooks.load()
io.write(encode({
    hooks = loaded.hooks,
    rejected = loaded.rejected,
    error = loaded.error,
    marker_global = hooks.MARKER_GLOBAL,
}), "\n")
