# Changelog

All notable changes to OXIS. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- Plugin APIs for things that happen over time:
  - `oxis.process.spawn` runs a program (or a command line) and gives
    the plugin its output as it's printed, line by line if asked, with
    stdin, the exit code, and `kill()`, which stops the whole process
    tree (job objects on Windows, process groups elsewhere).
  - `oxis.fs.watch` reports changes to a file or folder (recursive,
    with ignored names and debouncing; an editor's save is one `write`).
  - `oxis.net.stream` delivers an HTTP response as it arrives, parsing
    server-sent events and JSON lines, so an AI assistant's answer
    appears as it's written. OXIS makes the request itself (no CORS).
  - All three come from Go through one long poll with backpressure: a
    program printing faster than the window can show it is slowed down
    rather than filling memory. What a plugin starts stops when it's
    unloaded, and when OXIS closes.
- `oxis.editor`: read the open file, its cursor and selection; insert,
  replace lines, select, save and open files; `oxis.editor.on("open" |
  "change" | "save" | "close")`. A plugin's changes are undoable, and a
  streamed run of them is one undo step.
- `oxis.json.encode` / `oxis.json.decode`.
- `autotest` in the Market: `'autotest` re-runs a project's tests every
  time a file is saved (npm, Go, Cargo or pytest, detected; or any
  command) and prints one line, pass with the time taken or fail with
  the failing test and actual versus expected. Built on `oxis.fs.watch`
  and `oxis.process.spawn`.
- The editor shows pictures (png, jpg, gif, webp, avif, bmp, ico, svg)
  in an image viewer with zoom and a transparency checkerboard, instead
  of their bytes; an SVG can still be edited as text. Other binary files
  get a notice.
- Colour output: the colours and styles programs print (git diffs,
  test runners, linters, PowerShell errors) are shown instead of
  stripped: 16 theme colours, the 256-colour palette and 24-bit colour,
  with bold, dim, italic, underline, inverse and strikethrough. Sixteen
  "Terminal colours" theme keys (`ansiRed`, `ansiBrightBlue`, …) set
  the palette; `'config set ansiColors false` turns colour off. Shells
  are told 24-bit colour works (`COLORTERM=truecolor`).
- `'theme import` accepts a Windows Terminal colour scheme and builds a
  whole OXIS theme from it.
- `oxis.command` handlers get a third argument, `raw`: the text after
  the command name exactly as typed, quotes, backslashes and tabs
  included (`args` and `rest` stay as they were).
- `oxis.net.request` takes a `timeout` (seconds, default 60). In the
  desktop app OXIS makes the request itself, so local and self-hosted
  servers without CORS headers are reachable.
- Lines starting with a space, and lines that hand over a secret
  (`'ai key …`, `export GH_TOKEN=…`), aren't saved to history.
- `OXIS_PTY_TRACE=<file>` records the shell's raw output for bug reports.
- `'version` shows the build number, commit, release tag (`git
  describe` style), channel (CI `latest-build`, self-update or local
  source build), build and commit dates, update status, OS release,
  shell and engine versions; `'version --json` and `'version --copy`
  for bug reports. Home shows the build number and commit next to the
  version.
- Builds are stamped by one script (`scripts/buildstamp.js`) for both
  the binary and the page, so they always agree. CI tags each new
  `package.json` version as `v<version>` automatically.
- `'update` says how many commits behind `main` a build is, links the
  comparison, and no longer offers an "update" to a local build that is
  ahead of `main`.
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
- Themes can now set much more than colours: status, interface, syntax
  and sky colours, font, size, line height, letter spacing, weight,
  ligatures, corner radius, padding, scrollbar width, a glow, cursor
  shape and blink, the prompt label, whether the sky and corner mark
  show, a background image or gradient (with strength, blur and fit),
  and extra CSS. Anything a theme leaves out is derived from its core
  colours.
- `'theme set <key> <value>`, `'theme unset <key>` and `'theme keys`
  change and list options from the terminal (a built-in theme gets a
  `-custom` copy); `'theme edit` reopens a theme in the editor.
- The theme editor has a control for every option (colour pickers,
  sliders, choices, a CSS box), grouped into sections, with per-option
  reset and a "start from" theme.
- Two new built-in themes: `paper` (light) and `matrix`.
- OXIS reopens the named workspace you were last in.
- README screenshots of the desktop app and browser mode, and a gallery
  of every built-in theme.

### Changed
- Much faster terminal output. Output is applied at most once per frame
  (every 48 ms while a program floods it) instead of once per message,
  and the scrollback renders in blocks the browser skips while they're
  off screen. Printing 20,000 lines went from frames of up to 617 ms
  (4.5 s of the window frozen) to a steady 60 fps, and scrolling back
  through a full scrollback no longer stalls for seconds. The blinking
  prompt caret no longer restyles the page every frame while idle.
- The night sky's moon is one simple round moon, the same every night,
  instead of eight phase glyphs of different sizes.
- The README's demo is a recording of the real app (`assets/demo.gif`):
  every frame a screenshot of OXIS running git, a workflow, a Market
  install and a theme switch in a real project. It replaces a drawn SVG
  whose output was made up, and has no glow. New screenshots show
  `autotest` and the image viewer.
- The website's live demo prints what OXIS actually prints for those
  commands (the same session), instead of invented output; commands it
  can't show honestly say they'd run in your shell. Its gallery opens
  with the recording.
- The README's badge and the website show how many times OXIS has been
  downloaded. CI used to lose the count every time it replaced the
  `latest-build` files; it now carries it forward in the release notes.
- When OXIS can't write next to its executable (a `.deb` in `/usr/bin`)
  its data goes in the platform's per-user folder,
  `$XDG_DATA_HOME/oxis` (`~/.local/share/oxis`) or
  `%LOCALAPPDATA%\OXIS`, instead of `~/Downloads/OXIS`. An existing
  `~/Downloads/OXIS` keeps being used, so nothing moves.
- The README opens with what OXIS is and how to get it: a tagline, an
  animated demo, a feature grid, one-line installs, a short tour, a Lua
  example, screenshots and a roadmap; the full documentation follows.
  `assets/social-preview.png` is the card for link previews.
- The licence file is `LICENSE` (it was `license`, so links to
  `LICENSE`, including the website's, were broken on GitHub).
- The website's "watch demo" button only appears on plugins that have
  a demo video; `demoVideo` is optional.
- The website (`cloudflare/`) is now a full landing page: an animated
  hero with a live, typeable OXIS demo terminal, the current version,
  build number and commit pulled from GitHub, a download button for the
  visitor's OS, feature and theme sections (picking a theme recolours
  the page), a screenshot tour, install steps and an FAQ. The Market
  keeps its search, filters and checkout, and each card shows its
  `'market install` command. Screenshots are served as WebP, and the
  site links only to GitHub.
- `npm run deploy:site` deploys the website and Market backend to
  Cloudflare Pages, uploading only the public files. The site has a
  404 page, so a missing plugin file is a 404 instead of the home page
  served as `.lua`, and its plugin cards show the same versions as
  `index.json`.
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
- `'edit <relative path>` opens from the shell's current folder (like
  every other command), falling back to the data folder.
- `'update` in a browser tab says updates are a desktop-app feature;
  on a build without a commit stamp it shows the latest commit, and
  `'update install --force` installs it.
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
- `'plugin publish` (and unpublish, paid-plugin onboarding, checkout,
  license checks and premium downloads) couldn't reach the Market from
  the desktop app: the page's JSON requests failed their CORS preflight
  ("Failed to fetch"). OXIS now makes Market requests itself, and the
  backend answers the preflight for OXIS in a browser tab.
- A published plugin never appeared on the website: its card had to be
  added to `index.html` by hand, and the site only changed when
  redeployed. The website now builds a card for every plugin in
  `index.json`, read from `main`, and `'market` reads the same list, so
  a merged plugin is listed and installable straight away. Its entry
  now carries its permissions, platforms, size and minimum OXIS version.
- The website's download button offered a made-up placeholder `.lua`
  when it couldn't fetch the real file.
- `'edit assets/logo.png` on Windows opened `C:\proj\assets/logo.png`,
  mixing separators; the path now uses backslashes throughout.
- `oxis.autocmd("EditorClosed")` fired when a file was saved, not when
  it was closed. Saving now fires `EditorSaved`.
- Numbers reached Lua as floats, so `"status " .. res.status` read
  `status 200.0`. Whole numbers are Lua integers now.
- An error in a plugin call (a denied permission, a bad argument)
  escaped the Lua state instead of being a Lua error `pcall` can catch.
- Spaces ConPTY draws by moving the cursor (after the prompt, between
  coloured runs) were lost, so `PS C:\> git` showed as `PS C:\>git`.
- The MSI installed to `C:\Users\<name>OXIS` (a lost backslash) instead
  of `C:\Users\<name>\OXIS`. That folder isn't writable, so OXIS put
  its data in `~/Downloads/OXIS`. Installed properly it writes next to
  itself again, and copies any data from `~/Downloads/OXIS` over once.
  Installing another build of the same version now replaces the old
  one instead of adding a second install.
- The editor's live preview didn't look like the real page: module
  scripts, images, fonts and CSS `url()`s didn't load, and a README's
  images were missing. The page is now served from its own folder.
- Closing the last file with the file tree open left an empty editor.
- Website on phones: the menu was see-through, the code tabs and copy
  button were cut off, and several texts wrapped badly.
- A build of unpushed local work was told a "newer build" was
  available, because GitHub couldn't compare a commit it doesn't have.
  OXIS now compares commit dates in that case and says it's local work.
- The website's screenshots were squashed and stretched their rows, and
  the Market cards' hover lift never worked.
- `'update install` ended with "(intermediate value) is not iterable":
  the update had installed and started, but the old window never
  closed. A Go test now rejects any bound method whose result the page
  can't receive.
- Vim-mode `j`, `k`, `0`, `$` and `dd` misbehaved on an empty first line.
- Uninstalling a premium plugin left its package behind, so it came
  back on the next start.
- **Security:** the local PTY WebSocket accepted connections from any
  website. It now only accepts the OXIS window and its own origin.
- **Security:** restoring a backup or importing a workspace export could
  write files anywhere on disk through `../` paths in the file. Unsafe
  paths are now refused and reported.
- **Security:** the updater accepted a download URL from anywhere; it
  now only installs builds from this project's GitHub releases. Market
  plugin names that aren't plain file names are ignored.
- Typing lagged with a long scrollback (about 50 ms per key at 9,000
  lines); output lines no longer re-render on every keystroke.
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
- Colours that ignored the theme: neon-green selection, highlights, Home
  banner letters and success lines in every theme, and a lavender editor
  selection and search highlight.
- `'update` said "up to date" when GitHub couldn't be reached, in a
  browser tab, and on builds without a commit stamp.
- A successful `'update install` started the new version with a hidden
  window.
- Switching to a named workspace asked "Plugin __workspace__ wants to
  switch/load OXIS workspaces": your own workspace, config, task and
  workflow files are trusted and no longer get permission prompts.
- Home kept showing "git: not connected" after `'workspace github` until
  you switched workspaces.
- The theme editor was taller than the space between the title bar and
  the prompt, hiding its header and buttons.
- Workflow shell steps never failed: a step counted as passed whenever
  its command finished, so `retry`, `continueOnError` and "workflow
  failed" never applied. OXIS now reads each command's exit status (and
  shows it when a step fails); `oxis.run()` reports it too.
- A project file with a line break in a script or target name stopped
  the whole `auto-detected.lua` tasks file from loading.
- `'task commit` could wait on a git credential prompt it can't show;
  git now fails straight away with an authentication error (credential
  managers with their own window still work).
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
