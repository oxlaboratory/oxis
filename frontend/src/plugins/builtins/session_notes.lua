-- session_notes.lua — quick notes, one Markdown file per day
-- Kept in ~/.oxis/notes. Open one in the editor with 'edit <path>.

local WIN = oxis.platform == "windows"

local PS_DIR = [[
$dir = Join-Path $HOME '.oxis\notes'
New-Item -ItemType Directory -Force $dir | Out-Null
]]
local SH_DIR = [[
dir="$HOME/.oxis/notes"
mkdir -p "$dir"
]]

local function run(ps, sh) oxis.run(WIN and (PS_DIR .. ps) or (SH_DIR .. sh)) end

oxis.command("note", function(_, rest)
  local text = oxis.quote(rest)
  run(([[
$file = Join-Path $dir "$(Get-Date -Format 'yyyy-MM-dd').md"
if (!(Test-Path $file)) { Set-Content -Encoding UTF8 $file "# Notes - $(Get-Date -Format 'dddd, MMMM d yyyy')`n" }
$text = %s
if ($text) {
  Add-Content -Encoding UTF8 $file "- $(Get-Date -Format 'HH:mm') $text"
  Write-Host "Added to $file"
} else {
  Write-Host "Today's note: $file"
  Write-Host "Open it with: 'edit $file"
}
]]):format(text), ([[
file="$dir/$(date +%%F).md"
[ -f "$file" ] || printf '# Notes - %%s\n\n' "$(date '+%%A, %%B %%-d %%Y')" > "$file"
text=%s
if [ -n "$text" ]; then
  printf -- '- %%s %%s\n' "$(date +%%H:%%M)" "$text" >> "$file"
  echo "Added to $file"
else
  echo "Today's note: $file"
  echo "Open it with: 'edit $file"
fi
]]):format(text))
end, "add a line to today's note, or show where it is: 'note [text]")

oxis.command("notenew", function()
  run([[
$file = Join-Path $dir "$(Get-Date -Format 'yyyy-MM-dd-HHmmss').md"
Set-Content -Encoding UTF8 $file "# $(Get-Date -Format 'dddd, MMMM d yyyy HH:mm')`n"
Write-Host "Created $file"
Write-Host "Open it with: 'edit $file"
]], [[
file="$dir/$(date +%Y-%m-%d-%H%M%S).md"
printf '# %s\n\n' "$(date '+%A, %B %-d %Y %H:%M')" > "$file"
echo "Created $file"
echo "Open it with: 'edit $file"
]])
end, "start a new, separately named note")

oxis.command("notels", function()
  run([[
$notes = Get-ChildItem $dir -Filter '*.md' | Sort-Object LastWriteTime -Descending
if (!$notes) { Write-Host "No notes yet. 'note <text> starts one."; return }
$notes | Format-Table @{N='Modified';E={$_.LastWriteTime.ToString('yyyy-MM-dd HH:mm')}}, @{N='Size';E={"{0:N1} KB" -f ($_.Length / 1KB)}}, Name -AutoSize
]], [[
if ! ls "$dir"/*.md >/dev/null 2>&1; then echo "No notes yet. 'note <text> starts one."; exit 0; fi
ls -t "$dir"/*.md | while read -r f; do
  printf '%s  %6s  %s\n' "$(date -r "$f" '+%Y-%m-%d %H:%M')" "$(du -h "$f" | cut -f1)" "$(basename "$f")"
done
]])
end, "list notes, newest first")

oxis.command("notecat", function()
  run([[
$last = Get-ChildItem $dir -Filter '*.md' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($last) { Get-Content -Encoding UTF8 $last.FullName } else { Write-Host "No notes yet." }
]], [[
last=$(ls -t "$dir"/*.md 2>/dev/null | head -n 1)
if [ -n "$last" ]; then cat "$last"; else echo "No notes yet."; fi
]])
end, "print the most recently changed note")
