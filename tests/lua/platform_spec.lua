-- backend/updater/platform.lua against stubs shaped like Millennium's Lua
-- modules at commit 6522c24 (src/lua_host/api/*.cc).
local helpers = require("helpers")

describe("updater.platform", function()
    local platform, stubs, calls

    before_each(function()
        helpers.reset()
        stubs = helpers.install_millennium_stubs()
        calls = {}
        package.loaded["http"] = {
            get = function(url, opts)
                calls[#calls + 1] = { "get", url, opts }
                return { status = 200, body = "ok" }
            end,
            download = function(url, path, opts)
                calls[#calls + 1] = { "download", url, path, opts }
                return { success = true, status = 404, bytes_written = 9 }
            end,
        }
        package.loaded["utils"] = { getenv = function() return nil end }
        stubs.millennium.get_install_path = function() return "C:/Program Files (x86)/Steam" end
        platform = require("updater.platform")
    end)

    it("verifies TLS and passes timeouts and headers", function()
        platform.http_get("https://x", { A = "b" }, 10)
        platform.download("https://y", "out", { C = "d" }, 60)
        assert.is_true(calls[1][3].verify_ssl)
        assert.are.equal(10, calls[1][3].timeout)
        assert.are.same({ A = "b" }, calls[1][3].headers)
        assert.is_true(calls[2][4].verify_ssl)
        assert.are.equal(60, calls[2][4].timeout)
    end)

    it("reports the HTTP status of a download instead of treating it as success", function()
        local res = platform.download("https://y", "out", {}, 60)
        assert.are.equal(404, res.status)
        assert.are.equal(9, res.bytes)
    end)

    it("turns HTTP errors into nil, message", function()
        package.loaded["http"].get = function() return nil, "Timeout was reached" end
        local res, err = platform.http_get("https://x", {}, 1)
        assert.is_nil(res)
        assert.are.equal("Timeout was reached", err)
    end)

    it("finds the plugins folder from the environment first", function()
        package.loaded["utils"].getenv = function(k)
            if k == "MILLENNIUM__PLUGINS_PATH" then return "D:/m/plugins" end
        end
        assert.are.equal("D:/m/plugins", platform.plugins_dir())
    end)

    it("falls back to <install path>/plugins", function()
        assert.are.equal("C:/Program Files (x86)/Steam/plugins", platform.plugins_dir())
    end)

    it("uses fs.rename so an existing file is replaced", function()
        local seen
        package.loaded["fs"] = { rename = function(a, b) seen = { a, b }; return true end }
        assert.is_true(platform.rename("a", "b"))
        assert.are.same({ "a", "b" }, seen)
    end)

    it("schedules background work on Millennium's coroutine queue and keeps it alive", function()
        local queued
        stubs.millennium.start_coroutine = function(co) queued = co end
        local ran = false
        assert.is_true(platform.start_background(function() ran = true end))
        assert.are.equal("thread", type(queued))
        collectgarbage(); collectgarbage()
        assert.is_false(ran)
        assert.are.equal(1, platform.background_count())
        coroutine.resume(queued)
        assert.is_true(ran)
        assert.are.equal(0, platform.background_count())
    end)

    it("reports when there is no coroutine queue", function()
        assert.is_false(platform.start_background(function() end))
    end)

    it("reads and writes binary files", function()
        local path = os.tmpname()
        local data = "STAR\0\1\2\255"
        assert.is_true(platform.write_file(path, data))
        assert.are.equal(data, platform.read_file(path))
        assert.is_true(platform.exists(path))
        assert.is_true(platform.remove(path))
        assert.is_false(platform.exists(path))
    end)
end)
