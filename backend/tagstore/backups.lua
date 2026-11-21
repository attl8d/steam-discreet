-- Backup files the user keeps: "Save backup" and "Restore backup" on the
-- settings page. See docs/research.md, "Backup files".
--
-- * A backup holds one account's tag list plus a few facts (format.lua,
--   "Backup file format"). It never holds the reveal toggle.
-- * The account is recorded as a short hash of the SteamID64, so a restore onto
--   another account can be flagged without writing the ID itself. It hides the
--   ID from a casual reader; it is not encryption.
-- * Files go to a "Steam Discreet" folder in the user's Documents. When no
--   Documents folder exists or it cannot be written, they go to Backups in the
--   tag storage folder instead.
-- * Writes go to a temporary file, are read back and compared, then renamed, so
--   a backup on disk is always complete. An existing backup is never replaced.
-- * Restoring is the frontend's job: it reads a backup's text here and imports
--   it through the tag store, which keeps the Undo and every store guarantee.

local format = require("tagstore.format")
local default_paths = require("tagstore.paths")

local Backups = {}
Backups.__index = Backups

local FOLDER_NAME = "Steam Discreet"
local FALLBACK_NAME = "Backups"
local FILE_PREFIX = "Steam Discreet backup "
local MAX_LISTED = 100
local KEY_SALT = "steam-discreet-account:"

---@param deps? { fsio?: table, paths?: table, getenv?: fun(name: string): string|nil, now?: fun(): integer,
---              version?: string, logger?: table, hash?: fun(text: string): string }
function Backups.new(deps)
    deps = deps or {}
    local self = setmetatable({}, Backups)
    self.fsio = deps.fsio or require("tagstore.fsio")
    self.paths = deps.paths or default_paths
    self.getenv = deps.getenv or os.getenv
    self.now = deps.now or os.time
    self.version = deps.version
    self.logger = deps.logger
    self.hash = deps.hash
    return self
end

function Backups:log(level, msg)
    if self.logger then self.logger[level](self.logger, "[backup] " .. msg) end
end

function Backups:env(name)
    local ok, value = pcall(self.getenv, name)
    if ok and type(value) == "string" and value ~= "" then return value end
    return nil
end

--- A short, stable code for an account: the first 16 hex digits of
--- SHA-256("steam-discreet-account:" .. SteamID64).
---@param account string already validated
function Backups:account_key(account)
    local hash = self.hash or require("updater.sha256").hex
    return hash(KEY_SALT .. account):sub(1, 16)
end

--- Folders backups can live in, best first. Each is { path, kind } where kind
--- is "override", "documents" or "fallback".
function Backups:folders()
    local join = self.paths.join
    local out, seen = {}, {}
    local function add(path, kind)
        if path and not seen[path] then
            seen[path] = true
            out[#out + 1] = { path = path, kind = kind }
        end
    end
    local override = self:env("STEAM_DISCREET_BACKUP_DIR")
    if override then add(override, "override") end
    -- Windows sets USERPROFILE, macOS and Linux set HOME. OneDrive can move
    -- Documents into the OneDrive folder; the known-folder API is not reachable
    -- from Lua, so the usual places are tried in turn.
    local bases = {}
    local profile, home = self:env("USERPROFILE"), self:env("HOME")
    if profile then
        bases[#bases + 1] = join(profile, "Documents")
        bases[#bases + 1] = join(profile, "OneDrive/Documents")
    end
    if home then bases[#bases + 1] = join(home, "Documents") end
    for _, base in ipairs(bases) do
        if self.fsio.is_dir(base) then
            add(join(base, FOLDER_NAME), "documents")
            break
        end
    end
    local root = self.paths.root()
    if root then add(join(root, FALLBACK_NAME), "fallback") end
    return out
end

-- paths.join always adds "/", so a Windows path comes out mixed. Shown to the
-- user, it reads better with one kind of separator.
local function display(path)
    if path:find("\\", 1, true) then return (path:gsub("/", "\\")) end
    return path
end

local function plain_name(name)
    return type(name) == "string" and name ~= "" and #name <= 200
        and not name:find("[/\\%c]") and not name:find("%.%.") and name:sub(-4):lower() == ".txt"
end

--- A file name that does not exist yet: "Steam Discreet backup 2026-11-21.txt",
--- then "... (2).txt" and so on.
function Backups:free_name(folder, date)
    local base = FILE_PREFIX .. date
    for i = 1, 99 do
        local name = base .. (i == 1 and "" or (" (" .. i .. ")")) .. ".txt"
        if not self.fsio.exists(self.paths.join(folder, name)) then return name end
    end
    return nil
end

function Backups:write_new(folder, text, date)
    local made, mkerr = self.fsio.ensure_dir(folder)
    if not made then return nil, "cannot create the folder: " .. tostring(mkerr) end
    local name = self:free_name(folder, date)
    if not name then return nil, "too many backups saved today" end
    local path = self.paths.join(folder, name)
    local tmp = path .. ".tmp"
    local ok, err = self.fsio.write(tmp, text)
    if ok then
        local back, rerr = self.fsio.read(tmp)
        if back ~= text then
            ok, err = false, "verification read-back did not match" .. (rerr and (": " .. rerr) or "")
        end
    end
    if ok then ok, err = self.fsio.rename(tmp, path) end
    if not ok then
        self.fsio.remove(tmp)
        return nil, tostring(err)
    end
    return name, path
end

--- Save a backup of `set` for `account`. Tries each folder in turn.
---@return table result { ok, name, path, folder, kind, count, fallback_reason? } or { ok = false, error, message }
function Backups:save(account, set)
    local count = 0
    for _ in pairs(set) do count = count + 1 end
    if count == 0 then
        return { ok = false, error = "backup_empty", message = "There are no tagged games to back up." }
    end
    local t = self.now()
    local text = format.serialize_backup(set, {
        saved = os.date("!%Y-%m-%dT%H:%M:%SZ", t),
        plugin = self.version,
        account = self:account_key(account),
    })
    local date = os.date("%Y-%m-%d", t)
    local folders = self:folders()
    if #folders == 0 then
        return { ok = false, error = "unavailable", message = "No folder for backups could be found." }
    end
    local failures = {}
    for _, folder in ipairs(folders) do
        local name, path_or_err = self:write_new(folder.path, text, date)
        if name then
            local result = {
                ok = true, name = name, path = display(path_or_err), folder = display(folder.path),
                kind = folder.kind, count = count,
            }
            if #failures > 0 then result.fallback_reason = table.concat(failures, "; ") end
            return result
        end
        self:log("warn", "could not save in " .. folder.kind .. " folder: " .. path_or_err)
        failures[#failures + 1] = folder.kind .. " folder: " .. path_or_err
    end
    return { ok = false, error = "write_failed",
        message = "Could not save the backup (" .. table.concat(failures, "; ") .. ")." }
end

--- What a backup's text holds, compared with `account` (may be nil).
--- Returns { status, count?, saved?, same_account?, reason? }; same_account is
--- "yes", "no" or "unknown".
function Backups:describe(text, account)
    local parsed = format.parse_import(text)
    local info = { status = parsed.status, kind = parsed.kind, reason = parsed.reason }
    if parsed.status ~= "ok" then return info end
    info.count = parsed.count
    local facts = parsed.facts or {}
    if type(facts.saved) == "string" and facts.saved:match("^%d%d%d%d%-%d%d%-%d%dT%d%d:%d%d:%d%dZ$") then
        info.saved = facts.saved
    end
    local key = facts.account
    local valid = account and self.paths.validate_account(account)
    if type(key) ~= "string" or not key:match("^%x+$") or not valid then
        info.same_account = "unknown"
    else
        info.same_account = key:lower() == self:account_key(valid) and "yes" or "no"
    end
    return info
end

local function clean_field(value)
    return (tostring(value or ""):gsub("[\t\r\n]", " "))
end

--- Every backup file found, newest first. Entries travel as one line each,
--- tab-separated: id, name, status, count, saved, same_account, folder kind.
--- (Millennium turns an empty Lua table into a JSON object, so lists are text.)
function Backups:list(account)
    local folders = self:folders()
    local found = {}
    for index, folder in ipairs(folders) do
        if self.fsio.is_dir(folder.path) then
            local names, err = self.fsio.list_files(folder.path)
            if not names then
                self:log("warn", "cannot list " .. folder.kind .. " folder: " .. tostring(err))
            else
                for _, name in ipairs(names) do
                    if plain_name(name) then
                        local text = self.fsio.read(self.paths.join(folder.path, name))
                        local info = text and self:describe(text, account)
                            or { status = "invalid", reason = "cannot read" }
                        -- Other text files in the folder are left alone; a damaged
                        -- file that looks like ours is listed so the user sees it.
                        if info.status ~= "invalid" or name:sub(1, #FILE_PREFIX) == FILE_PREFIX then
                            found[#found + 1] = { index = index, name = name, kind = folder.kind, info = info }
                        end
                    end
                end
            end
        end
    end
    table.sort(found, function(a, b)
        local sa, sb = a.info.saved or "", b.info.saved or ""
        if sa ~= sb then return sa > sb end
        return a.name > b.name
    end)
    local lines = {}
    for i = 1, math.min(#found, MAX_LISTED) do
        local e = found[i]
        lines[#lines + 1] = table.concat({
            e.index .. ":" .. clean_field(e.name), clean_field(e.name), e.info.status, tostring(e.info.count or ""),
            e.info.saved or "", e.info.same_account or "unknown", e.kind,
        }, "\t")
    end
    local primary = folders[1]
    return {
        ok = true,
        entries = table.concat(lines, "\n"),
        count = #lines,
        folder = primary and display(primary.path) or "",
    }
end

--- The text of a listed backup, by the id `list` gave it.
function Backups:read(id)
    if type(id) ~= "string" then return { ok = false, error = "bad_request", message = "No backup chosen." } end
    local index, name = id:match("^(%d+):(.+)$")
    local folder = index and self:folders()[tonumber(index)]
    if not folder or not plain_name(name) then
        return { ok = false, error = "bad_request", message = "That backup is not in the backup folder." }
    end
    local path = self.paths.join(folder.path, name)
    if not self.fsio.exists(path) then
        return { ok = false, error = "missing", message = "That backup file is gone. Refresh the list." }
    end
    local text, err = self.fsio.read(path)
    if not text then
        return { ok = false, error = "read_failed", message = "Could not read the backup: " .. tostring(err) }
    end
    return { ok = true, text = text, name = name }
end

return Backups
