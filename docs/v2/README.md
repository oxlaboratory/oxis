# OXIS 2: the native rewrite

OXIS 2 is a native application: a **Rust** engine, a custom **Dear ImGui**
interface and **Lua** for plugins and automation, in one executable. It
replaces the Go + Wails + TypeScript stack of OXIS 1.x. It ships as
**v2.0.0** only when the engine and interface below are complete and
tested; until then the 1.x line carries on from `main`, and v2 is built on
the `v2` branch.

OXIS stays a *universal* development environment. Rust is what OXIS is
written in, not what its users have to write: the editor opens any text
file, projects run through whatever compilers, interpreters, build systems
and language servers the user already has, and nothing about a project's
language is hard-coded into the engine.

This document is the audit of 1.x, the architecture of 2.0, the migration
plan, and a running status. Unfinished work is listed as unfinished.

---

## 1. Audit of OXIS 1.x

| Area | Where it lives | Size | Notes for v2 |
|---|---|---|---|
| Desktop shell | `internal/wailsapp` (Go, Wails v2) | 5.6k lines, 14 test files | Window, bindings, file access, updates, notifications, summon key. Replaced by `oxis-app` (winit + ImGui) and `oxis-core`. |
| Terminal backend | `internal/pty` (Go) | 4.2k lines, 12 test files | ConPTY/Unix PTY sessions, a line-screen model, shell integration hooks (PowerShell, bash, zsh, fish), OSC 8/52/9;4/1337, asciinema recording. The hooks and OSC handling are reference behaviour for v2; the PTY layer is replaced by `portable-pty`, the screen model by `alacritty_terminal`. |
| Native Lua | `internal/luanative` (Go + C, Lua 5.4.9) | 1.4k lines | Runs plugin source in real Lua; every `oxis.*` call goes over a WebSocket to the TypeScript side. In v2, `mlua` (Lua 5.4) runs inside the engine and the `oxis.*` API is implemented in Rust. |
| Updater | `internal/update` (Go) | 0.5k lines | Downloads the `latest-build` asset, swaps it in, rolls back on a failed start. Ported to Rust. |
| UI and most behaviour | `frontend/src` (React + TypeScript) | 23.7k lines (App.tsx alone 9.7k), 24 test files | The app shell, terminal view, built-in editor, Home, themes (73 settings), settings, command palette, and also most *engine* logic: the plugin API (`pluginAPI.ts`), plugin manager, permissions, Market, workflows, workspaces, project detection, history, completion. The engine logic moves into Rust; the interface is rebuilt in ImGui. |
| Plugins | `cloudflare/plugins/*.lua`, `frontend/src/plugins/builtins/*.lua` | 8 Market + 5 built-in | Written against the `oxis.*` API. v2 keeps that API so they keep working (see §5). |
| Market and website | `cloudflare/` | — | Unchanged by the rewrite; v2 talks to the same `index.json`, `/downloads` and checkout endpoints. |
| Build and CI | `scripts/`, `.github/workflows/build.yml` | — | Builds Windows, Linux and macOS 1.x artifacts. v2 adds a Cargo job; the 1.x jobs stay until v2.0.0. |

What carries over as-is: the plugin API surface, the Market and its
protocol, the theme model (16 core colours plus options), the
per-workspace layout on disk (`workspaces/<name>/`, `.oxis/workspace.lua`),
and the project-detection rules (Node, Go, Rust, Python, Make…).

What doesn't: the WebSocket bridges, the Wails bindings, and the split
between "Go does processes, TypeScript does everything else".

---

## 2. Architecture

One Cargo workspace, one executable, crates with one job each. The engine
crates know nothing about ImGui; the app crate is the only one that draws.

```
crates/
  oxis-core       engine: ids, errors, config + persistence, events,
                  workspaces, processes, projects, tasks/workflows
  oxis-terminal   terminal sessions: PTY (portable-pty: ConPTY / Unix),
                  emulation (alacritty_terminal), shell detection
  oxis-lua        Lua 5.4 runtime (mlua), the oxis.* API, plugin loading,
                  permissions                                   [planned]
  oxis-editor     documents, undo, search, highlighting (tree-sitter with a
                  plain-text fallback), LSP client               [planned]
  oxis-app        the window: winit + Dear ImGui (imgui-rs), the design
                  system, title bar, sidebar, tabs, panes, views
```

Engine rules:

- **Explicit ownership.** Workspaces, processes, terminal sessions and
  tasks have typed IDs and one owner each. A workspace owns its sessions
  and processes; closing it ends them (or detaches them, where that's
  declared), so nothing leaks between workspaces.
- **Events, not shared state.** Subsystems publish typed events on one bus;
  the UI and Lua subscribe. The UI never reaches into engine internals.
- **Nothing blocks the frame.** Processes, PTY reads, Lua work and language
  servers run on their own threads and hand results to the UI through
  channels. Terminal output is kept in bounded buffers.
- **Real tools, real results.** Projects build, run and test through the
  user's own tools; a task is "passed" only when its exit code says so.
  Missing tools are reported by name, never installed silently.
- **Durable config.** Settings, workspaces and layouts are versioned JSON
  written atomically (temp file + rename); a corrupt file is kept aside and
  replaced with defaults, with a diagnostic, instead of crashing.

### Universal language support

- The editor opens any file as text. Highlighting comes from replaceable
  language definitions (tree-sitter grammars), chosen by extension or
  first line, with plain text as the fallback.
- Language intelligence comes from language servers over LSP, configured
  per language; built-in defaults are just entries in that table. OXIS
  never downloads a server without the user agreeing to it.
- Projects are found by configurable detectors (Cargo.toml, package.json,
  CMakeLists.txt, go.mod, pyproject.toml, Makefile, *.csproj, …) that
  *suggest* build/run/test commands. The project's own files stay the
  source of truth; an optional `.oxis/project.toml` adds or overrides
  commands, environment and language servers. Anything else runs through
  user-defined commands and the real terminal.

---

## 3. Migration plan

| Phase | What | Done when |
|---|---|---|
| 1. Audit | This document. | ✅ |
| 2. Foundation | Cargo workspace; `oxis-core`: errors, logging, versioned atomic config, event bus, workspace engine, process engine; tests against real processes. | Core tests pass on Windows and Linux CI. |
| 3. Native prototype | `oxis-app`: window, DPI-aware sizing, the OXIS design system on ImGui, custom title bar, sidebar, workspace switcher, terminal panel, tabs, settings. | Opens, resizes, high-DPI correct, usable on a 1366×768 laptop screen. |
| 4. Terminals | `oxis-terminal`: real shells (PowerShell, cmd, bash, zsh, fish), resize, input, selection, clipboard, many sessions per workspace, shell integration marks. | vim, less, htop and a REPL work; output routes to the right session. |
| 5. Editor | Documents, tabs, undo/redo, search/replace, indentation, encodings, large files; tree-sitter highlighting with fallback. | Files in at least ten languages edit and save correctly. |
| 6. Lua and plugins | `oxis-lua`: the `oxis.*` API in Rust, permissions, plugin discovery/manifests, the Market. | The 8 Market and 5 built-in plugins run unchanged. |
| 7. Projects and tooling | Detectors, tasks, workflows (sequence, dependencies, parallel, cancel), LSP client, Git, debugger adapters (DAP) where available. | Real projects in several languages build, run and test through their own toolchains. |
| 8. Hardening | Regressions, Windows and Linux verification, packaging (installer, .deb), updater, docs. | Release checklist in CONTRIBUTING passes → **v2.0.0**. |

---

## 4. Status

Kept up to date as phases land.

- **Phase 1** — done (this document).
- **Phase 2** — in progress on the `v2` branch.
- Phases 3–8 — not started.

## 5. Plugin compatibility

v2 keeps the 1.x plugin contract: `--[[@manifest ... ]]` headers,
declared permissions, and the `oxis.*` functions documented in the
README's Lua API section. Each API call is ported with a test; a call that
isn't ported yet fails with a clear message naming it, rather than doing
nothing. Plugins that need a change get a migration note in the changelog
before v2.0.0.
