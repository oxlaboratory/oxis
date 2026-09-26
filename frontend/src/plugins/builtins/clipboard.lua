-- clipboard.lua — look at and fill the system clipboard from the shell
-- Linux needs wl-clipboard (Wayland), xclip or xsel.

local WIN = oxis.platform == "windows"

-- Defines clip_read / clip_write for whichever clipboard tool exists.
local SH_TOOLS = [[
if [ -n "$WAYLAND_DISPLAY" ] && command -v wl-paste >/dev/null 2>&1; then
  clip_read() { wl-paste -n 2>/dev/null; }; clip_write() { wl-copy; }
elif command -v xclip >/dev/null 2>&1; then
  clip_read() { xclip -o -selection clipboard 2>/dev/null; }; clip_write() { xclip -selection clipboard; }
elif command -v xsel >/dev/null 2>&1; then
  clip_read() { xsel -ob; }; clip_write() { xsel -ib; }
else
  echo "No clipboard tool found. Install wl-clipboard, xclip or xsel."; exit 1
fi
]]

local function run(ps, sh) oxis.run(WIN and ps or (SH_TOOLS .. sh)) end

oxis.command("clip", function()
  run([[
$c = Get-Clipboard -Raw
if ([string]::IsNullOrEmpty($c)) { Write-Host "The clipboard is empty."; return }
Write-Host "--- clipboard ---"
Write-Host $c
Write-Host "--- $($c.Length) chars ---"
]], [[
c=$(clip_read)
if [ -z "$c" ]; then echo "The clipboard is empty."; exit 0; fi
echo "--- clipboard ---"
printf '%s\n' "$c"
echo "--- ${#c} chars ---"
]])
end, "show the clipboard's text")

oxis.command("clipclear", function()
  run([[
try { Set-Clipboard -Value $null -ErrorAction Stop } catch { cmd /c "echo off | clip" }
Write-Host "Clipboard cleared."
]], [[
printf '' | clip_write
echo "Clipboard cleared."
]])
end, "empty the clipboard")

oxis.command("cliphex", function()
  run([[
$c = Get-Clipboard -Raw
if ([string]::IsNullOrEmpty($c)) { Write-Host "The clipboard is empty."; return }
([Text.Encoding]::UTF8.GetBytes($c) | ForEach-Object { $_.ToString('X2') }) -join ' '
]], [[
clip_read | od -An -tx1 -v | tr -s ' \n' ' '
echo
]])
end, "the clipboard's text as UTF-8 bytes in hex")

oxis.command("clipfile", function(_, rest)
  if rest == "" then oxis.echo("usage: 'clipfile <file>"); return end
  local f = oxis.quote(rest)
  run(([[
$f = %s
if (!(Test-Path -LiteralPath $f -PathType Leaf)) { Write-Host "No such file: $f"; return }
$c = Get-Content -LiteralPath $f -Raw
Set-Clipboard -Value $c
Write-Host "Copied $($c.Length) chars from $f."
]]):format(f), ([[
f=%s
if [ ! -f "$f" ]; then echo "No such file: $f"; exit 1; fi
clip_write < "$f"
echo "Copied $(wc -c < "$f") bytes from $f."
]]):format(f))
end, "copy a file's contents to the clipboard: 'clipfile <file>")
