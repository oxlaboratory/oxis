-- fuzzy.lua — fuzzy file finder
-- 'ff abc matches paths containing a, b and c in that order (like
-- "src/app/config.ts"), shortest first. node_modules, .git, dist and
-- .next are skipped.

local WIN = oxis.platform == "windows"

-- "abc" -> "a.*b.*c" (case-insensitive), escaping regex characters.
local function fuzzyRegex(query)
  local parts = {}
  for ch in query:gmatch(".") do
    parts[#parts + 1] = ch:find("[%^%$%(%)%.%[%]%*%+%?%{%}%|\\]") and ("\\" .. ch) or ch
  end
  return table.concat(parts, ".*")
end

local function find(kind, query, limit)
  local re = query ~= "" and fuzzyRegex(query) or "."
  if WIN then
    oxis.run(([[Get-ChildItem -Recurse -%s -Name -ErrorAction SilentlyContinue | Where-Object { $_ -notmatch '(^|\\)(node_modules|\.git|dist|\.next)(\\|$)' -and $_ -match %s } | Sort-Object Length | Select-Object -First %d]])
      :format(kind == "f" and "File" or "Directory", oxis.quote(re), limit))
  else
    oxis.run(([[find . -type d \( -name node_modules -o -name .git -o -name dist -o -name .next \) -prune -o -type %s -print 2>/dev/null | sed 's|^\./||' | grep -v '^\.$' | grep -iE %s | awk '{ print length, $0 }' | sort -n | cut -d' ' -f2- | head -n %d]])
      :format(kind, oxis.quote(re), limit))
  end
end

oxis.command("ff", function(_, rest) find("f", rest, 40) end,
  "find files by fuzzy name: 'ff <letters> (e.g. 'ff appcfg)")

oxis.command("fd", function(_, rest) find("d", rest, 40) end,
  "find folders by fuzzy name: 'fd <letters>")

oxis.command("frec", function(args)
  local days = tonumber(args[1]) or 3
  if WIN then
    oxis.run(([[Get-ChildItem -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.FullName -notmatch '\\(node_modules|\.git|dist|\.next)\\' -and $_.LastWriteTime -gt (Get-Date).AddDays(-%d) } | Sort-Object LastWriteTime -Descending | Select-Object -First 30 @{N='Modified';E={$_.LastWriteTime.ToString('yyyy-MM-dd HH:mm')}}, @{N='File';E={Resolve-Path -Relative $_.FullName}} | Format-Table -AutoSize]])
      :format(days))
  else
    oxis.run(([[find . -type d \( -name node_modules -o -name .git -o -name dist -o -name .next \) -prune -o -type f -mtime -%d -printf '%%TY-%%Tm-%%Td %%TH:%%TM  %%P\n' 2>/dev/null | sort -r | head -n 30]])
      :format(days))
  end
end, "files changed in the last few days, newest first: 'frec [days] (default 3)")
