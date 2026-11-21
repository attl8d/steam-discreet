-- File primitives used by the tag store. Reads and writes use Lua's io library
-- (Millennium opens the standard libraries); rename, copy and mkdir use
-- Millennium's `fs` module, which wraps std::filesystem. std::filesystem::rename
-- replaces an existing target on Windows, which os.rename does not.
--
-- Under plain LuaJIT the tests provide an `fs` stub (tests/lua/helpers.lua).
-- Tests can also wrap this table to inject failures.

local fs = require("fs")

local M = {}

---@return string|nil content
---@return string|nil err
function M.read(path)
    local f, err = io.open(path, "rb")
    if not f then return nil, err end
    local content = f:read("*a")
    f:close()
    if content == nil then return nil, "read failed" end
    return content
end

---@return boolean ok
---@return string|nil err
function M.write(path, content)
    local f, err = io.open(path, "wb")
    if not f then return false, err end
    local ok, werr = f:write(content)
    if not ok then
        f:close()
        return false, werr or "write failed"
    end
    local flushed, ferr = f:flush()
    local closed, cerr = f:close()
    if not flushed then return false, ferr or "flush failed" end
    if not closed then return false, cerr or "close failed" end
    return true
end

function M.exists(path)
    return fs.exists(path) == true
end

---@return boolean ok
---@return string|nil err
function M.rename(from, to)
    local ok, err = fs.rename(from, to)
    if not ok then return false, err or "rename failed" end
    return true
end

---@return boolean ok
---@return string|nil err
function M.copy(from, to)
    local ok, err = fs.copy(from, to)
    if not ok then return false, err or "copy failed" end
    return true
end

-- Millennium's fs.remove and fs.create_directories return `false, message` on
-- failure and a bare `false` when there was nothing to do (filesystem.cc at
-- 6522c24), so failure is detected by the message, not by nil.
function M.remove(path)
    local _, err = fs.remove(path)
    if err ~= nil then return false, err end
    return true
end

---@return boolean ok
---@return string|nil err
function M.ensure_dir(path)
    local _, err = fs.create_directories(path)
    if err ~= nil then return false, err end
    if not fs.is_directory(path) then return false, "not a directory" end
    return true
end

function M.is_dir(path)
    return fs.is_directory(path) == true
end

--- The regular files directly in `dir`, as { name, size? }, through
--- Millennium's `fs.list` (an array of entries with `name`, `is_file`, `size`).
---@return { name: string, size: integer|nil }[]|nil files
---@return string|nil err
function M.list_files(dir)
    local ok, entries, err = pcall(fs.list, dir)
    if not ok then return nil, tostring(entries) end
    if type(entries) ~= "table" then return nil, err or "cannot list folder" end
    local names = {}
    for _, entry in ipairs(entries) do
        if type(entry) == "table" and entry.is_file == true and type(entry.name) == "string" then
            names[#names + 1] = { name = entry.name, size = type(entry.size) == "number" and entry.size or nil }
        end
    end
    return names
end

return M
