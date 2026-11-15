-- SHA-256 in pure Lua for LuaJIT (uses the built-in `bit` library).
-- Millennium exposes no hash function suitable for verifying a download
-- (utils.hash returns an integer), so the updater carries its own.

local bit = require("bit")

local band, bor, bxor, bnot = bit.band, bit.bor, bit.bxor, bit.bnot
local rshift, lshift, ror = bit.rshift, bit.lshift, bit.ror
local tobit, tohex = bit.tobit, bit.tohex
local byte, char, rep, format = string.byte, string.char, string.rep, string.format

local K = {
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
}

local function pad(msg)
    local len = #msg
    local bits_hi = math.floor(len / 0x20000000) -- (len * 8) >> 32
    local bits_lo = (len % 0x20000000) * 8
    local zeros = (55 - len) % 64
    return msg .. "\128" .. rep("\0", zeros)
        .. char(
            band(rshift(bits_hi, 24), 0xff), band(rshift(bits_hi, 16), 0xff),
            band(rshift(bits_hi, 8), 0xff), band(bits_hi, 0xff),
            band(rshift(bits_lo, 24), 0xff), band(rshift(bits_lo, 16), 0xff),
            band(rshift(bits_lo, 8), 0xff), band(bits_lo, 0xff))
end

local function digest_hex(msg)
    assert(type(msg) == "string", "sha256 expects a string")
    msg = pad(msg)

    local h0, h1, h2, h3 = 0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a
    local h4, h5, h6, h7 = 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
    local w = {}

    for chunk = 1, #msg, 64 do
        for i = 0, 15 do
            local a, b, c, d = byte(msg, chunk + i * 4, chunk + i * 4 + 3)
            w[i] = bor(lshift(a, 24), lshift(b, 16), lshift(c, 8), d)
        end
        for i = 16, 63 do
            local x, y = w[i - 15], w[i - 2]
            local s0 = bxor(ror(x, 7), ror(x, 18), rshift(x, 3))
            local s1 = bxor(ror(y, 17), ror(y, 19), rshift(y, 10))
            w[i] = tobit(w[i - 16] + s0 + w[i - 7] + s1)
        end

        local a, b, c, d, e, f, g, h = h0, h1, h2, h3, h4, h5, h6, h7
        for i = 0, 63 do
            local S1 = bxor(ror(e, 6), ror(e, 11), ror(e, 25))
            local ch = bxor(band(e, f), band(bnot(e), g))
            local t1 = tobit(h + S1 + ch + K[i + 1] + w[i])
            local S0 = bxor(ror(a, 2), ror(a, 13), ror(a, 22))
            local maj = bxor(band(a, b), band(a, c), band(b, c))
            local t2 = tobit(S0 + maj)
            h, g, f, e = g, f, e, tobit(d + t1)
            d, c, b, a = c, b, a, tobit(t1 + t2)
        end

        h0, h1, h2, h3 = tobit(h0 + a), tobit(h1 + b), tobit(h2 + c), tobit(h3 + d)
        h4, h5, h6, h7 = tobit(h4 + e), tobit(h5 + f), tobit(h6 + g), tobit(h7 + h)
    end

    return format("%s%s%s%s%s%s%s%s",
        tohex(h0), tohex(h1), tohex(h2), tohex(h3), tohex(h4), tohex(h5), tohex(h6), tohex(h7))
end

return { hex = digest_hex }
