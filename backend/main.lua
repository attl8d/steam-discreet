-- Steam Discreet backend entry point.
-- Lifecycle only. Tag storage (M2), patch loading from hooks/ (M5) and the
-- updater (M6) are added by their own milestones; see docs/PLAN.md.

local logger     = require("logger")
local millennium = require("millennium")

-- M1 diagnostics RPC (sd_diag_probe).
require("diagnostics")

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
-- account or configuration.
--
-- M1 experiment 1 (shared seam): collectionStore.BIsVisible is a non-writable
-- bound method, so it cannot be overridden at runtime. This transform appends
-- a guarded check to its body. If the plugin is missing or unloaded, the
-- `?.` guard yields undefined and the game stays visible (fail open).
M.patches = {
    {
        file = [[sp\.js]],
        find = [[BIsVisible\(\w+\)\{const \w+=typeof \w+=="number"\?[\w.]+\.GetAppOverviewByAppID\(\w+\):\w+;]]
            .. [[return [^}]*&&!this\.BIsHidden\(\w+\.appid\)\}]],
        transforms = {
            {
                match = [[&&!this\.BIsHidden\((\w+)\.appid\)\}]],
                replace = [[&&!this.BIsHidden(\1.appid)&&!(#{{self}}?.sdIsTagged?.(\1.appid)??!1)}]],
            },
        },
    },
}

return M
