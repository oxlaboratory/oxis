-- prelude.lua — runs first in every plugin's Lua state.
--
-- It builds the `oxis` table: the same API as the fengari runtime
-- (frontend/src/plugins/luaRuntime.ts), argument for argument. Each
-- call goes over the bridge to the same JS bindings (pluginAPI.ts):
-- `call` waits for the answer, `post` doesn't (it's sent with the next
-- batch, in order). Lua functions passed along become references JS
-- can call back.
--
-- It also puts Lua's own libraries behind the plugin's permissions:
-- files need `fs`, running programs `shell`, and C modules, package.
-- loadlib and the debug library `native` (C code can do anything).

local call, post, platform, path, cpath = ...

local type, tostring, select, error, setmetatable, pairs = type, tostring, select, error, setmetatable, pairs
local concat = table.concat

local function str(v) if v ~= nil then return tostring(v) end end
local function num(v) if type(v) == "number" then return v end end
local function fn(v) if type(v) == "function" then return v end end

-- Plain data only: JS gets no functions inside option tables (as
-- luaRuntime's luaToJS drops them).
local function plain(v, depth)
  if type(v) == "function" then return nil end
  if type(v) ~= "table" then return v end
  depth = (depth or 0) + 1
  if depth > 64 then return nil end
  local t = {}
  for k, x in pairs(v) do
    if type(k) == "string" or type(k) == "number" then t[k] = plain(x, depth) end
  end
  return t
end

-- The named callbacks out of a table: { stdout = fn, exit = fn }.
local function pick(t, names)
  local out = {}
  if type(t) == "table" then
    for _, n in ipairs(names) do
      if type(t[n]) == "function" then out[n] = t[n] end
    end
  end
  return out
end

local oxis = {}
oxis.platform = platform

function oxis.command(name, f, desc) post("command", str(name), f, str(desc)) end
function oxis.task(name, cmd, desc) post("task", str(name), str(cmd), str(desc)) end
function oxis.echo(text, kind) post("echo", tostring(text), str(kind)) end
function oxis.sound(name) post("sound", str(name)) end
function oxis.notify(title, body, always) post("notify", tostring(title), str(body), always == true) end
function oxis.line(text, kind) return call("line", str(text) or "", str(kind)) end
function oxis.run(cmd) post("run", str(cmd)) end
function oxis.quote(text) return call("quote", str(text) or "") end
function oxis.theme(name) post("theme", str(name)) end
function oxis.cwd() return call("cwd") end
function oxis.newTerminal() post("newTerminal") end
function oxis.workspace(p) call("workspace", str(p)) end
function oxis.dashboard(config) post("dashboard", plain(config)) end
function oxis.workflow(name, def, desc) post("workflow", str(name), plain(def), str(desc)) end
function oxis.option(key, ...)
  if select("#", ...) == 0 then return call("getOption", str(key)) end
  post("setOption", str(key), plain((...)))
end
function oxis.autocmd(event, f) post("autocmd", str(event), f) end
function oxis.keymap(mode, combo, f) post("keymap", str(mode), str(combo), f) end
oxis.plugin = {
  enable = function(name) call("pluginEnable", str(name)) end,
  disable = function(name) call("pluginDisable", str(name)) end,
}

-- oxis.fs.read(path, function(err, content) ... end) and friends: the
-- answer comes to the callback (err is nil, or what went wrong).
oxis.fs = {
  read = function(p, cb) post("fsRead", str(p), fn(cb)) end,
  write = function(p, content, cb) post("fsWrite", str(p), str(content), fn(cb)) end,
  list = function(p, cb) post("fsList", str(p), fn(cb)) end,
  stat = function(p, cb) post("fsStat", str(p), fn(cb)) end,
  mkdir = function(p, cb) post("fsMkdir", str(p), fn(cb)) end,
  remove = function(p, cb) post("fsRemove", str(p), fn(cb)) end,
  search = function(root, query, opts, cb)
    if type(opts) ~= "table" then opts, cb = {}, opts end
    post("fsSearch", str(root), str(query) or "", plain(opts), fn(cb))
  end,
  -- (path, fn [, opts]), (path, opts, fn) or (path, { change = fn, ready = fn } [, opts])
  watch = function(p, a, b)
    local cbs, opts
    if type(a) == "function" then cbs, opts = { change = a }, b
    elseif type(a) == "table" and type(a.change) == "function" then cbs, opts = a, b
    else opts, cbs = a, (type(b) == "function" and { change = b } or b) end
    return call("fsWatch", str(p), plain(opts), pick(cbs, { "change", "ready" }))
  end,
}

oxis.process = {
  list = function(cb) post("processList", fn(cb)) end,
  -- (opts, { start, stdout, stderr, exit }); the callbacks may sit in opts.
  spawn = function(opts, cbs)
    if type(cbs) ~= "table" then cbs = opts end
    return call("processSpawn", plain(opts), pick(cbs, { "start", "stdout", "stderr", "exit" }))
  end,
  kill = function(pid, cb) post("processKill", num(pid), fn(cb)) end,
}

oxis.net = {
  request = function(opts, cb) post("netRequest", plain(opts), fn(cb)) end,
  stream = function(opts, cbs)
    if type(cbs) ~= "table" then cbs = opts end
    return call("netStream", plain(opts), pick(cbs, { "response", "data", "line", "event", "done" }))
  end,
}

-- Done here, in Go: no trip to JS.
oxis.json = {
  encode = function(v) return call("$json.encode", v) end,
  decode = function(s) return call("$json.decode", str(s) or "") end,
}

oxis.editor = {
  current = function() return call("editorCurrent") end,
  open = function(p, line) call("editorOpen", str(p), num(line)) end,
  setText = function(t) return call("editorSetText", str(t) or "") end,
  insert = function(t) return call("editorInsert", str(t) or "") end,
  replaceLines = function(first, last, t) return call("editorReplaceLines", num(first), num(last), str(t) or "") end,
  select = function(line, col, toLine, toCol) return call("editorSelect", num(line), num(col) or 1, num(toLine), num(toCol)) end,
  save = function(cb) post("editorSave", fn(cb)) end,
  on = function(event, cb) post("editorOn", str(event), cb) end,
}

-- oxis.ask("Roll again?", function(answer) … end [, { label = "dice", cancel = fn }])
function oxis.ask(question, answer, opts)
  local label, cancel
  if type(opts) == "table" then label, cancel = str(opts.label), fn(opts.cancel) end
  call("ask", str(question) or "", answer, label, cancel)
end
function oxis.after(seconds, f) return call("after", num(seconds) or 0, f) end
function oxis.every(seconds, f, opts)
  local fg, stop = false, nil
  if type(opts) == "table" then fg, stop = opts.foreground and true or false, fn(opts.stop) end
  return call("every", num(seconds) or 1, f, fg, stop)
end
function oxis.input(text) post("input", str(text) or "") end
oxis.store = {
  get = function(key) return call("storeGet", str(key) or "") end,
  set = function(key, value) post("storeSet", str(key) or "", plain(value)) end,
}
oxis.system = { info = function(cb) post("systemInfo", fn(cb)) end }

_G.oxis = oxis

-- print shows in the terminal, like oxis.echo.
function _G.print(...)
  local n, parts = select("#", ...), {}
  for i = 1, n do parts[i] = tostring((select(i, ...))) end
  post("echo", concat(parts, "\t"))
end

-- ── Lua's libraries, behind permissions ──
local granted = {}
local function need(ns)
  if not granted[ns] then
    call("$perm", ns)
    granted[ns] = true
  end
end
local function guard(ns, f)
  if f then return function(...) need(ns) return f(...) end end
end

io.open, io.lines, io.input, io.output, io.tmpfile =
  guard("fs", io.open), guard("fs", io.lines), guard("fs", io.input), guard("fs", io.output), guard("fs", io.tmpfile)
io.popen = guard("shell", io.popen)
os.remove, os.rename, os.tmpname = guard("fs", os.remove), guard("fs", os.rename), guard("fs", os.tmpname)
os.execute = guard("shell", os.execute)
function os.exit() error("os.exit isn't allowed in a plugin: it would close OXIS", 2) end

-- Text only: precompiled chunks aren't checked by Lua and could break
-- out of the VM.
local rawload, rawloadfile, rawdofile = load, loadfile, dofile
function _G.load(chunk, name, _, env) return rawload(chunk, name, "t", env) end
_G.loadfile = guard("fs", function(name, _, env) return rawloadfile(name, "t", env) end)
_G.dofile = guard("fs", function(name)
  local f = assert(rawloadfile(name, "t"))
  return f()
end)

package.loadlib = guard("native", package.loadlib)
local searchpath, cLoader, cRootLoader = package.searchpath, package.searchers[3], package.searchers[4]
package.searchers[3] = function(name)
  if searchpath(name, package.cpath) then need("native") end
  return cLoader(name)
end
package.searchers[4] = function(name)
  local root = name:match("^([^.]+)")
  if root and searchpath(root, package.cpath) then need("native") end
  return cRootLoader(name)
end
local realdebug = debug
_G.debug = setmetatable({}, { __index = function(_, k) need("native") return realdebug[k] end })
package.loaded.debug = _G.debug

-- ~/.oxis/lua and LuaRocks' trees first.
package.path = path .. package.path
package.cpath = cpath .. package.cpath
