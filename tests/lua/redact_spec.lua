local helpers = require("helpers")

describe("backend/redact.lua", function()
    local redact = require("redact").redact
    local function env(t) return function(name) return t[name] end end

    it("replaces the real profile and AppData paths in every spelling, ignoring case", function()
        local getenv = env({
            USERPROFILE = "C:\\Users\\John Smith",
            APPDATA = "C:\\Users\\John Smith\\AppData\\Roaming",
            USERNAME = "John Smith",
        })
        local text = "open C:\\Users\\John Smith\\AppData\\Roaming\\SteamDiscreet failed; "
            .. "also \"C:\\\\Users\\\\John Smith\\\\Desktop\" and c:/users/john smith/x"
        local out = redact(text, getenv)
        assert.are.equal("open <APPDATA>\\SteamDiscreet failed; "
            .. "also \"<USERPROFILE>\\\\Desktop\" and <USERPROFILE>/x", out)
        assert.is_falsy(out:find("John", 1, true))
    end)

    it("replaces the macOS home and the login name as a whole word", function()
        local getenv = env({ HOME = "/Users/attila", USER = "attila" })
        local out = redact("/Users/attila/Library/x by attila, not attilas", getenv)
        assert.are.equal("<HOME>/Library/x by <user>, not attilas", out)
    end)

    it("ignores roots and short names that would redact everything", function()
        local out = redact("C:\\Program Files\\Steam and a b", env({ USERPROFILE = "C:\\", USERNAME = "a" }))
        assert.are.equal("C:\\Program Files\\Steam and a b", out)
    end)

    it("treats pattern characters in values literally", function()
        local out = redact("/home/a.b-c%d/x", env({ HOME = "/home/a.b-c%d" }))
        assert.are.equal("<HOME>/x", out)
    end)

    it("is exposed to the frontend and never raises", function()
        helpers.reset()
        helpers.install_millennium_stubs()
        require("main")
        assert.are.equal("text", _G.steam_discreet_redact("text"))
        assert.are.equal("", _G.steam_discreet_redact(nil))
    end)
end)

describe("tags_preview_import", function()
    before_each(function()
        helpers.reset()
        helpers.install_millennium_stubs()
        require("tagstore.rpc")
    end)

    it("counts distinct App IDs without saving", function()
        assert.are.same({ ok = true, count = 2 }, _G.tags_preview_import("570, 730\n570"))
    end)

    it("refuses text that is not a tag list", function()
        local r = _G.tags_preview_import("570 hello")
        assert.is_false(r.ok)
        assert.are.equal("import_invalid", r.error)
    end)
end)
