--[[@manifest
version: 1.0.0
description: Branches by when you last worked on them — pick one to switch to — a cleanup of branches already merged, and an undo for the last commit. Asks before changing anything.
author: Oxide Labs
category: devops
min_oxis_version: 1.2.1
os: windows, unix
permissions: shell
]]

-- git-tools.lua — 'branches lists local branches, most recent first,
-- with how long ago each last had a commit; type a number or name to
-- switch. 'gclean offers to delete branches already merged into the
-- main branch. 'gundo undoes the last commit and keeps its changes.

-- git's output, as lines; done(lines) or done(nil, why).
local function git(args, done)
  local out, errs = {}, {}
  oxis.process.spawn({ cmd = "git", args = args, cwd = oxis.cwd(), lines = true }, {
    stdout = function(l) out[#out + 1] = l end,
    stderr = function(l) errs[#errs + 1] = l end,
    exit = function(code, err)
      if code == 0 then return done(out) end
      done(nil, errs[1] or err or ("git exited with " .. tostring(code)))
    end,
  })
end

local function mainBranch(done)
  git({ "symbolic-ref", "--short", "refs/remotes/origin/HEAD" }, function(lines)
    if lines and lines[1] then return done((lines[1]:gsub("^origin/", ""))) end
    git({ "rev-parse", "--verify", "--quiet", "main" }, function(found)
      done(found and "main" or "master")
    end)
  end)
end

oxis.command("branches", function()
  git({ "for-each-ref", "--sort=-committerdate", "--format=%(HEAD)\t%(refname:short)\t%(committerdate:relative)\t%(subject)", "refs/heads" }, function(lines, why)
    if not lines then return oxis.echo("✗ " .. why, "err") end
    if #lines == 0 then return oxis.echo("no branches yet", "dim") end
    local names = {}
    for i, l in ipairs(lines) do
      local head, name, when, subject = l:match("^(.)\t([^\t]*)\t([^\t]*)\t?(.*)$")
      if name then
        names[i] = name
        oxis.echo(("%s %2d  %-28s %-16s %s"):format(head == "*" and "●" or " ", i, name:sub(1, 28), when, subject:sub(1, 60)),
          head == "*" and "ok" or (i % 2 == 0 and "dim" or nil))
      end
    end
    oxis.ask("Switch to which? (number or name, Enter to stay)", function(answer)
      answer = answer:gsub("^%s+", ""):gsub("%s+$", "")
      if answer == "" then return end
      local name = names[tonumber(answer) or -1] or answer
      oxis.run("git switch " .. oxis.quote(name))
    end, { label = "branch" })
  end)
end, "branches by when you last worked on them; pick one to switch to")

oxis.command("gclean", function()
  mainBranch(function(main)
    git({ "branch", "--merged", main, "--format=%(refname:short)" }, function(lines, why)
      if not lines then return oxis.echo("✗ " .. why, "err") end
      git({ "branch", "--show-current" }, function(cur)
        local current = cur and cur[1] or ""
        local merged = {}
        for _, b in ipairs(lines) do
          if b ~= main and b ~= current and b ~= "master" and b ~= "main" and b ~= "develop" then merged[#merged + 1] = b end
        end
        if #merged == 0 then return oxis.echo("✓ nothing to clean: no other branches are merged into " .. main, "ok") end
        oxis.echo(("merged into %s:"):format(main), "accent")
        for _, b in ipairs(merged) do oxis.echo("  " .. b) end
        oxis.ask((#merged == 1 and "Delete it? (yes/no)" or ("Delete these %d branches? (yes/no)"):format(#merged)), function(answer)
          if answer ~= "yes" and answer ~= "y" then return oxis.echo("kept them", "dim") end
          local args = { "branch", "-d" }
          for _, b in ipairs(merged) do args[#args + 1] = b end
          git(args, function(out, err)
            if not out then return oxis.echo("✗ " .. err, "err") end
            for _, l in ipairs(out) do oxis.echo(l, "dim") end
            oxis.echo(("✓ deleted %d branch%s"):format(#merged, #merged == 1 and "" or "es"), "ok")
          end)
        end, { label = "gclean" })
      end)
    end)
  end)
end, "delete local branches already merged into the main branch, after asking")

oxis.command("gundo", function()
  git({ "log", "-1", "--format=%h %s" }, function(lines, why)
    if not lines or not lines[1] then return oxis.echo("✗ " .. (why or "no commits"), "err") end
    oxis.ask("Undo " .. lines[1] .. "? Its changes stay, uncommitted. (yes/no)", function(answer)
      if answer ~= "yes" and answer ~= "y" then return oxis.echo("left as it is", "dim") end
      git({ "reset", "--soft", "HEAD~1" }, function(out, err)
        if not out then return oxis.echo("✗ " .. err, "err") end
        oxis.echo("✓ undone — the changes are staged", "ok")
      end)
    end, { label = "gundo" })
  end)
end, "undo the last commit, keeping its changes (asks first)")
