# Changelog

All notable changes to OXIS are documented here. Dates are when the
change was made, not necessarily when a version was tagged.

## [Unreleased]

### Added

- **Unsaved-change gutter in the Editor.** A real LCS-based line diff
  between the content at the last save and what's currently in the
  editor, shown as a colored marker per changed line. Resets on every
  save (the new content becomes the baseline), so it always means
  "changed since the last save" — works the same in Normal/Insert/
  Visual mode, since it's driven by content, not by mode.
- **Market updates and rollback** (`'market update`/`'market update all`,
  `'plugin rollback`). Update checks the new version's manifest for
  OXIS-version/OS/dependency compatibility BEFORE touching the
  installed plugin, backs up the currently-working version first, and
  automatically restores that backup if the new version fails to
  load — never leaves a half-installed, broken plugin registered.
  `'plugin rollback` restores the same backup manually, any time
  after an update. One backup per plugin (last-known-good), not a
  full version history.
- **Output search (Ctrl+F)** — searches the actual on-screen
  scrollback, distinct from Ctrl+R's command-history search. Enter/
  Shift+Enter step through matches (wrapping), matched lines get a
  highlight, Esc closes it.
- **Shell profile support** (`OXIS_SHELL` env var) — overrides the
  normal shell auto-detection on both platforms (PowerShell 7 →
  Windows PowerShell 5.1 → cmd.exe on Windows; `$SHELL` → `/bin/bash`
  on Unix, with `OXIS_SHELL` now taking priority over `$SHELL` too).
  Small, additive change to `pty_windows.go`/`pty_unix.go` — could not
  be compiled/tested in this environment (no Go toolchain available);
  worth a real build/run before relying on it.
- **Four more Terminal UX items**: terminal zoom (Ctrl+=/Ctrl+-/Ctrl+0,
  directly adjusting the real `fontSize` setting — no separate
  zoom-only mechanism), clickable URLs and file paths in terminal
  output (opens via the same `openUrl`/`openEditor` used everywhere
  else; deliberately conservative about what counts as a "path" to
  avoid false positives), and copy-on-select (finishing a selection
  copies immediately, in addition to Ctrl+C which still works as
  before). No new commands, so nothing new for `'help` to reflect
  here — these are keybind/rendering behaviors, documented in README
  § Keybind System instead.
- **Diagnostics (`'diagnostics`) and Plugin Doctor (`'plugin doctor`).**
  Both purely local — no telemetry, nothing ever transmitted.
  `'diagnostics` shows version/OS/runtime/plugin counts/active
  workspace/recent errors, the last of which now come from a real
  ring buffer fed by both explicit error sites (plugin load/
  compatibility failures) and a global `window.onerror`/
  `unhandledrejection` capture for genuinely uncaught exceptions.
  `'plugin doctor` runs `'plugin validate` across every installed
  plugin at once, adds file-missing and zero-commands-registered
  checks, and — unlike a flat issue list — genuinely distinguishes
  error (enabled + broken) from warning (disabled + broken) from info
  (legacy, not a problem), each with a suggested next step where one
  makes sense.
- **`'help <command>` — real per-command documentation.** For
  commands with actual subcommand structure (`workspace`, `plugin`,
  `market`, `config`, `workflow`, `edit`, `task`), shows every syntax
  variant, what each does, and worked examples — not just the
  one-line description the all-commands listing shows. Anything else
  falls through to the real command registry (covers every builtin
  and plugin command by name) rather than a hardcoded list, so
  `'help <anything that actually works>` never comes back empty.
  `'help` itself now explains its own three levels
  (`'help` / `'help <command>` / `'help <plugin>`) up front instead
  of assuming that's already obvious.
- **Settings system (`'config`/`'settings`).** `list`/`get`/`set`/
  `reset`, backed by the same option store `oxis.getOption`/
  `setOption` already use. Four settings with a real, immediate
  effect: `fontSize`, `cursorStyle` (block/bar/underline),
  `cursorBlink`, `updateCheckOnStartup`. Deliberately does NOT include
  a duplicate `theme` setting (`'theme` already owns that, with its
  own persistence) or settings for behaviors that are already real,
  working features controlled their own way (plugin enable/disable,
  `oxis.keymap()`) rather than through a generic key that would just
  be a second way to do the same thing — see README § Settings for
  the honest scope note.
- **File tree** (Ctrl+B) — lazy-loading file browser in the Editor,
  starting from the app's own directory. Click to expand folders or
  open files in a tab, via the same `openEditor()` `'edit` and
  `'plugin new` already use.
- **Command Palette (Ctrl+Shift+P).** Searches the real command
  registry — the same list `'`-command dispatch and Tab completion
  already use — not a separate hand-curated action list. Type to
  filter, ↑/↓ to navigate, Enter to run (opens the shell if needed and
  runs it exactly as if typed), Esc to close. Documented honest
  caveats: no editor-aware routing yet (running a command while the
  Editor/Plugin Creator is the visible pane sends it to the shell
  underneath, out of sight until you close the editor), and it
  collides with most browsers' own shortcut for the same key
  combination in browser mode (works reliably in the native app).
- **Find, Find & Replace, and Go to line** in the file Editor and
  Plugin Creator (Ctrl+F/H/G) — step through matches, replace one or
  all (one undo step for Replace All), jump to a line number. Plain
  substring search, case-insensitive, not regex. Shared via
  `useModalEditor`, same as undo/redo and syntax highlighting already
  are, so both editors got it from one implementation.
- Also fixed a real doc bug while touching this: the README had two
  contradictory "Editor Keybinds" tables (one stale, pre-dating modal
  editing entirely). The stale one now points at the real one instead
  of duplicating it.
- **Real tab completion for `'`-commands.** Pressing Tab after typing
  `'` completes against the actual command registry (`registry.all()`)
  — extends as far as unambiguous, or lists every match, same as bash.
  Scoped to just the verb (not subcommands like `'workspace <tab>` →
  `init`/`list`/`switch`/…, which aren't separate registry entries, so
  faking a list for them would be exactly the "autocomplete
  disconnected from the real registry" this is meant to avoid).
  Ordinary shell input is untouched — Tab still sends a real `\t`
  through to PowerShell/bash for their own native completion.
- **The active workspace's name is now shown on the Home screen** —
  a new `workspace = <name>` row in the WORKSPACE panel, sourced
  directly from `workspaceManager.getActiveNamed()` rather than
  inferred, so it's never ambiguous which one is active once more
  than one named workspace exists.
- **Real workflow system.** `'workflow <name>`/`list`/`info`/`cancel`,
  chaining `task`/`run`/`command` steps (sequential and — honestly
  scoped — parallel, env vars, conditions, retry, continueOnError,
  cancellation) into one runnable, named sequence declared in a
  workspace's `workflows/*.lua` files via `oxis.workflow(...)`. Built
  on the existing task/command registry rather than a second
  execution system: a `task` step runs the exact command string behind
  an existing `oxis.task()`, a `command` step calls the real command
  registry, a `run` step is exactly `oxis.run()`. Made `oxis.run()`
  itself properly awaitable in the process (previously fire-and-forget
  outside the Windows multi-line case) — see `scriptRunTracker.ts`'s
  new `runAndAwait()`, which is also what makes `'workflow cancel`/
  Ctrl+C actually stop a running step instead of leaving it running in
  the background. Workspace-scoped and isolated: switching workspaces
  clears the previous one's workflows before loading the new one's.
  Explicitly documented what this does NOT do: no nested/composed
  workflows, no saved run history, and "parallel" shell steps still
  serialize against each other (one real PTY shell — see README §
  Workflows for why claiming otherwise would be fake).
- **Plugin manifests, permissions, and dependencies.** A plugin can
  now declare `version`/`description`/`author`/`category`/
  `min_oxis_version`/`os`/`permissions`/`dependencies` in a
  `--[[@manifest ... ]]` block, parsed before any of its Lua runs.
  Building on the permission system that already existed (fs/process/
  net/system, runtime-prompted and persisted): a manifest'd plugin's
  undeclared namespaces are now hard-denied instead of prompted, with
  two new namespaces (`workspace`, `terminal`) gating
  `oxis.workspace()`/`oxis.newTerminal()`; legacy plugins with no
  manifest are unaffected and keep the exact prompt-based behavior
  they always had. Dependencies get real checking before load: missing
  dependency, incompatible version (real semver comparison — `>=`,
  `^`, exact), and dependency cycles are all detected and refused with
  a clear explanation; an installed-but-disabled dependency is enabled
  automatically. New commands: `'plugin uninstall` (refuses if another
  plugin depends on it, `--force` to override), `'plugin info`,
  `'plugin validate` (manifest + real Lua syntax check, without
  executing the plugin), `'plugin docs`, `'plugin test` (a real load,
  restores prior enabled state afterward), and `'plugin new --template=
  basic|dev|devops|system` with four genuinely different, working
  starter plugins. See README § Plugin Manifests/Permissions/
  Dependencies/Templates — including an explicit note on what this
  does NOT do (no Lua-VM sandboxing yet; no Market auto-install of
  missing dependencies; no `'market update`/`'plugin rollback`).
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

- **Plugins are now edited in the exact same Editor as any other
  file — the separate "Plugin Creator" component is gone.**
  `'plugin new <name>` writes the template to a real `.lua` file,
  registers and loads it live immediately, then opens it with
  `openEditor()` — the same call `'edit` uses. Saving a plugin file
  (Ctrl+S) reloads it live, same as the old dedicated "save & load"
  button did, via a new `findPluginForPath` check in the Editor's
  save path rather than a plugin-aware editor component. Also fixed a
  real bug found while doing this: `pluginManager.saveLuaPlugin` only
  ever wrote the file and updated in-memory state — it never actually
  reloaded the running plugin, so edits made after the initial
  `'plugin new` wouldn't take effect until a manual `'plugin reload`.
  It reloads now.
- **The Editor supports multiple open tabs** and **line numbers**
  (see README § Built-in Editor for both).- **GitLab CI simplified to Linux-only.** `build:windows` (WiX-based
  `.msi`, needed a dedicated Windows runner) has been removed —
  Windows builds are done locally via Visual Studio / `npm run build`
  instead, so there's no Windows GitLab Runner to register or
  maintain. `build:linux` is unaffected and still runs untagged on any
  available runner.
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

- **Home screen's command line sat too far below the help box above
  it.** First attempt at this overcorrected — re-anchoring the whole
  `.home` layout to the top instead of centering it, which just
  traded one layout problem for another (content tall enough to
  scroll). Reverted the layout change and fixed the actual gap
  instead: `.oxis-cmdline`'s margin-top down from 18px to 8px, so the
  `Shell <command-mode>` line now sits close under the help box like
  it should, with the overall layout still centered as originally.
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