-- M1 diagnostics. Answers open questions 5 and 6 on the live machine and is
-- exposed to the frontend as an RPC. Removed or folded into M5 self-check later.

local logger     = require("logger")
local millennium = require("millennium")
local fs         = require("fs")
local utils      = require("utils")
local http       = require("http")

local function try_write_dir(dir)
    local result = { dir = dir }
    local ok, err = fs.create_directories(dir)
    result.mkdir = (ok == nil) and ("error: " .. tostring(err)) or "ok"
    local tmp = fs.join(dir, ".probe.tmp")
    local final = fs.join(dir, ".probe")
    local wrote, werr = utils.write_file(tmp, "steam-discreet probe")
    result.write = wrote and "ok" or ("error: " .. tostring(werr))
    if wrote then
        local renamed, rerr = fs.rename(tmp, final)
        result.rename = renamed and "ok" or ("error: " .. tostring(rerr))
        local content = utils.read_file(renamed and final or tmp)
        result.read_back = content == "steam-discreet probe"
        -- Atomic save needs rename to replace an existing file.
        utils.write_file(tmp, "replaced")
        local replaced, perr = fs.rename(tmp, final)
        if replaced then
            result.rename_over_existing = utils.read_file(final) == "replaced"
        else
            result.rename_over_existing = "error: " .. tostring(perr)
        end
        fs.remove(final)
        fs.remove(tmp)
    end
    return result
end

---@ffi
---@return table
function sd_diag_probe()
    local appdata = utils.getenv("APPDATA")
    local backend = utils.get_backend_path()
    local report = {
        millennium_version = millennium.version(),
        steam_path = millennium.steam_path(),
        install_path = millennium.get_install_path(),
        backend_path = backend,
        cwd = fs.current_path(),
        writes = {},
    }
    if appdata then
        table.insert(report.writes, try_write_dir(fs.join(appdata, "SteamDiscreet")))
    end
    if backend then
        -- The plugin's own folder: needed for self-update (open question 6).
        table.insert(report.writes, try_write_dir(fs.join(fs.parent_path(backend), "probe-update")))
        fs.remove_all(fs.join(fs.parent_path(backend), "probe-update"))
    end
    table.insert(report.writes, try_write_dir(fs.join(millennium.steam_path(), "steam-discreet-probe")))
    fs.remove_all(fs.join(millennium.steam_path(), "steam-discreet-probe"))

    -- Plain Lua io/os, as used by the M2 tag store.
    local stdio = { os_getenv_appdata = os.getenv("APPDATA") ~= nil, has_io = type(io) == "table" }
    if appdata and type(io) == "table" then
        local dir = fs.join(appdata, "SteamDiscreet")
        local p = dir .. "\\probe.txt"
        local f, oerr = io.open(p, "wb")
        if f then
            stdio.write = f:write("io probe \0 binary\r\n") and "ok" or "error"
            f:close()
            local r = io.open(p, "rb")
            local content = r and r:read("*a")
            if r then r:close() end
            stdio.read_back = content == "io probe \0 binary\r\n"
            local q = io.open(dir .. "\\probe2.txt", "wb")
            if q then q:write("second"); q:close() end
            local ok, rerr = os.rename(dir .. "\\probe2.txt", p)
            stdio.os_rename_over_existing = ok and true or ("error: " .. tostring(rerr))
            local r2 = io.open(p, "rb")
            stdio.after_rename = r2 and r2:read("*a") == "second"
            if r2 then r2:close() end
            os.remove(p)
            os.remove(dir .. "\\probe2.txt")
        else
            stdio.open = "error: " .. tostring(oerr)
        end
    end
    report.stdio = stdio

    local res, herr = http.get("https://api.github.com/repos/attl8d/steam-discreet/releases",
        { headers = { ["User-Agent"] = "steam-discreet", ["Accept"] = "application/vnd.github+json" } })
    if res then
        report.https = { status = res.status, body_bytes = res.body and #res.body or 0 }
    else
        report.https = { error = tostring(herr) }
    end
    logger:info("diagnostic probe done")
    return report
end
