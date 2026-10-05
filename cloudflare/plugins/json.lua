--[[@manifest
version: 1.0.0
description: Pretty-prints a JSON file in colour, says whether it's valid, and pulls out one value with a path like scripts.build or items[0].name.
author: Oxide Labs
category: dev
min_oxis_version: 1.2.1
os: windows, unix
permissions: fs
]]

-- json.lua — 'json package.json prints it indented and coloured;
-- 'json package.json scripts.build prints one value; 'json-check <file>
-- just says whether it's valid.

local function isArray(t)
  if type(t) ~= "table" then return false end
  local n = 0
  for _ in pairs(t) do n = n + 1 end
  for i = 1, n do if t[i] == nil then return false end end
  return true
end

-- Lines of indented JSON, each with how to colour it. Objects' keys are
-- sorted (Lua tables don't keep the file's order).
local function pretty(value, indent, out, prefix, suffix)
  out = out or {}
  indent = indent or ""
  prefix = prefix or ""
  suffix = suffix or ""
  local t = type(value)
  if t == "table" then
    local arr = isArray(value)
    local keys = {}
    if arr then for i = 1, #value do keys[i] = i end
    else
      for k in pairs(value) do keys[#keys + 1] = k end
      table.sort(keys, function(a, b) return tostring(a) < tostring(b) end)
    end
    if #keys == 0 then out[#out + 1] = { indent .. prefix .. (arr and "[]" or "{}") .. suffix } return out end
    out[#out + 1] = { indent .. prefix .. (arr and "[" or "{") }
    for i, k in ipairs(keys) do
      local key = arr and "" or ("\"" .. tostring(k) .. "\": ")
      pretty(value[k], indent .. "  ", out, key, i < #keys and "," or "")
    end
    out[#out + 1] = { indent .. (arr and "]" or "}") .. suffix }
  else
    local text, kind
    if t == "string" then text, kind = oxis.json.encode(value), "ok"
    elseif t == "number" or t == "boolean" then text, kind = tostring(value), "accent"
    else text, kind = "null", "dim" end
    out[#out + 1] = { indent .. prefix .. text .. suffix, kind }
  end
  return out
end

-- "scripts.build", "items[0].name", "a.b.2" → the value, or nil and why.
local function dig(value, path)
  for part in path:gmatch("[^%.]+") do
    local name, rest = part:match("^([^%[]*)(.*)$")
    if name ~= "" then
      if type(value) ~= "table" then return nil, "no " .. name .. " in a " .. type(value) end
      local v = value[name]
      if v == nil and tonumber(name) then v = value[tonumber(name) + 1] end
      value = v
      if value == nil then return nil, "not found" end
    end
    for idx in rest:gmatch("%[(%d+)%]") do
      if type(value) ~= "table" then return nil, "can't index a " .. type(value) end
      value = value[tonumber(idx) + 1] -- JSON counts from 0, Lua from 1
      if value == nil then return nil, "no item " .. idx end
    end
  end
  return value
end

local function load(file, done)
  oxis.fs.read(file, function(err, text)
    if err then return oxis.echo("✗ " .. err, "err") end
    local ok, value = pcall(oxis.json.decode, text)
    if not ok then return oxis.echo("✗ " .. file .. " isn't valid JSON: " .. tostring(value):gsub("^.-: ", ""), "err") end
    done(value, text)
  end)
end

oxis.command("json", function(args)
  local file, path = args[1], args[2]
  if not file then return oxis.echo("'json <file> [path] — e.g. 'json package.json scripts.build", "warn") end
  load(file, function(value)
    if path then
      local v, why = dig(value, path)
      if v == nil then return oxis.echo("✗ " .. path .. ": " .. why, "err") end
      value = v
    end
    for _, l in ipairs(pretty(value)) do oxis.echo(l[1], l[2]) end
  end)
end, "pretty-print a JSON file, or one value in it: 'json package.json scripts.build")

oxis.command("json-check", function(args)
  if not args[1] then return oxis.echo("'json-check <file>", "warn") end
  load(args[1], function(_, text)
    oxis.echo(("✓ %s is valid JSON (%d bytes)"):format(args[1], #text), "ok")
  end)
end, "say whether a file is valid JSON")
