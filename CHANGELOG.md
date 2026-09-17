# Changelog

All notable changes to OXIS are documented here. Dates are when the
change was made, not necessarily when a version was tagged.

## [Unreleased]

### Added

- **`oxis.platform`** — a plain `"windows"`/`"unix"` string exposed to
  Lua plugins, so a plugin can offer both a PowerShell and a bash
  version of its `oxis.run()`/`oxis.task()` scripts. Used to fix
  `cloudflare/plugins/monitoring.lua` (`'tail`, `'healthcheck`,
  `'task watch-mem`), which previously only ever wrote PowerShell and
  so didn't work on Linux/macOS at all — not just worse, not at all
  (PowerShell syntax errors, or a `Read-Host` prompt with no bash
  equivalent). Several other builtin plugins have the same
  PowerShell-only limitation and are good candidates for the same fix
  — see README § Platform Detection.
- **Named workspaces.** `'workspace init "name"` / `list` / `switch`
  / `rename` / `delete`, on top of the existing single-project
  `.oxis/workspace.lua` flow. Each named workspace is a real folder
  (`workspaces/<name>/`) with its own `documents/`, `plugins/`,
  `scripts/`, `tasks/`, and `workflows/`, isolated from every other
  workspace. `'workspace link "<path>"` / `'workspace unlink` connect
  (or disconnect) the active workspace to an existing project
  directory elsewhere on disk, without moving it into `dist/`. See
  README § Named Workspaces.
- **`created-documents/` and `created-plugins/`.** `'new` and the
  Plugin Creator now write into these dedicated top-level folders (or
  the active workspace's own `documents/`/`plugins/` if one is
  switched on) instead of wherever the shell's current directory
  happened to be. Market-installed plugins keep using `plugins/`, kept
  deliberately separate from your own.
- **`'edit` with absolute paths.** `'edit "C:\Users\...\LICENSE"` (or
  any absolute path, quoted if it has spaces) now opens exactly that
  file regardless of where it lives. Also fixes quoted arguments for
  every other `'`-command — command-line parsing is now quote-aware
  instead of splitting blindly on whitespace.
- **Undo/redo in both editors.** Ctrl+Z undoes, Ctrl+Y or
  Ctrl+Shift+Z redoes, in the file Editor and the Plugin Creator.
  Typing in Insert mode groups into one undo step per session; single
  commands (`dd`, `dw`, `x`, `o`, `O`, Tab-indent) are each their own
  step.
- **Syntax highlighting** in both the file Editor and the Plugin
  Creator — a small dependency-free highlighter (comments, strings,
  numbers, keywords, `name(` calls), based on file extension for the
  Editor and always Lua for the Plugin Creator.
- A visible **GitLab link** — a subtle, low-contrast button on the
  Home screen (next to the version number) and on the OXIS Market
  website's titlebar, both pointing at
  `https://gitlab.com/oxidelab/oxis.git`.
- `AppDir()` (`internal/wailsapp/app.go`), exposed to the frontend as
  `window.go.wailsapp.App.AppDir()` — the directory the running
  executable lives in, resolved fresh every call.

### Changed

- **Plugin Creator now uses the same Normal/Insert/Visual modal
  editing as the file Editor** (a shared `useModalEditor` hook),
  instead of a second, simpler, mode-less textarea. Fixes a bug where
  triggering the Plugin Creator while a shell session existed opened
  **two** separate editor instances at once (a duplicate root-level
  event listener rendered its own overlay copy on top of the
  Terminal's own instance) — there is now exactly one.
- **Visual mode selection is now actually visible.** It previously
  tracked an internal "anchor" but never turned that into a real,
  visible text selection — every motion collapsed the browser
  selection to a single point. Motions now extend a real selection
  from the anchor, shown via `::selection` on top of the highlighted
  text.
- **Relative file paths resolve against the app's own directory**
  (`internal/wailsapp/app.go`'s `resolvePath`), not the process's
  working directory. This is what makes `created-documents/`,
  `created-plugins/`, `workspaces/`, and `plugins/` all keep working
  correctly if the whole `dist/` folder is moved — every path
  re-resolves against wherever the executable currently is, on every
  call, rather than a cached or launch-time location.
- **WiX and NSIS installer output reorganized** into `dist/wix/` and
  `dist/nsis/` respectively, instead of loose files at the `dist/`
  root. `dist/source/` (the bundled project source, used by both
  installer paths) is unchanged. The Linux `.deb` now follows the same
  pattern — `dist/deb/` (both `build-go.js` and the standalone
  `build-linux.sh` used by GitLab CI's `build:linux` job) — so the
  installer output layout is consistent across all three platforms.
  See README § dist/ layout for the full, current tree.
- **GitLab CI fixed.** Both `build:linux` and `build:windows` were
  stuck permanently pending — tagged for runners (`linux`, `windows`)
  the project had none of. `build:linux` no longer requires a tag, so
  it runs on any available runner (including GitLab.com's shared
  ones) with zero setup. `build:windows` genuinely needs a real
  Windows machine (the MSI step uses the Windows-only WiX v3
  toolset) — the pipeline file now documents the exact
  `gitlab-runner register` steps, and the job is `allow_failure: true`
  until that's done, so it no longer blocks the rest of the pipeline.
- Both CI jobs now install Node's current LTS line (`setup_lts.x` /
  Chocolatey's `nodejs-lts`) instead of a hardcoded Node 20, matching
  the project's `"engines": { "node": ">=24.0.0" }` requirement.

### Fixed

- **`'task watch-mem` (and any other long-running foreground task)
  couldn't be stopped.** Continuous PTY output while a loop is running
  could steal keyboard focus off the terminal's hidden input, after
  which Ctrl+C reached nothing. Added a window-level Ctrl+C fallback
  that still reaches the shell as long as focus isn't in some other
  real text field and there's no active text selection (so normal
  copy still works).
- **Running a second `'`-command while a previous one was still
  waiting on interactive input (e.g. `'tail` right after
  `'healthcheck`, before answering its prompt) corrupted both.** The
  second command's own launch line was silently consumed as the
  answer to the first script's `Read-Host`, producing garbage like
  `Invalid URI: The hostname could not be parsed`. This affected
  nearly every builtin/market plugin that prompts for input — a new
  `scriptRunTracker` marks the shell busy until a script has
  genuinely finished (prompts included) and refuses to launch another
  `'`-command on top of it instead.