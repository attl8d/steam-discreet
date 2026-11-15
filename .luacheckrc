std = "luajit"
max_line_length = 120
files["tests/lua"] = { std = "+busted" }
exclude_files = { ".millennium/", "node_modules/", ".luarocks/", "lua_modules/" }
-- Millennium calls frontend-facing backend functions by global name.
files["backend/tagstore/rpc.lua"] = {
    globals = { "tags_open", "tags_add", "tags_remove", "tags_clear", "tags_export", "tags_import" },
}
