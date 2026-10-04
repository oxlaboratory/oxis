-- snippets — commands you type often, saved by name. A snippet can take
-- arguments: {1}, {2}… are replaced by the words after its name, and
-- {*} by all of them.
--
--   'snip add <name> <text>   save one (e.g. 'snip add deploy npm run deploy -- --env={1})
--   'snip <name> [args]       put it in the prompt to check, then Enter runs it
--   'snip run <name> [args]   run it straight away
--   'snip                     list them
--   'snip rm <name>           forget one

local function all() return oxis.store.get("snippets") or {} end
local function save(t) oxis.store.set("snippets", t) end

local function fill(text, args, from)
  local rest = {}
  for i = from, #args do rest[#rest + 1] = args[i] end
  local missing = {}
  local out = text:gsub("{(%d+)}", function(n)
    local v = rest[tonumber(n)]
    if not v then missing[#missing + 1] = "{" .. n .. "}" return "{" .. n .. "}" end
    return v
  end)
  out = out:gsub("{%*}", table.concat(rest, " "))
  return out, missing
end

oxis.command("snip", function(args, rest)
  if not oxis.store then return oxis.echo("snippets needs a newer OXIS build — 'update install", "warn") end
  local sub = args[1] or ""
  local s = all()
  if sub == "" or sub == "ls" or sub == "list" then
    local names = {}
    for name in pairs(s) do names[#names + 1] = name end
    if #names == 0 then return oxis.echo("No snippets yet — 'snip add <name> <command>", "dim") end
    table.sort(names)
    oxis.echo(("✂ %d snippet%s"):format(#names, #names == 1 and "" or "s"), "accent")
    for _, name in ipairs(names) do oxis.echo(("  %-14s %s"):format(name, s[name])) end
    return
  end
  if sub == "add" then
    local name, text = rest:match("^%S+%s+(%S+)%s+(.+)$")
    if not name then return oxis.echo("'snip add <name> <text>  ({1} {2}… for arguments)", "warn") end
    local existed = s[name] ~= nil
    s[name] = text
    save(s)
    return oxis.echo(("✂ %s %s"):format(existed and "updated" or "saved", name), "ok")
  end
  if sub == "rm" or sub == "remove" then
    local name = args[2]
    if not name or not s[name] then return oxis.echo("no snippet called " .. tostring(name), "warn") end
    s[name] = nil
    save(s)
    return oxis.echo("✂ removed " .. name, "ok")
  end
  local run = sub == "run"
  local name = run and args[2] or sub
  local text = name and s[name]
  if not text then return oxis.echo(("no snippet called %s — 'snip lists them"):format(tostring(name)), "warn") end
  local filled, missing = fill(text, args, run and 3 or 2)
  if #missing > 0 then
    return oxis.echo(("%s needs %s: 'snip %s%s <%s>"):format(name, table.concat(missing, " "), run and "run " or "", name,
      table.concat(missing, "> <"):gsub("[{}]", "")), "warn")
  end
  if run then
    oxis.echo("✂ " .. filled, "dim")
    oxis.run(filled)
  else
    oxis.input(filled)
  end
end, "saved commands with arguments — 'snip add <name> <text>, 'snip <name> [args], 'snip run <name>")
