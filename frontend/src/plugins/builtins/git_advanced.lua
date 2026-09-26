-- git_advanced.lua — advanced Git tools

local WIN = oxis.platform == "windows"

-- Runs the PowerShell or the bash version of a command.
local function run(ps, sh) oxis.run(WIN and ps or sh) end

oxis.command("glog", function()
  oxis.run("git log --graph --pretty=format:'%h %an: %s (%cr)' --abbrev-commit -30")
end, "graph of the last 30 commits")

oxis.command("gdiff", function() oxis.run("git diff --stat HEAD") end,
  "files changed since the last commit, with line counts")

oxis.command("gshow", function(_, rest)
  oxis.run("git show --stat " .. (rest ~= "" and oxis.quote(rest) or "HEAD"))
end, "message and changed files of a commit: 'gshow [commit] (default HEAD)")

oxis.command("gwip", function()
  oxis.run("git add -A && git commit -m 'wip: work in progress'")
end, "commit everything as a work-in-progress checkpoint")

oxis.command("gunwip", function()
  run([[if ((git log -1 --format=%s) -like 'wip:*') { git reset HEAD~1 } else { Write-Host "The last commit isn't a wip commit." }]],
      [[if git log -1 --format=%s | grep -q '^wip:'; then git reset HEAD~1; else echo "The last commit isn't a wip commit."; fi]])
end, "undo the last commit if it was made by 'gwip (changes are kept)")

oxis.command("gundo", function() oxis.run("git reset --soft HEAD~1 && git status") end,
  "undo the last commit, keeping its changes staged")

oxis.command("gcln", function()
  run([[git branch --merged | Where-Object { $_ -notmatch '^[*+]|^\s*(main|master|develop)\s*$' } | ForEach-Object { git branch -d $_.Trim() }]],
      [[git branch --merged | grep -vE '^[*+]|^\s*(main|master|develop)\s*$' | while read -r b; do git branch -d "$b"; done]])
end, "delete local branches already merged into this one (keeps main, master, develop)")

oxis.command("gtag", function()
  oxis.run("git for-each-ref --sort=-v:refname --count=20 '--format=%(refname:short)' refs/tags")
end, "the 20 most recent tags")

oxis.command("gblame", function(_, rest)
  if rest == "" then oxis.echo("usage: 'gblame <file>"); return end
  oxis.run("git blame -- " .. oxis.quote(rest))
end, "who last changed each line of a file: 'gblame <file>")

oxis.command("gstash", function() oxis.run("git stash list") end, "list stashed changes")

oxis.command("greset", function()
  run([[if ((Read-Host "Discard ALL uncommitted changes to tracked files? (y/N)") -eq 'y') { git checkout -- .; git status } else { Write-Host "Nothing changed." }]],
      [[read -r -p "Discard ALL uncommitted changes to tracked files? (y/N) " a; case "$a" in [yY]*) git checkout -- . && git status ;; *) echo "Nothing changed." ;; esac]])
end, "discard uncommitted changes to tracked files (asks first)")

oxis.command("gfetch", function() oxis.run("git fetch --all --prune && git status") end,
  "fetch and prune all remotes, then show status")

oxis.command("grebase", function(args)
  local n = tonumber(args[1]) or 5
  oxis.run("git rebase -i HEAD~" .. math.floor(n))
end, "interactive rebase of the last n commits: 'grebase [n] (default 5; needs a windowed core.editor such as code --wait)")
