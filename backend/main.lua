-- Steam Discreet backend entry point.
-- Lifecycle, plus the tag storage RPC functions (M2). Patch loading from
-- hooks/ (M5) and the updater (M6) are added by their own milestones; see
-- docs/PLAN.md.

local logger     = require("logger")
local millennium = require("millennium")

-- Registers the frontend-callable tags_* functions as globals.
require("tagstore.rpc")

local M = {}

function M.on_load()
    logger:info("Steam Discreet loaded on Millennium " .. tostring(millennium.version()))
    millennium.ready()
end

-- Not called if Steam crashes or is killed, so never rely on it for persistence.
function M.on_unload()
    logger:info("Steam Discreet unloaded")
end

function M.on_frontend_loaded()
    logger:info("Steam Discreet frontend loaded")
end

-- Static patch table, read once by Millennium at load. It cannot depend on
-- account or configuration. Empty until hook definitions exist (M1/M5).
M.patches = {}

return M
