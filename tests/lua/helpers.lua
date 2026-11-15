-- Stubs for the modules Millennium injects into the Lua backend, so backend
-- code can be loaded and tested with plain LuaJIT + busted outside Steam.
local M = {}

local function shell_quote(s)
    return "'" .. tostring(s):gsub("'", "'\\''") .. "'"
end

local function sh_ok(cmd)
    local r = os.execute(cmd)
    return r == true or r == 0
end

-- Millennium's `fs` module wraps std::filesystem (src/lua_host/api/filesystem.cc).
-- This stub reproduces the return conventions the backend relies on, using
-- real files: rename replaces an existing target, copy overwrites, remove
-- returns false for a missing path, create_directories is recursive.
function M.make_fs_stub()
    local fs = {}
    function fs.exists(path) return sh_ok("test -e " .. shell_quote(path)) end
    function fs.is_directory(path) return sh_ok("test -d " .. shell_quote(path)) end
    function fs.create_directories(path)
        if fs.is_directory(path) then return false end
        if sh_ok("mkdir -p " .. shell_quote(path) .. " 2>/dev/null") then return true end
        return nil, "mkdir failed"
    end
    function fs.rename(from, to)
        local ok, err = os.rename(from, to)
        if not ok then return nil, err end
        return true
    end
    function fs.copy(from, to)
        local src, err = io.open(from, "rb")
        if not src then return nil, err end
        local data = src:read("*a")
        src:close()
        local dst, werr = io.open(to, "wb")
        if not dst then return nil, werr end
        dst:write(data)
        dst:close()
        return true
    end
    function fs.remove(path)
        if not fs.exists(path) then return false end
        local ok, err = os.remove(path)
        if not ok then return nil, err end
        return true
    end
    return fs
end

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
    package.loaded["fs"] = M.make_fs_stub()
    return { logger = logger, millennium = millennium }
end

local BACKEND_MODULES = {
    "logger", "millennium", "fs", "main",
    "tagstore.paths", "tagstore.format", "tagstore.fsio", "tagstore.store", "tagstore.rpc",
}
local RPC_GLOBALS = { "tags_open", "tags_add", "tags_remove", "tags_clear", "tags_export", "tags_import" }

function M.reset()
    for _, name in ipairs(BACKEND_MODULES) do
        package.loaded[name] = nil
    end
    for _, name in ipairs(RPC_GLOBALS) do
        _G[name] = nil
    end
end

-- A fresh, empty directory under the system temp folder.
function M.temp_dir()
    local base = os.tmpname()
    os.remove(base)
    assert(sh_ok("mkdir -p " .. shell_quote(base)))
    return base
end

function M.remove_dir(path)
    if path and path:match("^/tmp/") then os.execute("rm -rf " .. shell_quote(path)) end
end

function M.read_file(path)
    local f = io.open(path, "rb")
    if not f then return nil end
    local s = f:read("*a")
    f:close()
    return s
end

function M.write_file(path, content)
    local f = assert(io.open(path, "wb"))
    f:write(content)
    f:close()
end

function M.list_dir(path)
    local names = {}
    local p = io.popen("ls -1 " .. shell_quote(path))
    for line in p:lines() do names[#names + 1] = line end
    p:close()
    table.sort(names)
    return names
end

return M
