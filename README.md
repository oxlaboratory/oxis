# OXIS

**Open Xenial Intelligent Shell** — a Lua-configurable, terminal built on Go + React/TypeScript.

> Terminals were the beginning.

Status tags used throughout this document: **[shipped]** — in the
current codebase today, **[in progress]** — partially built, **[planned]**
— designed and specified here, not yet implemented. See the
[Roadmap Status Key](#roadmap-status-key) at the bottom for the full list.

---

## Table of Contents

- [Overview](#overview)
- [Available Now — v1.2.1](#available-now--v121)
- [Coming Soon — v1.2.2](#coming-soon--v122)
- [Architecture](#architecture)
- [Input Modes](#input-modes)
- [Browser Mode](#browser-mode)
- [Home Screen & Workspace Panel](#home-screen--workspace-panel)
- [Plugin Marketplace](#plugin-marketplace)
- [Directory Structure](#directory-structure)
- [Cloudflare Deployment](#cloudflare-deployment)
- [Getting Started](#getting-started)
- [Plugin System](#plugin-system)
- [Core System APIs](#core-system-apis)
- [Lua API](#lua-api)
- [Theme System](#theme-system)
- [Workspace System](#workspace-system)
- [Command Registry](#command-registry)
- [Event System](#event-system)
- [Keybind System](#keybind-system)
- [PTY Architecture](#pty-architecture)
- [Task Runner](#task-runner)
- [Built-in Editor](#built-in-editor)
- [Auto-Update](#auto-update)
- [Session Management](#session-management)
- [OXIS Market — Subscriptions & Premium Plugins](#oxis-market--subscriptions--premium-plugins)
- [Premium Plugin Licensing & Encryption](#premium-plugin-licensing--encryption)
- [AI DevOps (Flagship Plugin)](#ai-devops-flagship-plugin)
- [Third-Party Developer Marketplace](#third-party-developer-marketplace)
- [Open Source & Licensing Model](#open-source--licensing-model)
- [Plugin Development Guide](#plugin-development-guide)
- [Theme Creation Guide](#theme-creation-guide)
- [Workspace Creation Guide](#workspace-creation-guide)
- [Contribution Guide](#contribution-guide)
- [Roadmap Status Key](#roadmap-status-key)

---

## Overview

OXIS is built around a single philosophy: the terminal, editor, themes, commands, keymaps, plugins, and workspaces should all be scriptable through Lua.

```
OxiShell Core
├── Terminal (PTY ↔ WebSocket ↔ Browser)
├── Editor   (built-in, no external app)
├── Workspaces
├── Commands (registry + Lua)
├── Themes   (JSON + hot-reload)
├── Keymaps  (user-defined via Lua)
└── Plugins
      ↓
     Lua
```

---

## Available Now — v1.2.1

Everything in this list is real, working code in this repository
today, not a roadmap item:

- **Full programmable terminal** — real PTY (PowerShell/bash) behind
  a WebSocket, with Command Mode (`'command`) layered on top of
  ordinary Shell Mode — see [Input Modes](#input-modes)
- **Lua plugins** — a real embedded Lua VM (fengari) per plugin, with
  a genuine API surface: commands (now with real argument passing),
  keymaps scoped per input mode, tasks, events, themes, workspace
  hooks, and permissioned `oxis.fs`/`oxis.process`/`oxis.net`/`oxis.system`
  access — see [Plugin System](#plugin-system) and [Core System
  APIs](#core-system-apis)
- **Free OXIS Market** — `'market list/search/info/install` really
  fetch and install community Lua plugins over HTTPS — see [Plugin
  Marketplace](#plugin-marketplace)
- **Workspaces** — `'workspace init/info/reload/close`, real
  `.oxis/workspace.lua` files, and automatic detection when you `cd`
  into a project that has one — see [Workspace System](#workspace-system)
- **Editor** — built-in, with real modal Normal/Insert/Visual editing
  (not just a plain textarea) — see [Built-in Editor](#built-in-editor)
- **Auto-update check** — compares the running build against
  `gitlab.com/oxidelab/oxis`'s latest published Release and surfaces a
  one-line notice + `'update` to open the download — see
  [Auto-Update](#auto-update)
- **Themes** — JSON-defined, hot-reloadable, Lua-controllable
- **Automation** — tasks, keymaps, and event hooks (`oxis.autocmd`)
  that plugins and workspace files can register
- **Tasks** — `'task <name>`, declared via `oxis.task(...)` from any
  plugin or workspace file
- **Sessions** — tabs, active theme, workspace path, and command
  history persist across restarts
- **Browser mode** — OXIS also runs as a plain web page (no native
  window), with graceful degradation for anything that needs real
  filesystem access — see [Browser Mode](#browser-mode)

## Coming Soon — v1.2.2

These are **not purchasable or usable yet** — every one is marked
`comingSoon: true` in the Market and blocked from checkout — but the
underlying infrastructure is already built and integrated against
Stripe **test mode** today, not just designed on paper:

- **Premium Market subscriptions** — real Stripe Checkout session
  creation, a real webhook that issues licenses on `checkout.session.completed`,
  and real KV-backed license storage all exist now
  ([OXIS Market](#oxis-market--subscriptions--premium-plugins))
- **AI DevOps subscription** — the plugin itself is real and makes
  real AI API calls (bring your own key) today; what's missing is a
  live Stripe Price to subscribe to ([AI DevOps](#ai-devops-flagship-plugin))
- **Third-party paid plugins** — Stripe Connect Express onboarding
  and account-status checking are real, working endpoints; what's
  missing is a publishing UI for developers to list a plugin against
  their own account ([Third-Party Developer Marketplace](#third-party-developer-marketplace))
- **Developer payouts** — the 75/25 split is implemented via Stripe
  Connect destination charges (`application_fee_percent` +
  `transfer_data.destination`) and has been verified to produce
  correct request payloads; it activates the moment a developer's
  Connect account passes verification and their plugin gets a real
  Stripe Price ID

Production payments stay off until Stripe account verification is
complete — see [OXIS Market](#oxis-market--subscriptions--premium-plugins)
for exactly what's real vs. what's gated.

---

## Architecture

OXIS runs as a single native desktop window, built with [Wails v2](https://wails.io) — a Go backend driving a Chromium/WebKit webview, with no browser tab, no Electron, and no separate server process to manage day-to-day.

```
┌────────────────────────────────────────────────────────┐
│   OXIS  (native window — frameless, custom titlebar)     │
│                                                            │
│  ┌──────────────────────────────────────────────────┐   │
│  │  React + TypeScript (Vite)                         │   │
│  │                                                     │   │
│  │  Titlebar (traffic lights, drag) · tabs · home     │   │
│  │  terminal · editor · status                        │   │
│  │                                                     │   │
│  │  terminal/   plugins/   themes/   pty/              │   │
│  └───────────────────────┬──────────────────────────────┘   │
│                          │ Wails' own AssetServer —          │
│                          │ direct in-process request          │
│                          │ interception, no TCP socket        │
└──────────────────────────┼──────────────────────────────────┘
                           │
                           │  (separately, for the PTY only)
                           ▼
┌──────────────────────────────────────────────────────────┐
│  internal/server.Listen()  — a real TCP listener on        │
│  127.0.0.1, started alongside the native window             │
│                                                              │
│  /ws  → PTY (PowerShell/bash)     everything else → the      │
│  same frontend build, so a plain browser pointed at          │
│  http://127.0.0.1:1420 gets the full app too                 │
└──────────────────────────────────────────────────────────┘
```

`internal/wailsapp` owns the window: it embeds the built frontend
directly as the window's `AssetServer.Assets` (Wails' standard
embedded-filesystem path), so `window.go`/`window.runtime` are
injected into the one document the window ever loads — no navigation,
no redirect. `cmd/oxi/main.go` is a two-line entry point that just
calls `wailsapp.Run()`.

Wails' `AssetServer` intercepts requests through the native webview's
own API rather than a real `net.Conn`, so it can't perform the
`Hijack` a WebSocket upgrade needs. `internal/server.Listen()` runs a
second, genuine HTTP server on a real port (127.0.0.1:1420 by
default) purely for that — and, since it needs a real socket anyway,
also serves the same frontend build on it. That's what makes
`http://127.0.0.1:1420` work as a quick way to open OXIS in an
ordinary browser tab, completely independent of the native window
(see [Browser Mode](#browser-mode)).

The custom titlebar (`components/Titlebar.tsx`) only renders inside
the native window — a plain browser tab has its own chrome and
doesn't need one (see `isNativeApp()` in `frontend/src/native.ts`).
Where it does render, it exists because the native window is
frameless: Wails injects `window.runtime`, which gives the titlebar
direct access to `WindowMinimise` / `Quit` for its window controls,
and a `--wails-draggable: drag` CSS property makes the bar itself
draggable. (There's deliberately no maximise control — the window's
size is locked.)

---

## Input Modes

OXIS is not a single-mode command box. A shell that only understood
`'commands` and nothing else would be little more than a launcher —
so OXIS is built around several distinct input modes, each with a
clear purpose. The status bar always shows which mode is active.

| Mode          | Status        | Trigger                     | Purpose                                                             |
|---------------|---------------|------------------------------|----------------------------------------------------------------------|
| **Shell Mode**    | [shipped]     | default, in any terminal tab | Raw passthrough to the PTY (PowerShell/bash) — ordinary shell usage, no OXIS involvement |
| **Command Mode**  | [shipped]     | line starts with `'`         | Dispatches to the OXIS command registry (`'plugin`, `'theme`, `'market`, `'workspace`, Lua-registered commands, etc.) |
| **Home Mode**     | [shipped]     | `view === "home"`            | The dashboard/workspace screen shown on launch and via `'home` |
| **Normal Mode**   | [shipped]     | built-in editor, default     | Vim-style navigation/editing inside `'edit <file>` — hjkl/0/$/gg/G/w/b motion, x/dd/dw/o/O edits; no text is inserted |
| **Insert Mode**   | [shipped]     | `i`/`a`/`o`/etc. from Normal Mode | Free text entry inside the built-in editor — the textarea is `readOnly` outside this mode, so typing literally can't reach the buffer except here |
| **Visual Mode**   | [shipped]     | `v` from Normal Mode         | Character-range selection for delete (`d`/`x`) and yank (`y`, via the real clipboard) |
| **Search Mode**   | [planned]     | `/` in terminal or editor    | Incremental search through scrollback, command history, or open buffer |

Command Mode is deliberately just one of these, not the whole
interface — it's the entry point for OXIS's own functionality
(plugins, themes, the market, workspaces), while Shell Mode stays a
completely unmodified terminal for everything else. The editor's
Normal/Insert/Visual split follows the same reasoning: navigating,
editing, and selecting text are different enough tasks that
overloading them onto one mode makes both harder to use. Lua plugins
can register keymaps per-mode (`oxis.keymap("normal", ...)`,
`oxis.keymap("insert", ...)`, `oxis.keymap("visual", ...)`) — this is
real and enforced: `keybinds.ts` tracks which mode is currently
"live" and a mode-scoped bind simply doesn't fire outside it, rather
than the mode argument being silently ignored (which is what it
actually did before this was wired up).

Mode transitions fire a real `"mode_changed"` event (see [Event
System](#event-system)) that plugins can subscribe to — for example,
a status-line plugin can change color per-mode, or a plugin can
disable certain keymaps while in Insert Mode to avoid colliding with
normal typing.

---

## Browser Mode

OXIS doesn't strictly require the native window. With `oxis.exe`
running, point any browser at:

```
http://127.0.0.1:1420
```

and you get the same app — same terminal, same plugins, same PTY —
served by the same local HTTP server the native window uses for its
own PTY connection (see [Architecture](#architecture)). The custom
titlebar is skipped in this mode (an ordinary browser tab already has
window controls), and OXIS stops intercepting OS/browser shortcuts
like Ctrl+W or Ctrl+R, since those belong to the browser here, not to
OXIS.

If port 1420 is already taken, OXIS tries the next few ports up —
check the terminal output (or Task Manager) for the one actually
bound if 1420 doesn't respond.

---

## Home Screen & Workspace Panel

**[shipped]** — the ASCII banner, help box, command line, and the
Workspace panel itself all ship today.

The Home screen is OXIS's landing view (`view === "home"`, see
[Input Modes](#input-modes)) and is meant to feel like the central
hub of a development session, not a splash screen. There's no
donation section here at all anymore — see [OXIS
Market](#oxis-market--subscriptions--premium-plugins) for how OXIS
actually funds continued development now (Stripe subscriptions, not
donations).

In place of the old donation box, Home now surfaces a **Workspace
panel** built from the same box/ASCII styling as everything else
(`oxis-box`, terminal-aesthetic borders, no rounded skeuomorphic
cards). It shows, live:

- **Current workspace/project** — name, or "No project loaded"
- **Project path** — the resolved `.oxis/workspace.lua` directory, if any
- **Active plugins** — count + names of currently enabled plugins
- **Available tasks** — task names defined by the workspace (`'task <name>`)
- **Current theme** — the active theme name (also shown in the status bar)
- **Recent workspace activity** — the last few `WorkspaceLoaded` / task-run / plugin-reload events
- **Workspace status** — ready / loading / no workspace detected

```
┌ WORKSPACE ──────────────────────────────────────┐
│ project     oxis                                  │
│ path        C:\dev\oxis\.oxis\workspace.lua       │
│ theme       midnight                              │
│ plugins     6 active  (git, docker, npm, ...)     │
│ tasks       dev, build, test                      │
│ status      ● ready                               │
│ recent      workspace loaded · task "dev" run      │
└────────────────────────────────────────────────────┘
```

The panel is read-only by design — it reflects `workspaceManager` /
`pluginManager` state rather than accepting input directly, so it
stays fast and doesn't compete with Command Mode for focus. Quick
actions (`'market`, `'theme`, `'help`) remain available beneath it
exactly as before.

---

## Plugin Marketplace

`'market` browses and installs community plugins from
[oxis-market.pages.dev](https://oxis-market.pages.dev):

```
'market list              browse everything, grouped by category
'market search <query>    search by name / description / category
'market info <name>       show details for one plugin
'market install <name>    download, register, and enable a plugin
```

Installed plugins become ordinary user Lua plugins — same as anything
created with `'plugin new` — so `'plugin list`, `'plugin disable`, and
`'plugin reload` all work on them afterward.

### Marketplace site contract

`oxis-market.pages.dev` is expected to serve a static index plus raw
`.lua` files (this is what the client in `frontend/src/plugins/market.ts`
fetches):

```
GET /index.json
  → [
      {
        "name":    "docker-compose",
        "desc":    "Shortcuts for docker compose workflows",
        "category":"devops",
        "version": "1.0.0",
        "author":  "someone",
        "file":    "plugins/docker-compose.lua"
      },
      ...
    ]

GET /plugins/docker-compose.lua
  → raw Lua source (same format as any built-in plugin, see
    [Plugin Development Guide](#plugin-development-guide))
```

Since it's served from Cloudflare Pages, publishing a new plugin is
just committing `index.json` + the `.lua` file to that repo — no API,
no backend, no auth.

---

## Directory Structure

```
oxis/
├── cmd/oxi/
│   ├── main.go                 Entry point — calls wailsapp.Run()
│   └── windows.go              Windows console-hiding build tag
├── internal/
│   ├── wailsapp/
│   │   └── app.go              Native Wails v2 window + bound window-control/file/plugin/update methods
│   ├── update/
│   │   └── update.go           GitLab Releases check (gitlab.com/oxidelab/oxis) — see Auto-Update
│   ├── server/
│   │   └── server.go           /ws (PTY) + frontend, on a real 127.0.0.1 port — see Browser Mode
│   └── pty/
│       ├── pty.go              Shared types + ANSI stripping (both platforms)
│       ├── pty_windows.go      ConPTY (PowerShell/cmd)
│       └── pty_unix.go         creack/pty (bash, for build-linux.sh)
├── frontend/
│   ├── public/
│   ├── src/
│   │   ├── App.tsx             Root application component
│   │   ├── index.css           Complete stylesheet
│   │   ├── main.tsx
│   │   ├── native.ts           Go-bound native calls + isNativeApp() detection
│   │   ├── components/
│   │   │   └── Titlebar.tsx    Frameless custom titlebar (traffic lights, drag region) — native window only
│   │   ├── terminal/
│   │   │   ├── terminal.ts     Line model, ANSI, banner, output processing
│   │   │   ├── tabs.ts         Tab creation, switching, persistence
│   │   │   ├── history.ts      Command history + search + persistence
│   │   │   ├── keybinds.ts     Keyboard shortcuts + user-defined mappings
│   │   │   ├── commandRegistry.ts  Unified command registry
│   │   │   ├── events.ts       Event bus
│   │   │   ├── themeManager.ts Theme loading, switching, validation
│   │   │   └── sessionManager.ts   Session save/restore
│   │   ├── plugins/
│   │   │   ├── pluginManager.ts    Discovery, load, unload, enable, disable, disk persistence
│   │   │   ├── luaRuntime.ts       Real Lua 5.3 VM (fengari) — see Plugin System
│   │   │   ├── pluginAPI.ts        All oxis.* APIs exposed to Lua
│   │   │   ├── loader.ts           Built-in + user plugin bootstrapper
│   │   │   ├── market.ts           oxis-market.pages.dev client
│   │   │   └── builtins/
│   │   │       ├── git.lua                 npm.lua              docker.lua
│   │   │       ├── sysmon.lua              network.lua          files.lua
│   │   │       ├── python.lua              go.lua               winutil.lua
│   │   │       ├── fuzzy.lua               git_advanced.lua     lsp_diag.lua
│   │   │       ├── http.lua                session_notes.lua    env_manager.lua
│   │   │       ├── benchmark.lua           process_manager.lua  project_init.lua
│   │   │       ├── clipboard.lua           todo.lua             docker_compose.lua
│   │   │       ├── file_ops.lua            system_health.lua    snippets.lua
│   │   │       ├── ssh_manager.lua
│   │   │       ├── config.lua      User startup config template
│   │   │       └── workspace.lua   Per-project workspace template
│   │   ├── pty/
│   │   │   └── ptyClient.ts    WebSocket ↔ PTY bridge (no UI code)
│   │   └── themes/
│   │       ├── default.json
│   │       ├── midnight.json
│   │       └── custom/
│   ├── index.html
│   ├── vite.config.ts
│   └── tsconfig.json
├── scripts/
│   ├── setup.js                One-command dependency checker
│   ├── build-go.js             Builds dist/oxis(.exe)
│   ├── dev.js                  Watch + rebuild + relaunch loop (no true HMR — see Getting Started)
│   └── build-msi.js            NSIS installer builder — bundles full source
├── dist/
│   ├── oxis.exe
│   ├── source/                 Full project source (installer bundles this)
│   └── oxis-1.2.1-setup.exe
├── cloudflare/                 OXIS Market website + backend — see Cloudflare Deployment.
│   │                           One repo, independently deployable: Cloudflare Pages
│   │                           points its "Root directory" build setting at this folder.
│   ├── index.html              The Market website itself
│   ├── index.json              Plugin catalog (free + premium/comingSoon entries)
│   ├── functions/              Cloudflare Pages Functions (real Stripe backend)
│   │   ├── checkout.js         Creates a Stripe Checkout session (handles the 75/25 split)
│   │   ├── webhook.js          Verifies Stripe signatures, issues licenses to KV
│   │   ├── verify-license.js   Read-only license check the desktop app calls
│   │   ├── premium-plugin.js   Serves premium plugin source (license-gated, not a static file)
│   │   ├── connect-onboarding.js  Stripe Connect Express account creation
│   │   ├── connect-status.js      Verification-status gate for production payouts
│   │   └── lib/
│   │       ├── stripe.js       Dependency-free Stripe REST client + webhook signature verification
│   │       └── licenses.js     KV-backed license read/write
│   ├── premium-source/         Premium plugin .lua source — NOT served as static files;
│   │   └── ai_devops.lua       published into the OXIS_PREMIUM_SOURCE KV namespace instead
│   ├── plugins/                Free plugin .lua files — these ARE served as static files
│   ├── wrangler.toml           KV namespace binding declarations (no secrets)
│   ├── .dev.vars.example       Placeholder env vars for local `wrangler pages dev`
│   └── .gitignore entries live in the root .gitignore (see below), not a nested file
├── go.mod
├── go.sum
└── README.md
```

---

## Cloudflare Deployment

**[shipped]** — the OXIS Market website and its entire Stripe backend
live in `cloudflare/`, inside this same repository
(`gitlab.com/oxidelab/oxis`) — there is no second repository to keep
in sync. Cloudflare Pages deploys straight from this repo by pointing
its build configuration at that one subdirectory.

### Cloudflare Pages project settings

| Setting | Value |
|---|---|
| Framework preset | None (static site + Functions) |
| Build command | *(none — no build step, plain HTML/CSS/JS)* |
| Build output directory | `cloudflare` |
| Root directory | `cloudflare` |
| Functions directory | auto-detected (`cloudflare/functions/`) |

Connect the Pages project directly to the `gitlab.com/oxidelab/oxis`
repository (Cloudflare Pages supports GitLab as a Git provider the
same way it supports GitHub) and set **Root directory** to
`cloudflare` — this is what lets one repository serve both the
desktop app and the Market site without duplicating any source.

### Required configuration (Pages -> Settings)

**Environment variables** (Production and Preview; use test-mode
`sk_test_...` values until account verification is complete):

```
STRIPE_SECRET_KEY       sk_test_... (server-side only — never in this repo)
STRIPE_WEBHOOK_SECRET   whsec_...   (from the Stripe Dashboard webhook endpoint)
```

**KV namespace bindings** (Settings -> Functions -> KV namespace bindings):

```
OXIS_LICENSES         — created via: wrangler kv namespace create OXIS_LICENSES
OXIS_PREMIUM_SOURCE    — created via: wrangler kv namespace create OXIS_PREMIUM_SOURCE
```

**Stripe Dashboard webhook endpoint**, once deployed:

```
https://<your-pages-domain>/webhook
Subscribe to: checkout.session.completed, customer.subscription.updated, customer.subscription.deleted
```

### Local development

```
cp cloudflare/.dev.vars.example cloudflare/.dev.vars
# fill in real sk_test_.../whsec_... values, then:
cd cloudflare && npx wrangler pages dev . --kv OXIS_LICENSES --kv OXIS_PREMIUM_SOURCE
```

`cloudflare/.dev.vars` is gitignored at the repository root (see
`.gitignore`'s Cloudflare section) — it is never committed, matching
the rule that no secret ever lives in this repository regardless of
which part of the project it belongs to.

### Publishing a premium plugin's source (manual today, see [Third-Party Developer Marketplace](#third-party-developer-marketplace))

```
wrangler kv key put --binding=OXIS_PREMIUM_SOURCE "ai-devops" --path=cloudflare/premium-source/ai_devops.lua
```

---

## Getting Started

### Prerequisites

- Go 1.22+
- Node.js 18+ / npm
- PowerShell (Windows) or bash (Linux/macOS)
- WebView2 runtime (bundled with Windows 10/11 by default; older installs may need it separately)

### Install & Run

```bash
# Clone
git clone https://gitlab.com/yourorg/oxis.git
cd oxis

# One-command setup check
node scripts/setup.js

# Install frontend deps
cd frontend && npm install && cd ..

# Run (development — rebuilds + relaunches the window on file changes)
npm run dev

# Build frontend + single native binary
npm run build          # → dist/oxis.exe

# Build installer (Windows, NSIS required)
node scripts/build-msi.js
```

Note: the frontend is embedded into the Go binary at compile time
(`go:embed`), so there's no live hot-reload — `npm run dev` watches
`frontend/src`, `cmd/`, and `internal/`, and does a full rebuild +
relaunch on every change (a couple seconds, not instant).

### Installer & bundled source

`node scripts/build-msi.js` bundles the *entire OXIS project source* —
not just the binary — into `dist/source/` and installs it alongside
`oxis.exe` under `%PROGRAMFILES64%\OXIS\source\` (excluded:
`node_modules/`, `.git/`, `dist/`, build artifacts). This means
installing OXIS also gets you the app's own code: to read, to fork,
to write plugins against, or to rebuild from scratch with
`npm install && npm run build` in that directory. Uninstalling removes
it along with everything else.

**[shipped]** Both installer paths create real launch shortcuts —
neither leaves users to go dig `oxis.exe` out of Program Files
themselves:

- **WiX (`.msi`)**: `OxisShortcuts` component creates a Start Menu
  shortcut and an uninstall shortcut; a separate `OxisDesktopShortcut`
  component adds the Desktop shortcut. Both target `oxis.exe`
  directly via `[INSTALLFOLDER]`.
- **NSIS (`.exe`, used when WiX's `candle`/`light` aren't available)**:
  the install section runs three `CreateShortcut` calls — Start Menu,
  Desktop, and an uninstall entry under `$SMPROGRAMS\OXIS\` — plus a
  full `Add/Remove Programs` registry entry
  (`HKLM\...\Uninstall\OXIS`) and a `$PROGRAMFILES64\OXIS` PATH
  addition. The uninstall section deletes all three shortcuts and the
  Start Menu folder alongside everything else — nothing is left
  behind.

### User Config Directory

OXIS creates and reads from:

```
%USERPROFILE%\.oxis\
├── config.lua          Startup configuration
├── themes\             User JSON themes
└── workspaces\         Saved workspace state
```

User and market-installed **plugins** live somewhere different — a
`plugins\` folder next to `oxis.exe` itself (not under
`%USERPROFILE%`), since that's stable regardless of what directory
you happened to launch OXIS from:

```
<OXIS install dir>\
├── oxis.exe
└── plugins\
    ├── mynewplugin.lua      'plugin new mynewplugin
    └── games.lua            'market install games
```

`'plugin new` and `'market install` both write real `.lua` files
there — see [Plugin System](#plugin-system).

---

## Plugin System

OXIS plugins are real Lua 5.3 scripts, run by an actual embedded Lua
VM ([fengari](https://fengari.io)) — not a transpiler, not a subset,
not "Lua-flavored JS". Anything valid Lua supports (closures, proper
`for`/`while` loops, `[[ ]]` long-bracket strings, real tables) works.

Two kinds ship with OXIS:

- **TypeScript shortcut plugins** (`git`, `npm`, `docker`, `sysmon`,
  `network`, `files`, `python`, `go`, `winutil`, `rust`) — thin
  one-line-per-command tables that just run a shell command. Fast,
  simple, not meant to be edited.
- **Lua plugins** (`fuzzy`, `git_advanced`, `lsp_diag`, `http`,
  `session_notes`, `env_manager`, `benchmark`, `process_manager`,
  `project_init`, `clipboard`, `todo`, `docker_compose`, `file_ops`,
  `system_health`, `snippets`, `ssh_manager`) — full Lua source,
  fully editable, disabled by default (`'plugin enable <name>`).

User and market-installed plugins are Lua files too — real `.lua`
files in a `plugins\` folder next to `oxis.exe` (see [User Config
Directory](#getting-started)), not localStorage, not anything tied to
one particular window session.

### Plugin Structure

```
src/plugins/
├── pluginManager.ts    Discovery, loading, unloading, enable/disable, reload, disk persistence
├── luaRuntime.ts        Real Lua 5.3 VM (fengari) + the oxis.* table's Lua<->JS boundary
├── pluginAPI.ts         What each oxis.* call actually does inside OXIS
├── loader.ts            Bootstrap built-ins + user plugins
└── builtins/
    ├── git.lua
    ├── npm.lua
    └── ... (see Directory Structure)
```

### Creating a Plugin

`'plugin new myplugin` opens the built-in Lua editor. Saving writes
`plugins\myplugin.lua` next to `oxis.exe` — a real file, so it's just
as easy to open and edit in any other text editor afterward.

```lua
-- myplugin.lua

-- Register a command — the 3rd argument (a real description) is
-- required for good 'help output; a command registered without one
-- still works, but gets a generic auto-generated description and a
-- one-time warning telling you to add a real one.
oxis.command("hello", function()
    oxis.echo("Hello from my plugin!")
end, "say hello")

-- Run a shell command
oxis.command("myls", function()
    oxis.run("Get-ChildItem")
end, "list the current directory")

-- Listen to events
oxis.autocmd("ShellOpen", function()
    oxis.echo("Shell is ready")
end)

-- Add a keymap
oxis.keymap("normal", "<C-g>", function()
    oxis.run("git status")
end)

-- Define a task
oxis.task("dev", "npm run dev", "start the dev server")
```

Usage:

```
'hello
'myls
'task dev
```

### Plugin Commands

```
'plugin list                    List all plugins and status
'plugin enable <name>           Enable a plugin
'plugin enable all              Enable every registered plugin
'plugin disable <name>          Disable a plugin
'plugin reload <name>           Reload a plugin without restart
'plugin reloadall               Reload all plugins
'plugin new <name>              Create a new Lua plugin in-app
'plugin delete <name>           Delete a user/market plugin's file
```

### Built-in Plugins

**TypeScript shortcuts** (fast, one command = one shell command):

| Plugin   | Category | Default  | Shortcuts                         |
|----------|----------|----------|-----------------------------------|
| git      | dev      | enabled  | gs, gl, gd, ga, gp, gpl, gb, gst |
| npm      | dev      | enabled  | ni, nb, nd, nt, nr, nls           |
| docker   | devops   | disabled | dps, dimg, dup, ddown, dlog, dsh  |
| sysmon   | system   | enabled  | top, mem, cpu, uptime             |
| network  | system   | disabled | myip, wifi, ports, ping, dns      |
| files    | files    | enabled  | fsize, fopen, fhash, flatest, fbig|
| python   | dev      | disabled | py, pip, venv, act, freeze, pipu  |
| go       | dev      | disabled | gobuild, gorun, gotest, gotidy    |
| winutil  | system   | disabled | admin, events, sfc, winver        |
| rust     | dev      | disabled | cb, cr, ct, cc, cbr               |

**Lua plugins** (full source, disabled by default — `'plugin enable <name>`):

| Plugin           | Category | Example commands                          |
|------------------|----------|--------------------------------------------|
| fuzzy            | files    | ff, fd, frec                                |
| git_advanced     | dev      | glog, gwip, gunwip, gcln, grebase, gstash  |
| lsp_diag         | dev      | tsc, eslint, pycheck, golint, audit         |
| http             | dev      | get                                         |
| session_notes    | utility  | note, notenew, notels, notecat              |
| env_manager      | dev      | envload, envshow, envcheck                  |
| benchmark        | system   | time, bench                                 |
| process_manager  | system   | ptop, pnet, pwatch, pfind                   |
| project_init     | dev      | initts, initreact, initgo, initpy, initgit  |
| clipboard        | utility  | clip, clipclear, cliphex, clipfile          |
| todo             | dev      | todos, fixmes                               |
| docker_compose   | devops   | dcup, dcdown, dclogs, dcstats, dcexec       |
| file_ops         | files    | dup, tree, flatten, biggest, dupes          |
| system_health    | system   | health, temps                               |
| snippets         | utility  | snipset, snipget, snipls, sniprm            |
| ssh_manager      | system   | sshls, sshadd, sshkeygen, sshcopy           |

---

### The Plugin Ecosystem — Building Toward a Real Platform

Plugins are not treated as a minor extra. The intent is that if OXIS
doesn't do something out of the box, there's a plugin for it — or
you can build one — the same relationship VS Code has with
extensions. Today's `pluginManager.ts`/`pluginAPI.ts`/`luaRuntime.ts`
trio already covers discovery, load/unload, enable/disable, reload,
and disk persistence (see above). Turning that into a full ecosystem
means layering on:

| Capability                        | Status         | Notes |
|-----------------------------------|----------------|-------|
| Enable/disable/reload/list        | [shipped]      | `'plugin enable/disable/reload/list` |
| Local plugin creation             | [shipped]      | `'plugin new` |
| Community plugin install          | [shipped]      | `'market install`, see [Plugin Marketplace](#plugin-marketplace) |
| Plugin metadata (author, version, category, description) | [in progress] | present in market `index.json`; not yet required for local plugins |
| Plugin templates                  | [planned]      | `'plugin new <name> --template=devops` scaffolds a starter file per category |
| Plugin dependencies                | [planned]      | a plugin can declare other plugins it needs; OXIS enables/installs them first |
| Plugin versioning & updates        | [planned]      | semver in metadata; `'market update <name>` / `'market update all` |
| Plugin permissions                 | [planned]      | manifest declares which `oxis.*` namespaces a plugin may call — see [Core System APIs](#core-system-apis) |
| Plugin sandboxing                  | [planned]      | each plugin's Lua VM instance runs with only the capabilities its permissions grant |
| Plugin search                      | [in progress]  | `'market search <query>` exists; local `'plugin search` does not yet |
| Plugin documentation               | [planned]      | `'plugin docs <name>` renders a plugin's bundled README/help text |
| Plugin compatibility info          | [planned]      | minimum OXIS version + OS support declared in metadata, checked before install |
| Plugin categories                  | [shipped]      | already used for built-ins and market listings |
| Free / community / premium plugins | [planned]      | see [OXIS Market](#oxis-market--subscriptions--premium-plugins) |
| Plugin marketplace integration     | [in progress]  | today: static Cloudflare Pages index; planned: full Market backend |

Plugins can already reach commands, the terminal (`oxis.run`,
`oxis.echo`), themes, events, and tasks. To make "build a serious
tool as a plugin" actually true rather than aspirational, the API
surface is expanding to reach the rest of OXIS too — the built-in
editor, keybindings, workspaces, dashboards, and other plugins — see
[Core System APIs](#core-system-apis) and the extended [Lua
API](#lua-api) reference below.

---

## Core System APIs

**[planned]** — the surfaces below don't exist as `oxis.*` calls yet;
this section specifies what they need to cover so plugin authors can
build real developer tools rather than one-off scripts. Everything
here sits behind [plugin permissions](#the-plugin-ecosystem--building-toward-a-real-platform) —
a plugin has to declare what it needs before it can use it.

| System                     | Covers |
|----------------------------|--------|
| **Filesystem abstraction** | Read/write/watch files and directories through `oxis.fs.*` instead of shelling out — cross-platform paths, glob matching, file-change events plugins can `oxis.autocmd` on |
| **Process management**     | `oxis.process.*` — spawn, list, signal, and monitor processes beyond the single active PTY shell (what `process_manager.lua` currently does via raw shell commands would move onto this) |
| **Permissions**            | Per-plugin manifest listing which namespaces (`fs`, `process`, `network`, `device`, other-plugin access) a plugin may call; OXIS prompts once on install/enable, same shape as mobile app permissions |
| **Networking APIs**        | `oxis.net.*` — HTTP requests, and eventually raw sockets, gated by permission and (for premium/marketplace plugins) rate-limited so one plugin can't degrade OXIS itself |
| **Device/system APIs**     | `oxis.system.*` — CPU/memory/battery/OS info, notifications, clipboard — the pieces `sysmon.lua`/`system_health.lua` reach today via shell calls, exposed as a first-class API instead |
| **Plugin sandboxing**      | Each plugin's fengari VM instance is isolated; cross-plugin calls go through `oxis.plugins.call(name, ...)` rather than shared globals, so a misbehaving plugin can't corrupt another's state |
| **Package/plugin manager** | The install/update/dependency-resolution layer behind `'market` and (once shipped) the Market — resolves a plugin's declared dependencies before enabling it |
| **Workspace/session management** | `oxis.workspace.*` beyond the existing `oxis.workspace(path)` signal — querying active tasks, workspace-scoped plugin state, and per-workspace session persistence (see [Session Management](#session-management)) |

This is the layer that turns "Lua plugins can run shell commands"
into "Lua plugins can be real developer tools" — filesystem and
process access without shelling out, permissions so that's safe to
grant, and networking/device access so a plugin like [AI
DevTool](#ai-devops-flagship-plugin) doesn't need special-cased
access that ordinary third-party plugins can't also get.

---

## Lua API

All OXIS APIs are available to Lua plugins under the `oxis` global table.

### Commands

```lua
-- Register a command (invoked with '<name>)
oxis.command("name", function()
    -- handler
end)
```

### Shell Execution

```lua
-- Send a command to the active PTY shell
oxis.run("git status")

-- Print a message to the terminal
oxis.echo("Hello World")
```

### Themes

```lua
-- Switch to a named theme
oxis.theme("midnight")
```

### Options

```lua
-- Get or set runtime options
oxis.option("startupPage", "home")
oxis.option("shell", "powershell")

-- Read an option
local page = oxis.option("startupPage")
```

### Keymaps

```lua
-- Bind a key in normal mode
-- Supported: <C-x> (Ctrl), <A-x> (Alt), <S-x> (Shift)
oxis.keymap("normal", "<C-t>", function()
    oxis.newTerminal()
end)

oxis.keymap("normal", "<C-g>", function()
    oxis.run("git status")
end)
```

### Events (autocmd)

```lua
-- Register an event handler
oxis.autocmd("TerminalOpen", function()
    oxis.echo("Terminal opened")
end)

oxis.autocmd("ThemeChanged", function()
    oxis.echo("Theme was changed")
end)

oxis.autocmd("WorkspaceLoaded", function()
    oxis.echo("Project workspace loaded")
end)
```

### Tasks

```lua
-- Define a task (run with 'task <name>)
oxis.task("dev",     "npm run dev")
oxis.task("build",   "npm run build")
oxis.task("test",    "npm test")
oxis.task("backend", "go run .")
```

### Plugin Management

```lua
oxis.plugin.enable("docker")
oxis.plugin.disable("winutil")
```

### Workspace

```lua
-- Signal a workspace path to OXIS
oxis.workspace("C:/Projects/myapp")
```

### Terminal

```lua
-- Open a new terminal tab
oxis.newTerminal()

-- Get current working directory
local cwd = oxis.cwd()
```

### Dashboard

```lua
oxis.dashboard({
    header = "OXIS",
    theme  = "midnight",
    shortcuts = {
        "New Terminal",
        "Recent Projects",
        "Plugins"
    }
})
```

---

## Theme System

Themes are JSON objects defining 16 CSS custom properties.

### Built-in Themes

| Theme    | Style               |
|----------|---------------------|
| default  | Tokyo Night purple  |
| midnight | Deep black purple   |
| slate    | Cool blue-grey      |
| forest   | GitHub green        |
| ember    | Warm orange         |
| rose     | Soft pink           |
| dusk     | Deep violet         |
| void     | Pure black minimal  |

### Theme JSON Format

```json
{
  "name": "mytheme",
  "bg":      "#1e1e2e",
  "bg1":     "#232336",
  "bg2":     "#29293d",
  "bg3":     "#313148",
  "bg4":     "#3a3a54",
  "border":  "#45475a",
  "border2": "#8b5cf6",
  "text":    "#cdd6f4",
  "muted":   "#9399b2",
  "dim":     "#6c7086",
  "comment": "#585b70",
  "purple":  "#cba6f7",
  "purple2": "#8b5cf6",
  "purple3": "#d4bbff",
  "grey":    "#a6adc8",
  "grey2":   "#585b70"
}
```

Theme inheritance is supported via the `extends` key:

```json
{
  "name": "mytheme",
  "extends": "midnight",
  "purple": "#ff79c6"
}
```

### Theme Commands

```
'theme                  List all themes
'theme <name>           Switch theme
'theme new <name>       Open built-in theme editor
'theme delete <name>    Delete a custom theme
'theme export <name>    Export theme JSON to terminal
```

### Creating a Theme via Lua

```lua
-- In config.lua or a plugin
oxis.theme("midnight")
```

### Creating a Theme via Editor

Run `'theme new mytheme` to open the built-in visual theme editor. Adjust colors, preview live, then save. The theme is stored in localStorage and persists across restarts.

### Importing a Theme

Export JSON from another OXIS installation and run `'theme import` (planned), or paste the JSON into a `.json` file in `%USERPROFILE%\.oxis\themes\`.

---

## Workspace System

A workspace is a `workspace.lua` file that configures OXIS for a specific project. Place it at:

```
<project>/
└── .oxis/
    └── workspace.lua
```

### workspace.lua

```lua
-- Set project theme
oxis.theme("midnight")

-- Enable plugins for this project
oxis.plugin.enable("git")
oxis.plugin.enable("docker")
oxis.plugin.enable("npm")

-- Define project commands
oxis.command("dev", function()
    oxis.run("npm run dev")
end)

oxis.command("build", function()
    oxis.run("npm run build")
end)

oxis.command("deploy", function()
    oxis.run("./deploy.sh")
end)

-- Define tasks
oxis.task("frontend", "npm run dev")
oxis.task("backend",  "go run .")
oxis.task("test",     "npm test")

-- Startup notification
oxis.autocmd("WorkspaceLoaded", function()
    oxis.echo("my-project workspace loaded")
end)
```

Usage after loading the workspace:

```
'dev
'build
'deploy
'task frontend
'task backend
'task test
```

### Workspace Persistence

OXIS saves and restores per-session:

- Open tabs and order
- Active tab
- Active theme
- Active workspace path
- Command history (up to 500 entries)

---

## Command Registry

All built-in and Lua plugin commands register through the same unified registry in `terminal/commandRegistry.ts`.

### Registration

```typescript
registry.register({
  name:        "theme",
  description: "Manage themes",
  category:    "themes",
  handler:     (args, rest) => { /* ... */ },
});
```

### Lua Registration

```lua
oxis.command("hello", function()
    oxis.echo("Hello!")
end)
```

Both are dispatched identically when the user runs `'hello`.

### Built-in Command Categories

| Category  | Commands                                                   |
|-----------|------------------------------------------------------------|
| files     | new, touch, mkdir, rm, cat, ls, cd, pwd, cp, mv, write, edit, hash, size, update |
| shell     | clear, run, env, ps, kill, ip, disk, sysinfo, which, find, history, ports, user, path, alias, home |
| themes    | theme                                                      |
| plugins   | plugin, market                                              |
| workspace | task                                                       |
| info      | version, help, ?                                           |
| plugin    | All Lua-registered shortcuts                               |

---

## Event System

OXIS uses an event bus in `terminal/events.ts`. All subsystems communicate through it.

### Built-in Events

| Event               | Fired when                          |
|---------------------|-------------------------------------|
| terminal_open       | A terminal tab becomes active       |
| terminal_close      | A terminal tab is closed            |
| tab_created         | A new tab is created                |
| tab_closed          | A tab is closed                     |
| theme_changed       | The active theme changes            |
| plugin_loaded       | A plugin finishes loading           |
| plugin_unloaded     | A plugin is unloaded                |
| workspace_loaded    | A workspace.lua is applied          |
| workspace_unloaded  | Workspace is cleared                |
| command_executed    | Any command runs                    |
| shell_started       | PTY shell process starts            |
| shell_exited        | PTY shell process exits             |
| editor_opened       | Built-in editor opens               |
| editor_closed       | Built-in editor closes              |
| session_saved       | Session state is persisted          |
| session_restored    | Session state is restored           |

### TypeScript Usage

```typescript
import { events } from "./terminal/events";

// Subscribe
const unsub = events.on("theme_changed", (payload) => {
    console.log("theme is now", payload?.name);
});

// Emit
events.emit("theme_changed", { name: "midnight" });

// One-time
events.once("shell_started", () => console.log("shell ready"));

// Unsubscribe
unsub();
```

### Lua Usage

```lua
oxis.autocmd("ThemeChanged", function()
    oxis.echo("Theme changed!")
end)

oxis.autocmd("WorkspaceLoaded", function()
    oxis.echo("Workspace ready")
end)
```

---

## Keybind System

Keybinds live in `terminal/keybinds.ts`. Core binds are registered at startup; Lua plugins add their own.

### Built-in Keybinds

| Key      | Action              |
|----------|---------------------|
| Ctrl+T   | New terminal tab    |
| Ctrl+W   | Close current tab   |
| Ctrl+1–9 | Switch to tab N     |
| Ctrl+L   | Clear terminal      |
| Ctrl+C   | Interrupt (SIGINT)  |
| ↑ / ↓   | Command history     |

### Editor Keybinds

| Key      | Action              |
|----------|---------------------|
| Ctrl+S   | Save file           |
| Esc      | Close editor        |
| Tab      | Insert 2 spaces     |

### Lua Keymaps

```lua
-- Bind Ctrl+G to git status
oxis.keymap("normal", "<C-g>", function()
    oxis.run("git status")
end)

-- Bind Ctrl+T to new terminal
oxis.keymap("normal", "<C-t>", function()
    oxis.newTerminal()
end)
```

### TypeScript Registration

```typescript
import { keybinds } from "./terminal/keybinds";

keybinds.register({
    key:         "g",
    ctrl:        true,
    description: "Git status",
    handler:     (e) => { e.preventDefault(); sendToShell("git status\r"); },
});
```

---

## PTY Architecture

The PTY layer (`pty/ptyClient.ts`) is a pure WebSocket bridge with no UI, no React, and no business logic. On the Go side, `internal/pty/pty.go` holds logic shared by both platform backends — message types and `stripCtrl`, which strips ANSI/VT escape sequences (SGR colors, OSC title-set, bracketed-paste toggles, etc.) before anything reaches the frontend, since OXIS renders its own theme-driven output and doesn't want raw terminal escapes leaking through. `pty_windows.go` (ConPTY) and `pty_unix.go` (creack/pty, used by `build-linux.sh`) both call into it, so output is identical on every platform.

### Protocol

**Client → Server:**

```json
{ "type": "init",   "cols": 200, "rows": 50 }
{ "type": "input",  "data": "ls\r" }
{ "type": "resize", "cols": 180, "rows": 48 }
{ "type": "kill" }
```

**Server → Client:**

```json
{ "type": "output", "data": "..." }
{ "type": "ready" }
{ "type": "exit",  "code": 0 }
{ "type": "error", "message": "..." }
```

### Usage

```typescript
import { openPty } from "./pty/ptyClient";

const session = openPty({
    cols:     200,
    rows:     50,
    onOutput: (data) => renderOutput(data),
    onReady:  ()     => setReady(true),
    onExit:   (code) => handleExit(code),
    onError:  (msg)  => showError(msg),
});

session.write("ls\r");
session.resize(180, 48);
session.kill();
```

---

## Task Runner

Tasks are named shell commands defined in `workspace.lua` or `config.lua`.

### Defining Tasks

```lua
oxis.task("dev",     "npm run dev")
oxis.task("build",   "npm run build")
oxis.task("backend", "go run .")
oxis.task("test",    "npm test")
oxis.task("deploy",  "./deploy.sh")
```

### Running Tasks

```
'task dev
'task build
'task backend
```

Tasks run in the active PTY shell — output appears in the terminal exactly like any other command.

---

## Built-in Editor

OXIS includes a built-in editor so you never need to leave the app to edit files.

### Opening the Editor

```
'edit <file>
```

Example:

```
'edit config.lua
'edit workspace.lua
'edit src/main.go
```

### Editor Keybinds

| Key      | Action                |
|----------|-----------------------|
| Ctrl+S   | Save file             |
| Esc      | Close (prompts if dirty) |
| Tab      | Insert 2 spaces       |

The editor reads and writes files through the active PTY shell using PowerShell's `Get-Content` and `Set-Content`. This means it works anywhere the shell can reach.

---

## Auto-Update

**[shipped]** — OXIS checks `gitlab.com/oxidelab/oxis`'s latest
**Release** (not just the latest commit/push — an actual tagged
GitLab Release) against the version baked into the running binary,
and lets you know if something newer is out. It never replaces the
running `.exe` itself — Windows won't let a process overwrite its own
binary while it's executing, and there's no separate updater process
— it just hands you the link.

### How it fires

- **On startup** — once per run, ~2s after the shell connects (so a
  slow or offline GitLab never delays the shell becoming usable).
  Silent if you're up to date; a single terminal line if not:
  ```
  ↑  OXIS 1.3.0 is available (you're on 1.2.1) — run 'update to open it
  ```
- **On demand** — `'update` checks immediately and, if a newer
  release exists, opens its first `.exe`/`.msi` asset (falling back to
  the release page itself) in your default browser via the same
  `OpenURL` native call the Market's checkout flow uses.

### How the version is determined

`scripts/build-go.js`'s `VERSION` constant gets stamped into the
binary at compile time via `-ldflags -X .../wailsapp.Version=...` — a
`go run`/unlinked build falls back to `"0.0.0-dev"`, which never
reports as newer than a real release. Bump `VERSION` in
`build-go.js` (and `cmd/oxi/versioninfo.json`, so the `.exe`'s own
file-properties version matches) when you cut a release.

### What actually triggers a notification

**Pushing to a branch does nothing here.** The check hits GitLab's
`/releases/permalink/latest` API, which only returns something once
you've cut a real Release off a tag (Repository → Tags → a tag, then
Releases → New release, or `glab release create`) — not on every
`git push`. Draft/upcoming releases aren't returned by that endpoint
either.

### Files

| File                                | Role                                                        |
|--------------------------------------|--------------------------------------------------------------|
| `internal/update/update.go`          | `Check(currentVersion)` — hits the GitLab API, compares semver, never returns an error (a failed/offline check just comes back `Available: false`) |
| `internal/wailsapp/app.go`           | `Version` var (ldflags target) + `CheckForUpdate()` bound method |
| `frontend/src/native.ts`             | `checkForUpdate()` — typed wrapper around the bound method |
| `frontend/src/App.tsx`               | `'update` command + the once-per-run startup check          |
| `scripts/build-go.js`                | Stamps `VERSION` into the binary via ldflags                 |

---

## Session Management

OXIS saves session state automatically and restores it on next launch.

### Persisted State

- Open tabs and order
- Active tab
- Active theme
- Workspace path
- Command history (500 entries, localStorage)
- Plugin enabled/disabled states
- Custom themes

### Manual Session Control

```typescript
import { sessionManager } from "./terminal/sessionManager";

sessionManager.save({ tabs, activeTab, theme, savedAt: Date.now() });
sessionManager.load();   // → Session | null
sessionManager.clear();  // Wipe saved session
```

---

## OXIS Market — Subscriptions & Premium Plugins

**[in progress]** — free plugin install (`'market list/search/info/install`)
is [shipped] and documented in [Plugin Marketplace](#plugin-marketplace).
Everything below is the premium layer: the backend, the desktop
commands, and the encryption/licensing are real and working against
Stripe **test mode**; what's missing is production Stripe Price IDs
and Connect account verification, which is why every premium listing
shows `comingSoon` and can't actually be checked out yet (see
[Available Now / Coming Soon](#available-now--v121) at the top of
this document).

There is no separate "Store" — this is all still the same
`oxis-market.pages.dev` site and the same `'market` command family.

### Rules

- **Free plugins stay free**, full stop — nothing currently free
  moves behind a paywall.
- **No one-time purchases for premium plugins, and no
  cryptocurrency.** Every paid plugin is a recurring Stripe
  subscription. This applies to OXIS's own paid plugins ([AI
  DevOps](#ai-devops-flagship-plugin)) and to [third-party
  plugins](#third-party-developer-marketplace) alike.
- **Prices stay low and predictable** — a few dollars a month per
  plugin.

### Commands — real, working today

```
'market list                 Free + premium plugins together, premium
                              ones show "(coming soon)" or their price
'market search <query>       Search across the whole market
'market info <name>          Plugin details
'market install <name>       Free plugins install now; for a premium
                              plugin this checks your license and, if
                              active, decrypts+installs it (see below)
'market subscribe <name>     Opens a real Stripe Checkout session in
                              your browser for a premium plugin
'market license <email>      Set the email OXIS checks subscriptions
                              against (the one you subscribed with)
'market status <name>        Check a premium plugin's subscription
                              status right now (bypasses the 5-minute
                              cache — useful right after subscribing)
```

`'market subscribe`/`install`/`status` all refuse with a clear
"coming soon" message for any listing still marked `comingSoon` in
`index.json` — see [Available Now / Coming Soon](#available-now--v121).
That flag, not a separate code path, is what's actually gating
purchases right now.

### What's real behind those commands

- **`functions/checkout.js`** (Cloudflare Pages Function) creates an
  actual Stripe Checkout Session in subscription mode. For a
  third-party plugin (one with a `stripeConnectAccountId` in
  `index.json`) it automatically adds `application_fee_percent: 25`
  and `transfer_data.destination` — the 75/25 split happens inside
  the Checkout Session itself, not as a separate step later. Verified
  by generating a real request against a mocked `fetch` and checking
  the resulting form-encoded body is exactly Stripe's expected bracket
  notation.
- **`functions/webhook.js`** verifies the Stripe signature by hand
  (HMAC-SHA256 over `timestamp.body`, Stripe's documented v1 scheme —
  no SDK, since this project has no build step) and writes a license
  record to a Cloudflare KV namespace on `checkout.session.completed`
  and subscription update/cancel events. Signature verification was
  tested directly: a valid signature is accepted, a wrong secret, a
  tampered body, and a stale timestamp are each independently
  rejected.
- **`functions/verify-license.js`** is what the desktop app's
  `pluginLicense.ts` calls (`GET /verify-license?plugin=&email=`) —
  read-only, returns active/inactive and nothing else.
- **`functions/premium-plugin.js`** serves premium plugin *source*
  only after checking the license — deliberately NOT a static file
  under `/plugins/` the way free plugins are, since a static Pages
  site can't keep any file secret. Source lives in a separate
  `OXIS_PREMIUM_SOURCE` KV namespace instead.

### Payment

No cryptocurrency, no Payment Links, no third-party non-Stripe
provider — this Market used to integrate with a provider called
Paymento; that integration has been fully removed and replaced with
Stripe end-to-end. Real secret keys (`STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`) live only in Cloudflare Pages environment
variables / a local `.dev.vars` (gitignored) — never in this
repository, the desktop app, or any Lua plugin. See
`oxis-cloudflare-site/.dev.vars.example` for what to configure.

---

## Premium Plugin Licensing & Encryption

**[shipped]** — the encryption, local storage, and license-check
mechanics below are real, tested code
(`pluginEncryption.ts`/`pluginLicense.ts`/`market.ts`'s
`installPremium`/`loadPremiumPlugin`). What's still `comingSoon` is
being able to actually subscribe to anything — see [OXIS
Market](#oxis-market--subscriptions--premium-plugins).

Free plugins remain plain, readable `.lua` files, same as today. A
premium plugin needs a genuine licensing system, not just a hidden
file — the design has to survive a user copying the file around or
backing it up.

### Install Flow

```
User runs 'market subscribe <plugin> in the Market
        ↓
Real Stripe Checkout session opens in the browser
        ↓
Stripe webhook fires on checkout.session.completed → license
written to Cloudflare KV, keyed by plugin + email
        ↓
User runs 'market install <plugin>
        ↓
Desktop app calls /verify-license — confirms the license is active
        ↓
Desktop app fetches the real plugin source from /premium-plugin
(license-gated, never a public static file)
        ↓
Source is encrypted (AES-256-GCM) with a key derived from this
OXIS install's device ID, and written to .oxis/premium/<name>.oxispkg
        ↓
On every load (startup, or 'plugin reload), OXIS re-checks the
license is still active BEFORE decrypting into memory
        ↓
If active: decrypted into memory only, registered like any other
plugin, for that session
If not: OXIS declines to run it and says exactly why — the
encrypted file stays on disk untouched either way
```

### What encryption here actually protects — and what it doesn't

Real AES-256-GCM via the Web Crypto API, not a toy cipher — but
stated plainly rather than oversold: this protects a *distributed,
at-rest* file from casual copying and stops the plugin source from
being trivially readable by opening the file in a text editor. It
does **not**, and no client-side scheme from any vendor does, make a
plugin impossible to extract from a machine that's actively,
successfully running it — a sufficiently determined user with full
control of their own machine can always observe software they're
executing locally. This project doesn't market it as unbreakable DRM
because it isn't one; see the doc comment at the top of
`pluginEncryption.ts` for the same point in the code itself.

Concretely, what it does do:

- The encrypted `.oxispkg` file **can** be located, copied, and
  backed up freely — nothing about backups is blocked.
- Copying that file to another machine produces ciphertext that
  machine can't open — the decryption key is derived from a
  per-install device ID (`getDeviceId()`), so the same file simply
  fails to decrypt (AES-GCM fails closed on any key mismatch,
  verified in code) anywhere else.
- If a subscription lapses, the encrypted file is left alone on disk
  — `loadPremiumPlugin()` re-checks the license every time and
  refuses to decrypt/register the plugin until it's active again,
  but never deletes anything.
- Decrypted Lua source exists only in memory, inside
  `pluginManager.registerPremiumPlugin()` — a call deliberately kept
  separate from the ordinary `addLuaPlugin()` path specifically
  because that path always writes the source back to a `.lua` file on
  disk, which would put the plaintext right back next to the whole
  point of encrypting it.

### Architecture Separation

| Layer                  | Responsibility | Where |
|-------------------------|----------------|-------|
| Free/open-source plugins | Plain `.lua`, unchanged from today's plugin system | `plugins/*.lua` (Market), local `.lua` files |
| Premium plugins          | Encrypted package format (AES-256-GCM + salt/IV, versioned) | `pluginEncryption.ts`, `.oxis/premium/*.oxispkg` |
| Plugin licensing         | Maps plugin + email → entitlement | KV `license:{plugin}:{email}`, `lib/licenses.js` |
| Subscription status      | Owned by Stripe/the webhook; OXIS only ever asks "is this active?" | `functions/webhook.js`, `functions/verify-license.js` |
| Plugin encryption        | Key derivation (PBKDF2 over device ID) + encrypt/decrypt | `pluginEncryption.ts` |
| Market authentication     | Which email the desktop app checks licenses against | `pluginLicense.ts` (`'market license <email>`) |

Keeping these separate means a licensing bug can't leak encryption
keys, and a Market outage degrades to "can't verify right now"
(returned as an explicit error, not a silent false) rather than
silently disabling every premium plugin a user has already paid for.

---

## AI DevOps (Flagship Plugin)

**[shipped as a plugin, comingSoon as a purchase]** — the plugin
itself (`oxis-cloudflare-site/premium-source/ai_devops.lua`) is real,
complete Lua that makes genuine HTTP calls to an AI provider via
`oxis.net.request` and prints real replies — nothing in it is a
placeholder or a canned response. What's `comingSoon` is being able
to subscribe to it (see [OXIS Market](#oxis-market--subscriptions--premium-plugins)) —
today it needs your own API key either way (see below), so nothing
about the AI itself is gated on billing.

It's built entirely on the ordinary Lua plugin system (see [Plugin
System](#plugin-system) and [Core System APIs](#core-system-apis)) —
no AI-specific code lives in OXIS's core. In particular, it relies on
a real bug fix made alongside it: `oxis.command()` handlers used to
be unable to receive any arguments at all (every Lua plugin command
was silently arg-less); that's fixed now, which is what lets `'ai
command list all docker containers` actually see `"list all docker
containers"` as its argument instead of nothing.

**Price:** $4.99/month — set in `index.json`'s `priceDisplay` and,
once live, a real Stripe Price object; nothing about the price is
hard-coded into the plugin itself.

### Setup — needs your own API key

```
'ai key <your-api-key>          Required — nothing else works without this
'ai endpoint <url>              Optional — defaults to api.openai.com's chat completions endpoint
'ai model <name>                Optional — defaults to gpt-4o-mini
```

Works with OpenAI directly or any OpenAI-compatible chat-completions
endpoint, so it isn't locked to one vendor. Without a key set, every
`'ai` subcommand says so directly instead of faking a response.

### Commands

```
'ai explain <text>     Explain a terminal error, compiler error, or command output
'ai fix <text>         Suggest a fix for failing code or a broken command
'ai generate <text>    Generate code or a shell command from a description
'ai review <text>      Review code for bugs, security issues, and clarity
'ai debug <text>       Help debug a failure — diagnosis + next step
'ai command <text>     Turn a plain-English request into a real shell command
'ai plugin <text>      Scaffold a working Lua plugin from a description
```

Each one sends `<text>` as the user message with a task-specific
system prompt (see `SYSTEM_PROMPTS` in the plugin source) — e.g. `'ai
command` is instructed to reply with only the command, `'ai plugin`
is given OXIS's actual Lua API surface so what it generates has a
real chance of working unmodified.

Because it's a normal plugin, it's also a normal example: it needs
the `net` permission (see [Core System APIs](#core-system-apis)) to
reach an AI API and nothing else — the same permission any
third-party plugin would need to do the same thing, no special
access.

---

## Third-Party Developer Marketplace

**[in progress]** — the Stripe Connect account creation and
verification-status endpoints are real, working code today; what's
still `[planned]` is a publishing UI for a developer to list their
own plugin against their own Connect account (right now that's a
manual `index.json` edit).

The long-term goal is for other developers to publish and sell their
own subscription plugins through the OXIS Market — `network-pro` on
the live Market site is a real example of a third-party-style
listing (Oxide Labs, not OXIS itself), currently `comingSoon` while
it doesn't have a Stripe Price yet.

### Onboarding — real, working today

```
POST /connect-onboarding   { email }
  → creates a Stripe Connect EXPRESS account for the developer
  → returns a hosted onboarding link (Stripe collects KYC/bank
    details directly — OXIS never touches or stores banking info)

GET  /connect-status?account=acct_...
  → { chargesEnabled, payoutsEnabled, detailsSubmitted, readyForProduction }
```

`readyForProduction` is `true` only once both `chargesEnabled` and
`payoutsEnabled` report true — that's the actual gate referenced
throughout this document for "production payments stay off until
account verification is complete." In Stripe **test mode**, Express
test accounts typically report both as true almost immediately
(Stripe fakes KYC in test mode), which is what makes it possible to
test the entire 75/25 payout flow end-to-end before anything goes
live.

### Publishing (still manual, not yet a real dashboard)

A published plugin (free or premium) carries:

```
Name · Description · Icon · Screenshots · Version · Author
Category · Documentation · Changelog · Permissions
Compatibility · Subscription price (premium only)
stripeConnectAccountId (premium, third-party only — see index.json)
```

Every plugin is published as either:

- **Free** — works exactly like today's community `'market` plugins
- **Premium subscription** — no one-time-paid tier exists

### 75/25 Revenue Share — real, verified working

For third-party premium plugins, the developer keeps 75% and OXIS
keeps 25%, applied automatically by `functions/checkout.js` via
Stripe Connect destination charges — not a manual reconciliation
step:

```
Plugin subscription:  $10/month
Developer receives:   $7.50   (transfer_data.destination = their acct_...)
OXIS receives:        $2.50   (application_fee_percent: 25, kept on the platform account)
```

This was verified by generating an actual Checkout Session request
against a mocked `fetch` and confirming the resulting body contains
exactly `subscription_data[application_fee_percent]=25` and
`subscription_data[transfer_data][destination]=acct_...` — real
Stripe form encoding, not just plausible-looking code.

This split applies only to third-party plugins — an entry with no
`stripeConnectAccountId` in `index.json` (like [AI
DevOps](#ai-devops-flagship-plugin)) skips the split entirely; the
whole subscription is OXIS revenue. The distinction is tracked
explicitly in the Market's plugin metadata, not inferred from price
or category.

### Developer Dashboard (still [planned])

The eventual goal is a full publishing/management surface for
developers, not just a manual `index.json` PR and a `wrangler kv:key
put` for the source:

```
Create plugins · Upload releases · Manage versions
Set subscription prices · View subscribers · View installs
View revenue · View ratings · Publish updates
Manage documentation, screenshots, and permissions
```

This turns OXIS from a directory of community Lua scripts into an
actual plugin platform and marketplace, with the [Plugin
Ecosystem](#the-plugin-ecosystem--building-toward-a-real-platform)
and [Core System APIs](#core-system-apis) as the technical foundation
that makes a third-party plugin worth paying for in the first place.

### Business Model

```
                 OXIS
                  │
        ┌─────────┴─────────┐
        │                   │
     Free Core          OXIS Market
        │                   │
   Lua Ecosystem       Free Plugins
                            │
                      Premium Plugins
                            │
                       Subscriptions (Stripe)
                            │
               ┌────────────┴────────────┐
               │                         │
          OXIS Plugins          Third-Party Plugins
               │                         │
          OXIS Revenue         Stripe Connect: 75% Developer
                                            25% OXIS
```

The core OXIS experience — the terminal, editor, themes, commands,
keymaps, workspaces, and the entire free plugin ecosystem — stays
fully usable without anyone spending a cent. The Market is additional
functionality for people who want more, and a reason for developers
to build for OXIS in the first place.

---

## Open Source & Licensing Model

OXIS uses a **hybrid** model rather than being either fully open
source or fully closed. The split follows one rule: open the parts
that make the ecosystem grow, keep proprietary the parts that are
OXIS's actual competitive advantage and its ability to fund
continued development.

### Open Source

- Lua SDK / plugin API surface
- Plugin templates
- Plugin documentation
- Example plugins
- UI/component APIs (for building plugin UI)
- Community tooling
- Portions of the OXIS runtime, where it helps adoption
- Eventually, an official plugin verifier/auditor

### Proprietary

- The core OXIS application
- Premium plugin infrastructure
- The plugin encryption/licensing system (see [Premium Plugin
  Licensing & Encryption](#premium-plugin-licensing--encryption))
- The OXIS marketplace backend
- Subscription/payment infrastructure
- Any proprietary automation/system-control technology

### Why

OXIS's real advantage isn't the code by itself — it's the ecosystem:
a large, well-documented, easy-to-build-for Lua API draws developers
in, and that only works if the SDK, docs, templates, and examples are
genuinely open. But the marketplace, the licensing/encryption system,
and the core app are what make that ecosystem commercially viable at
all — those stay closed so the business built on top of the open
parts is actually sustainable.

This also determines where a contribution can land: PRs against the
Lua SDK, plugin templates, docs, and example plugins are welcome
through the normal [Contribution Guide](#contribution-guide) process;
the marketplace backend, billing, and encryption/licensing code are
not accepting outside contributions, since they're the part of the
project that isn't open source.

---

## Plugin Development Guide

### Step 1 — Create the plugin file

Easiest: `'plugin new myplugin` (opens the built-in editor, saves for
you). Or create the file directly, next to `oxis.exe`:

```
<OXIS install dir>\plugins\myplugin.lua
```

### Step 2 — Write the plugin

```lua
-- myplugin.lua

-- Commands — the 3rd argument is a real description, required for
-- good 'help output (see Plugin System)
oxis.command("greet", function()
    oxis.echo("Hello from myplugin!")
end, "say hello")

-- Shell shortcuts
oxis.command("serve", function()
    oxis.run("python -m http.server 8080")
end, "serve the current directory over HTTP")

-- Keymaps
oxis.keymap("normal", "<C-h>", function()
    oxis.echo("Help from myplugin")
end)

-- Events
oxis.autocmd("ShellOpen", function()
    oxis.echo("myplugin loaded")
end)

-- Tasks
oxis.task("start", "npm start", "start the dev server")
oxis.task("clean", "rm -rf dist", "remove build output")
```

### Step 3 — Enable the plugin

Plugins in `plugins\` (next to `oxis.exe`) are loaded automatically on
startup, in whatever enabled/disabled state you last left them in
(`'plugin enable`/`'plugin disable` — see Plugin System). A brand new
one created with `'plugin new` or `'market install` is enabled by
default.

To reload without restarting:

```
'plugin reload myplugin
```

### Step 4 — Distribute

Share the `.lua` file. Users drop it in their `.oxis/plugins/` directory.

### Lua API Reference

| API                            | Description                              |
|-------------------------------|------------------------------------------|
| `oxis.command(name, fn)`      | Register a command                       |
| `oxis.echo(text)`             | Print to terminal                        |
| `oxis.run(cmd)`               | Send to PTY shell                        |
| `oxis.theme(name)`            | Switch theme                             |
| `oxis.cwd()`                  | Current working directory                |
| `oxis.option(key, value?)`    | Get/set runtime option                   |
| `oxis.autocmd(event, fn)`     | Register event handler                   |
| `oxis.keymap(mode, key, fn)`  | Register keymap                          |
| `oxis.newTerminal()`          | Open new terminal tab                    |
| `oxis.task(name, cmd)`        | Define a task                            |
| `oxis.plugin.enable(name)`    | Enable a plugin                          |
| `oxis.plugin.disable(name)`   | Disable a plugin                         |
| `oxis.workspace(path)`        | Signal workspace path                    |
| `oxis.dashboard(config)`      | Configure dashboard                      |

The table above is what ships today. Planned additions to round out
[Core System APIs](#core-system-apis) and the [Market](#oxis-market--subscriptions--premium-plugins):

| API                              | Status    | Description                                    |
|-----------------------------------|-----------|-------------------------------------------------|
| `oxis.fs.read/write/watch(path)`  | [planned] | Filesystem access without shelling out          |
| `oxis.process.spawn/list/kill(...)` | [planned] | Process management beyond the active PTY      |
| `oxis.net.request(opts)`          | [planned] | Permission-gated HTTP requests                  |
| `oxis.system.info()`              | [planned] | CPU/memory/battery/OS info, notifications       |
| `oxis.plugins.call(name, ...)`    | [planned] | Sandboxed cross-plugin calls                    |
| `oxis.editor.buffer()/mode()`     | [planned] | Read/modify the built-in editor from a plugin   |
| `oxis.market.subscription(plugin)` | [planned] | Query a plugin's own subscription/license status |
| `oxis.permissions.request(list)`  | [planned] | Declare/request the namespaces a plugin needs   |

---

## Theme Creation Guide

### Option 1 — Visual Theme Editor

```
'theme new mytheme
```

Opens the built-in visual editor. Pick colors, preview live, save.

### Option 2 — JSON File

Create `%USERPROFILE%\.oxis\themes\mytheme.json`:

```json
{
  "name":    "mytheme",
  "bg":      "#0d1117",
  "bg1":     "#161b22",
  "bg2":     "#21262d",
  "bg3":     "#30363d",
  "bg4":     "#3d444d",
  "border":  "#30363d",
  "border2": "#388bfd",
  "text":    "#e6edf3",
  "muted":   "#8b949e",
  "dim":     "#6e7681",
  "comment": "#3b434b",
  "purple":  "#79c0ff",
  "purple2": "#388bfd",
  "purple3": "#a5d6ff",
  "grey":    "#8b949e",
  "grey2":   "#3d444d"
}
```

Then apply it:

```
'theme mytheme
```

### Option 3 — Inherit a Built-in

```json
{
  "name":    "my-midnight",
  "extends": "midnight",
  "purple":  "#ff79c6",
  "purple2": "#bd93f9"
}
```

Only overridden keys are applied; the rest inherit from `midnight`.

### Color Key Reference

| Key      | Used for                                |
|----------|-----------------------------------------|
| bg       | Main window background                  |
| bg1      | Tab bar, title bar, status bar          |
| bg2      | Cards, inputs, hover surfaces           |
| bg3      | Button backgrounds                      |
| bg4      | Scrollbars, badges                      |
| border   | Subtle borders                          |
| border2  | Active / accent borders                 |
| text     | Primary text                            |
| muted    | Secondary text                          |
| dim      | Placeholder, hint text                  |
| comment  | Very faint text                         |
| purple   | Primary accent (banner, prompts, tabs)  |
| purple2  | Secondary accent (active tab, borders)  |
| purple3  | Highlight accent (ok messages)          |
| grey     | Neutral text                            |
| grey2    | Neutral dark                            |

---

## Workspace Creation Guide

### Step 1 — Create the workspace file

```
<project>/
└── .oxis/
    └── workspace.lua
```

### Step 2 — Configure the workspace

```lua
-- workspace.lua

-- Theme for this project
oxis.theme("forest")

-- Plugins needed
oxis.plugin.enable("git")
oxis.plugin.enable("docker")

-- Project commands
oxis.command("dev", function()
    oxis.run("docker-compose up -d && npm run dev")
end)

oxis.command("logs", function()
    oxis.run("docker-compose logs -f")
end)

-- Tasks
oxis.task("frontend", "npm run dev")
oxis.task("backend",  "go run ./cmd/server")
oxis.task("db",       "docker-compose up -d postgres")

-- Notify on load
oxis.autocmd("WorkspaceLoaded", function()
    oxis.echo("myproject — docker + git + npm ready")
end)
```

### Step 3 — Load the workspace

Navigate to the project directory and OXIS will detect `.oxis/workspace.lua` automatically on the next shell session start, or run:

```
'run . .\.oxis\workspace.lua
```

---

## Contribution Guide

### Project Setup

```bash
git clone https://gitlab.com/yourorg/oxis.git
cd oxis
node scripts/setup.js
cd frontend && npm install && cd ..
npm run dev
```

### Code Style

- TypeScript: strict mode, no `any` except where documented
- Go: `gofmt`, standard library preferred
- Lua plugins: snake_case, single responsibility
- CSS: CSS custom properties for all colors, no hardcoded hex in rules

### Submitting Changes

1. Fork the repository
2. Create a feature branch (`git checkout -b feat/my-feature`)
3. Write clean, documented code
4. Test on Windows (PowerShell) and Linux (bash) where relevant
5. Submit a merge request with a clear description

### Adding a Built-in Plugin

1. Create `frontend/src/plugins/builtins/<name>.lua`
2. Add the TypeScript shortcut table to `frontend/src/plugins/loader.ts`
3. Add documentation to this README under the plugin table
4. Enable by default only if universally useful

### Adding a Built-in Theme

1. Add the theme object to `BUILTINS` in `frontend/src/terminal/themeManager.ts`
2. Add it to the theme table in this README

### File Ownership

| Area                    | File(s)                                    |
|-------------------------|--------------------------------------------|
| PTY protocol            | `pty/ptyClient.ts`, `internal/server/`, `internal/pty/` |
| Runtime mode switch     | `runtimeMode.ts`, `components/Titlebar.tsx`, `internal/appmode/`, `internal/wailsapp/` |
| Plugin marketplace      | `plugins/market.ts`                        |
| Line rendering          | `terminal/terminal.ts`, `App.tsx`          |
| Command dispatch        | `terminal/commandRegistry.ts`, `App.tsx`   |
| Plugin execution        | `plugins/luaRuntime.ts`, `plugins/pluginAPI.ts` |
| Theme application       | `terminal/themeManager.ts`                 |
| Session state           | `terminal/sessionManager.ts`               |
| Event bus               | `terminal/events.ts`                       |

---

## Screenshots

> Coming soon — submit yours via merge request.

---

## Roadmap Status Key

This README documents both what OXIS does today and where it's
headed. Every feature introduced above is tagged so it's clear which
is which:

| Tag              | Meaning |
|-------------------|---------|
| **[shipped]**      | Exists in the current codebase, usable today |
| **[in progress]**  | Partially built — some pieces exist, others don't yet |
| **[planned]**      | Specified here as a design, not yet implemented |

Untagged sections describe existing, shipped functionality (the
original core: terminal, editor, themes, commands, keybindings,
events, tasks, sessions, and the free community plugin marketplace).
Anything under [Home Screen & Workspace
Panel](#home-screen--workspace-panel), [Input Modes](#input-modes),
[Core System APIs](#core-system-apis), the [OXIS
Market](#oxis-market--subscriptions--premium-plugins) and everything under
it, and the [Open Source & Licensing
Model](#open-source--licensing-model) reflects the direction the
project is building toward — check the tag on each item, since some
of that work is already underway.

---

## License

The **core OXIS application is proprietary**, not MIT-licensed — see
[Open Source & Licensing Model](#open-source--licensing-model) for
exactly what is and isn't open. The Lua SDK, plugin templates,
example plugins, and documentation are intended to be released under
a permissive open-source license (exact license TBD — likely MIT or
Apache-2.0) once split out from the core application; until that
split happens, treat everything in this repository as proprietary
and all rights reserved.

---