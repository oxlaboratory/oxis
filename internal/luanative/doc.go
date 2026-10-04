// Package luanative runs OXIS plugins on real Lua 5.4 (third_party/lua)
// instead of fengari: the page sends each plugin's source over a
// WebSocket (bridge.go), and every oxis.* call comes back to the page's
// JS bindings. On Windows Lua is lua54.dll (embedded, written out on
// first use) so Lua C modules can share it; elsewhere it's compiled in.
// Without cgo the package reports native Lua as unavailable (stub.go)
// and plugins run on fengari.
package luanative
