-- lsp_diag.lua — code diagnostics
-- Runs linters/type-checkers and surfaces errors in OXIS

oxis.command("tsc",     function() oxis.run("npx tsc --noEmit 2>&1 | head -60") end, "run the TypeScript compiler in check-only mode")
oxis.command("eslint",  function() oxis.run("npx eslint . --ext .ts,.tsx,.js,.jsx --format compact 2>&1 | head -60") end, "run ESLint over ts/tsx/js/jsx files")
oxis.command("pycheck", function() oxis.run("python -m mypy . --ignore-missing-imports 2>&1 | head -40") end, "run mypy type checking")
oxis.command("golint",  function() oxis.run("golangci-lint run ./... 2>&1 | head -40") end, "run golangci-lint")
oxis.command("rustcheck",function() oxis.run("cargo check 2>&1") end, "run cargo check")
oxis.command("audit",   function() oxis.run("npm audit --audit-level=moderate 2>&1 | head -40") end, "check npm dependencies for known vulnerabilities")
oxis.command("outdated",function() oxis.run("npm outdated 2>&1") end, "list outdated npm dependencies")
oxis.command("depcheck", function() oxis.run("npx depcheck 2>&1 | head -40") end, "find unused npm dependencies")
