local helpers = require("helpers")

local ACCOUNT = "76561198000000001"
local OTHER = "76561198000000002"

local function set_of(...)
    local s = {}
    for _, id in ipairs({ ... }) do s[id] = true end
    return s
end

describe("tagstore.format", function()
    local format

    before_each(function()
        helpers.reset()
        helpers.install_millennium_stubs()
        format = require("tagstore.format")
    end)

    it("serialises sorted, deduplicated IDs with a header and an end marker", function()
        assert.are.equal("steam-discreet-tags 1\n570\n730\nend 2\n", format.serialize(set_of(730, 570)))
        assert.are.equal("steam-discreet-tags 1\nend 0\n", format.serialize({}))
    end)

    it("round-trips", function()
        local parsed = format.parse(format.serialize(set_of(10, 4294967295, 730)))
        assert.are.equal("ok", parsed.status)
        assert.are.same(set_of(10, 4294967295, 730), parsed.set)
    end)

    it("tolerates CRLF line endings and a UTF-8 BOM", function()
        local parsed = format.parse("\239\187\191steam-discreet-tags 1\r\n730\r\nend 1\r\n")
        assert.are.equal("ok", parsed.status)
        assert.are.same(set_of(730), parsed.set)
    end)

    it("rejects a file cut short", function()
        local full = format.serialize(set_of(1, 2, 3))
        assert.are.equal("invalid", format.parse(full:sub(1, #full - 7)).status)
        assert.are.equal("invalid", format.parse("steam-discreet-tags 1\n1\n2\nend 3\n").status)
        assert.are.equal("invalid", format.parse("").status)
        assert.are.equal("invalid", format.parse("garbage").status)
        assert.are.equal("invalid", format.parse("steam-discreet-tags 1\nabc\nend 1\n").status)
        assert.are.equal("invalid", format.parse("steam-discreet-tags 1\n0\nend 1\n").status)
        assert.are.equal("invalid", format.parse("steam-discreet-tags 1\n4294967296\nend 1\n").status)
    end)

    it("reports a newer format version instead of parsing it", function()
        local parsed = format.parse("steam-discreet-tags 2\nwhatever new\n")
        assert.are.equal("newer", parsed.status)
        assert.are.equal(2, parsed.version)
    end)

    it("imports an export file or a bare ID list", function()
        assert.are.same(set_of(1, 2), format.parse_import(format.serialize(set_of(1, 2))).set)
        assert.are.same(set_of(730, 570, 10), format.parse_import("730, 570;10\n730").set)
        assert.are.equal("invalid", format.parse_import("730 Portal").status)
        assert.are.equal("newer", format.parse_import("steam-discreet-tags 9\n").status)
    end)

    it("encodes and decodes the comma-separated wire format", function()
        assert.are.equal("570,730", format.encode_id_list(set_of(730, 570)))
        assert.are.equal("", format.encode_id_list({}))
        assert.are.same(set_of(570, 730), (format.decode_id_list("730,570,730")))
        assert.are.same({}, (format.decode_id_list("")))
        assert.is_nil((format.decode_id_list("730,,570")))
        assert.is_nil((format.decode_id_list("730,-1")))
        assert.is_nil((format.decode_id_list(730)))
    end)
end)

describe("tagstore.paths", function()
    local paths

    before_each(function()
        helpers.reset()
        helpers.install_millennium_stubs()
        paths = require("tagstore.paths")
    end)

    after_each(function()
        paths.set_root_override(nil)
        paths.set_os_override(nil)
    end)

    it("accepts only SteamID64-shaped account IDs", function()
        assert.are.equal(ACCOUNT, paths.validate_account(ACCOUNT))
        local bad_ids = { "", "0", "../x", "7656119800000000a", "1/2", 76561198000000001, {}, "123456789012345678901" }
        for _, bad in ipairs(bad_ids) do
            assert.is_nil(paths.validate_account(bad))
        end
    end)

    describe("default root", function()
        local real_getenv = os.getenv
        local env

        before_each(function()
            env = {}
            -- luacheck: ignore 122
            os.getenv = function(name) return env[name] end
        end)
        after_each(function()
            -- luacheck: ignore 122
            os.getenv = real_getenv
        end)

        it("uses %APPDATA% on Windows", function()
            paths.set_os_override("Windows")
            env.APPDATA = "C:\\Users\\u\\AppData\\Roaming"
            env.HOME = "C:\\Users\\u"
            local root, source = paths.root()
            assert.are.equal("C:\\Users\\u\\AppData\\Roaming/SteamDiscreet", root)
            assert.are.equal("APPDATA", source)
        end)

        it("uses ~/Library/Application Support on macOS", function()
            paths.set_os_override("OSX")
            env.HOME = "/Users/u"
            env.XDG_DATA_HOME = "/Users/u/.xdg"
            local root, source = paths.root()
            assert.are.equal("/Users/u/Library/Application Support/SteamDiscreet", root)
            assert.are.equal("macOS", source)
        end)

        it("lets STEAM_DISCREET_DATA_DIR win on macOS", function()
            paths.set_os_override("OSX")
            env.HOME = "/Users/u"
            env.STEAM_DISCREET_DATA_DIR = "/tmp/sd"
            assert.are.equal("/tmp/sd", (paths.root()))
        end)

        it("detects macOS from jit.os without an override", function()
            local real_jit = rawget(_G, "jit")
            -- luacheck: ignore 122
            _G.jit = { os = "OSX" }
            env.HOME = "/Users/u"
            local root, source = paths.root()
            _G.jit = real_jit
            assert.are.equal("/Users/u/Library/Application Support/SteamDiscreet", root)
            assert.are.equal("macOS", source)
        end)

        it("uses XDG, then ~/.local/share, elsewhere", function()
            paths.set_os_override("Linux")
            env.HOME = "/home/u"
            assert.are.equal("/home/u/.local/share/SteamDiscreet", (paths.root()))
            env.XDG_DATA_HOME = "/home/u/.xdg"
            assert.are.equal("/home/u/.xdg/SteamDiscreet", (paths.root()))
        end)
    end)

    it("routes every path through root()", function()
        paths.set_root_override("/data/x")
        local root, source = paths.root()
        assert.are.equal("/data/x", root)
        assert.are.equal("override", source)
        local files = paths.files(root, ACCOUNT)
        assert.are.equal("/data/x/tags-" .. ACCOUNT .. ".txt", files.main)
        assert.are.equal(paths.BACKUP_COUNT, #files.backups)
    end)
end)

describe("tagstore.store (real files)", function()
    local Store, paths, format, dir, files

    local function new_store(fsio)
        return Store.new({ fsio = fsio })
    end

    -- fsio wrapper that fails the named operation, optionally only for paths matching `pattern`.
    local function failing(op, pattern, err)
        local real = require("tagstore.fsio")
        local wrapped = {}
        for k, v in pairs(real) do wrapped[k] = v end
        wrapped[op] = function(a, ...)
            if not pattern or tostring(a):match(pattern) then return false, err or (op .. " refused") end
            return real[op](a, ...)
        end
        return wrapped
    end

    before_each(function()
        helpers.reset()
        helpers.install_millennium_stubs()
        Store = require("tagstore.store")
        paths = require("tagstore.paths")
        format = require("tagstore.format")
        dir = helpers.temp_dir() .. "/nested/root"
        paths.set_root_override(dir)
        files = paths.files(dir, ACCOUNT)
    end)

    local function prepare(name, content)
        assert(require("fs").create_directories(dir) ~= nil)
        helpers.write_file(name, content)
    end

    after_each(function()
        paths.set_root_override(nil)
        helpers.remove_dir(dir:match("^(.*)/nested/root$"))
    end)

    it("starts empty and creates the storage folder", function()
        local r = new_store():open(ACCOUNT)
        assert.is_true(r.ok)
        assert.are.equal("ok", r.state)
        assert.are.equal("", r.ids)
        assert.is_true(require("fs").is_directory(dir))
    end)

    it("adds, deduplicates, removes and persists across reloads", function()
        local s = new_store()
        s:open(ACCOUNT)
        assert.are.equal("570,730", s:add(ACCOUNT, set_of(730, 570)).ids)
        local again = s:add(ACCOUNT, set_of(730))
        assert.is_true(again.ok)
        assert.is_false(again.saved)
        assert.are.equal(2, again.count)
        assert.are.equal("570", s:remove(ACCOUNT, set_of(730)).ids)
        assert.are.equal("570", s:remove(ACCOUNT, set_of(999)).ids)

        local reloaded = new_store():open(ACCOUNT)
        assert.are.equal("ok", reloaded.state)
        assert.are.equal("570", reloaded.ids)
    end)

    it("stores nothing but the format header, App IDs and end marker", function()
        local s = new_store()
        s:add(ACCOUNT, set_of(730, 10))
        assert.are.equal("steam-discreet-tags 1\n10\n730\nend 2\n", helpers.read_file(files.main))
        for _, name in ipairs(helpers.list_dir(dir)) do
            assert.is_truthy(name:match("^tags%-%d+%.txt$") or name:match("^tags%-%d+%.bak%d$"))
        end
    end)

    it("keeps accounts separate", function()
        local s = new_store()
        s:add(ACCOUNT, set_of(1, 2))
        s:add(OTHER, set_of(3))
        s:remove(OTHER, set_of(1))
        local fresh = new_store()
        assert.are.equal("1,2", fresh:open(ACCOUNT).ids)
        assert.are.equal("3", fresh:open(OTHER).ids)
        assert.are_not.equal(files.main, paths.files(dir, OTHER).main)
    end)

    it("rejects malformed account IDs before touching the disk", function()
        local s = new_store()
        local r = s:add("../../evil", set_of(1))
        assert.is_false(r.ok)
        assert.are.equal("bad_account", r.error)
        assert.is_false(require("fs").exists(dir))
    end)

    it("keeps rotating backups of the previous versions", function()
        local s = new_store()
        for id = 1, 8 do s:add(ACCOUNT, set_of(id)) end
        -- main holds 1..8; bak1 holds 1..7, bak5 holds 1..3
        assert.are.equal(8, format.parse(helpers.read_file(files.main)).count)
        for i = 1, 5 do
            local b = format.parse(helpers.read_file(files.backups[i]))
            assert.are.equal("ok", b.status)
            assert.are.equal(8 - i, b.count)
        end
    end)

    it("recovers from the newest good backup and says so once", function()
        local s = new_store()
        s:add(ACCOUNT, set_of(1))
        s:add(ACCOUNT, set_of(2))
        s:add(ACCOUNT, set_of(3))
        -- main {1,2,3}, bak1 {1,2}, bak2 {1}; break main and bak1
        helpers.write_file(files.main, "steam-discreet-tags 1\n1\n2\n") -- cut short
        helpers.write_file(files.backups[1], "corrupt too")

        local s2 = new_store()
        local r = s2:open(ACCOUNT)
        assert.is_true(r.ok)
        assert.are.equal("ok", r.state) -- main was restored from the backup
        assert.are.equal("1", r.ids)
        assert.is_string(r.notice)
        assert.are.equal("corrupt too", helpers.read_file(files.backups[1]))
        assert.are.equal("steam-discreet-tags 1\n1\n2\n", helpers.read_file(files.corrupt))

        assert.is_nil(s2:open(ACCOUNT).notice)
        assert.are.equal("1", new_store():open(ACCOUNT).ids)
    end)

    it("restores a missing main file from a backup", function()
        local s = new_store()
        s:add(ACCOUNT, set_of(1))
        s:add(ACCOUNT, set_of(2))
        os.remove(files.main)
        local r = new_store():open(ACCOUNT)
        assert.are.equal("1", r.ids)
        assert.is_string(r.notice)
        assert.are.equal("1", new_store():open(ACCOUNT).ids)
    end)

    it("never writes over an unreadable file with no backup", function()
        prepare(files.main, "steam-discreet-tags 1\n730\n") -- no end marker
        local s = new_store()
        local r = s:open(ACCOUNT)
        assert.are.equal("unreadable", r.state)
        assert.is_false(r.writable)
        for _, attempt in ipairs({
            s:add(ACCOUNT, set_of(1)),
            s:remove(ACCOUNT, set_of(730)),
            s:clear(ACCOUNT),
            s:import(ACCOUNT, "1,2", "merge"),
        }) do
            assert.is_false(attempt.ok)
            assert.are.equal("unreadable", attempt.error)
        end
        assert.are.equal("steam-discreet-tags 1\n730\n", helpers.read_file(files.main))
    end)

    it("lets an explicit replace-import start over, keeping the unreadable file aside", function()
        prepare(files.main, "junk")
        local s = new_store()
        s:open(ACCOUNT)
        local r = s:import(ACCOUNT, "730,570", "replace")
        assert.is_true(r.ok)
        assert.are.equal("570,730", r.ids)
        assert.are.equal("junk", helpers.read_file(files.corrupt))
    end)

    it("leaves a newer-version file untouched", function()
        local newer = "steam-discreet-tags 2\n{\"future\":true}\n"
        prepare(files.main, newer)
        local s = new_store()
        local r = s:open(ACCOUNT)
        assert.are.equal("newer", r.state)
        assert.is_false(r.writable)
        assert.are.equal("newer", s:add(ACCOUNT, set_of(1)).error)
        assert.are.equal("newer", s:clear(ACCOUNT).error)
        assert.are.equal("newer", s:import(ACCOUNT, "1", "replace").error)
        assert.is_false(s:export(ACCOUNT).ok)
        assert.are.equal(newer, helpers.read_file(files.main))
    end)

    it("refuses to save if a newer version replaced the file after load", function()
        local s = new_store()
        s:add(ACCOUNT, set_of(1))
        helpers.write_file(files.main, "steam-discreet-tags 3\n")
        local r = s:add(ACCOUNT, set_of(2))
        assert.is_false(r.ok)
        assert.are.equal("newer", r.error)
        assert.are.equal("steam-discreet-tags 3\n", helpers.read_file(files.main))
    end)

    it("refuses to save if the file became unreadable after load", function()
        local s = new_store()
        s:add(ACCOUNT, set_of(1))
        helpers.write_file(files.main, "half")
        assert.are.equal("unreadable", s:clear(ACCOUNT).error)
        assert.are.equal("half", helpers.read_file(files.main))
    end)

    it("does not treat a newer backup as recoverable", function()
        prepare(files.main, "junk")
        helpers.write_file(files.backups[1], "steam-discreet-tags 2\n")
        local r = new_store():open(ACCOUNT)
        assert.are.equal("newer", r.state)
        assert.are.equal("junk", helpers.read_file(files.main))
    end)

    for _, case in ipairs({
        { op = "write", pattern = "%.tmp$" },
        { op = "rename", pattern = "%.tmp$" },
        { op = "read", pattern = "%.tmp$" },
    }) do
        it("reports a failed " .. case.op .. " and keeps the previous state", function()
            new_store():add(ACCOUNT, set_of(1))
            local before = helpers.read_file(files.main)
            local s = new_store(failing(case.op, case.pattern, "disk full"))
            s:open(ACCOUNT)
            local r = s:add(ACCOUNT, set_of(2))
            assert.is_false(r.ok)
            assert.are.equal("write_failed", r.error)
            assert.are.equal("1", r.ids)
            assert.are.equal(before, helpers.read_file(files.main))
            assert.is_false(require("fs").exists(files.tmp))
            assert.are.equal("1", s:export(ACCOUNT).ids)
        end)
    end

    it("saves even when a backup cannot be written, with a warning", function()
        new_store():add(ACCOUNT, set_of(1))
        local s = new_store(failing("copy", "%.txt$"))
        s:open(ACCOUNT)
        local r = s:add(ACCOUNT, set_of(2))
        assert.is_true(r.ok)
        assert.is_string(r.warning)
        assert.are.equal("1,2", new_store():open(ACCOUNT).ids)
    end)

    it("never lets an edit based on a backup overwrite a main file that was only briefly unreadable", function()
        local s = new_store()
        s:add(ACCOUNT, set_of(10))
        s:add(ACCOUNT, set_of(20))
        s:add(ACCOUNT, set_of(30)) -- main {10,20,30}, bak1 {10,20}

        local real = require("tagstore.fsio")
        local flaky = {}
        for k, v in pairs(real) do flaky[k] = v end
        local fail_once = true
        flaky.read = function(path)
            if fail_once and path == files.main then
                fail_once = false
                return nil, "sharing violation"
            end
            return real.read(path)
        end

        local s2 = new_store(flaky)
        local r = s2:open(ACCOUNT)
        assert.are.equal("recovered", r.state)
        assert.are.equal("10,20", r.ids)

        local after = s2:add(ACCOUNT, set_of(40))
        assert.is_true(after.ok)
        assert.are.equal("10,20,30,40", after.ids)
        assert.are.equal("10,20,30,40", new_store():open(ACCOUNT).ids)
    end)

    it("keeps every unreadable file aside, never replacing an earlier one", function()
        local s = new_store()
        s:add(ACCOUNT, set_of(1))
        s:add(ACCOUNT, set_of(2))
        helpers.write_file(files.main, "first broken")
        new_store():open(ACCOUNT)
        helpers.write_file(files.main, "second broken")
        new_store():open(ACCOUNT)
        assert.are.equal("first broken", helpers.read_file(files.corrupt))
        assert.are.equal("second broken", helpers.read_file(files.corrupt .. "2"))
    end)

    it("detects a failed mkdir from Millennium's false-plus-message return", function()
        local fs = require("fs")
        local real_mkdir = fs.create_directories
        fs.create_directories = function() return false, "Access is denied." end
        local r = new_store():open(ACCOUNT)
        fs.create_directories = real_mkdir
        assert.is_false(r.ok)
        assert.are.equal("unavailable", r.error)
        assert.is_truthy(r.message:match("Access is denied"))
    end)

    it("treats an already existing folder as fine", function()
        assert(require("fs").create_directories(dir))
        assert.is_false(require("fs").create_directories(dir)) -- false, no message
        assert.is_true(new_store():open(ACCOUNT).ok)
    end)

    it("reports an unusable storage folder", function()
        local s = new_store(failing("ensure_dir", nil, "access denied"))
        local r = s:open(ACCOUNT)
        assert.is_false(r.ok)
        assert.are.equal("unavailable", r.error)
        assert.are.equal("unavailable", s:add(ACCOUNT, set_of(1)).error)
    end)

    it("round-trips export and import, merging or replacing", function()
        local s = new_store()
        s:add(ACCOUNT, set_of(730, 570))
        local exported = s:export(ACCOUNT)
        assert.is_true(exported.ok)
        assert.are.equal(format.serialize(set_of(730, 570)), exported.text)

        s:add(OTHER, set_of(1))
        assert.are.equal("1,570,730", s:import(OTHER, exported.text, "merge").ids)
        assert.are.equal("570,730", s:import(OTHER, exported.text, "replace").ids)
        assert.are.equal("570,730", new_store():open(OTHER).ids)
    end)

    it("rejects empty, invalid and newer imports without changing anything", function()
        local s = new_store()
        s:add(ACCOUNT, set_of(1))
        assert.are.equal("import_empty", s:import(ACCOUNT, "steam-discreet-tags 1\nend 0\n", "replace").error)
        assert.are.equal("import_empty", s:import(ACCOUNT, "  ", "replace").error)
        assert.are.equal("import_invalid", s:import(ACCOUNT, "hello", "merge").error)
        assert.are.equal("import_invalid", s:import(ACCOUNT, "steam-discreet-tags 1\n2\n", "merge").error)
        assert.are.equal("import_newer", s:import(ACCOUNT, "steam-discreet-tags 2\n", "merge").error)
        assert.are.equal("bad_request", s:import(ACCOUNT, "2", "overwrite").error)
        assert.are.equal("1", new_store():open(ACCOUNT).ids)
    end)

    it("allows clearing a readable list", function()
        local s = new_store()
        s:add(ACCOUNT, set_of(1, 2))
        local r = s:clear(ACCOUNT)
        assert.is_true(r.ok)
        assert.are.equal("", new_store():open(ACCOUNT).ids)
        assert.are.equal(2, format.parse(helpers.read_file(files.backups[1])).count)
    end)
end)

describe("tagstore.rpc (frontend-callable globals)", function()
    local stubs, paths, root

    before_each(function()
        helpers.reset()
        stubs = helpers.install_millennium_stubs()
        paths = require("tagstore.paths")
        root = helpers.temp_dir()
        paths.set_root_override(root)
        require("main")
    end)

    after_each(function()
        paths.set_root_override(nil)
        helpers.remove_dir(root)
    end)

    it("registers the tags_* globals when main.lua loads", function()
        for _, name in ipairs({ "tags_open", "tags_add", "tags_remove", "tags_clear", "tags_export", "tags_import" }) do
            assert.is_function(_G[name])
        end
    end)

    it("takes and returns comma-separated ID lists", function()
        assert.are.equal("", _G.tags_open(ACCOUNT).ids)
        assert.are.equal("570,730", _G.tags_add(ACCOUNT, "730,570").ids)
        assert.are.equal("730", _G.tags_remove(ACCOUNT, "570").ids)
        local exported = _G.tags_export(ACCOUNT)
        assert.are.equal("730", _G.tags_import(OTHER, exported.text, "replace").ids)
        assert.are.equal("1,730", _G.tags_import(OTHER, "1", "merge").ids)
        assert.are.equal("", _G.tags_clear(ACCOUNT).ids)
    end)

    it("rejects malformed ID lists", function()
        local r = _G.tags_add(ACCOUNT, "730,abc")
        assert.is_false(r.ok)
        assert.are.equal("bad_request", r.error)
    end)

    it("turns Lua errors into a structured failure", function()
        local rpc = require("tagstore.rpc")
        local original = rpc.store.open
        rpc.store.open = function() error("boom") end
        local r = _G.tags_open(ACCOUNT)
        rpc.store.open = original
        assert.is_false(r.ok)
        assert.are.equal("internal", r.error)
        assert.are.equal("error", stubs.logger.messages[#stubs.logger.messages][1])
    end)
end)

describe("tagstore.format backups", function()
    local format

    before_each(function()
        helpers.reset()
        helpers.install_millennium_stubs()
        format = require("tagstore.format")
    end)

    local function sample()
        return format.serialize_backup(set_of(730, 570),
            { saved = "2026-11-21T19:40:00Z", plugin = "0.1.0", account = "abcdef0123456789" })
    end

    it("writes a header, comments, facts, the sorted list and an end marker", function()
        local text = sample()
        assert.are.equal("steam-discreet-backup 1\n", text:sub(1, 24))
        assert.truthy(text:find("\n# Steam Discreet backup. It lists the App IDs", 1, true))
        local tail = "\nsaved 2026-11-21T19:40:00Z\nplugin 0.1.0\naccount abcdef0123456789\ntags 2\n570\n730\nend 2\n"
        assert.are.equal(tail, text:sub(-#tail))
    end)

    it("round-trips with its facts", function()
        local parsed = format.parse_backup(sample())
        assert.are.equal("ok", parsed.status)
        assert.are.same(set_of(570, 730), parsed.set)
        assert.are.equal("2026-11-21T19:40:00Z", parsed.facts.saved)
        assert.are.equal("abcdef0123456789", parsed.facts.account)
    end)

    it("ignores unknown facts, blank and comment lines, CRLF and a BOM", function()
        local text = "\239\187\191steam-discreet-backup 1\r\n# hi\r\n\r\nfuture_setting on\r\n"
            .. "tags 1\r\n730\r\nend 1\r\n"
        local parsed = format.parse_backup(text)
        assert.are.equal("ok", parsed.status)
        assert.are.same(set_of(730), parsed.set)
        assert.are.equal("on", parsed.facts.future_setting)
    end)

    it("refuses a backup cut short or with mismatched counts", function()
        local full = sample()
        assert.are.equal("invalid", format.parse_backup(full:sub(1, #full - 7)).status)
        assert.are.equal("invalid", format.parse_backup(full:gsub("570\n", "")).status)
        assert.are.equal("invalid", format.parse_backup("steam-discreet-backup 1\ntags 2\n570\n730\nend 3\n").status)
        assert.are.equal("invalid", format.parse_backup("steam-discreet-backup 1\ntags 1\n570\n730\nend 2\n").status)
        assert.are.equal("invalid", format.parse_backup("steam-discreet-backup 1\nsaved now\n").status)
        assert.are.equal("invalid", format.parse_backup("steam-discreet-backup 1\n!!\ntags 0\nend 0\n").status)
        assert.are.equal("invalid", format.parse_backup("steam-discreet-backup 1\ntags 1\nabc\nend 1\n").status)
    end)

    it("reports a newer backup version instead of reading it", function()
        local parsed = format.parse_backup("steam-discreet-backup 2\nsomething new\n")
        assert.are.equal("newer", parsed.status)
        assert.are.equal("newer", format.parse_import("steam-discreet-backup 2\n").status)
    end)

    it("is accepted by import next to tag exports and bare lists, each with its kind", function()
        local b = format.parse_import(sample())
        assert.are.equal("backup", b.kind)
        assert.are.same(set_of(570, 730), b.set)
        assert.are.equal("tags", format.parse_import(format.serialize(set_of(1))).kind)
        assert.are.equal("list", format.parse_import("1, 2").kind)
    end)

    it("keeps control characters out of facts", function()
        local text = format.serialize_backup(set_of(1), { plugin = "0.1\ntags 9" })
        assert.are.equal("ok", format.parse_backup(text).status)
    end)
end)

describe("tagstore.backups (real files)", function()
    local Backups, format, paths, root, home, env, clock

    local function make(extra)
        local deps = {
            paths = paths,
            getenv = function(name) return env[name] end,
            now = function() return clock end,
            version = "0.1.0",
        }
        for k, v in pairs(extra or {}) do deps[k] = v end
        return Backups.new(deps)
    end

    before_each(function()
        helpers.reset()
        helpers.install_millennium_stubs()
        Backups = require("tagstore.backups")
        format = require("tagstore.format")
        paths = require("tagstore.paths")
        root = helpers.temp_dir()
        home = helpers.temp_dir()
        paths.set_root_override(root)
        env = { HOME = home }
        clock = os.time({ year = 2026, month = 11, day = 21, hour = 12 })
    end)

    after_each(function()
        paths.set_root_override(nil)
        helpers.remove_dir(root)
        helpers.remove_dir(home)
    end)

    it("saves into Documents/Steam Discreet with a dated name, and never replaces an earlier backup", function()
        os.execute("mkdir -p '" .. home .. "/Documents'")
        local b = make()
        local first = b:save(ACCOUNT, set_of(730, 570))
        assert.is_true(first.ok)
        assert.are.equal("documents", first.kind)
        assert.are.equal("Steam Discreet backup 2026-11-21.txt", first.name)
        assert.are.equal(home .. "/Documents/Steam Discreet", first.folder)
        assert.are.equal(2, first.count)
        local second = b:save(ACCOUNT, set_of(1))
        assert.are.equal("Steam Discreet backup 2026-11-21 (2).txt", second.name)
        local parsed = format.parse_backup(helpers.read_file(first.path))
        assert.are.same(set_of(570, 730), parsed.set)
        assert.are.equal("0.1.0", parsed.facts.plugin)
        assert.are.same({ "Steam Discreet backup 2026-11-21 (2).txt", "Steam Discreet backup 2026-11-21.txt" },
            helpers.list_dir(first.folder))
    end)

    it("never writes the SteamID64 into the file", function()
        os.execute("mkdir -p '" .. home .. "/Documents'")
        local saved = make():save(ACCOUNT, set_of(730))
        local text = helpers.read_file(saved.path)
        assert.is_nil(text:find(ACCOUNT, 1, true))
        assert.is_nil(text:find("38000000001", 1, true)) -- the 32-bit account ID's digits either
        assert.truthy(text:find("\naccount %x%x%x%x\n"))
    end)

    it("uses OneDrive Documents on Windows when the plain Documents folder is missing", function()
        os.execute("mkdir -p '" .. home .. "/OneDrive/Documents'")
        env = { USERPROFILE = home }
        local saved = make():save(ACCOUNT, set_of(730))
        assert.are.equal(home .. "/OneDrive/Documents/Steam Discreet", saved.folder)
    end)

    it("falls back to the storage folder when there is no Documents folder", function()
        local saved = make():save(ACCOUNT, set_of(730))
        assert.is_true(saved.ok)
        assert.are.equal("fallback", saved.kind)
        assert.are.equal(root .. "/Backups", saved.folder)
        assert.is_nil(saved.fallback_reason)
    end)

    it("falls back and says why when Documents cannot be written", function()
        os.execute("mkdir -p '" .. home .. "/Documents'")
        local fsio = require("tagstore.fsio")
        local failing = setmetatable({
            write = function(path, content)
                if path:find("/Documents/", 1, true) then return false, "access denied" end
                return fsio.write(path, content)
            end,
        }, { __index = fsio })
        local saved = make({ fsio = failing }):save(ACCOUNT, set_of(730))
        assert.is_true(saved.ok)
        assert.are.equal("fallback", saved.kind)
        assert.truthy(saved.fallback_reason:find("access denied", 1, true))
        assert.are.same({}, helpers.list_dir(home .. "/Documents/Steam Discreet"))
    end)

    it("reports a failure when no folder can be written, leaving no temporary file", function()
        local fsio = require("tagstore.fsio")
        local failing = setmetatable({ rename = function() return false, "disk full" end }, { __index = fsio })
        local saved = make({ fsio = failing }):save(ACCOUNT, set_of(730))
        assert.is_false(saved.ok)
        assert.are.equal("write_failed", saved.error)
        assert.truthy(saved.message:find("disk full", 1, true))
        assert.are.same({}, helpers.list_dir(root .. "/Backups"))
    end)

    it("refuses to back up an empty list", function()
        local saved = make():save(ACCOUNT, {})
        assert.is_false(saved.ok)
        assert.are.equal("backup_empty", saved.error)
    end)

    it("lists backups from every folder newest first, with counts and the account check", function()
        os.execute("mkdir -p '" .. home .. "/Documents'")
        local b = make()
        local old = b:save(OTHER, set_of(1, 2, 3))
        clock = clock + 3600
        local new = b:save(ACCOUNT, set_of(730))
        -- An older backup in the fallback folder, a damaged one and an unrelated file.
        os.execute("mkdir -p '" .. root .. "/Backups'")
        helpers.write_file(root .. "/Backups/Steam Discreet backup 2026-01-01.txt",
            format.serialize_backup(set_of(5), { saved = "2026-01-01T00:00:00Z" }))
        helpers.write_file(new.folder .. "/Steam Discreet backup broken.txt", "steam-discreet-backup 1\ntags 3\n1\n")
        helpers.write_file(new.folder .. "/notes.txt", "shopping list")
        helpers.write_file(new.folder .. "/old export.txt", format.serialize(set_of(9)))

        local listed = b:list(ACCOUNT)
        assert.is_true(listed.ok)
        assert.are.equal(new.folder, listed.folder)
        local rows = {}
        for line in (listed.entries .. "\n"):gmatch("([^\n]*)\n") do
            local f = {}
            for field in (line .. "\t"):gmatch("([^\t]*)\t") do f[#f + 1] = field end
            rows[#rows + 1] = f
        end
        assert.are.equal(5, listed.count)
        local function stamp(t) return os.date("!%Y-%m-%dT%H:%M:%SZ", t) end
        assert.are.same({ "1:" .. new.name, new.name, "ok", "1", stamp(clock), "yes", "documents" }, rows[1])
        assert.are.same({ "1:" .. old.name, old.name, "ok", "3", stamp(clock - 3600), "no", "documents" }, rows[2])
        assert.are.equal("2:Steam Discreet backup 2026-01-01.txt", rows[3][1])
        assert.are.equal("unknown", rows[3][6])
        local names = {}
        for i = 4, 5 do names[rows[i][2]] = rows[i][3] end
        assert.are.same({ ["Steam Discreet backup broken.txt"] = "invalid", ["old export.txt"] = "ok" }, names)
    end)

    it("lists nothing when no backup folder exists yet", function()
        local listed = make():list(ACCOUNT)
        assert.is_true(listed.ok)
        assert.are.equal(0, listed.count)
        assert.are.equal("", listed.entries)
    end)

    it("reads a listed backup by id and refuses anything outside the backup folders", function()
        local b = make()
        local saved = b:save(ACCOUNT, set_of(730))
        local read = b:read("1:" .. saved.name)
        assert.is_true(read.ok)
        assert.are.equal(helpers.read_file(saved.path), read.text)
        helpers.write_file(root .. "/secret.txt", "x")
        local bad = {
            "1:../secret.txt", "1:..\\secret.txt", "1:sub/x.txt", "9:" .. saved.name, saved.name, "1:x.lua",
            "1:a.txt:stream.txt", 5,
        }
        for _, id in ipairs(bad) do
            local r = b:read(id)
            assert.is_false(r.ok, tostring(id))
            assert.are.equal("bad_request", r.error)
        end
        assert.are.equal("missing", b:read("1:Steam Discreet backup gone.txt").error)
    end)

    it("describes pasted text with the account check", function()
        local b = make()
        local saved = "2026-11-21T19:40:00Z"
        local text = format.serialize_backup(set_of(1, 2), { account = b:account_key(ACCOUNT), saved = saved })
        assert.are.same({ status = "ok", kind = "backup", count = 2, saved = saved, same_account = "yes" },
            b:describe(text, ACCOUNT))
        assert.are.equal("no", b:describe(text, OTHER).same_account)
        assert.are.equal("unknown", b:describe(text, "").same_account)
        assert.are.equal("unknown", b:describe("1,2", ACCOUNT).same_account)
        assert.are.equal("invalid", b:describe("nope", ACCOUNT).status)
    end)

    it("derives a 4-hex-digit account code from SHA-256, stable and too short to identify anyone", function()
        local sha = require("updater.sha256")
        local key = make():account_key(ACCOUNT)
        assert.are.equal(sha.hex("steam-discreet-account:" .. ACCOUNT):sub(1, 4), key)
        assert.are.equal(4, #key)
        assert.are_not.equal(key, make():account_key(OTHER))
    end)

    it("hashes the account once per list, not once per file", function()
        os.execute("mkdir -p '" .. home .. "/Documents'")
        local calls = 0
        local sha = require("updater.sha256")
        local b = make({ hash = function(t) calls = calls + 1; return sha.hex(t) end })
        b:save(ACCOUNT, set_of(1))
        b:save(ACCOUNT, set_of(2))
        b:save(ACCOUNT, set_of(3))
        calls = 0
        b.key_cache = nil
        b:list(ACCOUNT)
        assert.are.equal(1, calls)
    end)

    it("prefers %OneDrive%\\Documents over a leftover empty profile Documents", function()
        os.execute("mkdir -p '" .. home .. "/Documents' '" .. home .. "/OD/Documents'")
        env = { USERPROFILE = home, OneDrive = home .. "/OD" }
        assert.are.equal(home .. "/OD/Documents/Steam Discreet", make():save(ACCOUNT, set_of(1)).folder)
    end)

    it("skips files too large to be a backup, and reports the uncapped total", function()
        local b = make()
        local saved = b:save(ACCOUNT, set_of(1))
        local big = {}
        for i = 1, 400000 do big[i] = tostring(i) end
        helpers.write_file(saved.folder .. "/Steam Discreet backup huge.txt",
            "steam-discreet-backup 1\ntags 400000\n" .. table.concat(big, "\n") .. "\nend 400000\n")
        local listed = b:list(ACCOUNT)
        assert.are.equal(1, listed.count)
        assert.are.equal(1, listed.total)
        for i = 1, 105 do
            helpers.write_file(string.format("%s/Steam Discreet backup x%03d.txt", saved.folder, i),
                format.serialize_backup(set_of(i), {}))
        end
        listed = b:list(ACCOUNT)
        assert.are.equal(100, listed.count)
        assert.are.equal(106, listed.total)
    end)

    it("restores only the tags from a backup with settings facts, never the reveal state", function()
        local text = "steam-discreet-backup 1\nreveal 1\nshow_adult_games true\ntags 1\n730\nend 1\n"
        local info = make():describe(text, ACCOUNT)
        assert.are.same({ status = "ok", kind = "backup", count = 1, same_account = "unknown" }, info)
        local Store = require("tagstore.store")
        local store = Store.new({ paths = paths })
        store:open(ACCOUNT)
        local result = store:import(ACCOUNT, text, "replace")
        assert.are.equal("730", result.ids)
        for key in pairs(result) do
            assert.is_nil(key:find("reveal", 1, true))
            assert.is_nil(key:find("adult", 1, true))
        end
        -- The tag file on disk holds App IDs only.
        assert.are.equal("steam-discreet-tags 1\n730\nend 1\n", helpers.read_file(paths.files(root, ACCOUNT).main))
    end)
end)

describe("backup rpc", function()
    local paths, root, home, rpc

    before_each(function()
        helpers.reset()
        helpers.install_millennium_stubs()
        paths = require("tagstore.paths")
        root = helpers.temp_dir()
        home = helpers.temp_dir()
        paths.set_root_override(root)
        require("main")
        rpc = require("tagstore.rpc")
        local Backups = require("tagstore.backups")
        rpc.backups = Backups.new({ getenv = function(name) return ({ HOME = home })[name] end, version = "0.1.0" })
    end)

    after_each(function()
        paths.set_root_override(nil)
        helpers.remove_dir(root)
        helpers.remove_dir(home)
    end)

    it("saves, lists, reads and restores a backup through the tag store, with the account check", function()
        _G.tags_open(ACCOUNT)
        _G.tags_add(ACCOUNT, "730,570")
        local saved = _G.backup_save(ACCOUNT)
        assert.is_true(saved.ok)
        assert.are.equal(2, saved.count)

        local listed = _G.backup_list(ACCOUNT)
        assert.are.equal(1, listed.count)
        local id = listed.entries:match("^([^\t]+)")
        local read = _G.backup_read(id)
        assert.is_true(read.ok)

        local mine = _G.tags_preview_import(read.text, ACCOUNT)
        assert.are.same({ ok = true, count = 2, kind = "backup", saved = mine.saved, same_account = "yes" }, mine)
        assert.are.equal("no", _G.tags_preview_import(read.text, OTHER).same_account)

        _G.tags_clear(ACCOUNT)
        assert.are.equal("570,730", _G.tags_import(ACCOUNT, read.text, "replace").ids)
        _G.tags_import(OTHER, "1", "merge")
        assert.are.equal("1,570,730", _G.tags_import(OTHER, read.text, "merge").ids)
    end)

    it("refuses to save while the tag file cannot be read, and saves nothing", function()
        local files = paths.files(root, ACCOUNT)
        helpers.write_file(files.main, "garbage")
        local saved = _G.backup_save(ACCOUNT)
        assert.is_false(saved.ok)
        assert.are.equal(0, _G.backup_list(ACCOUNT).count)
    end)

    it("preview still works without an account, and flags a newer backup", function()
        assert.are.equal("unknown", _G.tags_preview_import("1,2").same_account)
        local newer = _G.tags_preview_import("steam-discreet-backup 2\n", ACCOUNT)
        assert.is_false(newer.ok)
        assert.are.equal("import_newer", newer.error)
    end)
end)

describe("tagstore.backups paths shown to the user", function()
    it("use backslashes throughout on Windows", function()
        helpers.reset()
        helpers.install_millennium_stubs()
        local Backups = require("tagstore.backups")
        local written = {}
        local fsio = {
            is_dir = function(p) return p == "C:\\Users\\me/Documents" end,
            ensure_dir = function() return true end,
            exists = function(p) return written[p] ~= nil end,
            write = function(p, t) written[p] = t; return true end,
            read = function(p) return written[p] end,
            rename = function(a, b) written[b], written[a] = written[a], nil; return true end,
            remove = function() return true end,
        }
        local paths = { join = require("tagstore.paths").join, root = function() return nil end,
            validate_account = require("tagstore.paths").validate_account }
        local b = Backups.new({ fsio = fsio, paths = paths, getenv = function(n)
            return n == "USERPROFILE" and "C:\\Users\\me" or nil
        end, now = function() return 0 end })
        local saved = b:save(ACCOUNT, set_of(1))
        assert.are.equal("C:\\Users\\me\\Documents\\Steam Discreet", saved.folder)
        assert.is_nil(saved.path:find("/", 1, true))
    end)
end)
