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

    after_each(function() paths.set_root_override(nil) end)

    it("accepts only SteamID64-shaped account IDs", function()
        assert.are.equal(ACCOUNT, paths.validate_account(ACCOUNT))
        local bad_ids = { "", "0", "../x", "7656119800000000a", "1/2", 76561198000000001, {}, "123456789012345678901" }
        for _, bad in ipairs(bad_ids) do
            assert.is_nil(paths.validate_account(bad))
        end
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
