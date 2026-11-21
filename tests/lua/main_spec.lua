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

    it("reports the hook manifest for the self-check", function()
        local manifest = plugin.hook_manifest()
        assert.are.equal(1, manifest.version)
        assert.are.same({}, manifest.rejected)
    end)
end)
