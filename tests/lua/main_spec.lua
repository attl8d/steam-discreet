local helpers = require("helpers")

describe("backend/main.lua", function()
    local stubs, plugin

    before_each(function()
        helpers.reset()
        stubs = helpers.install_millennium_stubs()
        plugin = require("main")
    end)

    it("exposes the lifecycle hooks Millennium calls", function()
        assert.is_function(plugin.on_load)
        assert.is_function(plugin.on_unload)
        assert.is_function(plugin.on_frontend_loaded)
    end)

    it("signals ready exactly once on load", function()
        plugin.on_load()
        assert.are.equal(1, stubs.millennium.ready_calls)
    end)

    it("declares a static patch table with the real hooks only", function()
        assert.is_table(plugin.patches)
        assert.are.equal(1, #plugin.patches)
        local p = plugin.patches[1]
        assert.is_truthy(p.file:find("sp", 1, true))
        assert.is_truthy(p.find:find("BIsVisible", 1, true))
        -- The marker and the guarded plugin call are expanded/kept as Millennium needs them.
        local replace = p.transforms[1].replace
        assert.is_truthy(replace:find('["library-visibility"]=1', 1, true))
        assert.is_truthy(replace:find("#{{self}}?.sdShouldHide?.(", 1, true))
        for _, patch in ipairs(plugin.patches) do
            assert.is_falsy(patch.find:find("ExampleIsFiltered", 1, true))
        end
    end)

    it("exposes the hook manifest to the frontend as a global", function()
        assert.is_function(_G.steam_discreet_hook_manifest)
        -- json (cjson) is only available inside Millennium; without it the call
        -- returns nil rather than raising.
        assert.has_no.errors(function() _G.steam_discreet_hook_manifest() end)
    end)

    it("reports the hook manifest for the self-check", function()
        local manifest = plugin.hook_manifest()
        assert.are.equal(1, manifest.version)
        assert.are.same({}, manifest.rejected)
    end)

    it("schedules the update check in the background instead of running it during load", function()
        local queued
        stubs.millennium.start_coroutine = function(co) queued = co end
        local checks = 0
        package.loaded["updater"] = { new = function() return { check = function() checks = checks + 1 end } end }
        plugin.on_load()
        assert.are.equal(0, checks)
        coroutine.resume(queued)
        assert.are.equal(1, checks)
        plugin.on_frontend_loaded()
        assert.are.equal(1, checks)
    end)

    it("falls back to checking once on frontend load", function()
        local checks = 0
        package.loaded["updater"] = { new = function() return { check = function() checks = checks + 1 end } end }
        plugin.on_load()
        plugin.on_frontend_loaded()
        plugin.on_frontend_loaded()
        assert.are.equal(1, checks)
    end)

    it("installs a staged update on unload", function()
        local applied = 0
        local fake = { apply_staged = function() applied = applied + 1 end }
        package.loaded["updater"] = { new = function() return fake end }
        plugin.on_unload()
        assert.are.equal(1, applied)
    end)

    it("keeps loading when the platform module cannot be required", function()
        package.preload["updater.platform"] = function() error("broken platform") end
        assert.has_no.errors(function() plugin.on_load() end)
        package.preload["updater.platform"] = nil
        assert.are.equal(1, stubs.millennium.ready_calls)
    end)

    it("notes a manual rollback at startup, before any network check", function()
        local order = {}
        package.loaded["updater"] = { new = function()
            return { note_startup = function() order[#order + 1] = "startup" end,
                     check = function() order[#order + 1] = "check" end }
        end }
        plugin.on_load()
        plugin.on_frontend_loaded()
        assert.are.same({ "startup", "check" }, order)
    end)

    it("exposes status and rollback to the frontend as JSON", function()
        package.loaded["json"] = { encode = function(v) return "json:" .. tostring(v.result or v.current_version) end }
        package.loaded["updater"] = { new = function()
            return { status = function() return { current_version = "0.1.0" } end,
                     request_rollback = function() return { result = "rollback_staged" } end }
        end }
        assert.are.equal("json:0.1.0", _G.steam_discreet_update_status())
        assert.are.equal("json:rollback_staged", _G.steam_discreet_update_rollback())
    end)

    it("reports updater errors to the frontend instead of throwing", function()
        package.loaded["json"] = { encode = function(v) return "json:" .. tostring(v.result) end }
        package.loaded["updater"] = { new = function() error("boom") end }
        assert.are.equal("json:error", plugin.update_rollback())
    end)

    it("keeps loading and unloading when the updater throws", function()
        package.loaded["updater"] = { new = function() error("boom") end }
        assert.has_no.errors(function()
            plugin.on_load()
            plugin.on_frontend_loaded()
            plugin.on_unload()
        end)
        assert.are.equal(1, stubs.millennium.ready_calls)
    end)
end)
