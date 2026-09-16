-- utility.lua — small everyday conveniences

oxis.command("timestamp", function()
  oxis.run("[DateTimeOffset]::UtcNow.ToUnixTimeSeconds() | Set-Clipboard; Write-Host 'Unix timestamp copied.'")
end, "copy the current Unix timestamp to the clipboard")

oxis.command("now", function() oxis.run("Get-Date") end, "show the current date and time")

oxis.command("clipclear", function() oxis.run("Set-Clipboard -Value ''; Write-Host 'Clipboard cleared.'") end, "clear the clipboard")

-- Asks for the expression directly instead of trusting whatever's on
-- the clipboard, and only allows numbers/operators — not a general eval
oxis.command("calc", function()
  oxis.run([[
    $expr = Read-Host "Expression (numbers and + - * / ( ) only)"
    if ($expr -match '^[0-9\.\+\-\*/\(\)\s]+$') { Invoke-Expression $expr }
    else { Write-Host "Only numbers and + - * / ( ) allowed." }
  ]])
end, "evaluate a numbers-and-operators-only expression you type in")

oxis.command("wordcount", function()
  oxis.run("(Get-Clipboard) -split '\\s+' | Measure-Object | Select-Object Count")
end, "count words in the clipboard contents")

oxis.keymap("normal", "<C-A-c>", function() oxis.run("Set-Clipboard -Value ''") end)
