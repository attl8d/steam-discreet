local semver = require("updater.semver")
local sha256 = require("updater.sha256")

describe("updater.semver", function()
    it("parses plain versions with an optional v", function()
        assert.are.same({ 1, 2, 3 }, semver.parse("v1.2.3"))
        assert.are.same({ 0, 10, 0 }, semver.parse("0.10.0"))
    end)

    it("rejects pre-releases and junk", function()
        for _, v in ipairs({ "1.2", "1.2.3-beta.1", "1.2.3+build", "latest", "", "v", 123 }) do
            assert.is_nil(semver.parse(v), tostring(v))
        end
    end)

    it("compares numerically", function()
        assert.are.equal(1, semver.compare("0.10.0", "0.9.9"))
        assert.are.equal(-1, semver.compare("1.0.0", "1.0.1"))
        assert.are.equal(0, semver.compare("v2.0.0", "2.0.0"))
        assert.is_nil(semver.compare("x", "1.0.0"))
    end)
end)

describe("updater.sha256", function()
    -- FIPS 180-2 vectors, plus padding edge cases checked against sha256sum.
    local vectors = {
        { "", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" },
        { "abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" },
        { "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
          "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1" },
        { string.rep("a", 56), "b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a" },
        { string.rep("a", 64), "ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb" },
        { string.rep("a", 1000000), "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0" },
    }
    for i, v in ipairs(vectors) do
        it("matches vector " .. i, function()
            assert.are.equal(v[2], sha256.hex(v[1]))
        end)
    end

    it("hashes binary data with NUL bytes", function()
        assert.are.equal("6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d", sha256.hex("\0"))
    end)
end)
