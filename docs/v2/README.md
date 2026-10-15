# OXIS 2: the native rewrite

OXIS 2 is a native application: the **OXIDE Engine** (Rust), a custom **Dear ImGui**
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
| Desktop shell | `internal/wailsapp` (Go, Wails v2) | 5.6k lines, 14 test files | Window, bindings, file access, updates, notifications, summon key. Replaced by `oxis-app` (winit + ImGui) and the OXIDE Engine. |
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
  oxide           the OXIDE Engine (package oxide-engine): ids, errors,
                  config + persistence, events, workspaces, processes,
                  terminal sessions, projects, tasks/workflows
  oxide-terminal  one terminal: PTY (portable-pty: ConPTY / Unix),
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
| 2. Foundation | Cargo workspace; the OXIDE Engine (`oxide`): errors, logging, versioned atomic config, event bus, workspace engine, process engine; tests against real processes. | Core tests pass on Windows and Linux CI. |
| 3. Native prototype | `oxis-app`: window, DPI-aware sizing, the OXIS design system on ImGui, custom title bar, sidebar, workspace switcher, terminal panel, tabs, settings. | Opens, resizes, high-DPI correct, usable on a 1366×768 laptop screen. |
| 4. Terminals | `oxide-terminal` + `oxide::terminal`: real shells (PowerShell, cmd, bash, zsh, fish), resize, input, selection, clipboard, many sessions per workspace, shell integration marks. | vim, less, htop and a REPL work; output routes to the right session. |
| 5. Editor | Documents, tabs, undo/redo, search/replace, indentation, encodings, large files; tree-sitter highlighting with fallback. | Files in at least ten languages edit and save correctly. |
| 6. Lua and plugins | `oxis-lua`: the `oxis.*` API in Rust, permissions, plugin discovery/manifests, the Market. | The 8 Market and 5 built-in plugins run unchanged. |
| 7. Projects and tooling | Detectors, tasks, workflows (sequence, dependencies, parallel, cancel), LSP client, Git, debugger adapters (DAP) where available. | Real projects in several languages build, run and test through their own toolchains. |
| 8. Hardening | Regressions, Windows and Linux verification, packaging (installer, .deb), updater, docs. | Release checklist in CONTRIBUTING passes → **v2.0.0**. |

---

## 4. Status

Kept up to date as phases land.

- **Phase 1** — done (this document).
- **Phase 2** — done, verified on Windows and Linux CI. The OXIDE
  Engine (`oxide`) has typed IDs, errors, logging, versioned atomic config
  with corrupt-file recovery and migrations, the event bus, the workspace
  engine and the process engine.
  - Workspaces: create, open, close, rename and activate. Each has its own
    folder, Git remote, environment and settings, in its own file.
  - Linking a folder records the folder's Git remote (from the Git on
    `PATH`, never installed by OXIS).
  - Environment variables are validated.
  - A failed save leaves the workspace as it was in memory.
  - Processes: real processes with line-by-line output events, input and
    exit codes. Cancelling stops the whole process tree, through Windows
    job objects and Unix process groups. Processes are owned per workspace.
  - Starting in a folder that has gone away gives a clear error.
  - All output arrives before the exit event. After a cancel, that wait is
    bounded, so something that escaped the kill can't make a command look
    like it's running for ever.
  - Ended processes are forgotten beyond a limit (256), so long sessions
    don't grow without bound.
  - 33 engine tests run against real processes, files, Git and shells.
- **Phase 3** — in progress. `oxis-app` opens a frameless native window
  (winit, and OpenGL via glutin) running Dear ImGui 1.92 through
  `dear-imgui-rs`. The OXIS design system replaces ImGui's look: IBM Plex
  Sans and JetBrains Mono are bundled as TTFs, with the default theme's
  palette.
  - Window: a custom title bar (drag to move, double-click to maximise,
    minimise, maximise and close), resize edges, a workspace switcher, a
    sidebar and a status bar. It opens at about four fifths of the screen
    and remembers its size and place, in logical pixels so a change of
    display scale keeps it sensible.
  - Home (never scrolls): workspaces from the engine (create, switch), and
    the Project panel (link a folder, the detected Git remote, the
    workspace's environment variables). Long paths are shortened from the
    middle.
  - Run view: each line runs as a real process in the active workspace's
    folder and environment, in the chosen shell. Output is streamed,
    stderr is shown in red, and each run shows its exit code. Stop, or
    Ctrl+C with an empty prompt, cancels the process tree. A shell that
    can't be started is reported. Each workspace sees only its own
    commands; a command keeps running in the background when you switch
    away.
  - Settings are saved through the engine.
  - `oxis --drive <script> [WxH]` opens a hidden window and drives the
    real interface with mouse, keyboard and text input (see
    `crates/oxis-app/src/drive.rs`). `oxis --snapshot <file.png>
    [--view=…] [WxH]` renders one view.
  - `crates/oxis-app/tests/drive.rs` uses drive mode for end-to-end tests
    on Windows and on Linux (under Xvfb with Mesa in CI):
    - commands, exit codes, Stop and Ctrl+C, and a missing program, all
      through the Run view;
    - workspace isolation: two workspaces with different folders, Git
      remotes and environments, a background command surviving a switch,
      and nothing leaking between them, in memory or on disk;
    - the minimum size (720×460) and a resize to a 1366×768 laptop size,
      with nothing blank;
    - a missing shell.
  - Not yet: docking layouts.
- **Phase 4** — in progress.
  - `oxide-terminal` runs a real shell in a pseudo-terminal (ConPTY on
    Windows, a Unix PTY elsewhere), emulated by `alacritty_terminal`.
    - Input, xterm key encoding, paste (bracketed when the program asks,
      with escape characters stripped), resize (the shell sees the new
      size), 10,000 lines of scrollback, selection and copy, colours (16,
      256 and true colour), wide characters, the alternate screen,
      answers to programs' queries, exit codes, and kill.
    - Terminals get OXIS's environment.
    - Windows' inherited "ignore Ctrl+C" is reset, so Ctrl+C interrupts
      the running command.
    - The installed shells are detected; none is ever installed.
  - `oxide::terminal` holds the sessions. Each has an ID and a workspace
    owner, and publishes events (started, output, title, bell, clipboard,
    exited, closed). A session opens in its workspace's folder with its
    environment, and closing the workspace ends it. The engine picks the
    shell for both terminals and the Run view.
  - The Terminal view has tabs and split panes (side by side or stacked,
    with draggable dividers), per workspace: switching workspaces swaps
    the layout and the shells keep running.
    - Keys go straight to the focused shell.
    - Ctrl+Shift+T / W / D / E: new tab, close pane, split right, split
      down. Ctrl+Shift+C / V: copy and paste. Ctrl+C copies when
      something is selected. Ctrl+Tab switches tabs. Shift+PageUp and
      PageDown scroll.
    - Mouse: drag to select, wheel to scroll (in full-screen programs,
      the wheel sends arrow keys). A finished shell says how it ended,
      and Enter closes it.
  - Tests:
    - 11 terminal tests against cmd (Windows) and sh (Unix).
    - 4 engine session tests.
    - 2 end-to-end window tests: a real shell with output, Ctrl+C, a
      split, closing panes and tabs, exit codes and reopening; and each
      workspace with its own terminals in its own folder and environment.
  - Still to do in this phase:
    - mouse reporting to programs;
    - search in the scrollback;
    - shell integration marks;
    - checking vim, less, htop and a REPL by hand on both systems;
    - a font fallback for symbols that JetBrains Mono lacks.
- Phases 5–8 — not started.