# Changelog

All notable changes to OXIS. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- One global command prompt, fixed above the status bar on every screen
  (Home, terminal and editor). It replaces Home's separate input. It's
  a real text field, with native selection, mouse positioning, IME and
  paste, and a drawn cursor that follows `cursorStyle`/`cursorBlink`.
- Ctrl+I jumps to the prompt; typing while nothing editable is focused
  goes into it.
- `'oxis resize` resizes the window live (presets `small`, `default`,
  `medium`, `large`, `xl`, or `WxH`). The size is saved to `window.json`
  and used on the next launch. `'oxis resize config` opens the file.
- `~/.oxis/config.lua` runs at startup; `~/.oxis/themes/*.json` adds
  themes. `'config edit` and `'config reload` manage them.
- `'theme import <file>`.
- `oxis.dashboard{ header, theme, shortcuts }` now changes Home.
- `oxis.autocmd("ShellOpen")` / `"TerminalOpen"` / `"ShellExit"` fire.
- Ctrl+Shift+C copies a terminal selection without ever interrupting.
- Right-click menu items are disabled when there's nothing to copy, and
  the menu stays inside the window.
- Go tests for escape stripping and UTF-8 splitting.

### Changed
- Up/Down history: with text typed first, only matching commands are
  shown, the oldest match stays put instead of jumping to unrelated
  entries, and Down returns to what you typed.
- Output that redraws with `\r` (progress bars) updates in place instead
  of printing a line per update. Runs of blank lines are collapsed.
- The terminal starts with the app instead of on first use, and the PTY
  is sized from the window before it is first shown, so the shell no
  longer repaints and duplicates its output.
- The Windows shell starts without PSReadLine. OXIS does its own line
  editing, and PSReadLine's redraws garbled the echoed command.
- `oxis.run()` translates `a && b` for Windows PowerShell 5.1.
- Shortcut plugins (`sysmon`, `files`, `network`, `python`, `winutil`)
  use POSIX commands on Linux.
- One shared startup update check (it used to run twice and ignored
  `updateCheckOnStartup` in the terminal).
- README, CONTRIBUTING and code comments rewritten to be shorter and to
  match the code. OXIS's own hosting is GitHub-only.
- The npm launcher downloads from the GitHub `latest-build` release.

### Fixed
- **Security:** the local PTY WebSocket accepted connections from any
  website. It now only accepts the OXIS window and its own origin.
- Windows and Linux CI builds failed (clipboard sources weren't
  committed).
- Linux builds were compiled without Wails' `desktop` tag, and without
  GTK/WebKit, so the binary couldn't start. CI now installs WebKitGTK
  4.1 and builds with `desktop,production,webkit2_41`; the `.deb`
  declares its dependencies.
- Windows builds never embedded the build commit, so they could never
  detect updates.
- Ctrl+C didn't interrupt programs when OXIS inherited "ignore Ctrl+C"
  from whatever launched it.
- Ctrl+C with output selected copies instead of killing the process,
  and the selection is no longer lost when the prompt refocuses.
- Lines were merged together (`echo hiHi`), and rows ConPTY moved to by
  cursor positioning ran into each other.
- The cwd probe's own echo and a literal `$($PWD.Path)` leaked into the
  output and the tracked directory.
- `oxis.run()` completion markers matched the command's echo, so
  commands were considered finished before they ran.
- Async command errors weren't reported.
- Helpers printed to the console instead of the terminal when the
  terminal mounted first.
- `'workspace newfile`/`newdir`/`move` lost the leading `/` on Linux.
- `extends` didn't work for custom themes.
- `/health` checked `GITLAB_TOKEN` instead of `GITHUB_TOKEN`.
- `scripts/clean-install.ps1` failed to parse in Windows PowerShell 5.1,
  and missed installs under the user profile.
- Home's "new plugin" button sent `plugin new` to the shell instead of
  running `'plugin new`.
- `ps` flags in `oxis.process.list()` on non-GNU systems, and the
  Windows version resource said 1.2.0.

### Removed
- Unused modules (`tabs.ts`, `sessionManager.ts`), 11 unused `.lua`
  copies of the shortcut plugins, and the train/splash CSS.
- Build scripts no longer delete `go.sum` and run `go mod tidy` on every
  build.

## [1.2.1]

First public release.

- Native desktop terminal (Wails v2) for Windows and Linux, also usable
  in a browser at `http://127.0.0.1:1420`.
- `'`-commands on top of PowerShell/bash, with a command registry,
  `'help`, a command palette, history search and readline keys.
- Built-in editor: Vim-style modes, tabs, file tree, find/replace, undo
  grouping, change gutter, syntax highlighting, live HTML/Markdown
  preview with Mermaid.
- Lua plugins (fengari) with manifests, permissions, dependencies,
  templates, `'plugin doctor`, 26 built-in plugins.
- OXIS Market: install, update with rollback, publish via GitHub pull
  request; premium plugin infrastructure in Stripe test mode.
- Workspaces: `.oxis/workspace.lua`, named workspaces, linked projects
  with automatic task detection, workflows, projects, git remote setup
  and `'task commit`.
- Themes with a visual editor, settings, backup/restore, diagnostics,
  and a commit-based self-updater with rollback.
