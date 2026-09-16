-- games.lua — a few tiny terminal games

oxis.command("roll", function()
  oxis.echo("🎲 You rolled a " .. math.random(1, 6))
end, "roll a six-sided die")

oxis.command("roll20", function()
  oxis.echo("🎲 d20 -> " .. math.random(1, 20))
end, "roll a twenty-sided die")

oxis.command("coinflip", function()
  oxis.echo("🪙 " .. (math.random(0, 1) == 0 and "heads" or "tails"))
end, "flip a coin")

oxis.command("8ball", function()
  local answers = {
    "Yes.", "No.", "Ask again later.", "Definitely.",
    "Very doubtful.", "Signs point to yes.", "Cannot predict now.",
  }
  oxis.echo("🎱 " .. answers[math.random(1, #answers)])
end, "ask the magic 8-ball a question")

-- Real interactive guessing game, using Read-Host in a loop
oxis.command("guess", function()
  oxis.run([[
    $target = Get-Random -Minimum 1 -Maximum 11
    Write-Host "I'm thinking of a number between 1 and 10."
    while ($true) {
      $g = Read-Host "Your guess"
      if ($g -eq $target) { Write-Host "Correct! It was $target."; break }
      elseif ([int]$g -lt $target) { Write-Host "Too low." }
      else { Write-Host "Too high." }
    }
  ]])
end, "play a number-guessing game (1-10)")
