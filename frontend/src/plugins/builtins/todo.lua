-- todo.lua — find TODO/FIXME-style comments in source files
-- Tags match as whole, upper-case words, so "note" in prose doesn't
-- count. node_modules, .git, dist and vendor are skipped.

local WIN = oxis.platform == "windows"
local EXTS = { "ts", "tsx", "js", "jsx", "go", "py", "rs", "lua", "cs", "java", "c", "cpp", "h" }

local PS = [[
$files = Get-ChildItem -Recurse -File -Include @EXTS@ -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -notmatch '\\(node_modules|\.git|dist|vendor)\\' }
$hits = @($files | Select-String -Pattern '\b(@TAGS@)\b' -CaseSensitive)
foreach ($h in $hits) {
  Write-Host ("  [{0}] {1}:{2}  {3}" -f $h.Matches[0].Groups[1].Value, (Resolve-Path -Relative $h.Path), $h.LineNumber, $h.Line.Trim())
}
Write-Host ""
Write-Host "  $($hits.Count) found."
]]

local SH = [[
grep -rnE @EXTS@ --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist --exclude-dir=vendor '\b(@TAGS@)\b' . 2>/dev/null |
  sed 's|^\./||' |
  awk -v re='@TAGS@' '{
    file = $0; sub(/:.*/, "", file)
    rest = substr($0, length(file) + 2); line = rest; sub(/:.*/, "", line)
    text = substr(rest, length(line) + 2); gsub(/^[ \t]+|[ \t]+$/, "", text)
    match(text, re)
    printf "  [%s] %s:%s  %s\n", substr(text, RSTART, RLENGTH), file, line, text; n++
  } END { printf "\n  %d found.\n", n }'
]]

local function scan(tags)
  local exts = {}
  for i, e in ipairs(EXTS) do
    exts[i] = WIN and ("*." .. e) or ("--include='*." .. e .. "'")
  end
  local script = WIN and PS or SH
  script = script:gsub("@EXTS@", table.concat(exts, WIN and "," or " "))
  script = script:gsub("@TAGS@", tags)
  oxis.run(script)
end

oxis.command("todos", function() scan("TODO|FIXME|HACK|XXX|NOTE|BUG|WARN|PERF") end,
  "list TODO, FIXME, HACK, XXX, NOTE, BUG, WARN and PERF comments under this folder")

oxis.command("fixmes", function() scan("FIXME|BUG") end,
  "list FIXME and BUG comments under this folder")
