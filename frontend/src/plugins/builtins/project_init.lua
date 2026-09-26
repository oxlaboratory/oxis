-- project_init.lua — start a project in the current folder
-- Existing files are never overwritten.

local WIN = oxis.platform == "windows"

local function run(ps, sh) oxis.run(WIN and ps or ("set -e\n" .. sh)) end

-- A script line setting `var` from the command's argument, or asking
-- for it when there isn't one.
local function ask(var, value, question)
  if value ~= "" then return (WIN and "$" or "") .. var .. "=" .. oxis.quote(value) end
  if WIN then return "$" .. var .. ' = Read-Host "' .. question .. '"' end
  return "read -r -p " .. oxis.quote(question .. ": ") .. " " .. var
end

oxis.command("initts", function()
  run([[
npm init -y
if ($LASTEXITCODE) { return }
npm install -D typescript @types/node ts-node
if ($LASTEXITCODE) { return }
if (!(Test-Path tsconfig.json)) { npx tsc --init --target ES2022 --moduleResolution node --strict }
New-Item -ItemType Directory -Force src | Out-Null
if (!(Test-Path src/index.ts)) { Set-Content src/index.ts "console.log('OXIS project ready')" }
Write-Host "TypeScript project ready. Run it with: npx ts-node src/index.ts"
]], [[
npm init -y
npm install -D typescript @types/node ts-node
[ -f tsconfig.json ] || npx tsc --init --target ES2022 --moduleResolution node --strict
mkdir -p src
[ -f src/index.ts ] || echo "console.log('OXIS project ready')" > src/index.ts
echo "TypeScript project ready. Run it with: npx ts-node src/index.ts"
]])
end, "start a TypeScript project here")

oxis.command("initreact", function()
  oxis.run("npm create vite@latest . -- --template react-ts && npm install")
end, "start a React + TypeScript project here (Vite)")

oxis.command("initgo", function(_, rest)
  run(ask("mod", rest, "Module path (e.g. github.com/you/project)") .. [[

if (!$mod) { Write-Host "A module path is needed."; return }
go mod init $mod
if ($LASTEXITCODE) { return }
New-Item -ItemType Directory -Force cmd\app | Out-Null
if (!(Test-Path cmd\app\main.go)) { Set-Content cmd\app\main.go "package main`n`nimport `"fmt`"`n`nfunc main() {`n`tfmt.Println(`"OXIS project ready`")`n}" }
Write-Host "Go module $mod ready. Run it with: go run ./cmd/app"
]], ask("mod", rest, "Module path (e.g. github.com/you/project)") .. [[

[ -n "$mod" ] || { echo "A module path is needed."; exit 1; }
go mod init "$mod"
mkdir -p cmd/app
[ -f cmd/app/main.go ] || printf 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("OXIS project ready")\n}\n' > cmd/app/main.go
echo "Go module $mod ready. Run it with: go run ./cmd/app"
]])
end, "start a Go module here: 'initgo [module path]")

oxis.command("initpy", function()
  run([[
python -m venv .venv
if ($LASTEXITCODE) { return }
if (!(Test-Path requirements.txt)) { New-Item -ItemType File requirements.txt | Out-Null }
if (!(Test-Path main.py)) { Set-Content main.py "def main():`n    print('OXIS project ready')`n`n`nif __name__ == '__main__':`n    main()" }
Write-Host "Python project ready. Activate the venv with: .venv\Scripts\Activate.ps1"
]], [[
python3 -m venv .venv
[ -f requirements.txt ] || : > requirements.txt
[ -f main.py ] || printf "def main():\n    print('OXIS project ready')\n\n\nif __name__ == '__main__':\n    main()\n" > main.py
echo "Python project ready. Activate the venv with: . .venv/bin/activate"
]])
end, "start a Python project here, with a virtual environment in .venv")

oxis.command("initgit", function()
  run([[
git init
if ($LASTEXITCODE) { return }
if (!(Test-Path .gitignore)) { Set-Content .gitignore "node_modules/`ndist/`n.env`n*.log`n.DS_Store`n__pycache__/`n.venv/" }
git add .gitignore
git commit -m "Initial commit"
]], [[
git init
[ -f .gitignore ] || printf 'node_modules/\ndist/\n.env\n*.log\n.DS_Store\n__pycache__/\n.venv/\n' > .gitignore
git add .gitignore
git commit -m "Initial commit"
]])
end, "make this folder a git repository with a starter .gitignore")
