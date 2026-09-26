-- file_ops.lua — file tools for the current folder
-- node_modules and .git are skipped when searching.

local WIN = oxis.platform == "windows"

local function run(ps, sh) oxis.run(WIN and ps or sh) end

-- A script line setting `var` from the command's argument, or asking
-- for it when there isn't one.
local function ask(var, value, question)
  if value ~= "" then return (WIN and "$" or "") .. var .. "=" .. oxis.quote(value) end
  if WIN then return "$" .. var .. ' = Read-Host "' .. question .. '"' end
  return "read -r -p " .. oxis.quote(question .. ": ") .. " " .. var
end

oxis.command("fdup", function(_, rest)
  if rest == "" then oxis.echo("usage: 'fdup <file>"); return end
  run(ask("f", rest, "") .. [[

if (!(Test-Path -LiteralPath $f -PathType Leaf)) { Write-Host "No such file: $f"; return }
$item = Get-Item -LiteralPath $f
$new = Join-Path $item.DirectoryName ($item.BaseName + '_copy' + $item.Extension)
for ($i = 2; Test-Path -LiteralPath $new; $i++) { $new = Join-Path $item.DirectoryName ($item.BaseName + "_copy$i" + $item.Extension) }
Copy-Item -LiteralPath $f $new
Write-Host "Copied to $new"
]], ask("f", rest, "") .. [[

if [ ! -f "$f" ]; then echo "No such file: $f"; exit 1; fi
dir=$(dirname "$f"); name=$(basename "$f")
case "$name" in ?*.*) base=${name%.*}; ext=".${name##*.}" ;; *) base=$name; ext="" ;; esac
new="$dir/${base}_copy$ext"; i=2
while [ -e "$new" ]; do new="$dir/${base}_copy$i$ext"; i=$((i + 1)); done
cp -p "$f" "$new" && echo "Copied to $new"
]])
end, "copy a file next to itself as name_copy.ext: 'fdup <file>")

oxis.command("tree", function(args)
  local depth = math.floor(tonumber(args[1]) or 3)
  run([[
function Show-Tree([string]$Path, [string]$Indent, [int]$Depth) {
  if ($Depth -le 0) { return }
  $items = @(Get-ChildItem -LiteralPath $Path -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -notmatch '^(\.git|node_modules|\.venv|dist)$' })
  for ($i = 0; $i -lt $items.Count; $i++) {
    $item = $items[$i]; $last = $i -eq $items.Count - 1
    $name = if ($item.PSIsContainer) { $item.Name + '/' } else { $item.Name }
    Write-Host ($Indent + $(if ($last) { '└── ' } else { '├── ' }) + $name)
    if ($item.PSIsContainer) { Show-Tree $item.FullName ($Indent + $(if ($last) { '    ' } else { '│   ' })) ($Depth - 1) }
  }
}
Write-Host (Get-Location).Path
Show-Tree (Get-Location).Path '' ]] .. depth .. [[

]], [[
walk() {
  local dir=$1 prefix=$2 depth=$3 i=0 n e entries
  [ "$depth" -gt 0 ] || return 0
  mapfile -t entries < <(ls -A "$dir" 2>/dev/null | grep -vE '^(\.git|node_modules|\.venv|dist)$')
  n=${#entries[@]}
  for e in "${entries[@]}"; do
    i=$((i + 1))
    if [ "$i" -eq "$n" ]; then branch='└── '; next="$prefix    "; else branch='├── '; next="$prefix│   "; fi
    if [ -d "$dir/$e" ] && [ ! -L "$dir/$e" ]; then
      echo "$prefix$branch$e/"; walk "$dir/$e" "$next" $((depth - 1))
    else
      echo "$prefix$branch$e"
    fi
  done
}
pwd
walk . "" ]] .. depth .. [[

]])
end, "the folder tree from here (skips .git, node_modules, .venv, dist): 'tree [depth] (default 3)")

oxis.command("flatten", function(_, rest)
  run(ask("dest", rest, "Folder to copy into") .. [[

if (!$dest) { return }
New-Item -ItemType Directory -Force $dest | Out-Null
$destFull = (Resolve-Path -LiteralPath $dest).Path
$copied = 0; $skipped = 0
Get-ChildItem -Recurse -File -ErrorAction SilentlyContinue | Where-Object { !$_.FullName.StartsWith($destFull + '\') -and $_.FullName -notmatch '\\(node_modules|\.git)\\' } | ForEach-Object {
  $target = Join-Path $destFull $_.Name
  if (Test-Path -LiteralPath $target) { $skipped++ } else { Copy-Item -LiteralPath $_.FullName $target; $copied++ }
}
Write-Host "Copied $copied file(s) into $dest. Skipped $skipped whose name was already there."
]], ask("dest", rest, "Folder to copy into") .. [[

[ -n "$dest" ] || exit 0
mkdir -p "$dest"; destabs=$(cd "$dest" && pwd)
copied=0; skipped=0
while IFS= read -r -d '' f; do
  t="$destabs/$(basename "$f")"
  if [ -e "$t" ]; then skipped=$((skipped + 1)); else cp -p "$f" "$t"; copied=$((copied + 1)); fi
done < <(find "$PWD" \( -path "$destabs" -o -name node_modules -o -name .git \) -prune -o -type f -print0)
echo "Copied $copied file(s) into $dest. Skipped $skipped whose name was already there."
]])
end, "copy every file under this folder into one folder: 'flatten <folder>")

oxis.command("biggest", function(args)
  local n = math.floor(tonumber(args[1]) or 15)
  run([[Get-ChildItem -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.FullName -notmatch '\\(node_modules|\.git)\\' } | Sort-Object Length -Descending | Select-Object -First ]] .. n .. [[ @{N='MB';E={'{0:N2}' -f ($_.Length / 1MB)}}, @{N='File';E={Resolve-Path -Relative $_.FullName}} | Format-Table -AutoSize]],
      [[find . \( -name node_modules -o -name .git \) -prune -o -type f -printf '%s\t%P\n' 2>/dev/null | sort -rn | head -n ]] .. n .. [[ | awk -F'\t' '{ printf "%10.2f MB  %s\n", $1 / 1048576, $2 }']])
end, "the largest files under this folder: 'biggest [count] (default 15)")

oxis.command("dupes", function()
  run([[
Write-Host "Looking for files with identical content..."
$groups = @(Get-ChildItem -Recurse -File -ErrorAction SilentlyContinue |
  Where-Object { $_.Length -gt 0 -and $_.FullName -notmatch '\\(node_modules|\.git)\\' } |
  Group-Object Length | Where-Object Count -gt 1 | ForEach-Object { $_.Group } |
  Group-Object { (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash } | Where-Object Count -gt 1)
if (!$groups.Count) { Write-Host "No duplicates found."; return }
foreach ($g in $groups) {
  Write-Host ("  {0} copies, {1:N0} bytes each:" -f $g.Count, $g.Group[0].Length)
  $g.Group | ForEach-Object { Write-Host "    $(Resolve-Path -Relative $_.FullName)" }
}
]], [[
echo "Looking for files with identical content..."
find . \( -name node_modules -o -name .git \) -prune -o -type f -size +0 -print0 2>/dev/null |
  xargs -0 -r sha256sum | sort |
  awk '{ h = substr($0, 1, 64); f = substr($0, 67); sub(/^\.\//, "", f)
         if (h == prev) { if (!open) { print "  same content:"; print "    " pf; open = 1 } print "    " f; n++ }
         else open = 0
         prev = h; pf = f }
       END { if (!n) print "No duplicates found." }'
]])
end, "files under this folder with identical content")
