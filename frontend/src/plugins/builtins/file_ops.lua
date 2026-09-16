-- file_ops.lua — advanced file operations

oxis.command("dup", function()
  oxis.run([[
    $f = Read-Host "File to duplicate"
    $ext  = [System.IO.Path]::GetExtension($f)
    $base = [System.IO.Path]::GetFileNameWithoutExtension($f)
    $new  = "${base}_copy${ext}"
    Copy-Item $f $new
    Write-Host "Duplicated: $f → $new"
  ]])
end, "duplicate a file alongside itself")

oxis.command("tree", function()
  oxis.run([[
    function Show-Tree($path, $indent="") {
      $items = Get-ChildItem $path -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -notmatch '^\.(git|node_modules|venv)$' }
      foreach ($item in $items) {
        $prefix = if ($item -eq $items[-1]) { "└── " } else { "├── " }
        Write-Host "$indent$prefix$($item.Name)$(if($item.PSIsContainer){'/'})"
        if ($item.PSIsContainer) { Show-Tree $item.FullName "$indent$(if($item -eq $items[-1]){'    '}else{'│   '})" }
      }
    }
    Write-Host (Get-Location).Path
    Show-Tree (Get-Location).Path
  ]])
end, "print a directory tree from the current folder")

oxis.command("flatten", function()
  oxis.run([[
    $dest = Read-Host "Destination folder"
    New-Item -ItemType Directory $dest -Force | Out-Null
    $count = 0
    Get-ChildItem -Recurse -File -ErrorAction SilentlyContinue |
      Where-Object { $_.DirectoryName -ne (Resolve-Path $dest).Path } |
      ForEach-Object {
        $target = Join-Path $dest $_.Name
        if (!(Test-Path $target)) { Copy-Item $_.FullName $target; $count++ }
      }
    Write-Host "Flattened $count files into $dest"
  ]])
end, "copy every file in a tree into one flat folder")

oxis.command("biggest", function()
  oxis.run([[
    Get-ChildItem -Recurse -File -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -notmatch 'node_modules|\.git' } |
      Sort-Object Length -Descending |
      Select-Object -First 15 @{N='Size(MB)';E={[math]::Round($_.Length/1MB,2)}},FullName |
      Format-Table -AutoSize
  ]])
end, "list the 15 largest files under the current folder")

oxis.command("dupes", function()
  oxis.run([[
    Write-Host "Scanning for duplicate files (by hash)..."
    Get-ChildItem -Recurse -File -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -notmatch 'node_modules|\.git' } |
      Group-Object { (Get-FileHash $_.FullName -EA SilentlyContinue).Hash } |
      Where-Object { $_.Count -gt 1 } |
      ForEach-Object {
        Write-Host "  DUPLICATE ($($_.Count) copies):"
        $_.Group | ForEach-Object { Write-Host "    $($_.FullName)" }
      }
  ]])
end, "find duplicate files by content hash")
