-- todo.lua — project TODO tracker
-- Scans source files for TODO/FIXME/HACK/NOTE comments

oxis.command("todos", function()
  oxis.run([[
    $exts   = @("*.ts","*.tsx","*.js","*.jsx","*.go","*.py","*.rs","*.lua","*.cs","*.java")
    $tags   = @("TODO","FIXME","HACK","XXX","NOTE","BUG","WARN","PERF")
    $found  = 0
    $pattern = ($tags -join "|")
    $exts | ForEach-Object {
      Get-ChildItem -Recurse -Filter $_ -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -notmatch '\\node_modules\\|\\\.git\\|\\dist\\' } |
        ForEach-Object {
          $file = $_
          Select-String -Path $file.FullName -Pattern $pattern -ErrorAction SilentlyContinue |
            ForEach-Object {
              $tag  = ($_ | Select-String -Pattern $pattern).Matches[0].Value
              Write-Host "  [$tag] $($file.Name):$($_.LineNumber)  $($_.Line.Trim())"
              $found++
            }
        }
    }
    Write-Host ""
    Write-Host "  $found item(s) found."
  ]])
end, "scan source files for TODO/FIXME/HACK/NOTE comments")

oxis.command("fixmes", function()
  oxis.run([[
    Get-ChildItem -Recurse -Include *.ts,*.tsx,*.js,*.go,*.py -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -notmatch 'node_modules|\.git|dist' } |
      ForEach-Object {
        Select-String -Path $_.FullName -Pattern 'FIXME|BUG' -ErrorAction SilentlyContinue |
          ForEach-Object { Write-Host "  [FIXME] $($_.Filename):$($_.LineNumber)  $($_.Line.Trim())" }
      }
  ]])
end, "scan source files for FIXME/BUG comments")
