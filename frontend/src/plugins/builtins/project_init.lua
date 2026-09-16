-- project_init.lua — project scaffolding 

oxis.command("initts", function()
  oxis.run([[
    npm init -y
    npm install -D typescript @types/node ts-node
    npx tsc --init --target ES2022 --moduleResolution node --strict
    New-Item -ItemType Directory src -Force | Out-Null
    Set-Content src/index.ts "console.log('OXIS project ready')"
    Write-Host "TypeScript project initialised."
  ]])
end, "scaffold a new TypeScript project")

oxis.command("initreact", function()
  oxis.run([[
    npm create vite@latest . -- --template react-ts
    npm install
    Write-Host "React+TypeScript project initialised."
  ]])
end, "scaffold a new React + TypeScript project (Vite)")

oxis.command("initgo", function()
  oxis.run([[
    $mod = Read-Host "Module name (e.g. github.com/you/project)"
    go mod init $mod
    New-Item -ItemType Directory cmd\app -Force | Out-Null
    Set-Content cmd\app\main.go "package main`n`nimport `"fmt`"`n`nfunc main() {`n`tfmt.Println(`"OXIS project ready`")`n}"
    go mod tidy
    Write-Host "Go project initialised: $mod"
  ]])
end, "scaffold a new Go module")

oxis.command("initpy", function()
  oxis.run([[
    python -m venv .venv
    .venv\Scripts\Activate.ps1
    New-Item -ItemType File requirements.txt -Force | Out-Null
    New-Item -ItemType File main.py -Force | Out-Null
    Set-Content main.py "def main():`n    print('OXIS project ready')`n`nif __name__ == '__main__':`n    main()"
    Write-Host "Python project initialised."
  ]])
end, "scaffold a new Python project with a venv")

oxis.command("initgit", function()
  oxis.run([[
    git init
    Set-Content .gitignore "node_modules/`ndist/`n.env`n*.log`n.DS_Store`n__pycache__/`n.venv/"
    git add .gitignore
    git commit -m "chore: initial commit"
    Write-Host "Git repository initialised."
  ]])
end, "initialise a git repo with a starter .gitignore")
