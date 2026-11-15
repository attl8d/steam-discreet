-- Self-update (docs/PLAN.md, M6).
--
-- 1. check(): in the background after startup, ask the GitHub API for the
--    latest release of the one trusted repo. If it is newer, download the
--    .star, verify size, file magic and SHA-256, and stage it in the update
--    folder. The running plugin is not touched.
-- 2. apply_staged(): from on_unload (Steam shutting down or the plugin being
--    disabled), back up the running .star as previous.star and rename the
--    staged file over it. The new version loads at the next Steam start.
--
-- Why at shutdown and not at startup: Millennium reads a plugin's frontend
-- bundle and assets from the .star lazily, after every backend has loaded
-- (src/engine/plugin_loader.cc, register_virtual_resource). Replacing the
-- file during startup would run the old backend with the new frontend for
-- that session. By on_unload nothing reads the file any more.
--
-- This module only ever writes inside its own update folder and to the
-- plugin's own .star. It never reads or writes the tag file.

local semver = require("updater.semver")
local sha256 = require("updater.sha256")

local M = {}

M.REPO_OWNER = "attl8d"
M.REPO_NAME = "steam-discreet"
M.PLUGIN_ID = "steam-discreet"
M.ASSET_NAME = M.PLUGIN_ID .. ".star"
M.CHECKSUM_NAME = M.ASSET_NAME .. ".sha256"
-- A folder, not a .star file, so Millennium never tries to load it as a
-- plugin: it only loads *.star files and folders containing plugin.json.
M.UPDATE_DIR_NAME = M.PLUGIN_ID .. ".update"
M.MAX_SIZE = 16 * 1024 * 1024
M.API_TIMEOUT = 10
M.DOWNLOAD_TIMEOUT = 60
M.USER_AGENT = "steam-discreet-updater"

local function release_api_url()
    return ("https://api.github.com/repos/%s/%s/releases/latest"):format(M.REPO_OWNER, M.REPO_NAME)
end

local function trusted_download_prefix()
    return ("https://github.com/%s/%s/releases/download/"):format(M.REPO_OWNER, M.REPO_NAME)
end

-- True if data looks like a .star: "STAR" at offset 0, or a little-endian
-- u32 shim length followed by the shim and then "STAR"
-- (src/engine/star_parser.cc, star_load_bounded).
function M.looks_like_star(data)
    if type(data) ~= "string" or #data < 16 then return false end
    if data:sub(1, 4) == "STAR" then return true end
    local b1, b2, b3, b4 = data:byte(1, 4)
    local shim_len = b1 + b2 * 256 + b3 * 65536 + b4 * 16777216
    if shim_len > 4 * 1024 * 1024 or 4 + shim_len + 4 > #data then return false end
    return data:sub(5 + shim_len, 8 + shim_len) == "STAR"
end

function M.parse_checksum(text)
    if type(text) ~= "string" then return nil end
    local hex = text:match("^%s*(%x+)")
    if not hex or #hex ~= 64 then return nil end
    return hex:lower()
end

local Updater = {}
Updater.__index = Updater

-- opts.platform: see backend/updater/platform.lua
-- opts.current_version: version of the running plugin
function M.new(opts)
    assert(opts and opts.platform, "updater needs a platform")
    assert(semver.parse(opts.current_version), "updater needs a valid current version")
    local self = setmetatable({ p = opts.platform, current = semver.normalize(opts.current_version) }, Updater)
    return self
end

function Updater:paths()
    if self._paths then return self._paths end
    local plugins, err = self.p.plugins_dir()
    if not plugins then return nil, err end
    local dir = self.p.join(plugins, M.UPDATE_DIR_NAME)
    self._paths = {
        live = self.p.join(plugins, M.ASSET_NAME),
        dir = dir,
        part = self.p.join(dir, "download.part"),
        staged = self.p.join(dir, "staged.star"),
        staged_meta = self.p.join(dir, "staged.json"),
        previous = self.p.join(dir, "previous.star"),
        previous_meta = self.p.join(dir, "previous.json"),
        state = self.p.join(dir, "state.json"),
    }
    return self._paths
end

-- Every write goes through here, so a bug cannot aim the updater at the
-- tag file or anywhere else outside its own files.
function Updater:owned(path)
    local paths = assert(self:paths())
    if path == paths.live then return true end
    return path:sub(1, #paths.dir + 1) == paths.dir .. "/"
end

function Updater:write(path, data)
    assert(self:owned(path), "updater refused to write outside its own files: " .. tostring(path))
    local tmp = path .. ".tmp"
    local ok, err = self.p.write_file(tmp, data)
    if not ok then self.p.remove(tmp); return nil, err end
    ok, err = self.p.rename(tmp, path)
    if not ok then self.p.remove(tmp); return nil, err end
    return true
end

function Updater:rename(from, to)
    assert(self:owned(from) and self:owned(to), "updater refused to move files it does not own")
    return self.p.rename(from, to)
end

function Updater:remove(path)
    assert(self:owned(path), "updater refused to delete outside its own files: " .. tostring(path))
    return self.p.remove(path)
end

function Updater:read_json(path)
    local text = self.p.read_file(path)
    if not text then return nil end
    local value = self.p.json_decode(text)
    if type(value) ~= "table" then return nil end
    return value
end

function Updater:write_json(path, value)
    local text, err = self.p.json_encode(value)
    if not text then return nil, err end
    return self:write(path, text)
end

function Updater:state()
    local paths = self:paths()
    if not paths then return {} end
    return self:read_json(paths.state) or {}
end

function Updater:save_state(changes)
    local state = self:state()
    for k, v in pairs(changes) do state[k] = v end
    local ok, err = self:write_json(self:paths().state, state)
    if not ok then self.p.log("warn", "could not save update state: " .. tostring(err)) end
    return state
end

-- Record a check outcome. Failures change nothing but this note.
function Updater:finish(result, detail)
    local changes = { last_check_at = self.p.now(), last_result = result, last_error = false }
    if result == "error" then changes.last_error = detail end
    if detail and result ~= "error" then changes.last_detail = detail end
    self:save_state(changes)
    if result == "error" then
        self.p.log("warn", "update check failed: " .. tostring(detail))
    else
        self.p.log("info", "update check: " .. result .. (detail and (" (" .. detail .. ")") or ""))
    end
    return { result = result, detail = detail }
end

local function find_asset(assets, name)
    if type(assets) ~= "table" then return nil end
    for _, asset in ipairs(assets) do
        if type(asset) == "table" and asset.name == name then return asset end
    end
    return nil
end

function Updater:fetch_latest()
    local headers = { ["Accept"] = "application/vnd.github+json", ["User-Agent"] = M.USER_AGENT }
    local res, err = self.p.http_get(release_api_url(), headers, M.API_TIMEOUT)
    if not res then return nil, "release lookup failed: " .. tostring(err) end
    if res.status == 404 then
        return nil, "no published release found (HTTP 404; the repo may be private or have no releases)"
    end
    if res.status ~= 200 then return nil, "release lookup returned HTTP " .. tostring(res.status) end
    local release = self.p.json_decode(res.body)
    if type(release) ~= "table" then return nil, "release lookup returned invalid JSON" end
    if release.draft == true or release.prerelease == true then
        return nil, "latest release is a draft or pre-release"
    end
    local version = semver.normalize(release.tag_name)
    if not version then return nil, "release tag is not a plain version: " .. tostring(release.tag_name) end
    return { version = version, tag = release.tag_name, assets = release.assets }
end

local function validate_asset(asset, name)
    if not asset then return nil, "release has no " .. name end
    local url = asset.browser_download_url
    if type(url) ~= "string" or url:sub(1, #trusted_download_prefix()) ~= trusted_download_prefix() then
        return nil, name .. " is not hosted in the trusted repo"
    end
    return url
end

-- Background check. Returns { result = ..., detail = ... }; result is one of
-- up_to_date, skipped, already_staged, staged, error.
function Updater:check()
    local paths, perr = self:paths()
    if not paths then return { result = "error", detail = perr } end
    local ok, mkerr = self.p.mkdir(paths.dir)
    if not ok then return { result = "error", detail = "cannot create update folder: " .. tostring(mkerr) } end

    local latest, err = self:fetch_latest()
    if not latest then return self:finish("error", err) end

    if semver.compare(latest.version, self.current) <= 0 then
        return self:finish("up_to_date", latest.version)
    end
    local state = self:state()
    if state.skip_version == latest.version then
        return self:finish("skipped", latest.version .. " was rolled back")
    end
    local staged = self:read_json(paths.staged_meta)
    if staged and staged.version == latest.version and self.p.exists(paths.staged) then
        return self:finish("already_staged", latest.version)
    end

    local star = find_asset(latest.assets, M.ASSET_NAME)
    local star_url, aerr = validate_asset(star, M.ASSET_NAME)
    if not star_url then return self:finish("error", aerr) end
    local sum_url, serr = validate_asset(find_asset(latest.assets, M.CHECKSUM_NAME), M.CHECKSUM_NAME)
    if not sum_url then return self:finish("error", serr) end
    if type(star.size) ~= "number" or star.size <= 0 or star.size > M.MAX_SIZE then
        return self:finish("error", "release asset size is missing or too large")
    end

    local headers = { ["User-Agent"] = M.USER_AGENT, ["Accept"] = "application/octet-stream" }
    local sum_res, sum_err = self.p.http_get(sum_url, headers, M.API_TIMEOUT)
    if not sum_res then return self:finish("error", "checksum download failed: " .. tostring(sum_err)) end
    if sum_res.status ~= 200 then return self:finish("error", "checksum download returned HTTP " .. sum_res.status) end
    local expected = M.parse_checksum(sum_res.body)
    if not expected then return self:finish("error", "checksum file is malformed") end
    -- GitHub also reports its own digest for each asset; when present it must agree.
    if type(star.digest) == "string" and star.digest:lower() ~= "sha256:" .. expected then
        return self:finish("error", "checksum file disagrees with GitHub's asset digest")
    end

    self:remove(paths.part)
    local dl, derr = self.p.download(star_url, paths.part, headers, M.DOWNLOAD_TIMEOUT)
    local function fail(msg)
        self:remove(paths.part)
        return self:finish("error", msg)
    end
    if not dl then return fail("download failed: " .. tostring(derr)) end
    if dl.status ~= 200 then return fail("download returned HTTP " .. tostring(dl.status)) end
    local data = self.p.read_file(paths.part)
    if not data then return fail("downloaded file could not be read") end
    if #data ~= star.size then
        return fail(("download size %d does not match release size %d"):format(#data, star.size))
    end
    if not M.looks_like_star(data) then return fail("downloaded file is not a .star plugin") end
    local actual = sha256.hex(data)
    if actual ~= expected then return fail("SHA-256 mismatch") end

    -- Stage: metadata is cleared first so a crash in between leaves no
    -- metadata pointing at a half-written file.
    self:remove(paths.staged_meta)
    local rok, rerr = self:rename(paths.part, paths.staged)
    if not rok then return fail("could not stage download: " .. tostring(rerr)) end
    local wok, werr = self:write_json(paths.staged_meta, {
        version = latest.version, sha256 = actual, size = #data, tag = latest.tag, staged_at = self.p.now(),
    })
    if not wok then
        self:remove(paths.staged)
        return self:finish("error", "could not record staged update: " .. tostring(werr))
    end
    return self:finish("staged", latest.version)
end

-- Verify the staged file still matches what was checked at download time.
function Updater:verified_stage()
    local paths = self:paths()
    local meta = self:read_json(paths.staged_meta)
    if not meta or type(meta.sha256) ~= "string" then return nil, "nothing staged" end
    local data = self.p.read_file(paths.staged)
    if not data then return nil, "staged file missing" end
    if #data ~= meta.size or not M.looks_like_star(data) or sha256.hex(data) ~= meta.sha256 then
        return nil, "staged file is corrupt"
    end
    return meta
end

-- Called from on_unload. Returns { result = applied | nothing | error, ... }.
function Updater:apply_staged()
    local paths, perr = self:paths()
    if not paths then return { result = "error", detail = perr } end
    if not self.p.exists(paths.staged_meta) then return { result = "nothing" } end

    -- A crash between the swap and clearing staged.json leaves metadata for a
    -- file that is already live. Record it as applied instead of an error.
    local pending = self:read_json(paths.staged_meta)
    if pending and not self.p.exists(paths.staged) and type(pending.sha256) == "string" then
        local live_now = self.p.read_file(paths.live)
        if live_now and sha256.hex(live_now) == pending.sha256 then
            self:remove(paths.staged_meta)
            self:save_state({
                last_apply_error = false,
                last_applied = { from = self.current, to = pending.version, at = self.p.now(),
                    rollback = pending.rollback == true, recovered = true },
            })
            return { result = "already_applied", to = pending.version }
        end
    end

    local meta, verr = self:verified_stage()
    if not meta then
        self:remove(paths.staged)
        self:remove(paths.staged_meta)
        self:save_state({ last_apply_error = verr })
        self.p.log("warn", "discarded staged update: " .. verr)
        return { result = "error", detail = verr }
    end

    local live = self.p.read_file(paths.live)
    if not live then
        local msg = "running plugin file not found at " .. paths.live .. "; update left staged"
        self:save_state({ last_apply_error = msg })
        self.p.log("warn", msg)
        return { result = "error", detail = msg }
    end

    -- Keep the running version for rollback, unless this apply is the rollback itself.
    if not meta.rollback then
        local ok, err = self:write(paths.previous, live)
        if ok then
            ok, err = self:write_json(paths.previous_meta, { version = self.current, saved_at = self.p.now() })
        end
        if not ok then
            local msg = "could not back up the running version: " .. tostring(err) .. "; update left staged"
            self:save_state({ last_apply_error = msg })
            self.p.log("warn", msg)
            return { result = "error", detail = msg }
        end
    end

    -- A single rename: the live file is either the old or the new version.
    local ok, err = self:rename(paths.staged, paths.live)
    if not ok then
        local msg = "could not replace the plugin file: " .. tostring(err) .. "; update left staged"
        self:save_state({ last_apply_error = msg })
        self.p.log("warn", msg)
        return { result = "error", detail = msg }
    end
    self:remove(paths.staged_meta)
    self:save_state({
        last_apply_error = false,
        last_applied = { from = self.current, to = meta.version, at = self.p.now(), rollback = meta.rollback == true },
    })
    self.p.log("info", ("installed %s over %s; it loads at the next Steam start"):format(meta.version, self.current))
    return { result = "applied", from = self.current, to = meta.version }
end

-- Stage the backed-up previous version so it replaces the current one at the
-- next shutdown, and stop the updater from fetching the current version again.
function Updater:request_rollback()
    local paths, perr = self:paths()
    if not paths then return { result = "error", detail = perr } end
    local meta = self:read_json(paths.previous_meta)
    local data = self.p.read_file(paths.previous)
    if not meta or not data or not M.looks_like_star(data) or not semver.parse(meta.version) then
        return { result = "error", detail = "no previous version to roll back to" }
    end
    if semver.compare(meta.version, self.current) >= 0 then
        return { result = "error", detail = ("the saved previous version (%s) is not older than the running one (%s)")
            :format(meta.version, self.current) }
    end
    self:remove(paths.staged_meta)
    local ok, err = self:write(paths.staged, data)
    if ok then
        ok, err = self:write_json(paths.staged_meta, {
            version = meta.version, sha256 = sha256.hex(data), size = #data, rollback = true, staged_at = self.p.now(),
        })
    end
    if not ok then return { result = "error", detail = tostring(err) } end
    self:save_state({ skip_version = self.current })
    self.p.log("info", ("rollback to %s staged; it loads at the next Steam start"):format(meta.version))
    return { result = "rollback_staged", to = meta.version }
end

-- Called at startup, without network. If the last update installed a version
-- newer than the one now running, and that update was not a rollback, the
-- user put an older file back by hand: skip the newer version so the next
-- check does not reinstall it.
function Updater:note_startup()
    local state = self:state()
    local applied = state.last_applied
    if type(applied) ~= "table" or applied.rollback or type(applied.to) ~= "string" then return nil end
    if semver.compare(applied.to, self.current) ~= 1 or state.skip_version == applied.to then return nil end
    self:save_state({ skip_version = applied.to })
    self.p.log("info", ("running %s after %s was installed; skipping %s"):format(self.current, applied.to, applied.to))
    return applied.to
end

-- Allow the skipped version again (after a fixed release, or by hand).
function Updater:clear_skip()
    self:save_state({ skip_version = false })
end

-- For the diagnostic report (M5). Contains versions and errors only.
function Updater:status()
    local paths = self:paths()
    local state = self:state()
    local staged = paths and self:read_json(paths.staged_meta)
    local previous = paths and self:read_json(paths.previous_meta)
    return {
        current_version = self.current,
        source = M.REPO_OWNER .. "/" .. M.REPO_NAME,
        last_check_at = state.last_check_at,
        last_result = state.last_result,
        last_error = state.last_error or nil,
        last_apply_error = state.last_apply_error or nil,
        last_applied = state.last_applied,
        skip_version = state.skip_version or nil,
        staged_version = staged and staged.version or nil,
        previous_version = previous and previous.version or nil,
    }
end

return M
