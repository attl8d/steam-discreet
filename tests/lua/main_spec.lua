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

    it("declares a static patch table without placeholder hooks", function()
        assert.is_table(plugin.patches)
        assert.are.same({}, plugin.patches)
    end)

    it("reports the hook manifest for the self-check", function()
        local manifest = plugin.hook_manifest()
        assert.are.equal(1, manifest.version)
        assert.are.same({}, manifest.rejected)
    end)
end)
