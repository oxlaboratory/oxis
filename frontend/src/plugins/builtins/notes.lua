-- notes — a notes file for each project, in Markdown, kept in the
-- project's .oxis folder so it travels with the project.
--
--   'note <text>          add a note (with the date and time)
--   'note - [ ] <text>    or a task; 'notes done <n> ticks it
--   'notes [n]            the last n notes (10)
--   'notes find <words>   notes with those words
--   'notes done <n>       tick task n (as numbered by 'notes)
--   'notes edit           open the file in the editor
--   'notes where          where the file is

-- The separator the folder is already written with (Git Bash gives C:/…).
local function sep()
  local cwd = oxis.cwd() or ""
  if cwd:find("/", 1, true) then return "/" end
  return oxis.platform == "windows" and "\\" or "/"
end

local function dir()
  local cwd = oxis.cwd()
  if not cwd or cwd == "" then return nil end
  return (cwd:gsub("[\\/]+$", "")) .. sep() .. ".oxis"
end

local function file()
  local d = dir()
  return d and (d .. sep() .. "notes.md") or nil
end

local function now()
  return os.date and os.date("%Y-%m-%d %H:%M") or ""
end

-- Notes are the file's "- " lines; anything else (headings, prose
-- written in the editor) is kept as it is.
local function parse(content)
  local lines, notes = {}, {}
  for line in (content .. "\n"):gmatch("([^\n]*)\n") do
    lines[#lines + 1] = line
    if line:match("^%s*%- ") then notes[#notes + 1] = { at = #lines, text = line:gsub("^%s*%- ", "") } end
  end
  if lines[#lines] == "" then lines[#lines] = nil end
  return lines, notes
end

local function read(cb)
  local path = file()
  if not path then return oxis.echo("notes needs a folder: cd into your project first", "warn") end
  oxis.fs.read(path, function(err, content)
    if err then content = "" end
    cb(path, content)
  end)
end

local function write(path, content, cb)
  oxis.fs.mkdir(dir(), function()
    oxis.fs.write(path, content, function(err)
      if err then return oxis.echo("couldn't save notes: " .. err, "err") end
      if cb then cb() end
    end)
  end)
end

local function show(note, i)
  local box, rest = note.text:match("^(%[[ x]%])%s*(.*)$")
  rest = rest or note.text
  local stamp, body = rest:match("^`([^`]+)`%s*(.*)$")
  body = body or rest
  local kind = box == "[x]" and "dim" or box == "[ ]" and "accent" or "info"
  local mark = box == "[x]" and "☑ " or box == "[ ]" and "☐ " or ""
  oxis.echo(("%3d  %s%s%s"):format(i, mark, body, stamp and ("   · " .. stamp) or ""), kind)
end

oxis.command("note", function(_, rest)
  if rest == "" then return oxis.echo("'note <text> adds a note · 'note - [ ] <text> adds a task · 'notes lists them", "dim") end
  read(function(path, content)
    local task = rest:match("^%-%s*%[ %]%s*(.+)$") or rest:match("^%[ %]%s*(.+)$")
    local entry = task and ("- [ ] `" .. now() .. "` " .. task) or ("- `" .. now() .. "` " .. rest)
    if content == "" then content = "# Notes\n\n" end
    if not content:match("\n$") then content = content .. "\n" end
    write(path, content .. entry .. "\n", function()
      local _, notes = parse(content .. entry)
      oxis.echo(("📝 %s #%d"):format(task and "task" or "note", #notes), "ok")
    end)
  end)
end, "add a note to this project's notes (or a task: 'note - [ ] text)")

oxis.command("notes", function(args, rest)
  local sub = (args[1] or ""):lower()
  if sub == "where" then return oxis.echo(file() or "no folder yet", "dim") end
  if sub == "edit" then
    read(function(path, content)
      if content == "" then write(path, "# Notes\n\n", function() oxis.editor.open(path) end)
      else oxis.editor.open(path) end
    end)
    return
  end
  read(function(path, content)
    local lines, notes = parse(content)
    if #notes == 0 then return oxis.echo("No notes here yet — 'note <text> adds one", "dim") end
    if sub == "find" then
      local words = rest:gsub("^%S+%s*", ""):lower()
      local hits = 0
      for i, n in ipairs(notes) do
        if n.text:lower():find(words, 1, true) then hits = hits + 1 show(n, i) end
      end
      if hits == 0 then oxis.echo("No notes with “" .. words .. "”", "dim") end
      return
    end
    if sub == "done" then
      local n = tonumber(args[2])
      local note = n and notes[n]
      if not note or not note.text:match("^%[ %]") then return oxis.echo("'notes done <n> — the number of an open task", "warn") end
      lines[note.at] = lines[note.at]:gsub("%[ %]", "[x]", 1)
      write(path, table.concat(lines, "\n") .. "\n", function() oxis.echo("✓ ticked task " .. n, "ok") end)
      return
    end
    local count = tonumber(sub) or 10
    oxis.echo(("📝 %d note%s in %s"):format(#notes, #notes == 1 and "" or "s", path), "accent")
    for i = math.max(1, #notes - count + 1), #notes do show(notes[i], i) end
    local open = 0
    for _, n in ipairs(notes) do if n.text:match("^%[ %]") then open = open + 1 end end
    if open > 0 then oxis.echo(("%d open task%s — 'notes done <n> ticks one"):format(open, open == 1 and "" or "s"), "dim") end
  end)
end, "this project's notes: 'notes [n], 'notes find <words>, 'notes done <n>, 'notes edit")
