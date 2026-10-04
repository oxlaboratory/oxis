# Lua 5.4.9

The Lua interpreter's C sources, unchanged, from
<https://www.lua.org/ftp/lua-5.4.9.tar.gz> (SHA-256
`2335b6c582a52654f94612bf10d2f4672805d05329aa6568b1d8cd9e5c6fb8e6`,
as listed at <https://www.lua.org/ftp/>). The stand-alone `lua.c` and
`luac.c` programs are left out.

OXIS runs plugins on it (`internal/luanative`): compiled into the binary
on Linux, and as `lua54.dll` on Windows, so Lua C modules built for
Lua 5.4 load into the same Lua. `scripts/build-lua.js` rebuilds the DLL.

Lua is free software under the MIT license: see [LICENSE](LICENSE).
