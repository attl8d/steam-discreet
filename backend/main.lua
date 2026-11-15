-- Steam Discreet backend entry point.
-- Lifecycle and wiring only. Tag storage (M2) and patch loading from hooks/
-- (M5) are added by their own milestones; see docs/PLAN.md.

local logger     = require("logger")
local millennium = require("millennium")
local version    = require("version")

local M = {}

M.version = version

-- The updater must never be able to stop the plugin from loading or
-- unloading, so every call into it is protected.
local function with_updater(what, fn)
    local ok, result = pcall(function()
        if not M.updater then
            M.updater = require("updater").new({ platform = require("updater.platform"), current_version = version })
        end
        return fn(M.updater)
    end)
    if not ok then
        logger:warn("Steam Discreet updater " .. what .. " failed: " .. tostring(result))
        return nil, tostring(result)
    end
    return result
end

local update_check_started = false
local function start_update_check()
    if update_check_started then return end
    update_check_started = true
    with_updater("check", function(u) u:check() end)
end

-- Backend methods the frontend can call by name (Millennium looks up a
-- global function; src/lua_host/main.cc, handle_evaluate). Results are JSON
-- strings so they cross the bridge unchanged. The settings page (T8) uses them.
local function as_json(value)
    local ok, json = pcall(require, "json")
    if not ok then return nil end
    local eok, text = pcall(json.encode, value)
    if eok then return text end
    return nil
end

function M.update_status()
    local status, err = with_updater("status", function(u) return u:status() end)
    return as_json(status or { error = err })
end

function M.update_rollback()
    local result, err = with_updater("rollback", function(u) return u:request_rollback() end)
    return as_json(result or { result = "error", detail = err })
end

rawset(_G, "steam_discreet_update_status", M.update_status)
rawset(_G, "steam_discreet_update_rollback", M.update_rollback)

function M.on_load()
    logger:info("Steam Discreet " .. version .. " loaded on Millennium " .. tostring(millennium.version()))
    millennium.ready()
    -- No network here: Millennium waits for on_load before it counts the
    -- plugin as started. Noting a manual rollback is a quick local read.
    with_updater("startup", function(u) u:note_startup() end)
    -- Runs once the plugin has answered Millennium's init request, so Steam
    -- startup does not wait for GitHub. If the coroutine API is missing, the
    -- check falls back to the first on_frontend_loaded.
    local ok, scheduled = pcall(function()
        return require("updater.platform").start_background(start_update_check)
    end)
    if not (ok and scheduled) then logger:info("Steam Discreet update check deferred to frontend load") end
end

-- Called on Steam shutdown, on plugin disable, and also when Steam dies and
-- the backend sees its socket close (src/lua_host/main.cc, after rpc.run).
-- Only a hard kill of the backend process skips it; a staged update then
-- waits for the next unload. Swapping after a Steam crash is harmless: the
-- file is replaced in one rename and nothing is reading it.
function M.on_unload()
    with_updater("install", function(u) u:apply_staged() end)
    logger:info("Steam Discreet unloaded")
end

function M.on_frontend_loaded()
    logger:info("Steam Discreet frontend loaded")
    start_update_check()
end

-- Static patch table, read once by Millennium at load. It cannot depend on
-- account or configuration. Empty until hook definitions exist (M1/M5).
M.patches = {}

return M
