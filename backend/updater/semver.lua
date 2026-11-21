-- Plain MAJOR.MINOR.PATCH versions, with an optional leading "v".
-- Pre-release and build suffixes are rejected: the updater only installs
-- full releases.

local M = {}

function M.parse(text)
    if type(text) ~= "string" then return nil end
    local major, minor, patch = text:match("^v?(%d+)%.(%d+)%.(%d+)$")
    if not major then return nil end
    return { tonumber(major), tonumber(minor), tonumber(patch) }
end

-- Returns -1, 0 or 1, or nil if either side does not parse.
function M.compare(a, b)
    local va, vb = M.parse(a), M.parse(b)
    if not va or not vb then return nil end
    for i = 1, 3 do
        if va[i] < vb[i] then return -1 end
        if va[i] > vb[i] then return 1 end
    end
    return 0
end

function M.normalize(text)
    local v = M.parse(text)
    if not v then return nil end
    return string.format("%d.%d.%d", v[1], v[2], v[3])
end

return M
