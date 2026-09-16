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
    "Yes possibly", "No you will not", "Ask again later", "Definitely",
    "Very doubtful", "Signs point to yes", "Cannot predict now", "Very likely",
  }
  oxis.echo("🎱 " .. answers[math.random(1, #answers)])
end, "ask the magic 8-ball a question")

oxis.command("guess", function(args)
    local guess = tonumber(args)

    if not guess then
        oxis.print("Usage: guess <number>", "err")
        oxis.print("Choose a number from 1 to 10.", "info")
        return
    end

    if guess < 1 or guess > 10 then
        oxis.print("Please choose a number from 1 to 10.", "err")
        return
    end

    oxis.run('powershell -NoProfile -Command "$target=Get-Random -Minimum 1 -Maximum 11; if (' .. guess .. ' -eq $target) { Write-Host ''You win! The number was ''$target''.'' } else { Write-Host ''You lose! The number was ''$target''.'' }"')
end, "guess a random number (1-10)")
```

So:

```text
guess
```

shows:

```text
✗ Usage: guess <number>
  Choose a number from 1 to 10.
```

While:

```text
guess 7
```

plays the game.

