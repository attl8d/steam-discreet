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
    local ok, err = pcall(function()
        if not M.updater then
            M.updater = require("updater").new({ platform = require("updater.platform"), current_version = version })
        end
        return fn(M.updater)
    end)
    if not ok then logger:warn("Steam Discreet updater " .. what .. " failed: " .. tostring(err)) end
end

local update_check_started = false
local function start_update_check()
    if update_check_started then return end
    update_check_started = true
    with_updater("check", function(u) u:check() end)
end

function M.on_load()
    logger:info("Steam Discreet " .. version .. " loaded on Millennium " .. tostring(millennium.version()))
    millennium.ready()
    -- Runs once the plugin has answered Millennium's init request, so Steam
    -- startup does not wait for GitHub. If the coroutine API is missing, the
    -- check falls back to the first on_frontend_loaded.
    local platform = require("updater.platform")
    local ok, scheduled = pcall(platform.start_background, start_update_check)
    if not (ok and scheduled) then logger:info("Steam Discreet update check deferred to frontend load") end
end

-- Not called if Steam crashes or is killed, so never rely on it for persistence.
-- A staged update simply waits for the next clean shutdown.
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
