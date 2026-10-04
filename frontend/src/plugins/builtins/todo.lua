-- todo — every TODO, FIXME, HACK and BUG left in the project, with
-- links that open the line in the editor. Uses the editor's search, so
-- dependency and build folders and binary files are skipped.
--
--   'todo              all of them, grouped by file
--   'todo fixme        one kind (todo, fixme, hack, bug, xxx, note)
--   'todo mine         only the ones with your name: TODO(you)
--   'todo count        how many of each

local TAGS = { "TODO", "FIXME", "HACK", "BUG", "XXX", "NOTE" }
local KIND = { TODO = "accent", FIXME = "warn", HACK = "warn", BUG = "err", XXX = "warn", NOTE = "dim" }

local function rel(path, root)
  local p = path:gsub("\\", "/")
  local r = root:gsub("\\", "/"):gsub("/+$", "")
  if p:sub(1, #r + 1):lower() == (r .. "/"):lower() then return p:sub(#r + 2) end
  return p
end

local function search(pattern, cb)
  local root = oxis.cwd()
  if not root or root == "" then return oxis.echo("cd into a project first", "warn") end
  if not oxis.fs.search then return oxis.echo("todo needs a newer OXIS build — 'update install", "warn") end
  oxis.fs.search(root, pattern, { regex = true, caseSensitive = true, max = 5000 }, function(err, result)
    if err then return oxis.echo("couldn't search: " .. err, "err") end
    cb(result, root)
  end)
end

local function collect(result, only, mine)
  local items, counts = {}, {}
  for _, m in ipairs(result.matches or {}) do
    local tag, owner, text = m.text:match("%f[%w](%u+)%s*%(([^)]*)%)%s*:?%s*(.*)")
    if not tag then tag, text = m.text:match("%f[%w](%u+)%s*:?%s*(.*)") end
    if tag and KIND[tag] and (not only or tag == only) and (not mine or (owner and owner:lower() == mine)) then
      counts[tag] = (counts[tag] or 0) + 1
      text = (text or ""):gsub("%s*%*/%s*$", ""):gsub("%s*%-%->%s*$", "")
      items[#items + 1] = { path = m.path, line = m.line, tag = tag, owner = owner, text = text }
    end
  end
  return items, counts
end

oxis.command("todo", function(args)
  local sub = (args[1] or ""):lower()
  local only = nil
  for _, t in ipairs(TAGS) do if sub == t:lower() then only = t end end
  local mine = nil
  if sub == "mine" then mine = (args[2] or os.getenv and (os.getenv("USERNAME") or os.getenv("USER")) or ""):lower() end
  local pattern = "\\b(" .. table.concat(only and { only } or TAGS, "|") .. ")\\b"
  search(pattern, function(result, root)
    local items, counts = collect(result, only, mine)
    if #items == 0 then
      return oxis.echo(only and ("No " .. only .. "s here. 🎉") or "Nothing left to do here. 🎉", "ok")
    end
    if sub == "count" then
      oxis.echo(("📋 %d in %d files%s"):format(#items, result.files or 0, result.truncated and " (stopped at 5000)" or ""), "accent")
      for _, t in ipairs(TAGS) do
        if counts[t] then oxis.echo(("  %-6s %4d  %s"):format(t, counts[t], ("▪"):rep(math.min(40, counts[t]))), KIND[t]) end
      end
      return
    end
    table.sort(items, function(a, b) if a.path == b.path then return a.line < b.line end return a.path < b.path end)
    local summary = {}
    for _, t in ipairs(TAGS) do if counts[t] then summary[#summary + 1] = counts[t] .. " " .. t end end
    oxis.echo(("📋 %s"):format(table.concat(summary, " · ")), "accent")
    local last
    for _, it in ipairs(items) do
      local file = rel(it.path, root)
      if file ~= last then oxis.echo(file, "dim") last = file end
      -- path:line is a link: click to open it at that line.
      oxis.echo(("  %s:%d  %-5s %s%s"):format(file, it.line, it.tag, it.owner and ("(" .. it.owner .. ") ") or "", it.text), KIND[it.tag])
    end
  end)
end, "every TODO, FIXME, HACK and BUG in the project, linked to its line — 'todo [fixme|mine|count]")
