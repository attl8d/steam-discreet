-- Stubs for the modules Millennium injects into the Lua backend, so backend
-- code can be loaded and tested with plain LuaJIT + busted outside Steam.
local M = {}

function M.install_millennium_stubs()
    local log = {}
    local logger = {
        messages = log,
        info  = function(_, msg) log[#log + 1] = { "info", msg } end,
        warn  = function(_, msg) log[#log + 1] = { "warn", msg } end,
        error = function(_, msg) log[#log + 1] = { "error", msg } end,
    }
    local millennium = {
        ready_calls = 0,
        version = function() return "0.0.0-test" end,
    }
    function millennium.ready() millennium.ready_calls = millennium.ready_calls + 1; return true end

    -- fs, utils and http are only called inside RPC functions, never at load,
    -- so empty tables are enough for loading the backend.
    package.loaded["logger"] = logger
    package.loaded["millennium"] = millennium
    package.loaded["fs"] = {}
    package.loaded["utils"] = {}
    package.loaded["http"] = {}
    return { logger = logger, millennium = millennium }
end

function M.reset()
    for _, name in ipairs({ "logger", "millennium", "fs", "utils", "http", "diagnostics", "main" }) do
        package.loaded[name] = nil
    end
end

return M
