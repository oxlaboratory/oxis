-- lsp_diag.lua — run linters and type checkers from OXIS
-- Long outputs are cut to their first lines.

local WIN = oxis.platform == "windows"

-- Runs cmd, showing only the first n lines of its output.
local function capped(cmd, n)
  if WIN then oxis.run(cmd .. " | Select-Object -First " .. n)
  else oxis.run(cmd .. " 2>&1 | head -n " .. n) end
end

oxis.command("tsc", function() capped("npx tsc --noEmit", 60) end,
  "type-check the TypeScript project without emitting files")
oxis.command("eslint", function() capped("npx eslint .", 60) end,
  "lint the project with its ESLint config")
oxis.command("pycheck", function() capped((WIN and "python" or "python3") .. " -m mypy . --ignore-missing-imports", 40) end,
  "type-check Python with mypy")
oxis.command("golint", function() capped("golangci-lint run ./...", 40) end,
  "lint Go code with golangci-lint")
oxis.command("rustcheck", function() oxis.run("cargo check") end,
  "check the Rust crate compiles (cargo check)")
oxis.command("audit", function() capped("npm audit --audit-level=moderate", 40) end,
  "npm dependencies with known vulnerabilities (moderate and up)")
oxis.command("outdated", function() oxis.run("npm outdated") end,
  "npm dependencies with newer versions")
oxis.command("depcheck", function() capped("npx depcheck", 40) end,
  "npm dependencies the code doesn't use")
