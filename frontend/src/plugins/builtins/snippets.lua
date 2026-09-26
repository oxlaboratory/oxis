-- snippets.lua — save and reuse text snippets by name
-- Kept in ~/.oxis/snippets as <name>.txt.

local WIN = oxis.platform == "windows"

local PS_DIR = [[
$dir = Join-Path $HOME '.oxis\snippets'
New-Item -ItemType Directory -Force $dir | Out-Null
]]
local SH_DIR = [[
dir="$HOME/.oxis/snippets"
mkdir -p "$dir"
]]

local function run(ps, sh) oxis.run(WIN and (PS_DIR .. ps) or (SH_DIR .. sh)) end

-- The snippet name from the arguments, or nil (after saying why).
local function snippetName(rest, usage)
  if rest == "" then oxis.echo("usage: " .. usage); return nil end
  if not rest:match("^[%w._-]+$") then
    oxis.echo("Snippet names can use letters, digits, '.', '_' and '-'.")
    return nil
  end
  return rest
end

oxis.command("snipset", function(_, rest)
  local name = snippetName(rest, "'snipset <name>")
  if not name then return end
  run([[
$file = Join-Path $dir ']] .. name .. [[.txt'
Write-Host "Type or paste the snippet, then a line with only ### to finish:"
$lines = New-Object System.Collections.Generic.List[string]
while (($line = Read-Host) -ne '###') { $lines.Add($line) }
[IO.File]::WriteAllText($file, ($lines -join "`n") + "`n")
Write-Host "Saved snippet ']] .. name .. [['."
]], [[
file="$dir/]] .. name .. [[.txt"
echo "Type or paste the snippet, then a line with only ### to finish:"
: > "$file.part"
while IFS= read -r line && [ "$line" != "###" ]; do printf '%s\n' "$line" >> "$file.part"; done
mv "$file.part" "$file"
echo "Saved snippet ']] .. name .. [['."
]])
end, "save a snippet by typing or pasting it: 'snipset <name>")

oxis.command("snipget", function(_, rest)
  local name = snippetName(rest, "'snipget <name>")
  if not name then return end
  run([[
$file = Join-Path $dir ']] .. name .. [[.txt'
if (!(Test-Path $file)) { Write-Host "No snippet called ']] .. name .. [['. 'snipls lists them."; return }
$c = Get-Content -Raw -Encoding UTF8 $file
Set-Clipboard -Value $c
Write-Host $c
Write-Host "(copied to the clipboard)"
]], [[
file="$dir/]] .. name .. [[.txt"
if [ ! -f "$file" ]; then echo "No snippet called ']] .. name .. [['. 'snipls lists them."; exit 1; fi
cat "$file"
if [ -n "$WAYLAND_DISPLAY" ] && command -v wl-copy >/dev/null 2>&1; then wl-copy < "$file"
elif command -v xclip >/dev/null 2>&1; then xclip -selection clipboard < "$file"
elif command -v xsel >/dev/null 2>&1; then xsel -ib < "$file"
else exit 0; fi
echo "(copied to the clipboard)"
]])
end, "print a snippet and copy it to the clipboard: 'snipget <name>")

oxis.command("snipls", function()
  run([[
$s = Get-ChildItem $dir -Filter '*.txt' | Sort-Object Name
if (!$s) { Write-Host "No snippets yet. 'snipset <name> saves one."; return }
$s | Format-Table @{N='Name';E={$_.BaseName}}, @{N='Bytes';E={$_.Length}}, @{N='Modified';E={$_.LastWriteTime.ToString('yyyy-MM-dd')}} -AutoSize
]], [[
if ! ls "$dir"/*.txt >/dev/null 2>&1; then echo "No snippets yet. 'snipset <name> saves one."; exit 0; fi
for f in "$dir"/*.txt; do
  printf '%-24s %8s  %s\n' "$(basename "$f" .txt)" "$(wc -c < "$f")" "$(date -r "$f" +%F)"
done
]])
end, "list saved snippets")

oxis.command("sniprm", function(_, rest)
  local name = snippetName(rest, "'sniprm <name>")
  if not name then return end
  run([[
$file = Join-Path $dir ']] .. name .. [[.txt'
if (Test-Path $file) { Remove-Item $file; Write-Host "Deleted snippet ']] .. name .. [['." } else { Write-Host "No snippet called ']] .. name .. [['." }
]], [[
file="$dir/]] .. name .. [[.txt"
if [ -f "$file" ]; then rm "$file"; echo "Deleted snippet ']] .. name .. [['."; else echo "No snippet called ']] .. name .. [['."; fi
]])
end, "delete a saved snippet: 'sniprm <name>")
