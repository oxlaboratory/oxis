--[[@manifest
version: 2.1.0
description: Casino night in your terminal — a pokie machine, blackjack, dice you call before they land, coin tosses, guess-the-number and hangman. One chip bank across every game, kept between runs. Answer in the prompt; Ctrl+C walks away from any table.
author: Oxide Labs
category: games
min_oxis_version: 1.2.1
os: windows, unix
permissions:
]]

-- games.lua — every game talks through oxis.ask: the game asks, your
-- next line is the answer ("yes 5", "h", "bet 50"), and Ctrl+C leaves
-- the table. Chips live in oxis.store, shared by all the games.
--
--   'pokies [bet]        5-reel pokie machine, 9 paylines, wilds, free spins
--   'pokies auto <n>     spin n times by itself (Ctrl+C stops)
--   'blackjack [bet]     6-deck shoe, dealer stands on soft 17, 3:2 blackjack,
--                        double down, split pairs
--   'roll <1-6> [bet]    call the die before it lands (pays 5:1);
--   'roll d20 <n> [bet]  or a d20 (pays 19:1)
--   'coinflip [h|t] [bet]
--   'guess               1-100 in seven tries, higher or lower
--   'hangman             developer words, six lives
--   'chips               your bank and your record; 'chips reset

math.randomseed(os.time() + math.floor((os.clock() or 0) * 1000))

local START_CHIPS = 500

-- ── shared bank ─────────────────────────────────────────────

local function store(key, default)
  local v = oxis.store and oxis.store.get(key)
  if v == nil then return default end
  return v
end
local function save(key, v) if oxis.store then oxis.store.set(key, v) end end

local function chips() return math.floor(store("chips", START_CHIPS)) end
local function setChips(n) save("chips", math.floor(n)) end

local function stats() return store("stats", {}) end
local function record(game, net)
  local s = stats()
  local g = s[game] or { played = 0, won = 0, net = 0 }
  g.played = g.played + 1
  if net > 0 then g.won = g.won + 1 end
  g.net = g.net + net
  s[game] = g
  local peak = store("peak", START_CHIPS)
  if chips() > peak then save("peak", chips()) end
  save("stats", s)
end

local function fmt(n)
  local s = tostring(math.floor(n))
  local out = s:reverse():gsub("(%d%d%d)", "%1,"):reverse()
  return (out:gsub("^,", ""):gsub("^%-,", "-"))
end

-- Broke? The house spots you a hundred.
local function topUp()
  if chips() < 5 then
    setChips(100)
    oxis.echo("💸 You're out of chips — the house spots you 100. Good luck.", "warn")
  end
end

-- A bet from what was typed: a number, "all", or the game's default.
local function parseBet(word, default)
  local have = chips()
  if word == nil or word == "" then return math.min(default, have) end
  if word == "all" or word == "max" then return have end
  local n = tonumber(word)
  if not n or n < 1 then return nil, "a bet is a number of chips (or all)" end
  n = math.floor(n)
  if n > have then return nil, "you only have " .. fmt(have) .. " chips" end
  return n
end

local function needsAsk()
  if oxis.ask then return false end
  oxis.echo("games needs a newer OXIS build for its questions — run 'update install", "warn")
  return true
end

local function words(s)
  local t = {}
  for w in tostring(s or ""):lower():gmatch("%S+") do t[#t + 1] = w end
  return t
end

local function yes(w) return w == "y" or w == "yes" or w == "yeah" or w == "again" or w == "sure" end
local function no(w) return w == "n" or w == "no" or w == "nope" or w == "quit" or w == "q" or w == "stop" end

-- ── animation ───────────────────────────────────────────────
-- animate(frames, seconds, onFrame(i), onDone(interrupted)): a frame
-- every `seconds` (oxis.every), drawn into oxis.line lines. Ctrl+C ends
-- it at once with interrupted = true, and the game shows the result and
-- leaves the table. Builds without oxis.line skip straight to onDone.
local canAnimate = oxis.line ~= nil and oxis.every ~= nil
local function animate(frames, seconds, onFrame, onDone)
  if not canAnimate then onDone(false) return end
  local i, completed = 0, false
  local h
  h = oxis.every(seconds, function()
    i = i + 1
    onFrame(i)
    if i >= frames then completed = true h:stop() end
  end, { foreground = true, stop = function() onDone(not completed) end })
end

-- A line to draw frames into, or a stand-in that prints only its last
-- text on builds without oxis.line.
local function liveLine(text, kind)
  if canAnimate then return oxis.line(text, kind) end
  local last, lastKind = text, kind
  return {
    set = function(_, t, k) last, lastKind = t, k or lastKind end,
    flush = function() oxis.echo(last, lastKind) end,
  }
end
local function flush(l) if l.flush then l:flush() end end

-- ── dice ────────────────────────────────────────────────────

local FACES = { "⚀", "⚁", "⚂", "⚃", "⚄", "⚅" }
local function faceOf(sides, n) return sides == 6 and FACES[n] or ("d" .. sides .. ":" .. n) end

local dice
local function diceResult(sides, guess, bet, rolled, rollLine, interrupted)
  local face = faceOf(sides, rolled)
  rollLine:set(("🎲 %s  landed on %d"):format(face, rolled), rolled == guess and "ok" or "err")
  flush(rollLine)
  local streak = store("diceStreak", 0)
  if rolled == guess then
    local win = bet * (sides - 1) + bet
    setChips(chips() + win)
    streak = streak + 1
    save("diceStreak", streak)
    if streak > store("diceBest", 0) then save("diceBest", streak) end
    oxis.echo(("🎲 %s Correct — you rolled %d! +%s chips (bank %s)%s"):format(face, rolled, fmt(win - bet), fmt(chips()),
      streak > 1 and ("  🔥 " .. streak .. " in a row") or ""), "ok")
    record("dice", win - bet)
  else
    save("diceStreak", 0)
    oxis.echo(("🎲 %s Sorry, you lose — rolled %d, you called %d. −%s chips (bank %s)"):format(face, rolled, guess, fmt(bet), fmt(chips())), "err")
    record("dice", -bet)
  end
  if interrupted then oxis.echo("🎲 Walked away. Bank: " .. fmt(chips()), "dim") return end
  oxis.ask("Roll again? (yes [number] [bet] · no)", function(answer)
    local w = words(answer)
    if #w == 0 or yes(w[1]) or tonumber(w[1]) then
      local i = tonumber(w[1]) and 1 or 2
      local g = tonumber(w[i]) or guess
      if g < 1 or g > sides or g ~= math.floor(g) then
        oxis.echo("pick a whole number from 1 to " .. sides, "warn")
        g = guess
      end
      local b, err = parseBet(w[i + 1], bet)
      if not b then oxis.echo(err, "warn") b = math.min(bet, chips()) end
      dice(sides, g, b)
    else
      oxis.echo("🎲 Thanks for playing. Bank: " .. fmt(chips()) .. " chips", "dim")
    end
  end, { label = "dice" })
end

-- The die tumbles, slowing down, then lands.
dice = function(sides, guess, bet)
  topUp()
  if bet > chips() then bet = chips() end
  setChips(chips() - bet)
  local rolled = math.random(1, sides)
  local line = liveLine(("🎲 rolling for a %d…"):format(guess), "accent")
  local shown = 1
  -- Frames where the face changes, further apart as it slows.
  local changes = { [1]=1, [2]=1, [3]=1, [4]=1, [5]=1, [7]=1, [9]=1, [12]=1, [15]=1, [19]=1 }
  animate(22, 0.05, function(i)
    if changes[i] then
      local n = math.random(1, sides)
      if n == shown then n = n % sides + 1 end
      shown = n
      line:set(("🎲 %s  %s"):format(faceOf(sides, n), ("·"):rep(1 + i % 4)), "accent")
    end
  end, function(interrupted) diceResult(sides, guess, bet, rolled, line, interrupted) end)
end

oxis.command("roll", function(args)
  if needsAsk() then return end
  local a = {}
  for _, v in ipairs(args) do a[#a + 1] = v:lower() end
  local sides = 6
  if a[1] and a[1]:match("^d%d+$") then
    sides = tonumber(a[1]:sub(2))
    table.remove(a, 1)
    if sides < 2 or sides > 100 then oxis.echo("dice have 2 to 100 sides", "warn") return end
  end
  local guess = tonumber(a[1])
  if not guess then
    oxis.echo(("Call it before it lands: 'roll <1-%d> [bet]   (pays %d:1)"):format(sides, sides - 1), "dim")
    return
  end
  if guess < 1 or guess > sides or guess ~= math.floor(guess) then
    oxis.echo("pick a whole number from 1 to " .. sides, "warn")
    return
  end
  local bet, err = parseBet(a[2], 10)
  if not bet then oxis.echo(err, "warn") return end
  dice(sides, guess, bet)
end, "call a die roll before it lands — 'roll 4 [bet], 'roll d20 13; answer the rematch in the prompt")

-- ── coin flip ───────────────────────────────────────────────

-- The coin spins edge-on and face-up, rising and falling, and slows to
-- a stop on one side.
local COIN = { "( H )", "( ◖ )", "(  | )", "( ◗ )", "( T )", "( ◖ )", "( |  )", "( ◗ )" }
local HEIGHT = { 0, 1, 2, 3, 4, 4, 5, 5, 5, 4, 4, 3, 2, 1, 0 }

local flip
local function flipResult(call, bet, side, coinLine, interrupted)
  coinLine:set(("🪙 %s  %s"):format(side == "heads" and "( H )" or "( T )", side:upper()), call == side and "ok" or "err")
  flush(coinLine)
  if call == side then
    setChips(chips() + bet)
    oxis.echo(("🪙 %s — you called it. +%s (bank %s)"):format(side, fmt(bet), fmt(chips())), "ok")
    record("coinflip", bet)
  else
    setChips(chips() - bet)
    oxis.echo(("🪙 %s — not your toss. −%s (bank %s)"):format(side, fmt(bet), fmt(chips())), "err")
    record("coinflip", -bet)
  end
  if interrupted then oxis.echo("🪙 Walked away. Bank: " .. fmt(chips()), "dim") return end
  oxis.ask("Again? (heads/tails [bet] · no)", function(answer)
    local w = words(answer)
    local c = w[1]
    if c == "h" or c == "heads" then c = "heads" elseif c == "t" or c == "tails" then c = "tails"
    elseif #w == 0 or yes(c) then c = call else oxis.echo("🪙 Bank: " .. fmt(chips()), "dim") return end
    local b, err = parseBet(w[2], bet)
    if not b then oxis.echo(err, "warn") b = math.min(bet, chips()) end
    flip(c, b)
  end, { label = "coin" })
end

flip = function(call, bet)
  topUp()
  if bet > chips() then bet = chips() end
  local side = math.random(0, 1) == 0 and "heads" or "tails"
  local line = liveLine(("🪙 you call %s — tossing…"):format(call), "accent")
  local face = 0
  -- Every frame while it's in the air, then less and less often as it settles.
  local slow = { [16]=1, [18]=1, [21]=1, [24]=1 }
  animate(26, 0.06, function(i)
    if i <= #HEIGHT or slow[i] then face = face % #COIN + 1 end
    local h = HEIGHT[i] or 0
    line:set(("🪙 %s%s%s"):format((" "):rep(h * 2), COIN[face], h > 0 and ("  " .. ("˙"):rep(h)) or ""), "accent")
  end, function(interrupted) flipResult(call, bet, side, line, interrupted) end)
end

oxis.command("coinflip", function(args)
  if needsAsk() then return end
  local c = (args[1] or "heads"):lower()
  if c == "h" then c = "heads" elseif c == "t" then c = "tails" end
  if c ~= "heads" and c ~= "tails" then oxis.echo("'coinflip heads|tails [bet]", "warn") return end
  local bet, err = parseBet(args[2], 10)
  if not bet then oxis.echo(err, "warn") return end
  flip(c, bet)
end, "call heads or tails for chips — 'coinflip tails 50")

-- ── pokies ──────────────────────────────────────────────────
-- Five reels, three rows, nine paylines. 🃏 is wild (stands in for any
-- symbol but ⭐); three or more ⭐ anywhere pay a scatter and ten free
-- spins. Weighted reels, so the big symbols are rare: about 94% comes
-- back over time, a win on a third of spins, free spins 1 in ~180.

local SYMBOLS = {
  { s = "🍒", w = 18, pay = { [3] = 6,   [4] = 18,  [5] = 45 } },
  { s = "🍋", w = 16, pay = { [3] = 9,   [4] = 22,  [5] = 65 } },
  { s = "🍊", w = 14, pay = { [3] = 10,  [4] = 30,  [5] = 80 } },
  { s = "🍇", w = 11, pay = { [3] = 15,  [4] = 45,  [5] = 120 } },
  { s = "🔔", w = 8,  pay = { [3] = 25,  [4] = 75,  [5] = 250 } },
  { s = "💎", w = 5,  pay = { [3] = 50,  [4] = 150, [5] = 600 } },
  { s = "7️⃣", w = 3,  pay = { [3] = 100, [4] = 400, [5] = 2000 } },
  { s = "🃏", w = 3,  wild = true },
  { s = "⭐", w = 2,  scatter = true },
}
local TOTAL_W = 0
for _, sym in ipairs(SYMBOLS) do TOTAL_W = TOTAL_W + sym.w end

local function spinSymbol()
  local r = math.random() * TOTAL_W
  for _, sym in ipairs(SYMBOLS) do
    r = r - sym.w
    if r <= 0 then return sym end
  end
  return SYMBOLS[1]
end

-- Rows of each payline, left to right (1 top, 2 middle, 3 bottom).
local LINES = {
  { 2, 2, 2, 2, 2 }, { 1, 1, 1, 1, 1 }, { 3, 3, 3, 3, 3 },
  { 1, 2, 3, 2, 1 }, { 3, 2, 1, 2, 3 }, { 1, 1, 2, 3, 3 },
  { 3, 3, 2, 1, 1 }, { 2, 1, 2, 3, 2 }, { 2, 3, 2, 1, 2 },
}

local function lineWin(grid, line, betPerLine)
  -- The line's symbol is the first that isn't wild; a scatter ends it.
  local first
  for reel = 1, 5 do
    local sym = grid[reel][line[reel]]
    if sym.scatter then
      if reel == 1 then return 0 end
      break
    end
    if not sym.wild then first = sym break end
  end
  if not first then first = SYMBOLS[7] end -- wilds up to a scatter pay as sevens
  local count = 0
  for reel = 1, 5 do
    local sym = grid[reel][line[reel]]
    if sym == first or sym.wild then count = count + 1 else break end
  end
  local mult = first.pay and first.pay[count]
  if mult then return mult * betPerLine, count, first.s end
  return 0
end

local freeSpins = 0

local function rowText(grid, row, stopped)
  local cells = {}
  for reel = 1, 5 do
    cells[reel] = reel <= stopped and grid[reel][row].s or spinSymbol().s
  end
  return "┃  " .. table.concat(cells, "  ")
end

-- Open on the right: emoji are drawn narrower than two columns in some
-- fonts, so a closing edge wouldn't line up.
local FRAME = { plain = "┏━━━ 🎰 ━━━━━━━━━━━━━━", free = "┏━━━ 🎰 free spin ━━━━━",
  win = "┏━━━ ✨ WIN ✨ ━━━━━━━━", big1 = "┏━━━ 💰 BIG WIN 💰 ━━━━", big2 = "┏━━━ 💰 B I G  W I N 💰 " }
local BOTTOM = "┗━━━━━━━━━━━━━━━━━━━━━━"

-- Spins (paid for at once), draws the reels stopping left to right,
-- then shows the win, counting it up; done(interrupted) after.
local function pokieSpin(bet, done)
  topUp()
  local free = freeSpins > 0
  if free then freeSpins = freeSpins - 1
  else
    if bet > chips() then bet = chips() end
    setChips(chips() - bet)
  end
  local grid = {}
  local scatters = 0
  for reel = 1, 5 do
    grid[reel] = {}
    for row = 1, 3 do
      grid[reel][row] = spinSymbol()
      if grid[reel][row].scatter then scatters = scatters + 1 end
    end
  end
  local perLine = bet / #LINES
  local total, wins = 0, {}
  for i, line in ipairs(LINES) do
    local amount, count, sym = lineWin(grid, line, perLine)
    if amount > 0 then
      total = total + amount
      wins[#wins + 1] = ("line %d: %d× %s"):format(i, count, sym)
    end
  end
  if scatters >= 3 then
    total = total + bet * ({ [3] = 2, [4] = 10, [5] = 50 })[math.min(scatters, 5)]
    freeSpins = freeSpins + 10
    wins[#wins + 1] = scatters .. "× ⭐ — 10 free spins!"
  end
  total = math.floor(total + 0.5)
  setChips(chips() + total)
  record("pokies", total - (free and 0 or bet))

  local top = liveLine(free and FRAME.free or FRAME.plain, "dim")
  local rows = {}
  for row = 1, 3 do rows[row] = liveLine(rowText(grid, row, 0), row == 2 and "accent" or "info") end
  local bottom = liveLine(BOTTOM, "dim")

  local function summary(interrupted)
    oxis.echo(("Bank %s chips%s"):format(fmt(chips()), freeSpins > 0 and ("  ·  " .. freeSpins .. " free spins left") or ""), "dim")
    if done then done(interrupted) end
  end
  local function showWin(interrupted)
    for row = 1, 3 do rows[row]:set(rowText(grid, row, 5)) end
    if total > 0 then top:set(FRAME.win, "ok") end
    flush(top) for row = 1, 3 do flush(rows[row]) end flush(bottom)
    if total <= 0 then
      oxis.echo(free and "No luck on that free spin." or ("No win. −" .. fmt(bet)), "dim")
      return summary(interrupted)
    end
    local big = total >= bet * 20
    local head = big and "💰 BIG WIN!" or "✨ Win —"
    local tail = table.concat(wins, " · ")
    local winLine = liveLine(("%s %s  +0"):format(head, tail), "ok")
    local function final()
      winLine:set(("%s %s  +%s chips%s"):format(head, tail, fmt(total), free and " (free spin)" or ""))
      flush(winLine)
      if big then top:set(FRAME.big1, "ok") end
    end
    if interrupted then final() return summary(true) end
    -- The win counts up; a big one takes longer, and the frame flashes.
    local steps = big and 24 or 10
    animate(steps, 0.05, function(i)
      winLine:set(("%s %s  +%s"):format(head, tail, fmt(total * i / steps)))
      if big then top:set(i % 2 == 0 and FRAME.big1 or FRAME.big2, i % 2 == 0 and "ok" or "warn") end
    end, function(intr) final() summary(intr) end)
  end

  -- Each reel spins a little longer than the one before it.
  local STOP = { 6, 9, 12, 15, 18 }
  animate(STOP[5], 0.06, function(i)
    local stopped = 0
    for reel = 1, 5 do if i >= STOP[reel] then stopped = reel end end
    for row = 1, 3 do rows[row]:set(rowText(grid, row, stopped)) end
  end, showWin)
  return bet
end

local function pokieAsk(bet)
  oxis.ask(("Spin? (Enter spins %s · bet <n> · auto <n> · paytable · no)"):format(fmt(bet)), function(answer)
    local w = words(answer)
    if #w == 0 or yes(w[1]) or w[1] == "spin" then
      return pokieSpin(bet, function(interrupted)
        if interrupted then return oxis.echo("🎰 Cashed out with " .. fmt(chips()) .. " chips.", "dim") end
        pokieAsk(math.min(bet, math.max(chips(), 1)))
      end)
    end
    if w[1] == "bet" then
      local b, err = parseBet(w[2], bet)
      if not b then oxis.echo(err, "warn") return pokieAsk(bet) end
      return pokieSpin(b, function(interrupted)
        if interrupted then return oxis.echo("🎰 Cashed out with " .. fmt(chips()) .. " chips.", "dim") end
        pokieAsk(b)
      end)
    end
    if w[1] == "auto" then return oxis.echo("type 'pokies auto " .. (w[2] or "10") .. " to spin by itself", "dim") end
    if w[1] == "paytable" or w[1] == "pays" then
      oxis.echo("Pays per line bet — 3 / 4 / 5 of a kind:", "accent")
      for _, sym in ipairs(SYMBOLS) do
        if sym.pay then oxis.echo(("  %s   %d / %d / %d"):format(sym.s, sym.pay[3], sym.pay[4], sym.pay[5])) end
      end
      oxis.echo("  🃏   wild — counts as any symbol but ⭐", "dim")
      oxis.echo("  ⭐   scatter — 3+ anywhere: 2× / 10× / 50× your bet and 10 free spins", "dim")
      return pokieAsk(bet)
    end
    oxis.echo("🎰 Cashed out with " .. fmt(chips()) .. " chips.", "dim")
  end, { label = "pokies" })
end

oxis.command("pokies", function(args)
  if needsAsk() then return end
  if (args[1] or ""):lower() == "auto" then
    local n = math.min(tonumber(args[2] or "10") or 10, 200)
    local bet = parseBet(args[3], 9) or 9
    local left = n
    oxis.echo(("🎰 Auto-spinning %d times at %s a spin — Ctrl+C stops."):format(n, fmt(bet)), "accent")
    local function over() oxis.echo("🎰 Auto-spin over. Bank: " .. fmt(chips()), "dim") end
    local nextSpin
    nextSpin = function()
      if left <= 0 or (chips() <= 0 and freeSpins == 0) then return over() end
      left = left - 1
      pokieSpin(bet, function(interrupted)
        if interrupted then return over() end
        -- A short pause between spins (Ctrl+C stops here too).
        animate(8, 0.05, function() end, function(intr) if intr then over() else nextSpin() end end)
      end)
    end
    nextSpin()
    return
  end
  local bet, err = parseBet(args[1], 9)
  if not bet then oxis.echo(err, "warn") return end
  oxis.echo("🎰 Five reels, nine lines. 🃏 is wild, three ⭐ pay ten free spins.", "accent")
  pokieSpin(bet, function(interrupted)
    if interrupted then return oxis.echo("🎰 Cashed out with " .. fmt(chips()) .. " chips.", "dim") end
    pokieAsk(bet)
  end)
end, "a 5-reel pokie machine: 9 paylines, wilds, scatters and free spins — 'pokies [bet], 'pokies auto <n>")

-- ── blackjack ───────────────────────────────────────────────

local SUITS = { "♠", "♥", "♦", "♣" }
local RANKS = { "A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K" }
local shoe = {}

local function newShoe()
  shoe = {}
  for _ = 1, 6 do
    for _, s in ipairs(SUITS) do
      for _, r in ipairs(RANKS) do shoe[#shoe + 1] = { r = r, s = s } end
    end
  end
  for i = #shoe, 2, -1 do
    local j = math.random(1, i)
    shoe[i], shoe[j] = shoe[j], shoe[i]
  end
  oxis.echo("🂠 The dealer shuffles a fresh six-deck shoe.", "dim")
end

local function draw()
  if #shoe < 52 then newShoe() end
  return table.remove(shoe)
end

local function value(hand)
  local total, aces = 0, 0
  for _, c in ipairs(hand) do
    if c.r == "A" then total = total + 11 aces = aces + 1
    elseif c.r == "K" or c.r == "Q" or c.r == "J" then total = total + 10
    else total = total + tonumber(c.r) end
  end
  while total > 21 and aces > 0 do total = total - 10 aces = aces - 1 end
  return total, aces > 0
end

local function show(hand, hideSecond)
  local parts = {}
  for i, c in ipairs(hand) do
    parts[i] = (hideSecond and i == 2) and "🂠" or (c.r .. c.s)
  end
  return table.concat(parts, " ")
end

local function isBlackjack(hand) return #hand == 2 and value(hand) == 21 end

local function playBlackjack(bet)
  topUp()
  if bet > chips() then bet = chips() end
  setChips(chips() - bet)
  local dealer = { draw(), draw() }
  local hands = { { cards = { draw(), draw() }, bet = bet, done = false } }
  local current = 1

  local function line(prefix, cards, extra)
    local v = value(cards)
    oxis.echo(("%s %s  (%d)%s"):format(prefix, show(cards), v, extra or ""))
  end

  local function finish()
    oxis.echo(("Dealer: %s  (%d)"):format(show(dealer), value(dealer)), "accent")
    local anyLive = false
    for _, h in ipairs(hands) do if value(h.cards) <= 21 then anyLive = true end end
    if anyLive and not (isBlackjack(hands[1].cards) and #hands == 1) then
      while true do
        -- The dealer stands on every 17, soft ones included.
        if value(dealer) < 17 then
          dealer[#dealer + 1] = draw()
          oxis.echo(("Dealer draws %s — %d"):format(dealer[#dealer].r .. dealer[#dealer].s, value(dealer)), "dim")
        else break end
      end
    end
    local dv = value(dealer)
    local net = 0
    for i, h in ipairs(hands) do
      local pv = value(h.cards)
      local name = #hands > 1 and ("Hand " .. i .. ": ") or ""
      if pv > 21 then
        oxis.echo(name .. "bust — the house takes " .. fmt(h.bet), "err")
        net = net - h.bet
      elseif isBlackjack(h.cards) and #hands == 1 and not isBlackjack(dealer) then
        local win = math.floor(h.bet * 1.5)
        setChips(chips() + h.bet + win)
        oxis.echo(name .. "♠ BLACKJACK! Pays 3:2 — +" .. fmt(win), "ok")
        net = net + win
      elseif dv > 21 or pv > dv then
        setChips(chips() + h.bet * 2)
        oxis.echo(name .. (dv > 21 and "dealer busts — " or "you win — ") .. "+" .. fmt(h.bet), "ok")
        net = net + h.bet
      elseif pv == dv then
        setChips(chips() + h.bet)
        oxis.echo(name .. "push — your " .. fmt(h.bet) .. " comes back", "dim")
      else
        oxis.echo(name .. "dealer wins with " .. dv .. " — −" .. fmt(h.bet), "err")
        net = net - h.bet
      end
    end
    record("blackjack", net)
    oxis.echo("Bank " .. fmt(chips()) .. " chips", "dim")
    oxis.ask("Another hand? (yes [bet] · no)", function(answer)
      local w = words(answer)
      if #w == 0 or yes(w[1]) or tonumber(w[1]) then
        local b, err = parseBet(tonumber(w[1]) and w[1] or w[2], bet)
        if not b then oxis.echo(err, "warn") b = math.min(bet, chips()) end
        playBlackjack(b)
      else
        oxis.echo("🂡 You leave the table with " .. fmt(chips()) .. " chips.", "dim")
      end
    end, { label = "blackjack" })
  end

  local function nextHand()
    while hands[current] and hands[current].done do current = current + 1 end
    if not hands[current] then return finish() end
    local h = hands[current]
    local v = value(h.cards)
    if v >= 21 then h.done = true return nextHand() end
    local opts = { "(h)it", "(s)tand" }
    if #h.cards == 2 and chips() >= h.bet then opts[#opts + 1] = "(d)ouble" end
    local pair = #h.cards == 2 and value({ h.cards[1] }) == value({ h.cards[2] })
    if pair and #hands < 4 and chips() >= h.bet then opts[#opts + 1] = "s(p)lit" end
    local who = #hands > 1 and ("Hand " .. current .. " ") or "You"
    oxis.ask(("%s: %s (%d) — %s?"):format(who, show(h.cards), v, table.concat(opts, " ")), function(answer)
      local a = words(answer)[1] or ""
      if a == "h" or a == "hit" then
        h.cards[#h.cards + 1] = draw()
        local nv = value(h.cards)
        if nv > 21 then line("  You draw", h.cards, " — bust") h.done = true
        elseif nv == 21 then line("  You draw", h.cards, " — 21!") h.done = true end
      elseif a == "s" or a == "stand" then
        h.done = true
      elseif (a == "d" or a == "double") and #h.cards == 2 and chips() >= h.bet then
        setChips(chips() - h.bet)
        h.bet = h.bet * 2
        h.cards[#h.cards + 1] = draw()
        line("  Doubled — you draw", h.cards, value(h.cards) > 21 and " — bust" or "")
        h.done = true
      elseif (a == "p" or a == "split") and pair and chips() >= h.bet then
        setChips(chips() - h.bet)
        local second = { cards = { table.remove(h.cards), draw() }, bet = h.bet, done = false }
        h.cards[#h.cards + 1] = draw()
        table.insert(hands, current + 1, second)
        oxis.echo("  Split into two hands.", "dim")
      else
        oxis.echo("h, s" .. (#h.cards == 2 and ", d" or "") .. (pair and ", p" or "") .. " — or Ctrl+C to leave", "warn")
      end
      nextHand()
    end, { label = "blackjack" })
  end

  oxis.echo(("🂡 Bet %s · Dealer shows %s"):format(fmt(bet), show(dealer, true)), "accent")
  if isBlackjack(dealer) then
    oxis.echo("Dealer checks… blackjack.", "warn")
    hands[1].done = true
    return finish()
  end
  if isBlackjack(hands[1].cards) then
    line("You:", hands[1].cards, " — blackjack!")
    hands[1].done = true
    return finish()
  end
  nextHand()
end

oxis.command("blackjack", function(args)
  if needsAsk() then return end
  if #shoe == 0 then newShoe() end
  local bet, err = parseBet(args[1], 25)
  if not bet then oxis.echo(err, "warn") return end
  playBlackjack(bet)
end, "blackjack against the dealer: hit, stand, double down, split — 'blackjack [bet]")

-- ── guess the number ────────────────────────────────────────

oxis.command("guess", function(args)
  if needsAsk() then return end
  local top = tonumber(args[1]) or 100
  local secret = math.random(1, top)
  local tries = math.ceil(math.log(top, 2)) -- enough with a perfect strategy
  local used = 0
  local low, high = 1, top
  oxis.echo(("🎯 I'm thinking of a number from 1 to %d. You have %d guesses."):format(top, tries), "accent")
  local function ask()
    oxis.ask(("Guess (%d–%d, %d left):"):format(low, high, tries - used), function(answer)
      local n = tonumber(words(answer)[1])
      if not n then oxis.echo("a number, please", "warn") return ask() end
      used = used + 1
      if n == secret then
        local prize = (tries - used + 1) * 20
        setChips(chips() + prize)
        record("guess", prize)
        return oxis.echo(("🎯 %d — got it in %d! +%s chips (bank %s)"):format(n, used, fmt(prize), fmt(chips())), "ok")
      end
      if n < secret then low = math.max(low, n + 1) else high = math.min(high, n - 1) end
      if used >= tries then
        record("guess", 0)
        return oxis.echo(("🎯 Out of guesses — it was %d."):format(secret), "err")
      end
      oxis.echo(n < secret and "⬆ higher" or "⬇ lower", "dim")
      ask()
    end, { label = "guess" })
  end
  ask()
end, "guess my number in as few tries as you can — 'guess [max]")

-- ── hangman ─────────────────────────────────────────────────

local WORDS = {
  "terminal", "workspace", "function", "variable", "compiler", "debugger", "refactor", "pipeline",
  "container", "callback", "promise", "iterator", "recursion", "mutex", "goroutine", "closure",
  "keyboard", "shortcut", "branch", "rebase", "commit", "deploy", "kernel", "process", "syntax",
  "unicode", "plugin", "lambda", "boolean", "integer", "markdown", "frontend", "backend", "database",
}

oxis.command("hangman", function()
  if needsAsk() then return end
  local word = WORDS[math.random(1, #WORDS)]
  local found, misses, lives = {}, {}, 6
  local function shown()
    local t = {}
    for ch in word:gmatch(".") do t[#t + 1] = found[ch] and ch:upper() or "_" end
    return table.concat(t, " ")
  end
  local function solved()
    for ch in word:gmatch(".") do if not found[ch] then return false end end
    return true
  end
  oxis.echo("🪢 Hangman — a word from the developer's dictionary.", "accent")
  local function ask()
    oxis.ask(("%s   lives %s   missed: %s"):format(shown(), ("♥"):rep(lives), #misses > 0 and table.concat(misses, " ") or "—"), function(answer)
      local g = words(answer)[1] or ""
      if #g > 1 then
        if g == word then
          local prize = 40 + lives * 15
          setChips(chips() + prize)
          record("hangman", prize)
          return oxis.echo(("🪢 %s — solved! +%s chips"):format(word:upper(), fmt(prize)), "ok")
        end
        lives = lives - 1
        oxis.echo("not the word", "err")
      elseif g:match("^%a$") then
        if found[g] or misses[g] then oxis.echo("already tried " .. g, "dim")
        elseif word:find(g, 1, true) then found[g] = true
        else misses[#misses + 1] = g misses[g] = true lives = lives - 1 end
      else
        oxis.echo("a letter, or the whole word", "warn")
      end
      if solved() then
        local prize = 40 + lives * 15
        setChips(chips() + prize)
        record("hangman", prize)
        return oxis.echo(("🪢 %s — you got it with %d lives left! +%s chips"):format(word:upper(), lives, fmt(prize)), "ok")
      end
      if lives <= 0 then
        record("hangman", 0)
        return oxis.echo(("🪢 Hanged. The word was %s."):format(word:upper()), "err")
      end
      ask()
    end, { label = "hangman" })
  end
  ask()
end, "guess the developer word one letter at a time")

-- ── magic 8-ball ────────────────────────────────────────────

oxis.command("8ball", function(_, rest)
  if rest == "" then oxis.echo("Ask it something: '8ball will the build pass?", "dim") return end
  local answers = {
    { "It is certain.", "ok" }, { "Without a doubt.", "ok" }, { "Signs point to yes.", "ok" },
    { "Most likely.", "ok" }, { "Reply hazy — ask again later.", "dim" }, { "Cannot predict now.", "dim" },
    { "Better not tell you now.", "dim" }, { "Don't count on it.", "err" }, { "My sources say no.", "err" },
    { "Very doubtful.", "err" }, { "Only if the tests are green.", "warn" }, { "Ship it on a Friday and find out.", "warn" },
  }
  local a = answers[math.random(1, #answers)]
  oxis.echo("🎱 " .. a[1], a[2])
end, "ask the magic 8-ball a yes-or-no question")

-- ── the bank ────────────────────────────────────────────────

oxis.command("chips", function(args)
  if (args[1] or ""):lower() == "reset" then
    setChips(START_CHIPS)
    save("stats", {})
    save("peak", START_CHIPS)
    save("diceStreak", 0)
    save("diceBest", 0)
    return oxis.echo("Bank reset to " .. fmt(START_CHIPS) .. " chips.", "ok")
  end
  oxis.echo(("💰 Bank: %s chips   (best ever %s)"):format(fmt(chips()), fmt(store("peak", START_CHIPS))), "accent")
  local any = false
  for game, g in pairs(stats()) do
    any = true
    oxis.echo(("  %-10s %4d played  %4d won  %s%s"):format(game, g.played, g.won, g.net >= 0 and "+" or "", fmt(g.net)),
      g.net >= 0 and "ok" or "err")
  end
  if not any then oxis.echo("  No games yet: 'pokies, 'blackjack, 'roll 4, 'coinflip, 'guess, 'hangman", "dim") end
  if store("diceBest", 0) > 0 then oxis.echo("  Best dice streak: " .. store("diceBest", 0), "dim") end
end, "your chip bank and record across the games — 'chips reset starts over")
