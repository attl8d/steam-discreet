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

--- Parse text the user chose to import. Accepts an exported tag file, or a bare
--- list of App IDs separated by newlines, commas, semicolons or spaces.
--- Returns { status = "ok", set, count } or { status = "newer" | "invalid", ... }.
---@param text any
function M.parse_import(text)
    if type(text) ~= "string" then return { status = "invalid", reason = "not text" } end
    local stripped = text:gsub("^\239\187\191", ""):gsub("^%s+", "")
    if stripped:sub(1, #M.MAGIC) == M.MAGIC then
        return M.parse(stripped)
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
    return { status = "ok", set = set, count = count }
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
