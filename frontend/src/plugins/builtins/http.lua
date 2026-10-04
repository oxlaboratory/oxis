-- http — make an HTTP request and read the answer: status, time, size,
-- and the body with JSON laid out. OXIS makes the request itself, so
-- local and self-hosted APIs work (no CORS).
--
--   'http <url>                           GET
--   'http post <url> name=value …         a JSON body from name=value pairs
--   'http put <url> -d '{"raw":"body"}'   a body as written
--   'http get <url> -H "Authorization: Bearer x" -i
--        -H adds a header, -i shows the response headers, -f the full body

local METHODS = { get = true, post = true, put = true, patch = true, delete = true, head = true, options = true }

-- JSON laid out with two-space indents, keys in order.
local function pretty(v, indent)
  indent = indent or ""
  local t = type(v)
  if t == "table" then
    local isArray = #v > 0 or next(v) == nil
    local inner = indent .. "  "
    local parts = {}
    if isArray then
      if #v == 0 then return "[]" end
      for i = 1, #v do parts[i] = inner .. pretty(v[i], inner) end
      return "[\n" .. table.concat(parts, ",\n") .. "\n" .. indent .. "]"
    end
    local keys = {}
    for k in pairs(v) do keys[#keys + 1] = tostring(k) end
    table.sort(keys)
    for i, k in ipairs(keys) do parts[i] = inner .. ("%q"):format(k) .. ": " .. pretty(v[k], inner) end
    return "{\n" .. table.concat(parts, ",\n") .. "\n" .. indent .. "}"
  elseif t == "string" then
    return (("%q"):format(v):gsub("\\\n", "\\n"))
  elseif t == "nil" then
    return "null"
  end
  return tostring(v)
end

local function size(n)
  if n >= 1048576 then return ("%.1f MB"):format(n / 1048576) end
  if n >= 1024 then return ("%.1f KB"):format(n / 1024) end
  return n .. " B"
end

oxis.command("http", function(args)
  local method = "GET"
  local i = 1
  if args[1] and METHODS[args[1]:lower()] then method = args[1]:upper() i = 2 end
  local url = args[i]
  if not url then
    return oxis.echo("'http [get|post|put|patch|delete] <url> [name=value …] [-H \"Header: v\"] [-d body] [-i] [-f]", "dim")
  end
  if not url:match("^https?://") then
    url = (url:match("^localhost") or url:match("^127%.") or url:match("^%[::1%]")) and ("http://" .. url) or ("https://" .. url)
  end
  local headers, fields, body, showHeaders, full = {}, {}, nil, false, false
  i = i + 1
  while i <= #args do
    local a = args[i]
    if a == "-H" and args[i + 1] then
      local k, v = args[i + 1]:match("^([^:]+):%s*(.*)$")
      if k then headers[k] = v end
      i = i + 1
    elseif a == "-d" and args[i + 1] then body = args[i + 1] i = i + 1
    elseif a == "-i" then showHeaders = true
    elseif a == "-f" then full = true
    else
      local k, v = a:match("^([^=]+)=(.*)$")
      if k then fields[k] = tonumber(v) or (v == "true" and true) or (v == "false" and false) or v end
    end
    i = i + 1
  end
  if not body and next(fields) then
    body = oxis.json.encode(fields)
    headers["Content-Type"] = headers["Content-Type"] or "application/json"
  end
  oxis.echo(("→ %s %s"):format(method, url), "dim")
  oxis.net.request({ url = url, method = method, headers = headers, body = body or "", timeout = 30 }, function(err, res)
    if err then return oxis.echo("✗ " .. err, "err") end
    local kind = res.status < 300 and "ok" or res.status < 400 and "warn" or "err"
    oxis.echo(("%d %s · %s · %s"):format(res.status, res.ok and "OK" or "", res.ms and ("%.0f ms"):format(res.ms) or "", size(#(res.body or ""))), kind)
    if showHeaders then
      local names = {}
      for k in pairs(res.headers or {}) do names[#names + 1] = k end
      table.sort(names)
      for _, k in ipairs(names) do oxis.echo(("  %s: %s"):format(k, res.headers[k]), "dim") end
    end
    local text = res.body or ""
    if text == "" then return end
    local ctype = ""
    for k, v in pairs(res.headers or {}) do if k:lower() == "content-type" then ctype = v end end
    if ctype:find("json") or text:match("^%s*[{%[]") then
      local ok, decoded = pcall(oxis.json.decode, text)
      if ok and decoded ~= nil then text = pretty(decoded) end
    end
    local lines, shown = {}, 0
    for line in (text .. "\n"):gmatch("([^\n]*)\n") do lines[#lines + 1] = line end
    local limit = full and #lines or 60
    for n = 1, math.min(limit, #lines) do
      shown = shown + 1
      oxis.echo(lines[n])
    end
    if #lines > shown then oxis.echo(("… %d more lines (-f shows them all)"):format(#lines - shown), "dim") end
  end)
end, "make an HTTP request and read the answer, JSON laid out — 'http post localhost:3000/api name=ox")
