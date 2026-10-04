-- env — the project's .env file, read safely: values are masked unless
-- you ask, and it's checked against .env.example so a missing setting
-- is caught before the app is.
--
--   'dotenv [file]         the keys and masked values (.env by default)
--   'dotenv get <KEY>      one value, masked; 'dotenv get <KEY> show to see it
--   'dotenv check [file]   compare with .env.example: missing, extra, empty
--   'dotenv files          the .env* files here
-- (OXIS's own 'env lists the environment variables.)

-- The separator the folder is already written with (Git Bash gives C:/…).
local function sep()
  local cwd = oxis.cwd() or ""
  if cwd:find("/", 1, true) then return "/" end
  return oxis.platform == "windows" and "\\" or "/"
end
local function path(name)
  local cwd = (oxis.cwd() or ""):gsub("[\\/]+$", "")
  if name:match("^%a:[\\/]") or name:match("^/") then return name end
  return cwd .. sep() .. name
end

-- KEY=value lines; quotes stripped, "export " allowed, # comments skipped.
local function parse(text)
  local vars, order = {}, {}
  local n = 0
  for line in (text .. "\n"):gmatch("([^\n]*)\n") do
    n = n + 1
    line = line:gsub("\r$", "")
    local key, value = line:match("^%s*export%s+([%w_%.%-]+)%s*=%s*(.-)%s*$")
    if not key then key, value = line:match("^%s*([%w_%.%-]+)%s*=%s*(.-)%s*$") end
    if key then
      if value:match('^".*"$') or value:match("^'.*'$") then value = value:sub(2, -2)
      else value = value:gsub("%s+#.*$", "") end
      if not vars[key] then order[#order + 1] = key end
      vars[key] = { value = value, line = n }
    end
  end
  return vars, order
end

local SECRET = { "KEY", "SECRET", "TOKEN", "PASS", "PRIVATE", "CREDENTIAL", "AUTH", "DSN", "URL" }
local function mask(key, value)
  if value == "" then return "(empty)" end
  local upper = key:upper()
  local secret = false
  for _, w in ipairs(SECRET) do if upper:find(w, 1, true) then secret = true end end
  if not secret and #value <= 24 then return value end
  return value:sub(1, 3) .. ("•"):rep(math.min(12, math.max(4, #value - 3))) .. ("  (%d chars)"):format(#value)
end

local function load(name, cb)
  oxis.fs.read(path(name), function(err, text)
    if err then return cb(nil) end
    cb(parse(text))
  end)
end

oxis.command("dotenv", function(args)
  local sub = (args[1] or ""):lower()
  if sub == "files" then
    oxis.fs.list(oxis.cwd(), function(err, entries)
      if err then return oxis.echo(err, "err") end
      local found = 0
      for _, e in ipairs(entries) do
        if not e.isDir and e.name:match("^%.env") then found = found + 1 oxis.echo("  " .. e.name) end
      end
      if found == 0 then oxis.echo("No .env files here.", "dim") end
    end)
    return
  end
  if sub == "get" then
    local key = args[2]
    if not key then return oxis.echo("'dotenv get <KEY> [show]", "warn") end
    load(".env", function(vars)
      if not vars then return oxis.echo("No .env here.", "warn") end
      local v = vars[key]
      if not v then return oxis.echo(key .. " isn't in .env", "warn") end
      oxis.echo(("%s=%s"):format(key, (args[3] or ""):lower() == "show" and v.value or mask(key, v.value)))
    end)
    return
  end
  if sub == "check" then
    local name = args[2] or ".env"
    load(name, function(vars)
      load(".env.example", function(example, exampleOrder)
        if not example then return oxis.echo("No .env.example to check against.", "warn") end
        if not vars then return oxis.echo(("No %s — copy .env.example to %s and fill it in."):format(name, name), "err") end
        local missing, empty, extra = {}, {}, {}
        for _, k in ipairs(exampleOrder) do
          if not vars[k] then missing[#missing + 1] = k elseif vars[k].value == "" then empty[#empty + 1] = k end
        end
        for k in pairs(vars) do if not example[k] then extra[#extra + 1] = k end end
        table.sort(extra)
        if #missing == 0 and #empty == 0 then
          oxis.echo(("✓ %s has everything .env.example lists (%d settings)"):format(name, #exampleOrder), "ok")
        end
        if #missing > 0 then oxis.echo(("✗ missing from %s: %s"):format(name, table.concat(missing, ", ")), "err") end
        if #empty > 0 then oxis.echo(("⚠ empty in %s: %s"):format(name, table.concat(empty, ", ")), "warn") end
        if #extra > 0 then oxis.echo(("· only in %s (not in .env.example): %s"):format(name, table.concat(extra, ", ")), "dim") end
      end)
    end)
    return
  end
  local name = args[1] or ".env"
  load(name, function(vars, order)
    if not vars then return oxis.echo(("No %s here — 'dotenv files lists what there is"):format(name), "warn") end
    oxis.echo(("🔑 %s — %d setting%s (values masked; 'dotenv get KEY show to see one)"):format(name, #order, #order == 1 and "" or "s"), "accent")
    for _, k in ipairs(order) do oxis.echo(("  %-28s %s"):format(k, mask(k, vars[k].value))) end
  end)
end, "the project's .env with values masked, and 'dotenv check against .env.example")
