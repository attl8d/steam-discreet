std = "luajit"
max_line_length = 120
files["tests/lua"] = { std = "+busted" }
-- Global functions marked ---@ffi are Millennium RPC entry points.
files["backend/diagnostics.lua"] = { globals = { "sd_diag_probe" } }
exclude_files = { ".millennium/", "node_modules/", ".luarocks/", "lua_modules/" }
