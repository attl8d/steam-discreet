-- Tag file format, version 1. Plain text, one value per line:
--
--   steam-discreet-tags 1
--   570
--   730
--   end 2
--
-- The header carries the format version. The trailer repeats the ID count, so a
-- file cut short by a crash or a full disk is detected instead of being read as
-- a shorter list. Export files use the same format.

local M = {}

M.VERSION = 1
M.MAGIC = "steam-discreet-tags"

local MAX_APP_ID = 4294967295

---@param value any
---@return integer|nil
function M.parse_app_id(value)
    local n
    if type(value) == "number" then
        n = value
    elseif type(value) == "string" and value:match("^%d+$") and #value <= 10 then
        n = tonumber(value)
    else
        return nil
    end
    if n ~= n or n % 1 ~= 0 or n <= 0 or n > MAX_APP_ID then return nil end
    return n
end

--- Deduplicated, sorted array of IDs from a set table ({ [id] = true }).
function M.sorted_ids(set)
    local ids = {}
    for id in pairs(set) do ids[#ids + 1] = id end
    table.sort(ids)
    return ids
end

---@param set table<integer, boolean>
---@return string
function M.serialize(set)
    local ids = M.sorted_ids(set)
    local lines = { M.MAGIC .. " " .. M.VERSION }
    for i = 1, #ids do lines[#lines + 1] = string.format("%d", ids[i]) end
    lines[#lines + 1] = "end " .. #ids
    return table.concat(lines, "\n") .. "\n"
end

local function split_lines(text)
    local lines = {}
    -- Tolerate CRLF from files edited or transferred on Windows.
    for line in (text .. "\n"):gmatch("([^\n]*)\n") do
        lines[#lines + 1] = (line:gsub("\r$", ""))
    end
    while #lines > 0 and lines[#lines] == "" do lines[#lines] = nil end
    return lines
end

--- Parse a tag file.
--- Returns one of:
---   { status = "ok", set = {...}, count = n }
---   { status = "newer", version = v }   -- written by a newer plugin; do not touch
---   { status = "invalid", reason = "..." }
---@param text string|nil
function M.parse(text)
    if type(text) ~= "string" then return { status = "invalid", reason = "not text" } end
    if text:sub(1, 3) == "\239\187\191" then text = text:sub(4) end
    local lines = split_lines(text)
    local header = lines[1]
    if not header then return { status = "invalid", reason = "empty file" } end

    local magic, version = header:match("^(%S+) (%d+)$")
    if magic ~= M.MAGIC then return { status = "invalid", reason = "missing header" } end
    version = tonumber(version)
    if version > M.VERSION then return { status = "newer", version = version } end
    if version < 1 then return { status = "invalid", reason = "bad version" } end

    local trailer = lines[#lines]
    local expected = #lines >= 2 and trailer:match("^end (%d+)$")
    if not expected then return { status = "invalid", reason = "missing end marker (file cut short?)" } end
    expected = tonumber(expected)

    local set, count = {}, 0
    for i = 2, #lines - 1 do
        local id = M.parse_app_id(lines[i])
        if not id then
            return { status = "invalid", reason = "bad line " .. i }
        end
        if not set[id] then
            set[id] = true
            count = count + 1
        end
    end
    if (#lines - 2) ~= expected then
        return { status = "invalid", reason = "count mismatch" }
    end
    return { status = "ok", set = set, count = count, version = version }
end

-- Backup file format, version 1. A tag list with a few facts around it, so a
-- file the user keeps can be checked before it replaces anything:
--
--   steam-discreet-backup 1
--   # comment lines explain the file to whoever opens it
--   saved 2026-11-21T19:40:00Z
--   plugin 0.1.0
--   account 3f2a9c1b7d4e8a60
--   tags 2
--   570
--   730
--   end 2
--
-- `key value` lines before `tags` are facts. A reader ignores keys it does not
-- know, so later version 1 writers can add settings without breaking older
-- readers; anything an older reader must not ignore needs version 2. The
-- `account` value is a hash of the SteamID64 (backend/tagstore/backups.lua),
-- never the ID itself. The reveal toggle is never part of a backup.

M.BACKUP_VERSION = 1
M.BACKUP_MAGIC = "steam-discreet-backup"

local BACKUP_COMMENT = {
    "# Steam Discreet backup. It lists the App IDs of the games you tagged,",
    "# so anyone who opens it can see them. Keep it private.",
    "# Restore it from the Steam Discreet settings page in Steam.",
}

local function clean_fact(value)
    return (tostring(value):gsub("[%c]", " "))
end

---@param set table<integer, boolean>
---@param facts { saved?: string, plugin?: string, account?: string }
---@return string
function M.serialize_backup(set, facts)
    facts = facts or {}
    local ids = M.sorted_ids(set)
    local lines = { M.BACKUP_MAGIC .. " " .. M.BACKUP_VERSION }
    for i = 1, #BACKUP_COMMENT do lines[#lines + 1] = BACKUP_COMMENT[i] end
    for _, key in ipairs({ "saved", "plugin", "account" }) do
        if facts[key] ~= nil and facts[key] ~= "" then lines[#lines + 1] = key .. " " .. clean_fact(facts[key]) end
    end
    lines[#lines + 1] = "tags " .. #ids
    for i = 1, #ids do lines[#lines + 1] = string.format("%d", ids[i]) end
    lines[#lines + 1] = "end " .. #ids
    return table.concat(lines, "\n") .. "\n"
end

--- Parse a backup file.
--- Returns { status = "ok", set, count, facts = { [key] = value } },
--- { status = "newer", version } or { status = "invalid", reason }.
---@param text any
function M.parse_backup(text)
    if type(text) ~= "string" then return { status = "invalid", reason = "not text" } end
    if text:sub(1, 3) == "\239\187\191" then text = text:sub(4) end
    local lines = split_lines(text)
    local header = lines[1]
    if not header then return { status = "invalid", reason = "empty file" } end
    local magic, version = header:match("^(%S+) (%d+)$")
    if magic ~= M.BACKUP_MAGIC then return { status = "invalid", reason = "missing header" } end
    version = tonumber(version)
    if version > M.BACKUP_VERSION then return { status = "newer", version = version } end
    if version < 1 then return { status = "invalid", reason = "bad version" } end

    local facts, i, declared = {}, 2, nil
    while i <= #lines do
        local line = lines[i]
        local n = line:match("^tags (%d+)$")
        if n then
            declared = tonumber(n)
            break
        end
        if line ~= "" and line:sub(1, 1) ~= "#" then
            local key, value = line:match("^([%a_][%w_]*) (.*)$")
            if not key then return { status = "invalid", reason = "bad line " .. i } end
            facts[key] = value
        end
        i = i + 1
    end
    if not declared then return { status = "invalid", reason = "no tag list" } end

    local trailer = lines[#lines]
    local expected = #lines > i and trailer:match("^end (%d+)$")
    if not expected then return { status = "invalid", reason = "missing end marker (file cut short?)" } end
    expected = tonumber(expected)
    local first, last = i + 1, #lines - 1
    if last - first + 1 ~= expected or expected ~= declared then
        return { status = "invalid", reason = "count mismatch" }
    end

    local set, count = {}, 0
    for j = first, last do
        local id = M.parse_app_id(lines[j])
        if not id then return { status = "invalid", reason = "bad line " .. j } end
        if not set[id] then
            set[id] = true
            count = count + 1
        end
    end
    return { status = "ok", set = set, count = count, version = version, facts = facts }
end

--- Parse text the user chose to import. Accepts a backup file, an exported tag
--- file, or a bare list of App IDs separated by newlines, commas, semicolons or
--- spaces. Returns { status = "ok", set, count, kind, facts? } or
--- { status = "newer" | "invalid", ... }. `kind` is "backup", "tags" or "list".
---@param text any
function M.parse_import(text)
    if type(text) ~= "string" then return { status = "invalid", reason = "not text" } end
    local stripped = text:gsub("^\239\187\191", ""):gsub("^%s+", "")
    if stripped:sub(1, #M.BACKUP_MAGIC) == M.BACKUP_MAGIC then
        local parsed = M.parse_backup(stripped)
        parsed.kind = "backup"
        return parsed
    end
    if stripped:sub(1, #M.MAGIC) == M.MAGIC then
        local parsed = M.parse(stripped)
        parsed.kind = "tags"
        return parsed
    end
    local set, count = {}, 0
    for token in stripped:gmatch("[^%s,;]+") do
        local id = M.parse_app_id(token)
        if not id then return { status = "invalid", reason = "not an App ID: " .. token:sub(1, 20) } end
        if not set[id] then
            set[id] = true
            count = count + 1
        end
    end
    return { status = "ok", set = set, count = count, kind = "list" }
end

--- Comma-separated ID list, the wire format to the frontend. A string is used
--- because Millennium encodes an empty Lua table as a JSON object, not an array.
function M.encode_id_list(set)
    local ids = M.sorted_ids(set)
    for i = 1, #ids do ids[i] = string.format("%d", ids[i]) end
    return table.concat(ids, ",")
end

--- Parse a comma-separated ID list from the frontend. All-or-nothing.
---@return table<integer, boolean>|nil set
---@return integer|string count_or_error
function M.decode_id_list(text)
    if type(text) ~= "string" then return nil, "not text" end
    local set, count = {}, 0
    if text == "" then return set, 0 end
    for token in (text .. ","):gmatch("([^,]*),") do
        local id = M.parse_app_id(token)
        if not id then return nil, "not an App ID: " .. token:sub(1, 20) end
        if not set[id] then
            set[id] = true
            count = count + 1
        end
    end
    return set, count
end

return M
