-- Frontend-callable tag storage functions.
--
-- Millennium calls backend functions by global name (lua_host/main.cc,
-- handle_evaluate) and starlight generates `backend.<name>` typings from the
-- `---@ffi` annotations. ID lists travel as comma-separated strings because
-- Millennium encodes an empty Lua table as a JSON object, not an array.
--
-- Every function returns a table with `ok`. On success it also carries `state`,
-- `writable`, `ids` and `count`; on failure `error` (a code) and `message`.

local logger = require("logger")
local format = require("tagstore.format")
local Store = require("tagstore.store")

local M = {}

M.store = Store.new({ logger = logger })

local function guarded(fn, ...)
    local ok, result = pcall(fn, ...)
    if ok then return result end
    logger:error("[tags] internal error: " .. tostring(result))
    return { ok = false, error = "internal", message = "Internal error in tag storage: " .. tostring(result) }
end

local function with_ids(ids, fn)
    local set, count_or_err = format.decode_id_list(ids)
    if not set then return { ok = false, error = "bad_request", message = count_or_err } end
    return fn(set)
end

---@ffi
---Load an account's tags from disk.
---@param account string SteamID64
---@return table
function tags_open(account)
    return guarded(function() return M.store:open(account) end)
end

---@ffi
---Tag App IDs (comma-separated).
---@param account string
---@param ids string
---@return table
function tags_add(account, ids)
    return guarded(function()
        return with_ids(ids, function(set) return M.store:add(account, set) end)
    end)
end

---@ffi
---Untag App IDs (comma-separated).
---@param account string
---@param ids string
---@return table
function tags_remove(account, ids)
    return guarded(function()
        return with_ids(ids, function(set) return M.store:remove(account, set) end)
    end)
end

---@ffi
---Remove every tag for the account.
---@param account string
---@return table
function tags_clear(account)
    return guarded(function() return M.store:clear(account) end)
end

---@ffi
---Export the tag list as text (field `text`).
---@param account string
---@return table
function tags_export(account)
    return guarded(function() return M.store:export(account) end)
end

---@ffi
---Import a tag list exported earlier, or a plain list of App IDs.
---@param account string
---@param text string
---@param mode string "merge" or "replace"
---@return table
function tags_import(account, text, mode)
    return guarded(function() return M.store:import(account, text, mode) end)
end

---@ffi
---Parse pasted import text without saving anything: how many App IDs it holds.
---Lets the settings page show counts in the Replace confirmation.
---@param text string
---@return table
function tags_preview_import(text)
    return guarded(function()
        local parsed = format.parse_import(text)
        if parsed.status == "newer" then
            return { ok = false, error = "import_newer",
                message = "This export comes from a newer version of Steam Discreet." }
        end
        if parsed.status ~= "ok" then
            return { ok = false, error = "import_invalid",
                message = "The file is not a tag list: " .. tostring(parsed.reason) }
        end
        local count = 0
        for _ in pairs(parsed.set) do count = count + 1 end
        return { ok = true, count = count }
    end)
end

M.functions = {
    tags_open = tags_open,
    tags_add = tags_add,
    tags_remove = tags_remove,
    tags_clear = tags_clear,
    tags_export = tags_export,
    tags_import = tags_import,
    tags_preview_import = tags_preview_import,
}

return M
