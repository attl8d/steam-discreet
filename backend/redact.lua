-- Removes the user's own folder and login names from text before it leaves
-- the backend in the diagnostic report. The frontend's regex cleaning
-- (frontend/services/diagnostics.ts, clean) catches the usual path shapes;
-- this catches the real values, whatever they look like, without ever
-- sending them to the frontend.
--
-- Pure Lua; `getenv` is injectable for the specs.

local M = {}

-- Longest first, so a profile path is replaced before the name inside it.
local PATH_VARS = { "LOCALAPPDATA", "APPDATA", "USERPROFILE", "HOME", "XDG_DATA_HOME", "STEAM_DISCREET_DATA_DIR" }
local NAME_VARS = { "USERNAME", "USER", "LOGNAME" }

local function escape(s)
    return (s:gsub("[%^%$%(%)%%%.%[%]%*%+%-%?]", "%%%0"))
end

local function strip_trailing_sep(p)
    return (p:gsub("[\\/]+$", ""))
end

-- The same path as it may appear in text: as is, with doubled backslashes
-- (escaped strings, JSON) and with forward slashes.
local function spellings(path)
    local out, seen = {}, {}
    local function add(s)
        if s ~= "" and not seen[s] then seen[s] = true; out[#out + 1] = s end
    end
    add(path)
    add((path:gsub("\\", "\\\\")))
    add((path:gsub("\\", "/")))
    add((path:gsub("/", "\\")))
    return out
end

function M.redact(text, getenv)
    if type(text) ~= "string" then return text end
    getenv = getenv or os.getenv
    local function env(name)
        local ok, v = pcall(getenv, name)
        if ok and type(v) == "string" and v ~= "" then return v end
        return nil
    end

    local paths = {}
    for _, var in ipairs(PATH_VARS) do
        local v = env(var)
        -- A root like "C:\" or "/" would redact every path; skip those.
        if v and #strip_trailing_sep(v) >= 3 then
            for _, s in ipairs(spellings(strip_trailing_sep(v))) do
                paths[#paths + 1] = { text = s, label = "<" .. var .. ">" }
            end
        end
    end
    table.sort(paths, function(a, b) return #a.text > #b.text end)
    for _, p in ipairs(paths) do
        -- Case-insensitive file systems: match the path ignoring case.
        local pattern = escape(p.text):gsub("%a", function(c)
            return "[" .. c:lower() .. c:upper() .. "]"
        end)
        text = text:gsub(pattern, function() return p.label end)
    end

    for _, var in ipairs(NAME_VARS) do
        local name = env(var)
        if name and #name >= 3 then
            text = text:gsub("%f[%w]" .. escape(name) .. "%f[%W]", "<user>")
        end
    end
    return text
end

return M
