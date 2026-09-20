# Changelog

All notable changes to OXIS are documented here. Dates are when the
change was made, not necessarily when a version was tagged.

## [Unreleased]

### Added

- **HTML live preview in the built-in Editor** — the last item queued
  this session. A `preview` toggle on any `.html`/`.htm` file opens a
  split view (code | rendered `<iframe>`), debounced 300ms after
  typing stops. Sandboxed with `sandbox="allow-scripts"` only — no
  `allow-same-origin`, so the previewed page's own JavaScript runs but
  can't reach OXIS's DOM/storage or make a credentialed request back
  to it, and no `allow-forms`/top-level navigation either — the same
  isolation model tools like CodePen/JSFiddle use for live preview.
  Off by default even on an HTML file (a toggle, not automatic) so
  opening a file never silently executes its script tags. A fresh
  `<iframe>` per file (keyed on path) rather than one persistent frame
  carrying over state between files.
- **Live preview: resizable split + fullscreen mode.** Drag the
  handle between code and preview to resize either pane (20-80%
  clamp). A separate `⤢ full` button and **Ctrl+Shift+Enter** expand
  the preview to fill the whole editor — a distinct mode, not just
  the resize handle pushed to its limit — hiding the code pane with
  the `hidden` attribute (not unmounting it, so content/cursor/undo
  history survive toggling fullscreen). Esc exits fullscreen before
  falling through to the editor's own Escape handling, so it can't
  accidentally close the whole editor; a plain button inside the
  preview bar does the same for anyone who doesn't know the shortcut.
- **Market website: real intro/homepage content, an About section, and
  a SourceForge link — the site was a single, unexplained plugin grid
  before this.** Someone landing on `oxis-market.pages.dev` cold saw
  "PLUGIN MARKET" with zero context for what OXIS even is — same
  confusion problem the README's opening had, fixed the same way
  here: a real "What is OXIS?" section above the marketplace grid,
  in plain language, with a GitLab download link and a jump straight
  to the plugin grid. Added a proper About section at the bottom
  (project description, license, links to GitLab/SourceForge/
  CONTRIBUTING.md) and simple in-page nav (Market / About) in the
  titlebar. **Deliberately did NOT split this into separate pages**
  (a real `/home`, `/market`, `/about`) even though that's the more
  conventional site structure — every "browse the Market" link in the
  OXIS app itself (`'market open`, Ctrl+Shift+M) opens `MARKET_BASE`
  (the site root) directly, so moving the marketplace grid off `/`
  would have broken that flow. Everything added lives on the same
  page instead, reachable by scrolling or the new nav's anchor links.
- **Sky widget redesign — genuinely randomized, not just repositioned
  further.** The widget is now wider (90px → 240px) with the sun
  moved to the right side instead of dead center; clouds (4-6 of
  them, up from a fixed 2) are generated fresh per mount from a pool
  of glyph shapes with randomized size, opacity, and drift speed.
  Caught and fixed a real bug while building this: the drift
  animation's own opacity keyframes would have overridden each
  cloud's randomized opacity outright (a running CSS animation wins
  over an inline style for the same property) — fixed by animating a
  CSS custom property (`--cloud-opacity`) instead of a hardcoded
  value, so the randomized opacity actually sticks throughout the
  animation.
  **First attempt at spreading/timing them was wrong and got caught
  by testing, not assumed correct**: independently-random position
  and delay per cloud, in a small area with only a handful of clouds,
  clumped together and drifted in near-lockstep far more often than
  it spread out — small numbers of independent random draws don't
  reliably avoid each other. Replaced with **stratified** placement —
  the width is divided into one band per cloud (guaranteeing minimum
  horizontal spacing, jitter only within each cloud's own band),
  alternating high/low vertical lanes by index for depth, and drift
  delay set as a fraction of each cloud's own cycle (`-(i/count) ×
  duration`, plus small jitter) so clouds are mechanically spread
  across different points of their drift instead of hoping
  independent randomness lands that way. Widened again (240px →
  280px) and moved the sun/moon further right (their own `right`
  offset pulled to 0) for more visual separation from the clouds.
  Each cloud is now also randomly assigned to draw in front of OR
  behind the sun (`z-index: 1` or `3` against the sun's `2`) — a real
  sky has clouds pass both in front of and behind the sun depending
  on where they are, not permanently one or the other, which is what
  a fixed DOM-order stacking would have produced. Night mode's 5
  hand-placed, fixed-position stars are now generated the same
  stratified way as the day clouds (5-8 of them, banded across the
  widget width for guaranteed spacing, staggered twinkle delay) —
  they'd never been updated to match the widget's growing width
  through the earlier changes above, and used the same kind of fixed
  placement the clouds moved away from.
- **Terminal boot-banner smoke was oversized relative to the shrunk
  banner text.** Real bug, not a theme/build artifact: shrinking the
  terminal's own banner to 10px (an earlier fix in this same
  changelog) never touched the smoke puffs' font-sizes, which were
  hardcoded in `px` (9-13px) calibrated against the ORIGINAL 13px
  banner. Fixed by converting the puffs to `em`, calibrated against
  that same 13px base, so they scale down automatically inside a
  smaller context instead of staying a fixed absolute size next to
  now-tiny text. While tracing this, found and fixed the SAME
  font-size-coupling bug (the third instance of it this session) in
  `.startup-logo` (the launch splash) — it was tied to `var(--fs)`,
  the user's configurable terminal font size, meaning a larger
  fontSize setting would have ballooned the splash too; now fixed at
  13px. Also cleaned up two doc comments left over from Home's train
  being removed entirely, which still described a "home screen train"
  that no longer exists.
- **Terminal boot-banner made to match the startup splash train
  EXACTLY, on explicit request — superseding two earlier attempts at
  this same visual in this same changelog** (shrinking it down, then
  a per-digit wheel-color contrast fix). Both of those were solving
  for "looks better," this one is solving for "identical to the
  splash": same 13px font-size (was 10px), same single uniform color
  for every row including the wheel row (`var(--purple)` throughout —
  no more separate `banner`/`banner-wheel` colors, no more per-digit
  `0` highlighting), same 110px smoke height (was 70px). The
  now-unused `renderWheelRow`/`.term-wheel` from the previous attempt
  were removed rather than left behind as dead code.
- **`'hide workspace` / `'show workspace`** — toggles the WORKSPACE
  panel on Home, persisted across restarts.
- **Real subscriber counts on paid plugins.** Derived directly from
  existing license/webhook data (`license:{plugin}:{email}` records
  `webhook.js` already keeps current) — no separate counter to drift
  out of sync. New `lib/licenses.js` functions
  (`countActiveSubscribers`, `listPluginsWithLicenses`) and a new
  `GET /subscriber-counts` endpoint; the Market website shows a "N
  subscribers" line on purchasable premium cards, and `'market info
  <plugin>` in the OXIS app shows the same. Fails soft (no count
  shown, not an error) if the backend's `OXIS_LICENSES` binding isn't
  set up.
- **Workspace auto-reload** — polls `workspace.lua` plus the `tasks/`
  and `workflows/` folders every 3 seconds and automatically reloads
  the active workspace the moment any of them change on disk, with a
  visible `⟳ workspace auto-reloaded` line in the terminal. Honestly
  a poll, not a real push-based file-system watcher — that would need
  a new Go dependency (fsnotify or similar) I have no way to compile
  or test here, same caveat as this session's other new Go bindings.
  A change can take up to 3 seconds to be noticed, not instant.
- **Home screen redesign**: removed the static "parked" train ASCII
  from Home entirely (the launch splash animation and the terminal's
  own printed banner both keep theirs, unchanged in scope); the
  sun/moon/stars widget is now centered instead of pinned to the
  corner, and the sun icon itself is smaller; moved the whole widget
  down (it was overlapping the titlebar); cloud ASCII is now white
  instead of the dim muted color; removed the border
  around the GitLab link. The terminal's
  own banner (shown when a shell tab opens) is now visibly smaller
  and its wheel row is a real green instead of grey — and, same bug
  class as Home's earlier fix, its font size is now decoupled from
  the `fontSize` setting rather than ballooning with it.
- **`GET /health` on the Market backend** — self-diagnostic reporting
  which secrets/KV namespace bindings are actually configured
  (presence only, never values), with a `whatBreaks` map showing which
  endpoints depend on each missing piece. Built after discovering the
  `OXIS_LICENSES`/`OXIS_PREMIUM_SOURCE` KV namespaces had never
  actually been bound — `webhook.js` was already handling that
  correctly (logs loudly, never silently swallows it), but there was
  no way to catch the gap without waiting for a real Stripe webhook
  or plugin submission to fail first.
- **`'plugin publish` now opens a real GitLab merge request** against
  `gitlab.com/oxidelab/oxis` (`cloudflare/functions/submit-plugin.js`,
  using the GitLab API) — automates the tedious mechanical part
  (branch/commit/push/open-MR) but deliberately does NOT auto-merge:
  a human still reviews and merges it on GitLab before anything is
  live. (This replaces an earlier version of this same feature within
  this same round of work that went further — a fully-automatic,
  zero-review KV-based publish with no human step at all. Corrected
  before it shipped, at the user's explicit direction, to keep the
  review gate.) The MR includes the plugin's `.lua` file and its
  `index.json` entry in one commit; it does NOT touch `index.html`'s
  website card (fragile to edit programmatically — the MR description
  asks the reviewer to add it by hand). Requires a `GITLAB_TOKEN`
  secret (Cloudflare Pages env vars, same pattern as
  `STRIPE_SECRET_KEY`) scoped to create branches/commits/MRs but
  deliberately not to merge them. **Honestly flagged**: this backend
  code could not be exercised end-to-end here (no GitLab/Cloudflare
  account access) — try one real submission before relying on it.
  The old manual fork-and-PR path still works unchanged as an
  alternative for anyone who'd rather do it by hand.
- **Workspace auto-updater.** Whenever OXIS itself has been updated
  since the last launch, every named workspace's on-disk folder
  layout is brought up to date automatically (missing `tasks/`,
  `workflows/`, `.oxis/` etc. filled in — purely additive, nothing
  existing is ever touched). Tracked via a new `schemaVersion` field
  per workspace in `registry.json`; an up-to-date workspace costs
  nothing beyond the version check. Honest limitation noted in the
  README: the "N workspace(s) updated" notice is best-effort and may
  not always display depending on startup timing, though the actual
  migration always runs correctly regardless.
- **Refined: `commit` task is no longer created by default at all —
  only once GitHub/GitLab is actually connected.** Previous rounds
  went empty → always-one-task-commit; this is the actual final
  behavior: new workspaces start with zero tasks, and `'workspace
  github`/`'workspace gitlab` add a real `commit` task (a new file,
  `tasks/commit.lua`, not a rewrite of `workspace.lua`'s text) the
  moment a remote is actually configured, since a commit task has
  nothing to do before that. Checks the command registry (not just
  file existence) before adding it, so it's never duplicated.
- **File moving** — drag a file onto a folder in the file tree, or
  `'workspace move <file> <directory>` from the command line. New Go
  binding `MovePath` (real, atomic `os.Rename`, refuses if the
  destination already exists). `'workspace move` validates both paths
  stay inside the connected directory first (same guard `newfile`/
  `newdir` use); drag-and-drop paths come from the tree's own real
  directory listing rather than typed text, so that check doesn't
  apply the same way there. Same untested-Go-binding caveat as
  `RunCommand` above — needs a real build before relying on it.
- **Real git integration** — `'workspace github`/`'workspace gitlab`
  (configures the connected project's `origin` remote, initializing a
  repo if needed, refusing to silently overwrite a different existing
  remote without `--force`), and a default `commit` task with an
  actual dialog UI (real `git status`, a message field, real
  `git add -A` + `git commit -m`). Built on a new Go binding,
  `RunCommand` (argv-based, never shell-interpreted, 30s timeout —
  see `internal/wailsapp/app.go`) exposed as `runCommand()`
  (`native.ts`), with the actual git operations in the new
  `frontend/src/plugins/git.ts`. **Could not be compiled or run in
  this environment (no Go toolchain available)** — only checked for
  balanced braces/parens. Needs a real `go build` and a full exercise
  of every git command before relying on it.
- **Default workspace task changed to exactly one: `commit`** (was
  briefly zero tasks after the previous round's fix, which itself
  replaced three incorrect hardcoded npm tasks before that). Runs the
  new commit dialog. Nothing else is auto-generated. The task is
  completely ordinary and user-editable — nothing hardcodes or
  protects it beyond being the default content of a newly created
  `.oxis/workspace.lua`.
- **External project file tree switching.** With a workspace connected
  to an external directory (`'workspace link`), the file tree now
  shows that project's real filesystem instead of OXIS's own managed
  structure — labeled with the workspace's name, switching back
  automatically on disconnect. A manual refresh button (⟳), plus
  automatic refresh after OXIS's own file-creating operations
  (`newfile`/`newdir`/`task commit`) — there's no filesystem watcher,
  so this is how external changes get picked up.
- **`'edit` with no arguments now actually opens the file tree** —
  fixed a gap in the previous round's own work: the render logic and
  help text were updated to support this, but the command handler
  itself still errored with "usage: 'edit <file>" until this round.
- **Real workspace connector + `.gitignore` protection.** `'workspace
  link` now writes an actual `.oxis-connector.json` marker into the
  connected external directory (not just an internal registry
  pointer) and ensures that directory's `.gitignore` excludes it —
  creates the file if missing, appends only the missing rule if it
  already exists, never duplicates or touches any existing rule.
  `'workspace unlink` cleans up the marker but never lets a moved/
  deleted/inaccessible directory block the actual unlink.
- **`'workspace newfile`/`newdir`** — create files/directories inside
  a connected external workspace directory, with a real path-
  traversal guard (rejects absolute paths and any `..` that would
  escape the connected directory) checked before anything touches
  disk. `newfile` opens the result in the Editor immediately.
- **Home screen shows the connected project path** — a clear
  `connected = C:\...` row on the WORKSPACE panel when the active
  named workspace is linked, or an explicit "no project directory
  connected" message with the fix when it isn't.
- **`'plugin publish <name>`** — real validation + Market-listing
  prep, for both free and paid plugins, plus automatic update
  detection. Validates the plugin's manifest is actually complete
  enough to list (version/description/author/category/
  min_oxis_version/os, on top of everything `'plugin validate` already
  checks), then: for a **free** plugin, prepares the exact
  `index.json` entry and prints it ready to paste into a PR; for a
  **paid** plugin, explains the subscription model + 75/25 split and
  makes a genuine network call to the already-deployed
  `/connect-onboarding` endpoint to create a real Stripe Connect
  Express account, opening the real onboarding link Stripe returns.
  Running it again on an already-listed plugin (checked against the
  live Market index) is automatically shown as an update — old
  version → new version — rather than a new listing. Honestly scoped:
  this does NOT submit anything to the Market itself — no self-service
  endpoint exists for that (`/connect-onboarding`/`/checkout` handle
  payments, not listing edits) — it ends by handing over the prepared
  metadata and pointing at the same fork-and-PR process the README's
  § Third-Party Developer Marketplace already documents. Actual
  self-service submission is planned for v1.2.2.
- **Home command-line focus hardened + Ctrl+I hotkey.** Auto-focus
  now retries twice instead of once (a single attempt could lose a
  race with something mounting right after and stealing it back).
  Ctrl+I reliably (re-)focuses it from anywhere on Home, shown right
  in the placeholder text ("Type Here or Ctrl+I"). Guarded to only
  act while Home is actually visible — Home stays mounted-but-hidden
  behind the terminal, and Ctrl+I is literally the Tab byte at the
  terminal level, so an unguarded global handler would have broken
  tab-completion there.
- **Project Layer** (`'project init/open/run/task/workflow`). A
  project is an existing directory anywhere on disk carrying its own
  full `.oxis/` setup (`workspace.lua`, `project.lua`,
  `tasks/workflows/scripts/plugins/documents`) — deliberately thin
  wrappers around the same `load()`/task/workflow machinery
  `'workspace`/`'workflow` already use, not a second system. Fixed a
  real pre-existing gap while wiring this up: named workspaces'
  `tasks/` folder existed structurally but nothing ever actually
  loaded `.lua` files from it (only `workflows/` was) — both
  conventions (`<dir>/tasks/` and `<dir>/.oxis/tasks/`) are loaded now.
- **Backup/restore and export/import** (`'backup`/`'restore`,
  `'config export`/`import`, `'workspace export`/`import`,
  `'plugin export`). JSON-based (no zip library available in this
  environment — documented honestly rather than faking a `.zip`
  extension). `'backup` covers settings + every named workspace's
  real files + `created-documents/` + `created-plugins/`, explicitly
  excluding Market-installed plugins and installer build output.
  `'restore` requires confirmation and only ever adds/overwrites
  files the backup contains — never deletes or touches anything else.
- **File tree is now fully keyboard-navigable** — ↑/↓/←/→/Enter/
  Space/Home/End, no mouse required at any point, matching VS Code's
  tree conventions (← collapses or jumps to the parent row).
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

### Removed

- **`frontend/src/terminal/tabs.ts` — confirmed dead code, deleted.**
  Found during a dead-code audit: a self-contained tab-management
  module (`Tab`, `mkTab`, `addTab`, `removeTab`, `resolveActiveTab`,
  `MAX_TABS`) with zero imports anywhere in the codebase — verified
  directly (no `from ".../tabs"` anywhere) rather than assumed.
  **Correction to what I said about this at the time**: I described
  the app's "actual tab management" as living inline in `App.tsx`
  instead — continuing the audit turned up that this isn't quite
  right either. There is no real multi-tab terminal support anywhere
  in the app right now: `App.tsx` has a single `view: "home" | "shell"`
  toggle, the shell "only ever mounts once, then stays alive forever"
  (an actual comment in the code), and the keybind wiring for
  `switchTab` is a literal no-op (`() => {}`). `openShell` doesn't
  create a new tab — it just switches the one existing view from Home
  to the one existing shell. `tabs.ts` and a whole "TAB BAR" CSS
  section (below) were both real, apparently-abandoned pieces of an
  attempt at building this that never got finished or wired up —
  worth knowing as a genuine gap, not a small cosmetic thing, if
  multiple simultaneous terminal sessions is something you actually
  want. `tsc --noEmit` stays clean with `tabs.ts` gone, which is
  itself confirmation nothing secretly depended on it. **This file
  needs to be deleted from your actual repo manually** — there's no
  mechanism here to delete a file from your machine, only to tell you
  to.
- **A complete, unused "TAB BAR" CSS section** (`.tabs`, `.tab`,
  `.tab--on`, `.tab-icon`, `.tab-label`, `.tab-close`, `.tabs-fill`,
  `.tab-new`) and a separate `.home-tab-hint` rule — both confirmed
  zero usage anywhere in the frontend, both apparently belonging to
  the same abandoned multi-tab attempt as `tabs.ts` above. Deleted
  from `index.css` directly (a CSS-only removal needs no manual step
  on your end, unlike the `.ts` file above).
- **A media-query override still targeting `.oxis-train-wrap`**,
  Home's train-wrapper class, after the base rule for that class was
  already deleted earlier in this same session when Home's train was
  removed — a leftover that had been silently targeting an element
  that no longer exists. Cleaned up alongside the above.

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

- **Live-preview resize handle would stick/stop tracking the cursor
  the moment it crossed into the iframe — a classic iframe-vs-drag
  problem, reported after shipping.** The `mousemove` listener lived
  on the parent window, but a live-rendered iframe has its own
  document — the instant the cursor moved over it mid-drag, the
  iframe's own document received the mouse events instead of the
  parent's listener, so the drag appeared to stop responding until the
  cursor crossed back out. Fixed with the standard solution: a
  transparent overlay (`.editor-resize-overlay`) rendered above
  everything, including the iframe, for exactly the duration of the
  drag — it's what actually receives the mouse the whole time, so the
  iframe never gets a chance to intercept anything. Also fixed a
  smaller, real math discrepancy found while in there: the resize
  math treated the code and preview panes as if they summed to
  exactly 100% of the container's width, without accounting for the
  6px handle between them — a small, cumulative offset that made the
  split not quite track the cursor, worse on a wider window.
- **Workflow steps running a task/raw command had no error handling
  where the equivalent `command`-type step already did** — found
  continuing the audit into `workflowRunner.ts`. Not a crash risk
  (`execStep` is `async`, so a throw there already becomes a
  rejection, not a raw exception — different from the `runScript` bug
  above), but an uncaught rejection from this branch would propagate
  all the way past `runOne`/`runSteps`/`run()`'s own `finally`,
  meaning the workflow's own "✗ workflow X failed" summary line never
  prints — only whatever generic message the top-level `.catch()` at
  the `'workflow <name>` command handler shows instead, for the exact
  same underlying failure. Added the same try/catch shape the
  `command`-type branch already had, so both report the same way.
- **The Market website's new intro section (added last turn) claimed
  macOS support, contradicting the README's own earlier correction —
  and checking turned up the SAME stale claim still sitting in the
  README's own opening line and its "Runs anywhere" bullet, which the
  earlier macOS correction never actually touched.** Fixed all three
  places consistently: the Market site's intro now says "Windows and
  Linux," the README's opening line matches, and the "Runs anywhere"
  bullet now points to the honest Getting Started caveat instead of
  restating the same inaccurate platform list. Left the `iTerm2`
  comparison in both places as-is — that's a plain analogy for what
  kind of program this is, not a claim about where OXIS itself runs.
- **A real bug in my own earlier permission-gate work — found by
  continuing the security audit, not reported by testing.** The
  `oxis.run()`/`oxis.task()` shell-permission gate added earlier this
  session called `requireShellPermission()` as the first line of
  `runScript`, a function NOT declared `async` — meaning a denied
  permission threw a raw, synchronous JS exception straight out of
  `runScript()`, rather than becoming a clean promise rejection the
  way every other permission-gated binding's denial does (`fsRead` and
  friends are all `async`, where the exact same kind of throw is
  automatically converted into a rejection by JS's own semantics).
  That exception would have propagated from inside the native
  function fengari calls via `lua_pushcfunction` for `oxis.run()` —
  an uncaught exception crossing that boundary, not something caught
  cleanly and reported as a normal "Permission denied" message.
  Fixed by wrapping the permission check in a `try/catch` that
  returns a rejected promise instead, and added `.catch()` handlers at
  both call sites that previously discarded the promise entirely
  (`oxis.run`'s Lua binding, `oxis.task()`'s handler) — neither
  handled rejection before, so even a `runScript` failure that was
  ALREADY a rejection (not this specific bug) would have shown up as
  an unhandled promise rejection rather than a real error message.
  Also fixed the `OxisBindings.run` type declaration along the way —
  it said `void` while the actual implementation always returned a
  promise; that inaccuracy is what made the missing `.catch()` compile
  cleanly in the first place instead of being caught by the type
  system.
- **README never actually said macOS isn't a supported pre-built
  platform.** Checked `.gitlab-ci.yml` and `build-linux.sh` directly:
  CI only builds Linux (`.deb` included), Windows is built locally by
  the maintainer and distributed via GitLab Releases, and there is no
  macOS build job or script anywhere in this project. Getting
  Started now says so plainly — a Mac user needs to clone and build
  from source themselves; Wails does support macOS as a target, it
  just isn't a maintained or officially distributed path here.
- **`oxis.run()` and `oxis.task()` had NO permission gate at all —
  found continuing the security review.** Every other Core System API
  (`oxis.fs`/`oxis.process`/`oxis.net`/`oxis.system`) requires a
  granted permission before it does anything (see `permissions.ts`);
  `oxis.run()` — arbitrary shell execution, the single most-used
  capability in the entire plugin system — had none, and `oxis.task()`
  compounded it with a second, separate bypass (its handler called
  `ctx.sendToShell` directly, skipping `runScript` — and therefore
  skipping the new gate — entirely). A plugin denied every other
  permission, or one that explicitly declared needing none at all,
  could still run anything via either of these with zero check.
  Fixed with a NEW, deliberately independent gate
  (`requestShellPermission`/`requireShellPermission`) rather than
  reusing the existing `"process"` namespace: reusing it would have
  hard-denied every already-published plugin whose manifest doesn't
  list `"process"` (since "shell" as a concept didn't exist when
  those manifests were written) — instead, every plugin gets a fair
  one-time prompt regardless of its manifest, never a silent
  automatic denial based on a manifest that predates this permission.
  Built-in plugins and OXIS's own workspace/task/workflow loading
  (the user's own local files, not third-party code) are exempt via a
  new `isTrusted` flag threaded through all four `buildLuaAPI()` call
  sites — **this part was left unfinished in an earlier response in
  this same conversation** (the flag existed but nothing actually set
  it, which would have made every built-in plugin hit the new prompt)
  and is now actually complete; verified with a full sweep for any
  other call site.
- **Real stored-XSS vulnerability on the Market website**
  (`cloudflare/index.html`), found during a security review prompted
  by the new GitLab-MR publishing flow. Every plugin field (`name`,
  `desc`, `creator`, `cat`, `tags`, `ver`, `size`, `priceDisplay`) was
  interpolated raw into template strings assigned to `.innerHTML`,
  completely unescaped — a plugin entry containing HTML/script content
  in any of these fields would execute for every visitor who viewed
  its card. A second instance in `demoVideoHTML`: a non-YouTube
  `demoVideo` URL was interpolated raw into a `src="..."` attribute,
  letting it break out of the attribute entirely. Pre-existing, not
  introduced by the GitLab-MR work — but that work makes it more
  reachable (a reviewer's checklist emphasizes checking Lua source and
  permissions, not scrutinizing JSON string fields for HTML) and a
  self-published plugin could carry a crafted description all the way
  to a human copy-pasting it into `index.html`'s card array. Fixed
  with a real `escapeHtml()` applied everywhere a plugin field reaches
  HTML — at the render layer, not just "reviewers should catch it" —
  so even a naively-added malicious entry is neutralized on display.
- **User-created plugins never actually followed workspace switches —
  found during a broader audit of the workspace-switching bug above.**
  `loadUserPlugins()` (which scans the active workspace's `plugins/`
  folder — `pluginsDir()` — into the registry) was only ever called
  once at startup (`loader.ts`), never again on `'workspace switch`.
  Concretely: create a plugin while workspace A is active, switch to
  workspace B, and A's plugin would stay registered and enabled (its
  file might not even exist under B), while B's own `plugins/` folder
  was never scanned at all. Fixed with a new
  `pluginManager.unloadAllUserPlugins()`, wired to fire (with an
  in-flight guard against overlapping calls) on every
  `workspace_loaded`/`workspace_unloaded` event: the previous
  workspace's user plugins are cleared out and the newly-active one's
  are freshly scanned, every time. Market-installed plugins are
  untouched by this — those were never workspace-scoped to begin
  with, and a check of `marketUpdate.ts` confirmed the update/
  rollback path doesn't touch `workspaceManager` at all.
- **Named workspace switching could silently break — real, actively-
  triggered bug, not theoretical.** `load()` (the core path every
  workspace operation shares) never touched `activeNamed` itself —
  only `switchNamed` set it, as an afterthought, after calling
  `load()`. Every OTHER caller — `'workspace reload`, `'workspace
  init` in an ad-hoc directory, and (the actively dangerous one)
  `detectAndLoad`, which fires automatically on every shell `cd` —
  left `activeNamed` stale, still pointing at whatever named
  workspace was active before. Concretely: switch to a named
  workspace, then `cd` anywhere in the shell that happens to have its
  own `.oxis/workspace.lua`, and OXIS would silently load THAT
  instead while still reporting the old named workspace as active —
  wrong workspace shown on Home's panel, wrong root in the file tree,
  `'workspace newfile`/`github`/`gitlab` all operating against the
  wrong registry entry. Fixed by making `load()` the single place
  `activeNamed` is ever set (every caller now says explicitly: this
  name, or null for an ad-hoc directory) — it can no longer drift out
  of sync with what's actually loaded. Also stopped `detectAndLoad`
  from firing at all while a named workspace is active — a named
  workspace is a deliberate choice and shouldn't be silently
  overridden by incidentally `cd`-ing into an unrelated directory
  that happens to have its own workspace file (`'workspace switch
  default` first if you actually want the ad-hoc flow to take over).
  Reviewed every other workspace-lifecycle method (`renameNamed`,
  `removeNamed`, `close`) against this same fix for consistency —
  found them already correct.
- **Large-file editor freezing/lag.** Root cause: the syntax
  highlighter and the unsaved-change gutter's line diff both re-ran
  synchronously against the FULL file content on every single
  keystroke. Both now run against a debounced copy (150-200ms) of the
  content instead — the real `<textarea>` is never debounced, only
  the color overlay/change-gutter can lag a beat on a large file;
  small files see no perceptible change. Above 500,000 characters,
  syntax highlighting turns off entirely (plain text, with a visible
  notice) rather than attempting an expensive pass on a huge file.
  Known remaining gap, documented rather than silently left: line
  numbers still render one DOM row per line with no virtualization.
- **Home screen could overflow into scrolling on smaller windows —
  real root cause found**, not just spacing trimmed. The ASCII banner
  and the WORKSPACE/help box text were sized with `var(--fs)`, the
  same variable `'config set fontSize` controls for the terminal and
  editor — turning that up for coding readability would inflate
  Home's dashboard too, no logical connection between the two. Split
  into a dedicated `--home-fs`/`--home-lh` pair the font-size setting
  doesn't touch. Also compacted padding/margins throughout and added
  height-based media queries for genuinely short windows that scale
  the banner down rather than hiding content outright.
- **Ctrl+Z could wipe an entire document in one press.** Root cause:
  undo grouping collapsed one whole continuous Insert-mode session,
  however long, into a single undo step — normal usage (typing for a
  while without hitting Escape) meant one Ctrl+Z could erase
  everything typed since the session started. Fixed with time-based
  grouping (a group also breaks after a 700ms pause), the standard
  technique real editors use, so undo steps stay reasonably sized
  regardless of how long a typing session runs.
- **New workspaces started with three live, npm-specific tasks**
  (`dev`/`build`/`test`) registered automatically, assuming every new
  workspace is an npm project. Now commented out as examples —
  workspaces start empty, tasks get added deliberately for what the
  project actually needs. Existing workspace.lua files are unaffected
  (only the template for new ones changed).
- **`workspaces/<name>/tasks/` and `workflows/` folders were
  documented as "plain storage, not a real execution engine"** —
  contradicted by the actual, real workflow engine and tasks/
  workflows folder loading built earlier this session. Corrected.
- **Stale icon filename in the Windows version resource**
  (`cmd/oxi/versioninfo.json` referenced `oxishell.ico`, which doesn't
  exist — the real file is `oxis.ico`). The actual build wasn't
  affected (`build-go.js` passes `-icon=oxis.ico` explicitly, which
  takes precedence over the JSON), but the metadata itself was wrong.
  Also added an honest README section on Windows Defender/antivirus
  false positives — what's already done to minimize them (proper
  version metadata, standard build flags) and what would actually fix
  it (code signing, not implemented — requires a purchased certificate
  and a release-process change that don't exist yet).
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