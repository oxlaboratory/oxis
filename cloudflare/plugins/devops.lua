-- devops.lua — deploy chain + env var check
-- Complements the built-in docker plugin (dps, dimg, dup, ddown, dlog, dsh)

oxis.command("envcheck", function()
  oxis.run([[
    $prefix = Read-Host "Prefix (default OXIS_)"
    if (!$prefix) { $prefix = "OXIS_" }
    Get-ChildItem Env: | Where-Object { $_.Name -like "$prefix*" }
  ]])
end, "list environment variables matching a prefix (default OXIS_)")

oxis.command("deploy", function() oxis.run("npm run build && npm test && git push origin main") end, "build, test, then push to origin main")

oxis.task("deploy-build", "npm run build", "run just the build step of the deploy command")
oxis.task("deploy-test",  "npm test", "run just the test step of the deploy command")
oxis.task("deploy-push",  "git push origin main", "run just the push step of the deploy command")

oxis.command("predeploy", function() oxis.run("git status --short --branch") end, "show short git status + current branch before deploying")
