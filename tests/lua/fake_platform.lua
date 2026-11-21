-- In-memory stand-in for backend/updater/platform.lua: a dictionary file
-- system plus scripted HTTP responses, so updater logic runs without Steam.
local cjson_ok, cjson = pcall(require, "cjson")

local M = {}

-- Tiny JSON fallback for environments without lua-cjson: values are kept
-- as Lua tables behind an opaque handle.
local store, next_id = {}, 0
local function encode(v)
    if cjson_ok then return cjson.encode(v) end
    next_id = next_id + 1
    store["json#" .. next_id] = v
    return "json#" .. next_id
end
local function decode(s)
    if cjson_ok then
        local ok, v = pcall(cjson.decode, s)
        if ok then return v end
        return nil, v
    end
    local v = store[s]
    if v == nil then return nil, "invalid json" end
    return v
end

function M.new(opts)
    opts = opts or {}
    local p = {
        files = {},
        routes = {},
        requests = {},
        writes = {},
        clock = 1000,
        plugins = opts.plugins or "C:/Steam/millennium/plugins",
        logs = {},
        fail_rename = {},
        fail_write = {},
    }

    function p.now() return p.clock end
    function p.plugins_dir() return p.plugins end
    function p.join(a, b) return a .. "/" .. b end

    -- route = { status = 200, body = "..." } or { error = "..." }
    function p.http_get(url, headers, timeout)
        p.requests[#p.requests + 1] = { kind = "get", url = url, headers = headers, timeout = timeout }
        local r = p.routes[url]
        if not r then return { status = 404, body = "" } end
        if r.error then return nil, r.error end
        return { status = r.status or 200, body = r.body }
    end

    function p.download(url, path, headers, timeout)
        p.requests[#p.requests + 1] =
            { kind = "download", url = url, path = path, headers = headers, timeout = timeout }
        local r = p.routes[url]
        if not r then p.files[path] = ""; return { status = 404, bytes = 0 } end
        if r.error then return nil, r.error end
        p.files[path] = r.body
        p.writes[#p.writes + 1] = path
        return { status = r.status or 200, bytes = #r.body }
    end

    p.json_decode = decode
    p.json_encode = encode

    function p.exists(path) return p.files[path] ~= nil end
    function p.read_file(path)
        local d = p.files[path]
        if d == nil then return nil, "not found" end
        return d
    end
    function p.write_file(path, data)
        if p.fail_write[path] then return nil, "disk full" end
        p.files[path] = data
        p.writes[#p.writes + 1] = path
        return true
    end
    function p.rename(from, to)
        if p.fail_rename[to] then return nil, "access denied" end
        if p.files[from] == nil then return nil, "missing " .. from end
        p.files[to] = p.files[from]
        p.files[from] = nil
        p.writes[#p.writes + 1] = to
        return true
    end
    function p.remove(path) p.files[path] = nil; return true end
    function p.mkdir() return true end
    function p.start_background() return false end
    function p.log(level, msg) p.logs[#p.logs + 1] = { level, msg } end

    return p
end

M.encode = encode
return M
