-- Per-account tag store. See docs/PLAN.md, M2.
--
-- Guarantees:
-- * Writes go to a temporary file, are read back and compared, then renamed
--   over the main file. A failed write leaves the previous file and the
--   in-memory set untouched and is reported as an error.
-- * Before each write the current main file is copied into a ring of backups.
-- * A main file that cannot be parsed is never overwritten by normal edits.
--   If a backup is good it is restored (the bad file is kept aside as
--   `.unreadable`) and the caller is told once.
-- * A file written by a newer format version is never written to.
-- * IDs are never pruned: games missing from the library keep their tag.
-- * Only App IDs are stored. Visibility state is not part of this module.

local format = require("tagstore.format")
local default_paths = require("tagstore.paths")

local Store = {}
Store.__index = Store

local STATE_OK = "ok"                 -- loaded (or fresh), writable
local STATE_RECOVERED = "recovered"   -- loaded from a backup, writable
local STATE_NEWER = "newer"           -- newer format on disk, read-only, nothing loaded
local STATE_UNREADABLE = "unreadable" -- main and all backups unreadable, read-only
local STATE_UNAVAILABLE = "unavailable" -- storage folder missing or not creatable

---@param deps? { fsio?: table, paths?: table, logger?: table }
function Store.new(deps)
    deps = deps or {}
    local self = setmetatable({}, Store)
    self.fsio = deps.fsio or require("tagstore.fsio")
    self.paths = deps.paths or default_paths
    self.logger = deps.logger
    self.accounts = {}
    return self
end

function Store:log(level, msg)
    if self.logger then self.logger[level](self.logger, "[tags] " .. msg) end
end

local function copy_set(set)
    local out = {}
    for id in pairs(set) do out[id] = true end
    return out
end

local function set_count(set)
    local n = 0
    for _ in pairs(set) do n = n + 1 end
    return n
end

local function sets_equal(a, b)
    for id in pairs(a) do if not b[id] then return false end end
    for id in pairs(b) do if not a[id] then return false end end
    return true
end

local function is_writable(state)
    return state == STATE_OK or state == STATE_RECOVERED
end

--- Read and parse a file. Returns the parse result, or
--- { status = "missing" } / { status = "read_error", reason }.
function Store:inspect(path)
    if not self.fsio.exists(path) then return { status = "missing" } end
    local text, err = self.fsio.read(path)
    if text == nil then return { status = "read_error", reason = tostring(err) } end
    return format.parse(text)
end

local function snapshot(acct, extra)
    local result = {
        ok = true,
        state = acct.state,
        writable = is_writable(acct.state),
        ids = format.encode_id_list(acct.set),
        count = set_count(acct.set),
    }
    if acct.reason then result.reason = acct.reason end
    if acct.notice and not acct.notice_delivered then
        result.notice = acct.notice
        acct.notice_delivered = true
    end
    if extra then
        for k, v in pairs(extra) do result[k] = v end
    end
    return result
end

local function failure(code, message, acct)
    local result = { ok = false, error = code, message = message }
    if acct then
        result.state = acct.state
        result.writable = is_writable(acct.state)
        result.ids = format.encode_id_list(acct.set)
        result.count = set_count(acct.set)
    end
    return result
end

--- Try backups newest first. Returns parse result and path of the first usable
--- one, or a "newer" result if a newer-format backup is found first.
function Store:find_backup(files)
    for i = 1, #files.backups do
        local info = self:inspect(files.backups[i])
        if info.status == "ok" or info.status == "newer" then
            return info, files.backups[i]
        end
    end
    return nil
end

--- Load (or reload) an account's tags from disk.
function Store:open(account)
    local id = self.paths.validate_account(account)
    if not id then return failure("bad_account", "Not a Steam account ID") end

    local previous = self.accounts[id]
    local acct = {
        id = id,
        set = {},
        notice_delivered = previous and previous.notice_delivered or false,
        notice = previous and previous.notice or nil,
    }
    self.accounts[id] = acct

    local root, source = self.paths.root()
    if not root then
        acct.state, acct.reason = STATE_UNAVAILABLE, "No storage folder could be determined"
        return failure("unavailable", acct.reason, acct)
    end
    local made, mkerr = self.fsio.ensure_dir(root)
    if not made then
        acct.state = STATE_UNAVAILABLE
        acct.reason = "Cannot create storage folder (" .. source .. "): " .. tostring(mkerr)
        self:log("error", acct.reason)
        return failure("unavailable", acct.reason, acct)
    end
    acct.files = self.paths.files(root, id)
    local files = acct.files

    local main = self:inspect(files.main)
    if main.status == "ok" then
        acct.state, acct.set = STATE_OK, main.set
        return snapshot(acct)
    end
    if main.status == "newer" then
        acct.state = STATE_NEWER
        acct.reason = "The tag file was written by a newer version of Steam Discreet (format "
            .. main.version .. "). It is left untouched."
        self:log("warn", acct.reason)
        return snapshot(acct)
    end

    local backup, backup_path = self:find_backup(files)

    if main.status == "missing" and not backup then
        acct.state = STATE_OK -- first run for this account
        return snapshot(acct)
    end

    if backup and backup.status == "newer" then
        acct.state = STATE_NEWER
        acct.reason = "The newest tag backup was written by a newer version of Steam Discreet. It is left untouched."
        self:log("warn", acct.reason)
        return snapshot(acct)
    end

    if not backup then
        acct.state = STATE_UNREADABLE
        acct.reason = "The tag file cannot be read (" .. (main.reason or main.status)
            .. ") and no usable backup exists. It is left untouched."
        self:log("error", acct.reason)
        return snapshot(acct)
    end

    -- Recover from the backup.
    acct.state, acct.set = STATE_RECOVERED, backup.set
    local why = main.status == "missing" and "was missing" or ("could not be read (" .. (main.reason or "") .. ")")
    acct.notice = "Your tag list " .. why .. ", so it was restored from a backup with "
        .. set_count(backup.set) .. " games."
    acct.notice_delivered = false
    self:log("warn", "main tag file " .. why .. "; restored from " .. backup_path)

    if main.status ~= "read_error" then
        -- Put the backup back in place. Failure here is not fatal: the next
        -- successful save writes the main file anyway.
        local ok, err = true, nil
        if main.status ~= "missing" then
            ok, err = self.fsio.rename(files.main, files.corrupt)
        end
        if ok then ok, err = self.fsio.copy(backup_path, files.main) end
        if ok then
            acct.state = STATE_OK
        else
            self:log("warn", "could not restore main tag file from backup: " .. tostring(err))
        end
    end
    return snapshot(acct)
end

function Store:get(account)
    local id = self.paths.validate_account(account)
    if not id then return nil end
    local acct = self.accounts[id]
    if not acct then
        self:open(id)
        acct = self.accounts[id]
    end
    return acct
end

function Store:rotate_backups(files)
    local backups = files.backups
    local warnings = {}
    if self.fsio.exists(backups[#backups]) then
        local ok, err = self.fsio.remove(backups[#backups])
        if not ok then warnings[#warnings + 1] = "remove oldest backup: " .. tostring(err) end
    end
    for i = #backups - 1, 1, -1 do
        if self.fsio.exists(backups[i]) then
            local ok, err = self.fsio.rename(backups[i], backups[i + 1])
            if not ok then warnings[#warnings + 1] = "rotate backup " .. i .. ": " .. tostring(err) end
        end
    end
    local ok, err = self.fsio.copy(files.main, backups[1])
    if not ok then warnings[#warnings + 1] = "copy backup: " .. tostring(err) end
    for i = 1, #warnings do self:log("warn", warnings[i]) end
    return warnings
end

--- Persist `new_set` for an account. The in-memory set changes only on success.
---@param opts? { replace_unreadable?: boolean }
function Store:commit(acct, new_set, opts)
    opts = opts or {}
    if acct.state == STATE_UNAVAILABLE then
        return failure("unavailable", acct.reason, acct)
    end
    if acct.state == STATE_NEWER then
        return failure("newer", acct.reason, acct)
    end
    if acct.state == STATE_UNREADABLE and not opts.replace_unreadable then
        return failure("unreadable", acct.reason, acct)
    end

    local files = acct.files

    -- Re-check the file on disk: something else may have changed it since load.
    local on_disk = self:inspect(files.main)
    if on_disk.status == "newer" then
        acct.state = STATE_NEWER
        acct.reason = "The tag file was replaced by a newer version of Steam Discreet. It is left untouched."
        return failure("newer", acct.reason, acct)
    end
    if on_disk.status == "read_error" then
        return failure("write_failed", "Cannot read the current tag file before saving: " .. on_disk.reason, acct)
    end
    local move_aside = false
    if on_disk.status == "invalid" then
        if acct.state == STATE_RECOVERED or opts.replace_unreadable then
            move_aside = true
        else
            acct.state = STATE_UNREADABLE
            acct.reason = "The tag file became unreadable (" .. on_disk.reason .. "). It is left untouched."
            return failure("unreadable", acct.reason, acct)
        end
    end

    if on_disk.status == "ok" and sets_equal(on_disk.set, new_set) and sets_equal(acct.set, new_set) then
        return snapshot(acct, { saved = false })
    end

    local content = format.serialize(new_set)
    local ok, err = self.fsio.write(files.tmp, content)
    if ok then
        local back, rerr = self.fsio.read(files.tmp)
        if back ~= content then
            ok, err = false, "verification read-back did not match" .. (rerr and (": " .. rerr) or "")
        end
    end
    if not ok then
        self.fsio.remove(files.tmp)
        self:log("error", "save failed: " .. tostring(err))
        return failure("write_failed", "Could not save the tag list: " .. tostring(err), acct)
    end

    local warnings = {}
    if on_disk.status == "ok" then
        warnings = self:rotate_backups(files)
    elseif move_aside then
        local moved, merr = self.fsio.rename(files.main, files.corrupt)
        if not moved then
            self.fsio.remove(files.tmp)
            return failure("write_failed", "Could not move the unreadable tag file aside: " .. tostring(merr), acct)
        end
    end

    local renamed, rnerr = self.fsio.rename(files.tmp, files.main)
    if not renamed then
        self.fsio.remove(files.tmp)
        self:log("error", "save failed at rename: " .. tostring(rnerr))
        return failure("write_failed", "Could not save the tag list: " .. tostring(rnerr), acct)
    end

    acct.set = copy_set(new_set)
    acct.state = STATE_OK
    acct.reason = nil
    local extra = { saved = true }
    if #warnings > 0 then extra.warning = "Saved, but the backup could not be updated." end
    return snapshot(acct, extra)
end

local function with_account(self, account, fn)
    local acct = self:get(account)
    if not acct then return failure("bad_account", "Not a Steam account ID") end
    return fn(acct)
end

function Store:add(account, ids)
    return with_account(self, account, function(acct)
        local new_set = copy_set(acct.set)
        for id in pairs(ids) do new_set[id] = true end
        return self:commit(acct, new_set)
    end)
end

function Store:remove(account, ids)
    return with_account(self, account, function(acct)
        local new_set = copy_set(acct.set)
        for id in pairs(ids) do new_set[id] = nil end
        return self:commit(acct, new_set)
    end)
end

function Store:clear(account)
    return with_account(self, account, function(acct)
        return self:commit(acct, {})
    end)
end

function Store:export(account)
    return with_account(self, account, function(acct)
        if not is_writable(acct.state) then
            return failure(acct.state, acct.reason or "Tags are not loaded", acct)
        end
        return snapshot(acct, { text = format.serialize(acct.set) })
    end)
end

---@param mode "merge"|"replace"
function Store:import(account, text, mode)
    if mode ~= "merge" and mode ~= "replace" then
        return failure("bad_request", "Import mode must be merge or replace")
    end
    return with_account(self, account, function(acct)
        local parsed = format.parse_import(text)
        if parsed.status == "newer" then
            return failure("import_newer", "This export comes from a newer version of Steam Discreet.", acct)
        end
        if parsed.status ~= "ok" then
            return failure("import_invalid", "The file is not a tag list: " .. parsed.reason, acct)
        end
        if parsed.count == 0 then
            return failure("import_empty", "The file contains no App IDs.", acct)
        end
        if mode == "merge" then
            local new_set = copy_set(acct.set)
            for id in pairs(parsed.set) do new_set[id] = true end
            return self:commit(acct, new_set)
        end
        return self:commit(acct, parsed.set, { replace_unreadable = true })
    end)
end

Store.STATES = {
    ok = STATE_OK,
    recovered = STATE_RECOVERED,
    newer = STATE_NEWER,
    unreadable = STATE_UNREADABLE,
    unavailable = STATE_UNAVAILABLE,
}

return Store
