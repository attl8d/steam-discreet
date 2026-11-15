local helpers = require("helpers")

local function valid_hook(overrides)
    local h = {
        id = "demo-hook",
        description = "demo",
        runs = "startup",
        file = [[chunk\.js]],
        find = [[a\(b\)]],
        transforms = { { match = [[b]], replace = [[#{{marker}},b]] } },
    }
    for k, v in pairs(overrides or {}) do h[k] = v end
    return h
end

local function load_one(overrides)
    local hooks = require("hooks")
    return hooks.load({ version = 1, hooks = { valid_hook(overrides) } })
end

describe("backend/hooks.lua", function()
    local hooks

    before_each(function()
        helpers.reset()
        package.loaded["hooks"] = nil
        hooks = require("hooks")
    end)

    it("loads the real definitions file with nothing rejected", function()
        local loaded = hooks.load()
        assert.is_nil(loaded.error)
        assert.are.same({}, loaded.rejected)
        assert.is_true(#loaded.hooks > 0)
    end)

    it("never sends placeholder hooks to Millennium", function()
        local loaded = hooks.load()
        for _, h in ipairs(loaded.hooks) do assert.is_true(h.placeholder) end
        assert.are.same({}, hooks.patches(loaded))
        assert.are.same({}, hooks.manifest(loaded).expected)
    end)

    it("builds Millennium's patch shape with the marker expanded", function()
        local patches = hooks.patches(load_one())
        assert.are.same({
            {
                file = [[chunk\.js]],
                find = [[a\(b\)]],
                transforms = { { match = "b", replace = hooks.marker_js("demo-hook") .. ",b" } },
            },
        }, patches)
        assert.are.equal('((window.__steamDiscreetHooks||={})["demo-hook"]=1)', hooks.marker_js("demo-hook"))
    end)

    it("lists expected hooks and rejections in the manifest", function()
        local loaded = hooks.load({ version = 1, hooks = { valid_hook(), valid_hook({ id = "Bad" }) } })
        local m = hooks.manifest(loaded)
        assert.are.equal(1, #m.expected)
        assert.are.equal("demo-hook", m.expected[1].id)
        assert.are.equal(1, #m.rejected)
    end)

    local cases = {
        { "an id that is not kebab-case", { id = "Bad_Id" }, "kebab" },
        { "a missing description", { description = "" }, "description" },
        { "a missing find", { find = "" }, "find" },
        { "no transforms", { transforms = {} }, "transform" },
        { "an unknown field", { finds = "x" }, "unknown field 'finds'" },
        { "a non-boolean placeholder", { placeholder = "yes" }, "placeholder" },
        { "a missing runs", { runs = false }, "runs" },
        { "an unknown runs value", { runs = "sometimes" }, "runs" },
        { "transforms with a gap", { transforms = { [1] = { match = "b", replace = "#{{marker}}" },
            [3] = { match = "c", replace = "c" } } }, "plain list" },
        { "transforms with a named key", { transforms = { { match = "b", replace = "#{{marker}}" },
            extra = { match = "c", replace = "c" } } }, "plain list" },
        { "no marker", { transforms = { { match = "b", replace = "b" } } }, "marker" },
        { "#{{self}} without ?.", { transforms = { { match = "b", replace = "#{{marker}},#{{self}}.x" } } }, "?." },
        { "an unknown token", { transforms = { { match = "b", replace = "#{{marker}}#{{selff}}" } } },
            "unknown token" },
        { "\\1 followed by a word character", { transforms = { { match = "(b)", replace = [[#{{marker}},\1a]] } } },
            "backreference" },
        { "a transform with an unknown field", { transforms = { { match = "b", replace = "#{{marker}}", re = 1 } } },
            "unknown field 're'" },
    }
    for _, c in ipairs(cases) do
        it("rejects " .. c[1] .. " without affecting other hooks", function()
            local loaded = hooks.load({ version = 1, hooks = { valid_hook(c[2]), valid_hook({ id = "other" }) } })
            assert.are.equal(1, #loaded.rejected)
            assert.truthy(loaded.rejected[1].reason:find(c[3], 1, true), loaded.rejected[1].reason)
            assert.are.equal(1, #loaded.hooks)
            assert.are.equal("other", loaded.hooks[1].id)
        end)
    end

    it("disables every hook, with an error, when hooks has a gap or a named key", function()
        local gap = hooks.load({ version = 1, hooks = { [1] = valid_hook(), [3] = valid_hook({ id = "c" }) } })
        assert.truthy(gap.error:find("plain list", 1, true))
        assert.are.same({}, gap.hooks)
        local named = hooks.load({ version = 1, hooks = { sidebar = valid_hook() } })
        assert.truthy(named.error:find("plain list", 1, true))
        local mixed = hooks.load({ version = 1, hooks = { valid_hook(), other = valid_hook({ id = "o" }) } })
        assert.truthy(mixed.error)
        assert.are.same({}, hooks.patches(mixed))
    end)

    it("carries runs into the manifest", function()
        local m = hooks.manifest(load_one({ runs = "on_demand" }))
        assert.are.equal("on_demand", m.expected[1].runs)
    end)

    it("rejects duplicate ids", function()
        local loaded = hooks.load({ version = 1, hooks = { valid_hook(), valid_hook() } })
        assert.are.equal(1, #loaded.hooks)
        assert.are.equal("duplicate id", loaded.rejected[1].reason)
    end)

    it("accepts \\1 followed by punctuation", function()
        local loaded = load_one({ transforms = { { match = "(b)", replace = [[#{{marker}},\1.x]] } } })
        assert.are.same({}, loaded.rejected)
    end)

    it("disables every hook, without raising, on an unsupported version or shape", function()
        assert.truthy(hooks.load({ version = 2, hooks = {} }).error:find("version"))
        assert.truthy(hooks.load({}).error)
        assert.truthy(hooks.load("nope").error)
    end)

    describe("loading the data file", function()
        after_each(function()
            package.preload["hook_definitions"] = nil
        end)

        it("runs it with no globals, so it can only hold data", function()
            package.preload["hook_definitions"] = function() return { version = 1, hooks = { os = os } } end
            local loaded = hooks.load()
            assert.is_nil(loaded.error)
            assert.are.same({}, loaded.hooks)
        end)

        it("never falls back to a file on disk when running from a package", function()
            -- In a .star, Millennium preloads every backend module, including this one.
            package.preload["hooks"] = function() return hooks end
            local loaded = hooks.load()
            package.preload["hooks"] = nil
            assert.truthy(loaded.error:find("did not compile", 1, true))
            assert.are.same({}, loaded.hooks)
        end)

        it("reports a data file that raises instead of crashing the plugin", function()
            package.preload["hook_definitions"] = function() local t = false; return t.hooks end
            local loaded = hooks.load()
            assert.truthy(loaded.error:find("hook_definitions failed", 1, true))
            assert.are.same({}, hooks.patches(loaded))
        end)
    end)
end)
