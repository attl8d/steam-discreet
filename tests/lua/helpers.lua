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

    package.loaded["logger"] = logger
    package.loaded["millennium"] = millennium
    return { logger = logger, millennium = millennium }
end

function M.reset()
    for _, name in ipairs({ "logger", "millennium", "main", "version", "updater", "updater.platform",
                            "http", "fs", "utils", "json" }) do
        package.loaded[name] = nil
    end
end

return M
