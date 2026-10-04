//go:build !windows && cgo

/* Linux (and other Unix): the Lua interpreter compiled into OXIS, one translation unit
 * (like Lua's own onelua.c), from third_party/lua. Built with its
 * symbols exported (-Wl,-E in luanative.go) so Lua C modules loaded
 * with require find this Lua. */
#define LUA_CORE
#define LUA_LIB
#include "../../third_party/lua/src/lzio.c"
#include "../../third_party/lua/src/lctype.c"
#include "../../third_party/lua/src/lopcodes.c"
#include "../../third_party/lua/src/lmem.c"
#include "../../third_party/lua/src/lundump.c"
#include "../../third_party/lua/src/ldump.c"
#include "../../third_party/lua/src/lstate.c"
#include "../../third_party/lua/src/lgc.c"
#include "../../third_party/lua/src/llex.c"
#include "../../third_party/lua/src/lcode.c"
#include "../../third_party/lua/src/lparser.c"
#include "../../third_party/lua/src/ldebug.c"
#include "../../third_party/lua/src/lfunc.c"
#include "../../third_party/lua/src/lobject.c"
#include "../../third_party/lua/src/ltm.c"
#include "../../third_party/lua/src/lstring.c"
#include "../../third_party/lua/src/ltable.c"
#include "../../third_party/lua/src/ldo.c"
#include "../../third_party/lua/src/lvm.c"
#include "../../third_party/lua/src/lapi.c"
#include "../../third_party/lua/src/lauxlib.c"
#include "../../third_party/lua/src/lbaselib.c"
#include "../../third_party/lua/src/lcorolib.c"
#include "../../third_party/lua/src/ldblib.c"
#include "../../third_party/lua/src/liolib.c"
#include "../../third_party/lua/src/lmathlib.c"
#include "../../third_party/lua/src/loadlib.c"
#include "../../third_party/lua/src/loslib.c"
#include "../../third_party/lua/src/lstrlib.c"
#include "../../third_party/lua/src/ltablib.c"
#include "../../third_party/lua/src/lutf8lib.c"
#include "../../third_party/lua/src/linit.c"
