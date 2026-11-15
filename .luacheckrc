std = "luajit"
max_line_length = 120
files["tests/lua"] = { std = "+busted" }
exclude_files = { ".millennium/", "node_modules/", ".luarocks/", "lua_modules/" }
