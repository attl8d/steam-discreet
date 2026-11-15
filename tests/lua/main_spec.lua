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

    it("declares a static patch table", function()
        assert.is_table(plugin.patches)
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
