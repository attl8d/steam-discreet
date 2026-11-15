local fake = require("fake_platform")
local sha256 = require("updater.sha256")

local API = "https://api.github.com/repos/attl8d/steam-discreet/releases/latest"
local DL = "https://github.com/attl8d/steam-discreet/releases/download/"
local PLUGINS = "C:/Steam/millennium/plugins"
local LIVE = PLUGINS .. "/steam-discreet.star"
local DIR = PLUGINS .. "/steam-discreet.update"
local TAGS = "C:/Users/me/AppData/Roaming/steam-discreet/tags-123.json"

local function star(payload) return "STAR" .. string.rep("\0", 12) .. payload end
-- A .star with a shim prefix: u32 LE length, shim, then the STAR header.
local function shimmed_star(payload)
    local shim = "-- shim"
    return string.char(#shim, 0, 0, 0) .. shim .. "STAR" .. string.rep("\0", 12) .. payload
end

local function release(version, data, overrides)
    overrides = overrides or {}
    local tag = "v" .. version
    local rel = {
        tag_name = tag, draft = false, prerelease = false,
        assets = {
            { name = "steam-discreet.star", size = #data, browser_download_url = DL .. tag .. "/steam-discreet.star",
              digest = "sha256:" .. sha256.hex(data) },
            { name = "steam-discreet.star.sha256", size = 85,
              browser_download_url = DL .. tag .. "/steam-discreet.star.sha256" },
        },
    }
    for k, v in pairs(overrides) do rel[k] = v end
    return rel
end

local function publish(p, version, data, opts)
    opts = opts or {}
    local rel = release(version, data, opts.release)
    p.routes[API] = { status = 200, body = fake.encode(rel) }
    local tag = "v" .. version
    p.routes[DL .. tag .. "/steam-discreet.star"] = { status = 200, body = opts.served or data }
    p.routes[DL .. tag .. "/steam-discreet.star.sha256"] = {
        status = 200, body = (opts.checksum or sha256.hex(data)) .. "  steam-discreet.star\n" }
    return rel
end

describe("updater", function()
    local updater, p, u

    before_each(function()
        package.loaded["updater"] = nil
        updater = require("updater")
        p = fake.new({ plugins = PLUGINS })
        p.files[LIVE] = star("v0.1.0")
        p.files[TAGS] = '{"version":1,"apps":[10,20]}'
        u = updater.new({ platform = p, current_version = "0.1.0" })
    end)

    local function files_in_dir()
        local n = 0
        for path in pairs(p.files) do
            if path:sub(1, #DIR + 1) == DIR .. "/" and not path:match("state%.json$") then n = n + 1 end
        end
        return n
    end

    describe("check", function()
        it("stages a newer verified release without touching the running plugin", function()
            local new = star("v0.2.0")
            publish(p, "0.2.0", new)
            local r = u:check()
            assert.are.equal("staged", r.result)
            assert.are.equal(new, p.files[DIR .. "/staged.star"])
            assert.are.equal(star("v0.1.0"), p.files[LIVE])
            assert.is_nil(p.files[DIR .. "/download.part"])
            assert.are.equal("0.2.0", u:status().staged_version)
        end)

        it("accepts a .star with a shim prefix", function()
            publish(p, "0.2.0", shimmed_star("x"))
            assert.are.equal("staged", u:check().result)
        end)

        it("only asks the trusted repo, over HTTPS, with short timeouts", function()
            publish(p, "0.2.0", star("v0.2.0"))
            u:check()
            assert.are.equal(API, p.requests[1].url)
            for _, req in ipairs(p.requests) do
                assert.truthy(req.url:find("^https://"))
                assert.truthy(req.url == API or req.url:sub(1, #DL) == DL)
                assert.truthy(req.timeout and req.timeout <= 60)
            end
        end)

        it("does nothing when the release is not newer", function()
            publish(p, "0.1.0", star("same"))
            assert.are.equal("up_to_date", u:check().result)
            publish(p, "0.0.9", star("old"))
            assert.are.equal("up_to_date", u:check().result)
            assert.are.equal(0, files_in_dir())
        end)

        it("compares versions numerically", function()
            u = updater.new({ platform = p, current_version = "0.9.0" })
            publish(p, "0.10.0", star("ten"))
            assert.are.equal("staged", u:check().result)
        end)

        it("does not download again when that version is already staged", function()
            publish(p, "0.2.0", star("v0.2.0"))
            u:check()
            local before = #p.requests
            assert.are.equal("already_staged", u:check().result)
            assert.are.equal(1, #p.requests - before)
        end)

        local failures = {
            { "a network error", function() p.routes[API] = { error = "Could not resolve host" } end },
            { "a private repo or no releases (404)", function() end },
            { "a rate limit (403)", function() p.routes[API] = { status = 403, body = "{}" } end },
            { "invalid JSON", function() p.routes[API] = { status = 200, body = "<html>" } end },
            { "a pre-release", function() publish(p, "0.2.0", star("x"), { release = { prerelease = true } }) end },
            { "a non-version tag", function()
                publish(p, "0.2.0", star("x"), { release = { tag_name = "nightly" } }) end },
            { "a missing .star asset", function()
                publish(p, "0.2.0", star("x"), { release = { assets = {} } }) end },
            { "an asset hosted elsewhere", function()
                local rel = release("0.2.0", star("x"))
                rel.assets[1].browser_download_url = "https://evil.example/steam-discreet.star"
                p.routes[API] = { status = 200, body = fake.encode(rel) }
            end },
            { "an asset from another repo", function()
                local rel = release("0.2.0", star("x"))
                rel.assets[1].browser_download_url =
                    "https://github.com/someone/steam-discreet/releases/download/v0.2.0/steam-discreet.star"
                p.routes[API] = { status = 200, body = fake.encode(rel) }
            end },
            { "an oversized asset", function()
                local rel = release("0.2.0", star("x"))
                rel.assets[1].size = 64 * 1024 * 1024
                p.routes[API] = { status = 200, body = fake.encode(rel) }
            end },
            { "a malformed checksum file", function()
                publish(p, "0.2.0", star("x"), { checksum = "not-a-hash" }) end },
            { "a checksum mismatch", function()
                local good = star("good")
                publish(p, "0.2.0", good, { served = star("evil") })
                -- keep the size equal so the hash is what catches it
                p.routes[DL .. "v0.2.0/steam-discreet.star"].body = star("eviL")
            end },
            { "a checksum that disagrees with GitHub's digest", function()
                publish(p, "0.2.0", star("x"), { checksum = string.rep("a", 64) }) end },
            { "a truncated download", function()
                publish(p, "0.2.0", star("full payload"), { served = star("full") }) end },
            { "a file that is not a .star", function()
                local junk = string.rep("x", 40)
                publish(p, "0.2.0", junk)
            end },
            { "an HTTP error on the download", function()
                publish(p, "0.2.0", star("x"))
                p.routes[DL .. "v0.2.0/steam-discreet.star"].status = 500
            end },
            { "a download that cannot be moved into place", function()
                publish(p, "0.2.0", star("x"))
                p.fail_rename[DIR .. "/staged.star"] = true
            end },
        }

        for _, case in ipairs(failures) do
            it("changes nothing on " .. case[1], function()
                case[2]()
                local live_before = p.files[LIVE]
                local r = u:check()
                assert.are.equal("error", r.result)
                assert.are.equal(live_before, p.files[LIVE])
                assert.are.equal(0, files_in_dir())
                assert.truthy(u:status().last_error)
            end)
        end

        it("keeps an earlier staged update when a later check fails", function()
            publish(p, "0.2.0", star("v0.2.0"))
            u:check()
            publish(p, "0.3.0", star("v0.3.0"), { checksum = string.rep("0", 64) })
            assert.are.equal("error", u:check().result)
            assert.are.equal(star("v0.2.0"), p.files[DIR .. "/staged.star"])
            assert.are.equal("0.2.0", u:status().staged_version)
        end)

        it("replaces a staged update with a newer release", function()
            publish(p, "0.2.0", star("v0.2.0"))
            u:check()
            publish(p, "0.3.0", star("v0.3.0"))
            assert.are.equal("staged", u:check().result)
            assert.are.equal(star("v0.3.0"), p.files[DIR .. "/staged.star"])
        end)

        it("records failures for the diagnostic report", function()
            local r = u:check()
            local s = u:status()
            assert.are.equal("error", s.last_result)
            assert.are.equal(r.detail, s.last_error)
            assert.truthy(s.last_error:find("404"))
            assert.are.equal("attl8d/steam-discreet", s.source)
        end)
    end)

    describe("apply_staged", function()
        it("does nothing when nothing is staged", function()
            assert.are.equal("nothing", u:apply_staged().result)
            assert.are.equal(star("v0.1.0"), p.files[LIVE])
        end)

        it("swaps the staged file in and keeps the old one for rollback", function()
            publish(p, "0.2.0", star("v0.2.0"))
            u:check()
            local r = u:apply_staged()
            assert.are.equal("applied", r.result)
            assert.are.equal(star("v0.2.0"), p.files[LIVE])
            assert.are.equal(star("v0.1.0"), p.files[DIR .. "/previous.star"])
            assert.is_nil(p.files[DIR .. "/staged.star"])
            local s = u:status()
            assert.are.equal("0.1.0", s.previous_version)
            assert.is_nil(s.staged_version)
            assert.are.same({ from = "0.1.0", to = "0.2.0", at = 1000, rollback = false }, s.last_applied)
        end)

        it("discards a staged file that was corrupted after download", function()
            publish(p, "0.2.0", star("v0.2.0"))
            u:check()
            p.files[DIR .. "/staged.star"] = star("v0.2.X")
            assert.are.equal("error", u:apply_staged().result)
            assert.are.equal(star("v0.1.0"), p.files[LIVE])
            assert.is_nil(p.files[DIR .. "/staged.star"])
        end)

        it("leaves the update staged if the plugin file cannot be replaced", function()
            publish(p, "0.2.0", star("v0.2.0"))
            u:check()
            p.fail_rename[LIVE] = true
            assert.are.equal("error", u:apply_staged().result)
            assert.are.equal(star("v0.1.0"), p.files[LIVE])
            assert.are.equal(star("v0.2.0"), p.files[DIR .. "/staged.star"])
            assert.truthy(u:status().last_apply_error)
            p.fail_rename[LIVE] = nil
            assert.are.equal("applied", u:apply_staged().result)
        end)

        it("does not swap if the running version cannot be backed up", function()
            publish(p, "0.2.0", star("v0.2.0"))
            u:check()
            p.fail_write[DIR .. "/previous.star.tmp.tmp"] = true
            p.fail_write[DIR .. "/previous.star.tmp"] = true
            assert.are.equal("error", u:apply_staged().result)
            assert.are.equal(star("v0.1.0"), p.files[LIVE])
        end)

        it("leaves the update staged when the plugin was installed under another name", function()
            publish(p, "0.2.0", star("v0.2.0"))
            u:check()
            p.files[LIVE] = nil
            assert.are.equal("error", u:apply_staged().result)
            assert.is_nil(p.files[LIVE])
            assert.truthy(p.files[DIR .. "/staged.star"])
        end)
    end)

    describe("rollback", function()
        local function update_to_020()
            publish(p, "0.2.0", star("v0.2.0"))
            u:check()
            u:apply_staged()
            -- next Steam start runs 0.2.0
            u = updater.new({ platform = p, current_version = "0.2.0" })
        end

        it("restores the previous version at the next shutdown", function()
            update_to_020()
            assert.are.equal("rollback_staged", u:request_rollback().result)
            assert.are.equal(star("v0.2.0"), p.files[LIVE])
            assert.are.equal("applied", u:apply_staged().result)
            assert.are.equal(star("v0.1.0"), p.files[LIVE])
            assert.is_true(u:status().last_applied.rollback)
        end)

        it("does not reinstall the rolled-back version", function()
            update_to_020()
            u:request_rollback()
            u:apply_staged()
            u = updater.new({ platform = p, current_version = "0.1.0" })
            assert.are.equal("skipped", u:check().result)
            assert.are.equal(star("v0.1.0"), p.files[LIVE])
            publish(p, "0.2.1", star("v0.2.1"))
            assert.are.equal("staged", u:check().result)
        end)

        it("reports when there is nothing to roll back to", function()
            assert.are.equal("error", u:request_rollback().result)
        end)
    end)

    describe("file safety", function()
        it("never writes outside its own folder and the plugin file", function()
            publish(p, "0.2.0", star("v0.2.0"))
            u:check()
            u:apply_staged()
            u = updater.new({ platform = p, current_version = "0.2.0" })
            u:request_rollback()
            u:apply_staged()
            for _, path in ipairs(p.writes) do
                assert.truthy(path == LIVE or path:sub(1, #DIR + 1) == DIR .. "/", path)
            end
        end)

        it("never touches the tag file", function()
            publish(p, "0.2.0", star("v0.2.0"))
            u:check()
            u:apply_staged()
            assert.are.equal('{"version":1,"apps":[10,20]}', p.files[TAGS])
            for _, path in ipairs(p.writes) do assert.are_not.equal(TAGS, path) end
        end)

        it("refuses paths it does not own", function()
            assert.has_error(function() u:write(TAGS, "x") end)
            assert.has_error(function() u:remove(TAGS) end)
            assert.has_error(function() u:rename(LIVE, TAGS) end)
            assert.has_error(function() u:write(DIR .. "x/evil", "x") end)
        end)
    end)
end)

describe("updater helpers", function()
    local updater = require("updater")

    it("parses sha256sum output", function()
        local h = string.rep("Ab", 32)
        assert.are.equal(h:lower(), updater.parse_checksum(h .. "  steam-discreet.star\n"))
        assert.is_nil(updater.parse_checksum("abc"))
        assert.is_nil(updater.parse_checksum(nil))
    end)

    it("recognises .star files", function()
        assert.is_true(updater.looks_like_star("STAR" .. string.rep("\0", 20)))
        assert.is_false(updater.looks_like_star("PK\3\4" .. string.rep("\0", 20)))
        assert.is_false(updater.looks_like_star("STAR"))
        assert.is_false(updater.looks_like_star(string.char(255, 255, 255, 255) .. string.rep("\0", 20)))
    end)
end)
