-- Steam Discreet backend entry point.
-- Lifecycle, patch loading from hook_definitions.lua (M5) and the tag storage
-- RPC functions (M2). The updater (M6) is added by its own milestone; see
-- docs/PLAN.md.

local logger     = require("logger")
local millennium = require("millennium")
local hooks      = require("hooks")

-- Registers the frontend-callable tags_* functions as globals.
require("tagstore.rpc")

local M = {}

-- Read once, when Millennium loads this file. Problems in the data file never
-- stop the plugin: the affected hooks are left out and Steam stays unpatched.
local loaded_hooks = hooks.load()

function M.on_load()
    logger:info("Steam Discreet loaded on Millennium " .. tostring(millennium.version()))
    if loaded_hooks.error then
        logger:error("Hooks disabled: " .. loaded_hooks.error)
    end
    for _, r in ipairs(loaded_hooks.rejected) do
        logger:error("Hook '" .. r.id .. "' rejected: " .. r.reason)
    end
    millennium.ready()
end

-- Not called if Steam crashes or is killed, so never rely on it for persistence.
function M.on_unload()
    logger:info("Steam Discreet unloaded")
end

function M.on_frontend_loaded()
    logger:info("Steam Discreet frontend loaded")
end

-- What the frontend self-check expects. Wired to the settings page later.
function M.hook_manifest()
    return hooks.manifest(loaded_hooks)
end

-- Static patch table, read once by Millennium at load. It cannot depend on
-- account or configuration. Placeholder hooks are never included.
M.patches = hooks.patches(loaded_hooks)

return M
