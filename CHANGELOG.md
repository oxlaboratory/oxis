# Changelog

All notable changes to OXIS. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- `'broadcast` (or ⇶ on a split tab's panes): what you type in one
  pane — commands, Enter, Ctrl+C — runs in every pane of the tab.
- `'record [name]` / `'record stop`: a tab's session saved as an
  asciinema cast (`created-documents/recordings/`), with ● REC and the
  time in the status bar. `asciinema play` and asciinema.org play it.
- Tab completes SSH hosts after `ssh`, `scp`, `sftp`, `mosh` and `rsync`
  (from `~/.ssh/config`, `known_hosts` and earlier commands, keeping a
  `user@`; scp's ends in `:`), and Makefile targets after `make`.
- A Settings window (**Ctrl+,** or `'settings`): every setting, grouped
  and searchable, with switches, lists, sliders and resets; sounds play
  from it and the shell list shows the shells installed. `'config` still
  works the same.
- Sound effects: a soft sound when a command fails or a long one
  finishes, a program rings the bell, a tab opens, something's copied or
  a plugin installs. `'sound` lists, plays and changes them — twelve
  synthesised sounds or your own files (`'sound set error nope.wav`,
  `'sound pack <folder>`); `'sound volume`, `'sound off`. Plugins get
  `oxis.sound()`.
- Demo videos for every Market plugin, on its card at oxis.space and in
  `'market info`. Publishing takes an optional demo: `demo:` in the
  manifest or `'plugin publish <name> --demo=<link>` (YouTube, Vimeo,
  Loom or a video file).
- Real download counts for every plugin, on its card and in
  `'market info`: `'market install` and the site's download button each
  count once a day per address (setting `countInstalls`).
- Quick select (**Ctrl+Shift+Space**): the URLs, paths, file:line,
  git hashes, IPs and numbers on screen get letters; type one to copy
  it, Shift+letter to put it in the prompt. No mouse needed.
- A summon key: **`` Win+` ``** brings OXIS to the front from any
  program, ready to type, and pressed again tucks it away (Windows;
  setting `summonKey`, e.g. `Ctrl+Alt+T`, or empty for none).
- **Open in OXIS**: the Windows installer adds it to Explorer's
  right-click menu (folders, and the space inside one), and
  `oxis <folder>` works from anywhere. The folder opens as a tab in the
  OXIS already running (brought to the front), or starts one there.
- Save a tab's output to a text file: **Save Output to File…** in the
  output's right-click menu, or `'save-output [name]` (into
  `created-documents/`, with a link to it).
- The command palette (Ctrl+Shift+P) also finds shell commands you've
  run before; choosing one runs it again.
- Five more Market plugins: **git-tools** (recent branches to switch
  to, a cleanup of merged branches, undo the last commit), **scripts** (run a project's package.json
  scripts and Makefile targets from a numbered list), **docker** (a live
  container list, streamed logs, prune after asking), **json**
  (pretty-print, validate and query JSON files) and **timer** (a
  countdown that ticks in place, and pomodoro).
- Scrolled up into a command's output, its command line stays pinned at
  the top (click it to jump there).
- Fold a command's output: hover its line and click ▾; it shows
  "▸ 120 lines" until you click again.
- Searching the output (Ctrl+Shift+F): an upper-case letter makes it
  match case, and `/…/` searches with a regular expression (`/…/i`
  ignores case).
- Right-click a tab: Rename Tab… (or double-click its name; the name
  comes back with the session), Duplicate Tab (same folder and shell),
  Close Tab, Close Other Tabs.
- Drag a tab along the strip to move it.
- Setting `startIn`: `terminal` opens straight into the shell instead
  of Home.
- Setting `copyOnSelect`: selecting output copies it, as in Windows
  Terminal and PuTTY (off by default).
- Progress from programs (OSC 9;4: winget, PowerShell 7.4+, cargo…)
  shows in the status bar: a bar with the percentage, "working…", or
  red when it failed. On Windows the taskbar button shows it too, as
  in Windows Terminal. It goes when the program says so or its command
  ends.
- OSC 52: programs that copy to the clipboard (tmux, Neovim, a remote
  shell) can, in the line view and in full-screen programs; the status
  bar says each time. Reading the clipboard this way is never allowed.
- OSC 8 hyperlinks: text a program links (`ls --hyperlink`, gcc,
  cargo, `gh`, delta…) is clickable, web links in the browser and
  `file://` ones in the editor. They used to show as plain text.
- Choose the shell in OXIS: `'shell` lists the ones on this machine
  (PowerShell 7, Windows PowerShell, Git Bash, WSL, cmd; or `$SHELL`,
  zsh, bash, fish), `'shell gitbash` opens a tab with one, and
  `'config set shell <name>` sets what new tabs start. Right-click a
  "+" for the same list, or a pane's split buttons to split with one. Before, only the `OXIS_SHELL` environment
  variable could.
- macOS: an app menu (⌘Q, ⌘H), a Window menu, and an Edit menu whose
  ⌘C ⌘V ⌘X ⌘A ⌘Z ⌘⇧Z work in the prompt and the editor (undo is the
  editor's own, and pasting several lines still asks first).
- macOS: ⌘ works for OXIS's shortcuts (⌘T, ⌘W, ⌘=, ⌘⇧P, and in the
  editor ⌘S, ⌘F, ⌘Z, ⌘⇧Z…), ⌘K clears and ⌘F searches the output; Ctrl
  stays the shell's and ⌘C/⌘V/⌘X/⌘A the system's.
- A macOS build (Apple silicon), as a preview: `OXIS.app`, zipped, in
  the `latest-build` release. CI builds it and runs the Go tests on
  macOS; it hasn't been tried on a Mac yet. System stats (`'mon`,
  `oxis.system.info`) read macOS's own counters.
- A long command (10 s or more, setting `notifyAfter`) that finishes
  while OXIS is in the background flashes its taskbar button on Windows
  until you come back.
- Right-click a command's output for **Run Again**, **Copy Command**
  (as typed, without the prompt), **Copy Output** or **Copy Command and
  Output**.
- Suggestions from history as you type, as in fish: the rest of the
  newest command starting with what's typed shows dim after the cursor,
  and →, End, Ctrl+F or Ctrl+E at the end of the line takes it.
- Clickable compiler output: relative paths (`src/app.ts:12:5`,
  `src/app.ts(12,5)`, `./main.go:40`, Python's `File "…", line 3`) open
  in the editor at that line and column, from the shell's folder. Only
  absolute paths were links before, and a `:line` after one broke it.
  A path in several colours is one link; a missing file says so.
- Tab completes shell commands in the prompt, the same in bash,
  PowerShell, cmd or zsh: files and folders where the shell is (only
  folders after `cd`, Git Bash `/c/…` paths too), subcommands of
  docker, kubectl, cargo, go, npm, gh, pip, winget and dotnet, git's
  long options (`git log --on` → `--oneline`), git subcommands and
  aliases, branches, remotes and changed files (`git add`), package.json
  scripts after `npm run`, `pnpm`, `yarn` or `bun run`, programs on
  PATH (`wing` → `winget`), commands used before, and in PowerShell its everyday cmdlets (`get-chi` →
  `Get-ChildItem`). When several match, it fills in what they share and lists them.
  Tab used to go to the shell without the typed text, so it did nothing.
- Tab in a REPL (node, python, irb…) hands what's typed to it with the
  Tab, so the REPL's own completion fills in its line; typing on and
  Enter add to it, and Backspace on an empty prompt edits it.
- Git Bash on Windows gets shell integration (exit marks, Ctrl+↑/↓,
  exact directory tracking) when `OXIS_SHELL` is just its bash.exe.
- Writing a plugin: in a Lua file, typing a dot after `oxis`,
  `oxis.fs`, `oxis.process`, `oxis.editor`… (or `string`, `table`,
  `math`, `os`, `utf8`, `coroutine`) lists that library's functions with
  their arguments.
- Plugins run on real Lua 5.4.9 inside OXIS instead of fengari's Lua
  5.3 in the page: each in its own thread, so a busy or stuck plugin
  can't freeze the window (and unloading one stops it mid-loop). The
  whole standard library, `require` from `~/.oxis/lua` and LuaRocks'
  tree, and Lua C modules (luafilesystem, luasocket, lua-cjson…: on
  Windows they share OXIS's `lua54.dll`). Lua's file, process and
  native-code functions follow the plugin's permissions (`fs`, `shell`,
  and the new `native`); `os.exit` is refused and precompiled chunks
  aren't loaded. `'version` and `'plugin info` say what plugins run on;
  `'config set luaEngine fengari` goes back to the old engine, and a
  build without a C compiler uses it by itself.
- While the editor fills a pane, what a command run at the prompt
  prints shows in a panel under the editor, instead of out of sight
  behind it.
- The editor's Vim keys grew from a handful to the everyday set: counts
  (`3j`, `2dd`, `d3w`), `e` `^` and `5G`, `yy`/`yw`/`y$` with `p` and
  `P`, `D` `C` `cc` `cw` `s` `S` `r` `X`, `dj`/`dk`/`de`/`db`, `J`, `~`,
  `>>`/`<<`, `u` and Ctrl+R, `/` `n` `N` `*` `#`, and in Visual mode
  `c` `s` `p` `~` `>` `<`. `j` and `k` keep the column they started
  from across shorter lines.
- `oxis.line(text [, kind])` for Lua plugins: a line that `l:set()`
  redraws in place, for animations and progress; `oxis.every` now runs
  as often as every 0.03 s.
- games 2.1.0 animates: the pokie reels spin and stop left to right
  and wins count up (a big win flashes), the coin spins in the air
  before it lands, the die tumbles. Ctrl+C shows the result at once and
  leaves the table.
- File tree: right-click a file or folder for Rename (F2; typed in
  place, the name without its extension selected, and files open in the
  editor follow), Duplicate (Ctrl+D; "name copy", "name copy 2"…, whole
  folders too) and Delete… (Delete key; moves it to the Recycle Bin, the
  Trash on macOS and Linux, after a confirmation in the menu).
- Plugins can talk and keep time: `oxis.ask(question, fn)` takes the
  next line typed as the answer (the prompt shows whose question it is,
  Ctrl+C cancels), `oxis.after`/`oxis.every` run later or repeatedly (a
  `foreground` one stops on Ctrl+C), `oxis.store` keeps a plugin's own
  values between runs, `oxis.input` fills the prompt, and
  `oxis.fs.search` is the editor's Search in files.
- `oxis.system.info` reports the machine now: CPU use, memory, uptime,
  load and disks; `oxis.process.list` gives each process's memory (and
  CPU on Linux); `oxis.net.request` says how long a request took (`ms`).
  `'sysinfo` and `'disk` read these directly instead of running a shell
  command.
- New built-in plugins (`'plugin enable <name>`): **notes** (project notes
  and tasks), **todo** (every TODO/FIXME linked to its line), **snippets**
  (saved commands with arguments), **http** (requests with laid-out JSON)
  and **env** (`'dotenv`: .env masked and checked against .env.example).
- Market **games** 2.0: a pokie machine, blackjack with doubles and
  splits, dice you call (and call again with "yes 5"), coin tosses,
  guess-the-number and hangman, sharing one chip bank.
- Market **monitoring** 2.0: live CPU/memory, top and growing memory
  users, followed logs, health checks with up/down changes, alerts.
- Home's sky is the theme's to change: `skyMode` sun or moon only (or
  auto, by the clock), `cloudCount`, `cloudSpeed`, `starCount`, your own
  pixel art for the sun and moon (`sunArt`, `moonArt`), or a picture in
  its place (`skyImage`). All in the theme editor's Sky group too.
- The download count includes `'update install`s that build from source
  (a prebuilt download was already counted by GitHub): the app adds one
  to the count at oxis.space, with no ID or data, at most once a day per
  address; setting `countInstalls` turns it off. The README badge and the
  website show the total, which keeps every download counted so far.
- The file tree's right-click menu: New File and New Folder (in the
  folder clicked, a file's own folder, or the project for empty space),
  named in a row in the tree; a new file opens in the editor.
- A new terminal tab or pane says when a newer OXIS build is waiting.
- New tabs and split panes open in the folder you're working in (the
  focused pane's), not the default one; setting `newShellHere`.
- `npm run dev` hot-reloads: the real window with its UI served by
  Vite, so a frontend change appears as you save without a reload, and
  the shells (and what's running in them) carry on. Go changes rebuild
  only the Go binary and reopen the window. The terminal no longer ends
  its shell when React runs its effect again (a hot reload, StrictMode);
  only closing the tab or pane does. `vite dev` works at all now (the
  Lua runtime needed `process.env` defined for the dev bundle).
- Frontend tests (Vitest, `npm test` in `frontend/`, run in CI): output
  and colour parsing, readline editing, session save and restore,
  editor suggestions, Go to symbol, the directory probe and history
  filtering.
- Tab and pane hints: buttons at the top right of a pane under the
  pointer (new tab, split beside, split below, close), the same in the
  output's right-click menu, a line under the welcome saying the keys
  until you've used them, and one in a new tab or pane saying how to get
  around (the first three times). Home's Get started lists Ctrl+T and
  Ctrl+Shift+\\.
- Split panes: a tab holds several shells side by side or one above
  another. Ctrl+Shift+\\ or Alt+Shift+= splits beside, Alt+Shift+- below;
  Alt+arrows move between panes, Alt+Shift+arrows or dragging the
  divider resize them, Ctrl+Shift+W closes one; `'split`. Each pane is
  sized to its own width and height, and splits are part of the
  restored session.
- Sessions survive a restart or a crash: terminal tabs come back in the
  directories they were in, with their last 1,000 lines of output, the
  files open in their editors and unsaved editor text. Saved every few
  seconds; setting `restoreSession`. The shell can now be started in a
  given directory (`dir` in the PTY's init message).
- Search in files (Ctrl+Shift+F in the editor): every matching line in
  the project, grouped by file, with case, whole-word and regex options;
  opening a result selects the match. The search runs in Go, skips
  dependency and build folders and binary files, and stops as soon as
  a newer query starts.
- Terminal tabs, each its own shell: Ctrl+T in the terminal (or
  `'tab new`, or +) opens one, Ctrl+Tab / Ctrl+1…9 switch, Ctrl+Shift+W
  closes one (and its shell). Tabs are named after their directory and
  marked when a program prints in one you aren't looking at. OXIS
  commands, plugins and workspace detection follow the selected tab.
- The editor shows mistakes as you type: a red or yellow squiggle, the
  message at the end of the line, a count in the editor bar, a list of
  problems under the text, coloured line numbers, a tooltip on hover,
  and F8 / Shift+F8 to step through them. JavaScript and TypeScript are
  parsed with Babel in a worker; HTML (an attribute left open, unclosed
  or mismatched tags, duplicate ids and attributes, and the scripts and
  styles inside), CSS, JSON, Lua, brackets and strings in Python, Go,
  Rust and C-like files, YAML tabs and merge-conflict markers are
  checked too.
- Suggestions while typing in the editor: words from the file and the
  language's keywords, matched even with letters skipped; ↑/↓, Enter or
  Tab, Esc, and Ctrl+Space to ask (setting `editorSuggest`).
- Ctrl+P in the editor goes to a file: fuzzy search over the project
  the open file is in, open tabs first.
- A minimap beside the editor's text, with the visible part outlined
  and markers for mistakes, find matches and unsaved changes; click or
  drag to scroll (setting `editorMinimap`).
- Find and replace highlight every match in the text, the current one
  brighter.
- VS Code's editing keys: Ctrl+/ comment, Alt+↑/↓ move lines,
  Shift+Alt+↑/↓ copy lines, Ctrl+Shift+K delete lines, Ctrl+D select the
  next match, Ctrl+L select lines, Ctrl+Enter new line below, Ctrl+] /
  Ctrl+[ and Tab / Shift+Tab indent and outdent, smart Home, Enter keeps
  the indentation, brackets and quotes close themselves, Backspace
  removes an empty pair, Shift+Alt+F formats JSON. The caret's line,
  its matching bracket and other uses of the word under it are
  highlighted.
- An editor status line: line and column, selection size, language,
  line endings, encoding.
- `'help hotkeys` lists every keyboard shortcut: the prompt, the output,
  the app, the editor, Vim keys and plugins' key bindings.
- `'market` shows the Market as a table: grouped by category, with each
  plugin's version, whether it's installed, its price if it has one,
  and search matches picked out; `'market info` is a card with what the
  plugin asks for, where it works and how to install it.
- More colour: `'help` and OXIS's other output show commands, arguments
  and descriptions in different colours, and the shell's prompt and the
  commands you ran are coloured too (the path, the command, options,
  strings, variables and numbers, in the theme's terminal colours;
  setting "Colour Prompts", on by default).
- Shell integration: PowerShell, bash, zsh and fish start with a prompt
  hook (after the user's own startup files) that reports each command's
  exit status and the working directory (OSC 133 and OSC 7, as VS Code
  and Windows Terminal use). Every command run gets `✓` or `✗` and its
  exit code at the end of its line, with the time it took if that was a
  second or more; Ctrl+↑ / Ctrl+↓ jump between commands; the directory
  is followed exactly, so OXIS no longer sends `Write-Host` probes to
  the shell (they ended up in its history). Plugins get
  `ShellCommandDone` ({ command, code, ms }) and `DirectoryChanged`.
  `OXIS_SHELL_INTEGRATION=0` turns it off; without it OXIS probes for
  the directory as before.
- Arrow-key menus work: `npm create vite`, `gh`, and anything built on
  inquirer, clack, prompts, dialoguer or survey. While a program shows
  a menu (it hides the cursor), Up, Down and Space go to it; at the
  shell prompt Up and Down are still history.
- The line view plays output on a model of the terminal's screen, so a
  program that redraws what it drew (a menu, a spinner, progress bars,
  a task list with spinners, a status line under scrolling output)
  changes those lines instead of printing another copy below. When it
  finishes, only the final state stays: `✔ Pick a framework · Vue`,
  not every frame. Long lines stay one line, colours carry across lines
  as they do in a terminal, and cleared screens stay in the history.
  The model is checked against xterm.js on recorded random output, and
  100,000 lines of output go through it in under 0.3 s.
- Full-screen programs work: vim, less, htop, lazygit, fzf, Microsoft
  Edit… When a program switches to the terminal's alternate screen, its
  output goes untouched to a real terminal grid (xterm.js, loaded the
  first time it's needed) over the output; keys, mouse and window size
  go to it, and when it exits the line view carries on without repeating
  anything. **back to OXIS** recovers from a program that crashed without
  closing its screen.
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
- `oxis.echo(text, kind)` colours a plugin's line like OXIS's own messages
  (`"ok"`, `"err"`, `"warn"`, `"dim"`, `"accent"`).
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
- A plugin asking for a permission asks in the prompt ("🔐 X wants to
  make network requests. Allow? (yes / no)") instead of a system dialog
  that froze the whole window. Animations, other panes and other
  plugins keep running while it waits. A question the plugin already
  had open comes back after the answer. On native Lua this covers
  every permission, `oxis.editor`, `oxis.newTerminal` and
  `oxis.workspace` included.
- `'plugin new`'s templates use today's API: `devops` reads
  deploy.json, asks, and deploys with a spinner (oxis.ask, oxis.line,
  oxis.every, oxis.process.spawn), `system` shows the machine live,
  `dev` asks before undoing a commit, and the new `interactive` is a
  game answered in the prompt. Each declares the permissions it uses.
- The Linux package and its menu entry describe OXIS as a programmable
  workspace, listed under Development and Utility (with search
  keywords), and point at oxis.space.
- `'plugin publish` opens a GitHub issue (details and source, labelled
  plugin-submission) instead of a pull request; `'plugin unpublish` a
  removal request. The Market backend files it when it has a token,
  otherwise GitHub's new-issue page opens with it filled in.
- A plugin can't replace one of OXIS's own commands; it's told so and
  OXIS's command stays.
- The Market lives at [oxis.space](https://oxis.space); the app, README
  and website use it (oxis-market.pages.dev keeps working for older
  builds).
- The editor's preview serves the page's whole project, so a page in a
  subfolder loads `<link rel="stylesheet" href="../css/main.css">` and
  other files above its own folder. Without a project marker (.git,
  package.json, go.mod…) it reaches one folder up, and never the home
  folder or above.
- The `latest-build` release's files are only replaced when the app
  changed: pushes that touch only docs, screenshots, the website, the
  Market listing or tests leave them (and GitHub's download counts on
  them) alone. The update check skips those commits too, so they no
  longer show as an update.
- Home's Get started box is two columns (commands, shortcuts) and half
  as tall, with more room above the prompt. Each item is clickable: a
  command runs (or, like `'edit <file>`, is put in the prompt to
  finish) and a shortcut does what its keys do. Clouds fade in and out
  in pixel steps, and the workspace box's hints are shorter.
- Premium plugin licenses run on up to 3 devices: a device is activated
  the first time it checks the license, `'market devices <name>` lists
  them and `'market deactivate <name> <id>` frees one. The source is only
  sent to an activated device. A license confirmed in the last 30 days
  keeps working offline. A package copied from another machine is
  downloaded again for this one instead of failing, and a premium plugin
  that can't load at startup says why (not activated here, subscription
  ended, offline too long) instead of being left out silently.
- Home's panels match the pixel-art sky: frames with notched corners
  and a pixel shadow, title strips, a pixel status dot, shortcuts as
  keycaps, and the O, X, I, S letters as blocks.
- Home's sky is pixel art. By day, a sun whose ray tips shimmer in
  turn, and clouds with a new shape each time (a big round puff with
  smaller ones either side, lit from above) drifting across: far ones
  small, faint and slow, near ones bigger and faster, fading in at the
  left and thinning out before the sun, never overlapping. By night, a
  moon with craters and twinkling pixel stars. Nothing glows.
- PowerShell is started with its shell-integration hook as plain,
  readable `-Command` text instead of `-EncodedCommand`: encoded
  PowerShell started by a program is what malware does, and antivirus
  and company security tools flag it.
- The Windows exe carries an application manifest (runs as the user,
  never elevated; Windows 10/11), a fuller description, and its real
  version and build number; builds no longer contain the paths of the
  machine that built them (`-trimpath`).
- The editor's modes can be turned off (setting `editorVim`, or a click
  on the mode in the editor bar) for an editor that just types.
- `oxis.dashboard` no longer changes the theme: that's the user's.
- `'theme <name>` and `'theme edit <name>` find a theme whatever the
  case of its name.
- Much faster terminal output. Output is applied at most once per frame
  (every 48 ms while a program floods it) instead of once per message,
  and the scrollback renders in blocks the browser skips while they're
  off screen. Printing 20,000 lines went from frames of up to 617 ms
  (4.5 s of the window frozen) to a steady 60 fps, and scrolling back
  through a full scrollback no longer stalls for seconds. The blinking
  prompt caret no longer restyles the page every frame while idle.
- A sharp app icon. The icon is drawn from the logo's own geometry at
  every size Windows asks for (16 to 256 px, including the 16 and 20 px
  it had none of) with the ring's edges on whole pixels, in the brand
  green, with a thin rim on small sizes so it shows on light taskbars.
  It used to be a muted green picture scaled down, blurry below 48 px.
  The Linux package installs the vector logo and a 512 px icon instead
  of a 1350×1165 picture in the 256 px folder. `scripts/make-icons.py`
  regenerates them all.
- The night sky's moon is one simple round moon, the same every night,
  instead of eight phase glyphs of different sizes.
- The README's demo is a recording of the real app (`assets/demo.gif`,
  captured at 2x so it stays sharp on high-DPI screens): every frame a
  screenshot of OXIS running git, a workflow, a Market
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
- An `oxis.run` step marker could show as text when it arrived after
  its call had been cancelled.
- monitoring 2.0.1: `'tail` no longer prints a line after it stops.
- Ctrl+Shift+P didn't open the command palette while the prompt had
  the keyboard (it did from everywhere else).
- Each tab keeps its own shell's kind (PowerShell, bash, cmd…), so with
  different shells in different tabs, commands and the directory probe
  are written for the right one. cmd now reports its folder too, WSL's
  `/mnt/c/…` reads as `C:\…`, and a tab's shell comes back with the
  session.
- Quitting OXIS no longer leaves "stopped: the connection to OXIS
  closed" for every native-Lua plugin in the session it restores next
  time (the lines piled up with each restart).
- CI: failing Go tests on Linux passed the build, because the test step
  piped into `tee` without `pipefail`.
- After a jump to a line (search results, go to line), the status bar's
  Ln/Col and the current-line highlight followed only on the next key.
- The directory reported by Git Bash (`/c/Users/…`) is read as
  `C:\Users\…`, not as a network path. Its own folders (`/tmp`, other
  mounts) are reported as the Windows folder they are.
- Windows: Esc in a full-screen program works. ConPTY held a lone Esc
  until the next key, which then arrived as Alt+key, so vim never left
  Insert mode and `Esc :wq` typed `:wq` into the file. Esc is now sent
  as a key event, the way Windows Terminal sends it.
- `clear`, `cls` or `Clear-Host` typed at the prompt empties the view,
  as in any terminal (it used to only clear the shell's own screen,
  which the line view keeps as history). The prompt line stays.
- `oxis.fs.read/write/list/stat/mkdir/remove` resolve relative paths
  from the shell's current folder, like `oxis.fs.search` and
  `oxis.edit` already did, not from the folder OXIS started in.
- A line typed while a plugin's animation or live view ran went to the
  shell (answering a game's die before it landed ran `yes 5`, which
  floods the terminal). It waits now, like type-ahead: it answers that
  plugin's next question, or runs once nothing is running.
- `'plugin enable` and `'plugin reload` find a plugin file copied into
  a plugins folder after OXIS started, and only say a plugin is on once
  it has actually run.
- `'plugin validate` and the editor's Lua checks no longer call Lua 5.4
  syntax (`<const>`, `<close>`) an error.
- After a search, the first match was selected again with every key
  typed, even with the find bar closed, so typing in Insert mode kept
  jumping back to it.
- Moving in Normal or Visual mode moved the caret a frame later, so a
  key typed quickly after a motion (or in a window in the background)
  acted where the caret had been.
- Selecting text in the editor drew a second, bold-looking copy of the
  selected text over the code (and a theme's solid selection colour hid
  it); the selection now only tints the highlighted text.
- `'plugin reload` reran the copy already loaded, so an edit to a
  plugin's file didn't take effect until OXIS restarted; it reads the
  file again now.
- An empty `permissions:` line in a manifest was treated as a missing
  one, so a plugin that needs no permissions couldn't be published.
- After opening a Search in files (Ctrl+Shift+F) result, typing in the
  editor pulled the selection back to the match every time the text
  changed.
- `'version` reported the result of the update check made at startup for
  as long as OXIS stayed open, so it kept saying "up to date with main"
  after newer builds came out. The check is redone when it's over ten
  minutes old (two for `'version`), the status bar rechecks every half
  hour, and `'update`'s own check updates both.
- A workspace's git connection could be another project's: a project
  folder inside another repository (or inside a home folder that is a
  git repository) used that repository, so `'workspace github` changed
  its origin, Home showed its remote and `'task commit` staged all of it.
  Each project now has its own repository: one inside another gets its
  own on `'workspace github`, and the outer one is left alone.
- Git Bash (and other MSYS/Cygwin shells) on Windows sometimes lost the
  first key typed after its pane was resized: splitting, closing a
  pane or resizing the window turned `echo` into `cho`, and at startup
  the folder probe could fail the same way. About one resize in three,
  reproducible with ConPTY alone. The first input after a resize now
  starts with a Shift press sent as a win32-input-mode key event, which
  is what gets lost, if anything; PowerShell and cmd are unchanged.
- After `'clear`, resizing a pane could bring the cleared output back:
  ConPTY's repaint wasn't recognised when it switched input modes
  first (`?9001`, `?1004`, `?2004`), as it does when Git Bash's console
  is set up again.
- With Git Bash (or another sh) as the shell on Windows (`OXIS_SHELL`),
  OXIS sent it PowerShell: the directory probe printed a bash syntax
  error, and commands like `'env` and `'path` failed. What OXIS sends
  now follows the shell that's running, not the operating system, and
  Git Bash is asked for its directory as a Windows path (it says
  `/c/Users/…`), so `'edit src/app.ts` opens the right file.
- Keys typed straight after the editor changed the text itself (a
  closing bracket added or stepped over, an undo, a Vim command) could
  land where the caret had been when the window was busy or in the
  background: the caret is now placed as soon as the text is on screen.
- A Windows path with forward slashes in the output (`C:/dev/app.ts`)
  became a link without its drive letter.
- Switching editor tabs lost unsaved changes, the tab's ● never showed,
  closing a changed file didn't ask, and Save All saved nothing. Each
  tab now keeps its unsaved text, caret and scroll position.
- Editing a file with Windows (CRLF) line endings turned them all into
  LF when it was saved, so every line showed as changed in git; the
  editor now saves a file with the line endings it had. Mistakes and
  find matches in such files were also marked in the wrong place.
- Vim commands, moving lines, auto-indent and undo in a large file took
  a quarter of a second each (the whole text was replaced); they now
  change only what they change.
- Home's stars and clouds could land on the title, depending on the
  window's height; the sky now has its own strip above it.
- Stray `32m`, `?25h` and similar in the output: a read that ended
  right after the `ESC [` of a colour or cursor code sent it early, and
  the rest of the code showed up as text.
- Lines printed twice after resizing the window (Windows): ConPTY
  repaints the whole screen after a resize, and OXIS showed it again.
  Repaints that report the new size first, end without moving the
  cursor, or happen with the cursor hidden (a menu is up) are caught
  too, and the next command's echo is never taken for part of one.
  The same repaint after a full-screen program exits is dropped too.
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
- The old built-in Lua plugins (fuzzy, git_advanced, lsp_diag,
  session_notes, env_manager, benchmark, process_manager, project_init,
  clipboard, docker_compose, file_ops, system_health, ssh_manager) and
  the docker, network, python, go, rust and winutil shortcut tables,
  whose short names clashed and whose `'admin`/`'sfc` raised elevation
  prompts. The Market keeps games, monitoring, autotest and ai-devops.
- The Market plugin `ui`: it switched the theme and changed Home every
  time OXIS started. A copy that's already installed is removed at
  startup, with a note in the terminal saying so.
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
