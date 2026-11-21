-- The only updater module that touches Millennium's Lua APIs or the disk.
-- Everything else in backend/updater receives this table and can be tested
-- with an in-memory fake (tests/lua/fake_platform.lua).
--
-- API names below were read from Millennium source at commit 6522c24
-- (src/lua_host/api/*.cc); see docs/research.md, "Self-update". None of
-- them has been exercised on the live client yet.

local M = {}

local function lib(name)
    local ok, mod = pcall(require, name)
    if ok then return mod end
    return nil
end

function M.now()
    return os.time()
end

-- Millennium's plugins folder. The parent process sets MILLENNIUM__PLUGINS_PATH
-- in its own environment (src/system/environment.cc) and the Lua host is a
-- child process, so it should inherit it. On Windows the same folder is
-- <install path>/plugins, which is the fallback.
function M.plugins_dir()
    local utils = lib("utils")
    local dir = utils and utils.getenv and utils.getenv("MILLENNIUM__PLUGINS_PATH")
    if type(dir) == "string" and dir ~= "" then return dir end
    local millennium = lib("millennium")
    local install = millennium and millennium.get_install_path and millennium.get_install_path()
    if type(install) == "string" and install ~= "" then return install .. "/plugins" end
    return nil, "plugins folder unknown"
end

function M.join(a, b)
    return a .. "/" .. b
end

-- GET a small text resource. http.request returns the body through
-- lua_pushstring, which stops at a NUL byte, so it is only used for JSON
-- and checksum text; binaries go through M.download.
function M.http_get(url, headers, timeout)
    local http = lib("http")
    if not http then return nil, "http module unavailable" end
    local res, err = http.get(url, { headers = headers, timeout = timeout, verify_ssl = true, follow_redirects = true })
    if not res then return nil, tostring(err) end
    return { status = res.status, body = res.body }
end

-- Stream a URL to a file. http.download exists in http.cc but is missing
-- from Millennium's Lua type stubs. It does not fail on HTTP error codes,
-- so callers must check `status`.
function M.download(url, path, headers, timeout)
    local http = lib("http")
    if not http or not http.download then return nil, "http.download unavailable" end
    local res, err = http.download(url, path, { headers = headers, timeout = timeout, verify_ssl = true,
        follow_redirects = true })
    if not res then return nil, tostring(err) end
    return { status = res.status, bytes = res.bytes_written }
end

function M.json_decode(text)
    local json = lib("json")
    if not json then return nil, "json module unavailable" end
    local ok, value = pcall(json.decode, text)
    if not ok then return nil, tostring(value) end
    return value
end

function M.json_encode(value)
    local json = lib("json")
    if not json then return nil, "json module unavailable" end
    local ok, text = pcall(json.encode, value)
    if not ok then return nil, tostring(text) end
    return text
end

function M.exists(path)
    local f = io.open(path, "rb")
    if f then f:close(); return true end
    return false
end

function M.read_file(path)
    local f, err = io.open(path, "rb")
    if not f then return nil, err end
    local data = f:read("*a")
    f:close()
    return data
end

function M.write_file(path, data)
    local f, err = io.open(path, "wb")
    if not f then return nil, err end
    local ok, werr = f:write(data)
    local cok, cerr = f:close()
    if not ok then return nil, werr end
    if not cok then return nil, cerr end
    return true
end

-- Replaces `to` if it exists. Uses fs.rename (std::filesystem::rename, which
-- replaces an existing file on Windows too); os.rename fails there instead.
function M.rename(from, to)
    local fs = lib("fs")
    if fs and fs.rename then
        local ok, err = fs.rename(from, to)
        if ok then return true end
        return nil, tostring(err)
    end
    local ok, err = os.rename(from, to)
    if ok then return true end
    return nil, tostring(err)
end

function M.remove(path)
    if not M.exists(path) then return true end
    local ok, err = os.remove(path)
    if ok then return true end
    return nil, tostring(err)
end

function M.mkdir(path)
    local fs = lib("fs")
    if fs and fs.create_directories then
        -- Returns false when the folder already exists and false, message on
        -- error (filesystem.cc, Lua_CreateDirectories), so the message is
        -- what signals failure.
        local _, err = fs.create_directories(path)
        if err ~= nil then return nil, tostring(err) end
        return true
    end
    return nil, "fs module unavailable"
end

-- Run fn after Millennium's event loop starts, i.e. after the plugin has
-- answered the init request, so Steam's startup never waits on the network.
-- millennium.start_coroutine is in millennium.cc but not in the type stubs.
-- The Lua host keeps only a raw lua_State* to the coroutine, so a reference
-- is held here until it finishes to stop it being garbage collected.
local running = {}
function M.start_background(fn)
    local millennium = lib("millennium")
    if not (millennium and millennium.start_coroutine) then return false end
    local co
    co = coroutine.create(function()
        local ok, err = pcall(fn)
        running[co] = nil
        if not ok then M.log("error", "background task failed: " .. tostring(err)) end
    end)
    running[co] = true
    millennium.start_coroutine(co)
    return true
end

-- Number of background tasks still referenced (for tests and diagnostics).
function M.background_count()
    local n = 0
    for _ in pairs(running) do n = n + 1 end
    return n
end

function M.log(level, msg)
    local logger = lib("logger")
    if not logger then return end
    local fn = logger[level] or logger.info
    fn(logger, "[updater] " .. msg)
end

return M
