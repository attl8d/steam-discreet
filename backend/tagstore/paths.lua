-- Where the tag files live.
--
-- Open question 5 in docs/PLAN.md (which locations outside the plugin folder the
-- Lua backend can write to) is not yet answered on the live client. Every path
-- the store uses comes from `M.root()`, so changing the location is a one-line
-- change here. See docs/research.md, "Tag storage location".

local M = {}

local DIR_NAME = "SteamDiscreet"

-- Test and diagnostic overrides. Never set in production code paths.
local override_root = nil
local override_os = nil

-- LuaJIT names the OS in jit.os ("Windows", "Linux", "OSX", ...). Millennium's
-- Lua host is LuaJIT; plain Lua has no jit table and counts as "unknown".
local function os_name()
    if override_os ~= nil then return override_os end
    if type(jit) == "table" and type(jit.os) == "string" then return jit.os end
    return "unknown"
end

local function getenv(name)
    local value = os.getenv(name)
    if value == nil or value == "" then return nil end
    return value
end

local function join(a, b)
    local last = a:sub(-1)
    if last == "/" or last == "\\" then return a .. b end
    return a .. "/" .. b
end
M.join = join

--- The one function that decides the storage root.
--- Order: explicit override, STEAM_DISCREET_DATA_DIR, %APPDATA%\SteamDiscreet,
--- on macOS ~/Library/Application Support/SteamDiscreet, then
--- $XDG_DATA_HOME or ~/.local/share/SteamDiscreet. Returns nil when none is known.
---@return string|nil root
---@return string source which rule produced it
function M.root()
    if override_root then return override_root, "override" end
    local env = getenv("STEAM_DISCREET_DATA_DIR")
    if env then return env, "STEAM_DISCREET_DATA_DIR" end
    local appdata = getenv("APPDATA")
    if appdata then return join(appdata, DIR_NAME), "APPDATA" end
    local home = getenv("HOME")
    if home and os_name() == "OSX" then
        return join(home, "Library/Application Support/" .. DIR_NAME), "macOS"
    end
    local xdg = getenv("XDG_DATA_HOME")
    if xdg then return join(xdg, DIR_NAME), "XDG_DATA_HOME" end
    if home then return join(home, ".local/share/" .. DIR_NAME), "HOME" end
    return nil, "none"
end

---@param root string|nil
function M.set_root_override(root)
    override_root = root
end

--- Test override for the OS name that root() sees ("OSX", "Windows", ...); nil restores detection.
---@param name string|nil
function M.set_os_override(name)
    override_os = name
end

-- SteamID64 values are decimal strings. Accepting digits only keeps account
-- IDs from ever forming a path outside the root.
---@param account any
---@return string|nil
function M.validate_account(account)
    if type(account) ~= "string" then return nil end
    if not account:match("^%d+$") or #account > 20 then return nil end
    if account:match("^0+$") then return nil end
    return account
end

M.BACKUP_COUNT = 5

---@param root string
---@param account string
function M.files(root, account)
    local base = join(root, "tags-" .. account)
    local backups = {}
    for i = 1, M.BACKUP_COUNT do
        backups[i] = base .. ".bak" .. i
    end
    return {
        main = base .. ".txt",
        tmp = base .. ".tmp",
        corrupt = base .. ".unreadable",
        backups = backups,
    }
end

return M
