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
- Cut / Copy / Paste / Select All right-click menu on every text field
  and in the editor (the desktop window has no browser menu).
- The status bar confirms every copy ("copied 14 chars").
- An in-app confirm dialog replaces the system "wails.localhost says"
  boxes (discarding edits, multi-line paste, restore, theme delete).
- `oxis.quote(text)` quotes an argument for PowerShell or bash, so
  plugins can pass user input to `oxis.run()` safely.

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
- Copy and paste use the native clipboard first in the desktop app, so
  they work even when the WebView's clipboard API is unavailable.
- Pasting several lines runs the complete ones and leaves the last,
  unfinished line in the prompt. It used to wait in the shell's hidden
  input and join onto the next command.
- Paste and cut work in the editor's Normal mode.
- Typing while the prompt isn't focused no longer drops or reorders
  fast keystrokes.
- Clouds on Home move together and no longer overlap each other or the
  sun.
- Shortcut plugins (`sysmon`, `files`, `network`, `python`, `winutil`)
  use POSIX commands on Linux.
- All 16 Lua plugins work on Linux as well as Windows, take their input
  as arguments (asking only when it's missing), and describe every
  command in `'help`. Multi-line `oxis.run()` scripts run from a temp
  bash file on Linux, like the `.ps1` on Windows.
- `docker_compose` uses Compose v2 (`docker compose`) and accepts
  service names; `'dcprune` lets Docker ask before deleting.
- `file_ops`: `'dup` is now `'fdup` (it clashed with the docker
  plugin's `'dup`) and copies next to the original. `'tree` takes a
  depth and really skips `node_modules`.
- `git_advanced`: `'gblame <file>` runs `git blame`; `'greset` asks
  before discarding changes; `'gshow` and `'grebase` take arguments.
- The `network` plugin no longer has its own `'ports`, which replaced
  (and, once the plugin was disabled, removed) the built-in one.
- Existing files are never overwritten by `project_init`.
- `latest-build` now always points at the commit its files were built
  from (CI moves the tag on every published build).
- One shared startup update check (it used to run twice and ignored
  `updateCheckOnStartup` in the terminal).
- README, CONTRIBUTING and code comments rewritten to be shorter and to
  match the code. OXIS's own hosting is GitHub-only.
- The npm launcher downloads from the GitHub `latest-build` release.

### Fixed
- **Security:** the local PTY WebSocket accepted connections from any
  website. It now only accepts the OXIS window and its own origin.
- **Security:** answers to password prompts (`sudo`, `ssh`, git,
  `Read-Host -AsSecureString`) were shown in the prompt and saved to
  command history. The prompt is now masked there and the answer is
  never recorded.
- `git log`, `git diff`, `man` and other paged output stopped at a
  `less` prompt the line-based terminal can't drive. The shell now
  starts with `PAGER=cat` and `GIT_PAGER=cat`.
- On Windows, a line longer than the terminal that wrapped while at the
  bottom of the screen was split in two with a character repeated, in
  the output and in anything copied from it.
- Escape sequences and CRLFs cut in half by the end of a PTY read are
  now joined with the next read instead of leaking as text.
- Multi-line plugin scripts with non-ASCII text were garbled in Windows
  PowerShell 5.1.
- A command's completion marker could leak into the output (e.g. at the
  end of `'glog`) and leave OXIS thinking the command was still running
  when the marker arrived split across two reads. The cwd probe had the
  same problem.
- Lua plugin bugs: `'sshls`/`'sshadd`/`'sshcopy` assigned PowerShell's
  read-only `$host`; `'get`, `'time` and `'bench` ignored their
  arguments; `lsp_diag` piped to `head`, which PowerShell doesn't have,
  and used ESLint options removed in ESLint 9; `'clipclear` failed on
  Windows PowerShell 5.1; `'ping4` only worked on PowerShell 7;
  `'todos` matched any "note" in prose; `'pnet` cut its table after
  formatting it.
- `'gc`, `'gco`, `'fsize`, `'fopen` and `'fhash` broke on arguments with
  quotes or spaces.
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
