# Changelog

All notable changes to OXIS are documented here. Dates are when the
change was made, not necessarily when a version was tagged.

## [Unreleased]

### Added

- **`'workspace github unlink` / `'workspace gitlab unlink` —
  Priority 4, a genuinely missing feature found while auditing the
  README, not just a documentation gap.** There was no way to
  disconnect a GitHub/GitLab remote at all before this — only ways to
  set one up or replace it. New `unlinkRemote()` in `git.ts`: by
  default renames `origin` to a timestamped backup rather than
  deleting it (OXIS has no separate "which provider is this"
  bookkeeping of its own — it just looks for a remote literally named
  `origin` to decide a workspace is connected, so renaming it away is
  what makes OXIS treat the project as unlinked while the remote's
  own URL stays fully intact and restorable via plain git), matching
  the explicit requirement that unlinking must not remove the actual
  git remote unless specifically asked to (`--remove-remote` does
  that instead). Touches nothing else — the local project, workspace,
  `.oxis/` directory, source files, and `.git` repository itself are
  never touched. `origin` is free again either way, so the same
  workspace can immediately connect to a different repository
  afterward. Updated both in-app `'help workspace` listings, which
  had also gone stale (see below).
- **README: three sections were dangerously stale, describing
  functionality that no longer exists while omitting what actually
  ships now — Priority 8, verified against the real code, not
  assumed.** "The `commit` task" still described the old
  `git-commit-dialog`/`tasks/commit.lua`-generated-conditionally flow
  that was explicitly retired earlier in this pass, with zero mention
  of push, cancellation, or classified errors — rewritten to describe
  `'task commit` as the direct, always-available built-in it actually
  is now. "Auto-Update" explicitly said "it just hands you the
  link... there's no separate updater process" — completely wrong
  now that `'update install` performs a real in-place update;
  rewritten with the actual mechanism, its rollback safety
  guarantees, the artifact-verification requirement, and the updated
  three-job CI structure. Added an entirely missing section,
  "Automatic Project Detection & Task Generation," documenting all
  nine detected ecosystems, the auto-detected/user-created/default
  task provenance model, and the task integrity checker's core
  guarantee (never aggressively overwrites a hand-edited task) — none
  of which existed anywhere in the README despite being a major
  feature of this pass.
- **CI now builds a Windows `.msi` too — the auto-updater added
  earlier in this pass could never actually offer a Windows update
  without this.** `Check()` in `update.go` looks for a `.msi`/`.exe`/
  `.deb` asset in the rolling "latest-build" release, but the CI
  workflow only ever built Linux — Windows builds were done and
  released manually, so there was never actually a `.msi` in that
  release for a Windows install to find. Restructured
  `.github/workflows/build.yml` into three jobs: `build-linux`
  (unchanged), a new `build-windows` (installs WiX Toolset via
  chocolatey — pinned to the exact version, 3.14.1, confirmed to be
  what the unversioned package currently resolves to, rather than
  trusting that indefinitely, since WiX v4+ replaces
  `candle.exe`/`light.exe` with a completely different single-binary
  CLI and would silently break this build the day chocolatey's
  default ever moves off v3; runs `npm run build` then
  `npm run build:msi`, exactly the two commands a person would run
  locally), and a new `publish-release` that depends on both and
  downloads their artifacts before publishing. That three-job
  split — build, build, THEN publish once — is deliberate: two build
  jobs publishing to the same rolling tag independently, in parallel,
  would race each other, with whichever finished last winning and
  whichever finished first potentially having its own assets
  clobbered before anyone saw them. Each build job stages its own
  outputs into a flat `release-files/` directory before uploading,
  specifically so the artifact's own internal layout is simple and
  predictable — `actions/upload-artifact@v4` otherwise preserves
  directory structure relative to the *least common ancestor* of
  whatever paths are listed, which would have quietly produced the
  wrong download path for the `.deb` (one directory level deeper than
  the other two Linux outputs) had it been left to that default.
- **The task integrity checker — spec item 8, the piece that makes
  automatic task generation trustworthy over time instead of a
  one-shot snapshot.** New `terminal/taskReconciler.ts`, run in the
  background (never blocking workspace load — a real requirement:
  detection can spawn subprocesses to confirm a tool exists) every
  time a linked workspace loads or reloads. The one rule everything
  here serves, stated explicitly by the person who asked for this:
  never aggressively "fix" a task the user has hand-edited. Each
  generated task's content is hashed at generation time
  (`GeneratedTaskMeta.contentHash`); reconciliation compares that hash
  against the task's actual current line in the file before touching
  anything — a mismatch means the user edited it, and that task is
  permanently carried forward exactly as they left it, un-tracked by
  the auto-generated metadata from that point on, kept in the file
  even if its original source configuration later disappears
  entirely. Untouched tasks are reconciled normally: still present
  with the same command → left alone; present with a different
  command (a script got renamed to run something else) → updated;
  no longer present (a script was deleted) → removed. New tasks a
  project didn't have before → added. Verified with a direct
  simulation covering all four cases happening at once in a single
  pass (one edited, one updated, one removed, one added) before
  trusting the real implementation — every outcome matched exactly.
  `go build ./...`/`go vet ./...`/`tsc --noEmit` all clean.
- **Automatic project detection and task generation on `'workspace
  link` — Priority 5 of the spec-driven pass.** New
  `terminal/projectDetector.ts`: real detectors for Rust (Cargo),
  Node.js/JS/TS (reads actual `package.json` scripts — never
  generates `npm run build` for a project with no build script;
  detects the real package manager from its lockfile: pnpm/yarn/bun/
  npm), Python (`pyproject.toml`/`setup.py`/`requirements.txt`, with
  real tool-section checks for pytest/ruff/black rather than assuming
  every Python project uses them), Go (`go.mod`), .NET
  (`.csproj`/`.fsproj`/`.sln`), Java (Maven or Gradle, using the
  project's own wrapper script — `./mvnw`/`./gradlew` — when present),
  C/C++ (CMake, or Make with real target extraction from the actual
  Makefile — verified with a direct test that it correctly excludes
  variable assignments like `CFLAGS = ...` and `SRCS := ...`, not
  just target lines), PHP (`composer.json` scripts), and Ruby
  (`Gemfile`/`Rakefile`). Generated tasks are written to their own
  file, `.oxis/tasks/auto-detected.lua` — completely separate from
  `workspace.lua` and any hand-written `tasks/*.lua`, so generation
  can never touch or overwrite anything a person wrote themselves,
  by construction rather than by convention. A metadata sidecar
  (`.auto-detected-meta.json`) records each task's source and a
  content hash, laying the groundwork for the task integrity checker
  (still to come) to tell "still exactly as generated" apart from
  "hand-edited since" — tested the escaping and generated-file
  grouping logic directly, including a Lua-string apostrophe case.
  `go build ./...`/`go vet ./...`/`tsc --noEmit` all clean.
- **README: replaced the "See it in action" YouTube embed with a real
  screenshot** (`assets/screenshot-git-connected.png`) showing the
  Home screen's workspace panel with a live GitLab connection — a
  static image of the actual app rather than a video link out.
- **`'update install` — a real, automatic, in-place update, not just
  a browser link — Priority 2 of the spec-driven engineering pass.**
  This is genuinely high-risk (a bug here could leave someone without
  a working `oxis.exe`), so implemented with maximum safety margins
  at every step, all in `internal/wailsapp/selfupdate.go`: downloads
  the new build to a temp file first, verifies it (non-trivial size —
  a real gap flagged in its own doc comment: no checksum is published
  alongside the rolling release yet to verify against more
  rigorously), only THEN renames the currently-running exe to a
  backup path (Windows allows renaming/moving an in-use file, just not
  overwriting it in place — the whole mechanism depends on this),
  moves the verified download into the vacated install path, launches
  it as a new process, and confirms — via a non-blocking `cmd.Wait()`
  with a timeout, not the Unix-only "signal 0" trick, which doesn't
  work on Windows — that it's still alive a moment later before
  declaring success. Any failure at any step rolls back to the exact
  working state from before. The backup is deleted by the NEW
  process itself, from its own `(a *App).startup` — genuinely
  reaching that point IS the real confirmation the spec asked for
  ("verify the new version actually launched"), not just Start() not
  immediately erroring. Preserves the exact existing install path
  always — never Downloads, never a different default location, since
  it replaces the file at `os.Executable()`'s own path, whatever that
  actually is. Also fixed a real gap in the CHECK side while building
  this: `Check()` used to set `Available: true` purely from a commit
  SHA comparison, without ever confirming a usable download actually
  existed OR that its URL genuinely resolves — a real HEAD request
  (`artifactIsAccessible`) now gates `Available` too, matching the
  spec's explicit "never advertise an update before the actual
  downloadable artifact exists and is accessible."
  **Honestly flagged**: `go build ./...`/`go vet ./...` both clean,
  and the logic was designed with real Windows file-locking semantics
  in mind throughout, but this could not be exercised against a real
  Windows install replacing itself from this environment — this is
  the single most important piece of this whole pass to test for
  real before trusting it on an actual machine.
- **Real cancellation for `'task commit` — Ctrl+C now actually kills
  the in-flight git process, not just stops waiting for it.** There
  was genuinely no way to interrupt an in-flight `RunCommand` call
  before this — the only thing that could ever stop one was a fixed
  timeout. That timeout also had to grow from 30s to 3 minutes as
  part of this same change, since `commitAll` pushing now (see
  above) means a real, legitimately slow network operation goes
  through this exact binding, and 30s could have falsely killed a
  genuinely-still-in-progress push and reported it as failed. Added
  `internal/wailsapp/app.go`'s `CancelCommand`, keyed by a request ID
  the frontend generates per call and can hand back later to cancel
  that exact in-flight one — cancelling the underlying Go context is
  what makes `exec.CommandContext` actually kill the child process
  (`Process.Kill`, per the stdlib's own documented behavior), not
  just stop waiting on it, so a cancelled push can't leave an
  orphaned `git.exe` running in the background. `git.ts` tracks
  whichever step of `'task commit` is currently active so Ctrl+C can
  target it, and `runCommitTask` now reports a genuine cancellation
  as its own distinct "commit cancelled" message instead of folding
  it into a generic "commit failed" — a user-initiated stop isn't
  the same thing as an actual failure. `go build ./...` and
  `go vet ./...` both clean.
- **`'task commit` now actually pushes to the connected remote —
  starting a large, priority-ordered engineering pass driven by a
  detailed spec and real screenshots of it still being broken.**
  `commitAll()` used to explicitly, deliberately never push (an
  earlier design note said so directly) — a real, reported gap: a
  "successful" commit task that never reached GitHub/GitLab wasn't
  doing what anyone running `'task commit` would expect. Pushes to
  `origin` after a successful commit if one is configured; a commit
  with no remote configured is NOT an error (`pushed: false`, no
  error message — committing locally-only is completely valid).
  Push failures are classified, not just raw stderr dumped at the
  user: authentication failures, diverged-history rejections
  (deliberately NOT auto-merged/rebased — that's a real decision a
  person should make, not something a commit task should guess at),
  unreachable remotes, and missing repositories each get their own
  clear message. Added an `onProgress` callback so the caller can
  show real progress ("staging changes…", "committing…", "pushing to
  origin…") instead of one silent black box, and `runCommitTask` now
  reports the push outcome as its own clearly-marked line
  (`✓ pushed to origin` / `⚠ committed locally, but push failed: ...`
  / a dim note when there's no remote at all) instead of folding
  everything into one message.
- **MSI: install location is now validated and restricted to the
  user's own profile, not just picker-enabled.** A real Custom Action
  (VBScript — the reliable WiX 3 pattern for this, not MSI's own
  property table, which doesn't reliably auto-expose `%USERPROFILE%`)
  now runs on every "Next" click from the Destination Folder page:
  defaults the path to `%USERPROFILE%\OXIS` instead of Program Files,
  and rejects anything NOT under the user's own profile — Program
  Files, another drive's root, another user's folder, all correctly
  blocked — with a real warning dialog before install proceeds, not
  a launch-time rejection after clicking through every remaining
  page. Extracted and validated the actual generated XML (not just
  the static template) end to end; well-formed. The workspace/
  plugins/documents folders added last time are genuinely nested
  under `INSTALLFOLDER` in the WXS, so they follow wherever the user
  picks automatically — confirmed, no changes needed there.
- **Linux: a portable tarball, matching the Windows portable `dist/`
  folder experience, built in both places that package Linux —
  found they'd drifted apart.** `build-linux.sh` (what GitHub Actions
  CI actually calls) turned out to be a completely separate
  implementation from `build-go.js`'s own Linux packaging path, and
  it was stale — still said `Maintainer: OxiShell <oxis@gitlab.com>`,
  and never got the Downloads-fallback postinst message added to the
  other file earlier this session. Fixed both, and added a new
  `dist/oxis-<version>-linux-portable.tar.gz` to each: the binary
  plus pre-created empty `workspaces/`, `created-plugins/`,
  `created-documents/` folders, extract-and-run, no package manager.
  Deliberately NOT bundled into the `.deb` itself — `/usr/bin` is
  shared across every user on a Linux machine, and per-user data
  belongs there as little as it belongs in Program Files, for the
  same reason. `.github/workflows/build.yml` updated to upload and
  publish the new tarball alongside the existing binary and `.deb`.
- **README accuracy sweep — cross-checked claims against the actual
  code rather than trusting labels already there, found real,
  significant staleness.** Checked the real Lua API bindings in
  `luaRuntime.ts` against what a `[planned]` table claimed:
  `oxis.fs.read/write/list/stat/mkdir/remove`, `oxis.process.list/kill`,
  `oxis.net.request`, and `oxis.system.info` are all genuinely
  shipped — only `fs.watch` and `process.spawn` are actually still
  missing, not the whole surface the table implied. Also fixed:
  "Plugin templates" (shipped — `--template=basic|dev|devops|system`
  is real), "Free/community/premium plugins" (shipped — the very next
  table row already correctly described the same feature), "Search
  Mode" (the underlying capability ships in all three places —
  terminal scrollback, command history, editor find — just not
  through the literal `/` key this row described), and "Third-party
  paid plugins" in the Coming Soon section (the actual publishing
  flow, `'plugin publish --price`, is real and working — what's still
  gated is OXIS's own Stripe production-mode verification, not a
  missing publishing UI).
- **MSI: real install-location picker (`WixUI_InstallDir`) and
  explicit, empty `workspaces/`/`created-plugins/`/`created-documents/`
  folders created at install time, not left to appear lazily on
  first use.** The whole reason nothing seemed to show up under
  `Program Files\OXIS` right after installing — the folders were
  correctly permissioned (see the grant below) but genuinely didn't
  exist yet, since the app only creates each one the first time it's
  actually needed (first plugin, first document, first workspace).
  Now they're real, visible, empty folders the moment install
  finishes, wherever the person chooses to install to — the location
  picker isn't hardcoded to Program Files anymore either. Needed
  `WixUIExtension` linked at both compile and link time, and a
  license RTF for its License Agreement page (`buildLicenseRtf()`
  converts the real `LICENSE` file — Apache 2.0, not a placeholder —
  into minimal valid RTF; escaping RTF's own control characters and
  turning blank lines into paragraph breaks is enough for plain text,
  no real formatting needed).
- **Linux `.deb`: matching explanation, not a matching picker —
  `dpkg` installs are fundamentally non-interactive, so there's no
  GUI step to add a location choice to, and `/usr/bin` (where the
  binary goes) has to stay fixed.** The underlying need was already
  solved without any installer change: `/usr/bin` isn't writable by
  a regular non-root user either, so OXIS's own write-test in
  `AppDirPath()` already redirects to `~/Downloads/OXIS` on Linux
  the same way it does for an MSI install landing in Program Files —
  same code, no Linux-specific branch needed. Added a `postinst`
  message that says this plainly right after `apt install` finishes,
  rather than leaving it to be discovered.
- **MSI now grants the "Users" group write permission on
  `Program Files\OXIS` during install** (`util:PermissionEx`, WiX's
  utility extension — linked at both compile and link time now,
  `candle.exe` was missing `-ext WixUtilExtension`, needed for the
  compiler to recognize the extension element at all), so
  `workspaces/`, `created-plugins/`, `created-documents/` can live
  under `Program Files\OXIS` itself as requested, not redirected to
  Downloads. This is the standard, correct way to give an app write
  access to its own install folder without requiring it to run
  elevated on every launch — the MSI runs elevated once, during
  install (installing to Program Files always requires that), and
  grants the permission up front. Reverting to writing there as a
  normal user without this would have brought back the exact bug this
  session already found and fixed (Program Files' UAC protection
  silently blocking every write). `AppDirPath`'s own write-test/
  fallback logic in `internal/wailsapp/app.go` needed no changes at
  all — it's generic, so it now simply detects the grant took effect
  and uses `Program Files\OXIS` directly; the Downloads-folder
  fallback stays in place purely as a safety net (e.g. Group Policy
  overriding the grant), not the primary path anymore for a normal
  install.
- **`addLines`/`ctx.printLines` — a batched sibling of `addLine`/
  `ctx.print`, found and added during a performance audit.**
  `addLine`'s own `[...next, newLine]` copies the whole scrollback
  buffer (up to 10,000 lines) on every single call — fine for one
  line, but a real, measurable cost when a command splits a multi-
  line message and calls it once per line, which several places
  already did (`'plugin publish`/`unpublish`'s own status messages,
  `'plugin info`). Each of those now builds the whole batch of lines
  first and makes one state update instead of N, same total output,
  one buffer copy instead of N.
- **README's "Screenshots" section removed** — three `<img>` tags
  pointing at `assets/screenshot-*.png` files that don't exist in
  the repo (confirmed — grepped for any other reference to them,
  found none). A section of broken images is worse than no section.
- **Home's help box: the `'theme` line replaced with the command
  palette hotkey** (`Ctrl+Shift+P`) — checked the palette's own
  wiring first (the keydown listener is on `window`, unconditional;
  Home's own input handler only intercepts Escape/Enter, so it
  doesn't swallow the hotkey; `runHomeCommand` correctly opens the
  shell and runs the selected command whether or not it's ready yet)
  and found it already worked correctly — this was a documentation
  gap, not a functional bug.
- **Markdown live preview — the editor's preview feature now covers
  `.md`/`.markdown`, rendered like GitHub/GitLab render a README, not
  just `.html`.** Added `marked` as a real dependency (a real,
  tested markdown parser, not a hand-rolled regex converter that
  would look close enough until a table or nested list broke it) —
  verified it actually parses correctly before wiring it in. Styled
  with a GitHub dark-mode look (headers, code blocks, tables,
  blockquotes). Renders ` ```mermaid ` fenced blocks as actual
  diagrams via Mermaid.js (loaded from a CDN inside the preview
  iframe itself, same external-resource model the HTML preview
  already used) — this README's own Architecture/Business Model
  diagrams are exactly that, so this wasn't optional for the feature
  to actually be useful on this repo's own README. Same resizable
  split, fullscreen mode, and sandboxing (`allow-scripts`, no
  `allow-same-origin`) as the existing HTML preview — one shared
  pipeline, not a separate implementation.
- **README's box diagrams — three found broken, fixed with two
  different approaches depending on what each one actually was.**
  Reported as rendering broken/misaligned on GitHub, a known, common
  problem with hand-drawn box-drawing-character diagrams in markdown:
  they depend on pixel-perfect monospace alignment across many lines,
  which doesn't hold up reliably in every renderer. The Architecture
  and Business Model diagrams (real flowcharts) became actual Mermaid
  diagrams — GitHub renders ` ```mermaid ` fences as real vector
  graphics, so there's no alignment to break. **The Home screen's
  WORKSPACE panel mockup was initially left as-is, incorrectly
  assumed safe — reported broken too, in a follow-up screenshot,
  which it was.** That one isn't a flowchart (Mermaid doesn't fit a
  "here's what this UI panel looks like" mockup), so it got a
  different fix: the vertical `│` border bars removed entirely,
  leaving plain, left-aligned key-value text with nothing left that
  needs cross-line alignment to look right. Also found and fixed,
  while sweeping the whole document for any other instance of this
  same problem: Directory Structure's tree listing still included
  `tabs.ts` — the file deleted as dead code earlier this session —
  with a description implying it was still active and in use.
- **Real YouTube video wired into the README's video section** —
  `eiCB0-0p7p4`. Switched the thumbnail from `maxresdefault.jpg` to
  `hqdefault.jpg`, which is guaranteed to exist for every YouTube
  video (maxres thumbnails only get generated for higher-resolution
  uploads) — couldn't verify either way from this environment
  (img.youtube.com isn't in this sandbox's network allowlist), so
  picked the option that can't end up broken regardless.
- **GitHub repo URL received (`oxlaboratory/oxis`) — every placeholder
  from the earlier GitLab→GitHub migration work filled in.**
  `internal/update.ProjectPath`, `lib/github.js`'s `OWNER`/`REPO`, and
  every doc link across README/index.html/CONTRIBUTING.md/
  wrangler.toml now point at the real repo instead of a marked
  placeholder. Also cleaned up several doc comments that had gone
  stale mid-session as pieces got built (e.g. `update.go` still said
  the GitHub Actions workflow was "to-be-written" after it had
  already been written) — these now accurately describe what exists.
- **README: badges, a video section, and a real research-backed "why
  this approach" section.** Badges (OXIS/GitHub stars/License, plus
  total and latest-release download counts) at the top; a YouTube
  video placeholder right below them, ready for a real video ID once
  one exists. New "Why a customizable, extensible terminal at all?"
  section citing real, external sources for three specific claims —
  terminal customization's documented effect on developer workflow,
  Lua's two-decade track record as an embedded extension language
  (World of Warcraft, Roblox, Adobe Lightroom), and VS Code's
  100,000+ extension marketplace as proof the plugin-ecosystem model
  works at scale. That last citation cuts both ways honestly: the
  same research documents real malicious-extension incidents in the
  VS Code marketplace, cited specifically as part of *why* OXIS's own
  Market publishing keeps a human-review gate rather than being fully
  automatic, not just as a success story with the security risk left
  out.
- **GitLab → GitHub migration for the Market's publish/delete
  backend, prepared ahead of having the actual repo URL.**
  `cloudflare/functions/lib/gitlab.js` removed; new
  `cloudflare/functions/lib/github.js` replaces it, using GitHub's
  Contents API (simpler than the Git Data API real atomic multi-file
  commits would need — a deliberate tradeoff, documented in the file
  itself: submitting a plugin is now two separate commits on the
  branch, not one). `submit-plugin.js` and `delete-plugin.js`
  rewritten to use it — same behavior, same human-review-gated model,
  just talking to GitHub instead of GitLab. `wrangler.toml`/
  `.dev.vars.example` updated for a `GITHUB_TOKEN` secret (fine-
  grained PAT, Contents + Pull requests read/write, scoped to the
  repo) replacing `GITLAB_TOKEN`. Updated every GitLab reference in
  the README and the Market website (`index.html`) to match — the
  ones that couldn't be filled in with a real value (the repo path
  itself, in `internal/update.ProjectPath` and
  `lib/github.js`'s `OWNER`/`REPO`) are clearly marked placeholders,
  same pattern as the auto-updater and CI workflow from earlier in
  this session. `'workspace github`/`'workspace gitlab` (for a USER'S
  OWN project's git remote — completely unrelated to which platform
  OXIS itself is hosted on) are untouched; both remain fully
  supported either way.
- **`.github/workflows/build.yml`** — replaces `.gitlab-ci.yml`
  (removed). Builds Linux on every push, same as before, uploaded as
  a workflow artifact. New: on a push to the default branch (never a
  PR), also publishes the build to a rolling `latest-build` release —
  this is the CI half the new commit-based auto-updater needed (see
  below) and didn't have until now. Windows still builds locally, not
  in CI, unchanged from the GitLab CI version's own approach.
  **One thing still needs filling in**: `internal/update.ProjectPath`
  is a placeholder the client uses to know where to check — this
  workflow itself doesn't need the repo path (GitHub Actions resolves
  its own repo automatically via `${{ github.repository }}`), but that
  one client-side constant still does.
- **`scripts/clean-install.ps1`** — a safe clean-reinstall helper for
  the recurring "stale 'release' task keeps showing up" reports this
  session. Root cause: running OXIS as a portable `dist/` folder
  (extract a zip, run `oxis.exe` directly, rather than the real MSI
  installer) means workspace/plugin data sitting alongside the exe can
  silently persist across "new" downloads if a new zip lands on top of
  an old folder without clearing it first. The script only ever
  touches files/registry keys it can specifically identify as OXIS's
  own (never anything inside a connected project), and always shows
  what it found and asks before deleting, unless run with `-Force`.
- **`'task commit <message>` — the commit flow, completely redesigned
  after being reported broken (screenshot showed garbled `Write-Host`
  text in the terminal).** Root cause: the auto-created "commit" task
  had `oxis.task()`'s command set to the STRING `"'git-commit-dialog"`
  — an OXIS-internal command — but `oxis.task()`'s command is always
  sent to the real shell (PowerShell/bash), which has no idea what a
  leading-apostrophe OXIS command is. This had never actually worked,
  since the task was first introduced. Retired the whole dialog-based
  flow (`CommitDialog` component, `git-commit-dialog` command, the
  per-workspace `ensureCommitTask()` file-writing, and their CSS) and
  replaced it with a direct, built-in `'task commit <message>` command
  that calls `commitAll()` directly — no shell/task indirection left
  to go wrong — with real progress (`committing in <dir>…`) and a
  clear `✓`/`✗` result. A commit message is now required as an
  argument, matching how the old dialog's message field always should
  have worked but never actually could, given the underlying command
  never even reached `commitAll()`.
- **Auto-updater redesigned: checks commits, not release tags.**
  Previously only checked GitLab's tagged Releases API — a push to
  main never triggered a notification until someone manually cut a
  release. Now compares the running binary's own build commit
  (`internal/update.BuildCommit`, stamped in via `-ldflags -X` —
  `build-linux.sh` updated) against the commit recorded in a
  continuously-overwritten "rolling" GitHub release
  (`latest-build`). **Honestly incomplete**: this is the checking
  half only — the CI half that actually publishes/updates that
  rolling release on every push doesn't exist yet, and needs a GitHub
  Actions workflow once the real repo exists. Also found and fixed,
  while auditing this: a completely SEPARATE, already-broken update
  check (a raw `fetch()` straight to GitLab's API with a literal
  `"YOUR_PROJECT_ID"` placeholder that had never been filled in) that
  ran silently on every single startup and could never have worked —
  replaced with the real mechanism.
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

- **`build-msi.js`'s `findWiX()` — a real, pre-existing bug, confirmed
  against a second real CI run, that had simply never been triggered
  before now.** After the previous fix stopped chocolatey from
  reinstalling WiX unnecessarily, the very next run got further and
  hit a different failure: "WiX found but candle.exe/light.exe are
  incomplete — skipping MSI" — despite WiX genuinely being present.
  `findWiX()`'s first candidate is the bare string `"candle.exe"`
  (checking whether it's resolvable via the system PATH at all); when
  that resolved successfully via `spawnSync`, the code did
  `path.dirname("candle.exe")`, which is just `"."` for a bare name
  with no real directory information — not the actual WiX bin
  directory. `buildMSI()`'s own `fs.existsSync` check for
  `"./candle.exe"` then correctly found nothing there, since the real
  binary lives in `C:\Program Files (x86)\WiX Toolset v3.14\bin\`, not
  the repo root. This is why it was never caught before: on every
  previous build (local machines, the old manual Windows release
  process), `candle.exe` was presumably never actually on `PATH`
  itself, so this candidate always failed cleanly and fell through to
  the correct, full-path candidates lower in the list — CI is the
  first environment where WiX being preinstalled AND on `PATH` made
  this specific buggy branch actually get hit. Fixed with a real
  `where candle.exe` resolution for the PATH case, checking every
  match `where` returns (not just the first) for a real sibling
  `light.exe` before accepting it — since `where` can list more than
  one match, e.g. a chocolatey shim (a one-off wrapper executable, not
  necessarily sitting next to a real `light.exe` the way an actual WiX
  bin directory would be) earlier on `PATH` than the genuine install
  directory. Verified the parsing (CRLF line endings, multiple
  matches, correctly skipping a shim with no sibling `light.exe`)
  against realistic simulated `where` output before trusting it.
- **CI: `build-windows` failed outright on its very first real run —
  the exact thing flagged as unverified turned out to need fixing,
  confirmed against a real GitHub Actions log, not assumed.**
  `choco install wixtoolset --version=3.14.1` failed with "a newer
  version of wixtoolset (v3.14.1.20250415) is already installed" —
  `windows-latest` ships WiX Toolset v3.14 preinstalled, and pinning
  an exact chocolatey version made it refuse to proceed without
  `--force`/`--allow-downgrade`, rather than just recognizing a
  compatible version was already there. Fixed by checking for
  `candle.exe` at WiX's real v3.14 install path first (the same path
  `build-msi.js` itself already searches) and only invoking
  chocolatey if it's genuinely missing — sidesteps the version-pin
  conflict entirely, and is more robust than the previous unconditional
  install if a future runner image ever drops WiX from its defaults.
- **README's "Updates and rollback" section made an absolute claim
  ("you're never left with a broken plugin") that the code didn't
  actually guarantee until this same pass fixed it.** Before the
  `rollbackPlugin()` fake-success fix earlier in this audit, an
  automatic rollback could itself silently fail while still being
  reported as successful — meaning the README's claim was aspirational
  at best, not yet true, at the time it was written. Reworded to be
  precisely honest now that the underlying fix makes it accurate: a
  failed restore is reported plainly, not silently masked as recovery
  having succeeded. Applied the same correction to the compact
  feature-table row for consistency.
- **In-app `'help workspace` text and README's "Git Integration"
  section both still claimed things that haven't been true since
  earlier in this same pass.** The help listing said `'workspace
  github`/`gitlab` "also adds a commit task the first time this
  succeeds" — stale from before `'task commit` became the always-
  available universal built-in it is now. README's "Git Integration"
  was worse: it claimed a 30-second timeout (actually 3 minutes,
  changed earlier in this pass specifically for push support), said
  the Go binding "could not be compiled or run in the environment it
  was built in" (false — extensively compiled and `go vet`'d
  throughout this entire session), described the retired commit-
  dialog flow, and said remote setup "does not push" (wrong — it does
  now, via `'task commit`). Rewrote both to match the actual, current
  code, including documenting the real `RunCommand` signature
  (verified against `app.go` directly, including the `requestID`
  parameter that makes real cancellation possible) rather than an
  outdated one.
- **`rollbackPlugin()` — the update flow's own safety net — could
  itself silently fail, the worst version of the fake-success
  pattern found this whole audit.** It returned `ok: true`
  unconditionally after calling `addLuaPlugin()`, never checking
  whether the RESTORED plugin actually loaded successfully — unlike
  `updatePlugin()` itself, which already correctly checks exactly
  this after its own `addLuaPlugin()` call. That made it worse than
  an ordinary fake-success bug: `updatePlugin()` calls this
  automatically when a new version fails to load, reporting
  "automatically rolled back" — if the rollback ALSO failed to load
  (the backed-up source somehow also broken, a compatibility check
  now rejecting it), the person would still be told recovery
  succeeded while the plugin sat there broken and disabled, with no
  indication anything was still wrong. Fixed to check real final
  state the same way `updatePlugin()` already does, and fixed the
  automatic-rollback message itself to distinguish "rolled back
  successfully" from "rollback also failed" instead of always
  claiming success in both cases. The `'plugin rollback` command
  handler already correctly branched on the result's `ok` field, so
  it benefits from this fix automatically with no changes of its own
  needed.
- **`unload()` (and therefore `disable()`) could leave persisted state
  out of sync with in-memory state if a plugin's own Lua teardown
  threw — continuing the marketplace reliability audit.**
  `disable()` sets the in-memory `enabled` flag to false, calls
  `unload()`, THEN persists — but `unload()`'s call to the plugin's
  own `dispose()` had no try/catch around it, so an exception there
  would propagate straight through and abort `disable()` before
  `persist()` ever ran: in memory the plugin already looked disabled,
  but the ON-DISK state would still say enabled, meaning it could
  come back enabled on the next launch — the same class of bug as
  the uninstall issue above, just a different trigger. Found the
  inconsistency by noticing this file already wraps the equivalent
  `dispose()` call in a try/catch elsewhere (`loadTasksFrom`) but not
  here — fixed to match, so a plugin's own teardown failing can never
  block the rest of `unload()`/`disable()` from completing correctly.
  Also audited every caller of `enable()`/`disable()` for the same
  "trusts an optimistic return value instead of the real, final
  state" pattern that `enableAll()` already explicitly guards
  against in its own comment — the `'plugin enable` command and the
  Plugin panel's own UI toggle both already correctly re-check real
  state afterward (`pluginManager.get(name)?.enabled` and a full
  `refresh()` respectively), so no further bug found there.
- **A plugin could silently reappear after being "successfully"
  uninstalled — a genuinely severe fake-success bug, found continuing
  the marketplace reliability audit.** `pluginManager.remove()` used
  to delete the in-memory entry and persist that removal BEFORE the
  actual file delete was even attempted, and that delete's failure
  was silently swallowed by a `catch { /* already gone, or browser
  mode */ }` — a reasonable-looking comment masking a real problem,
  since a genuine delete failure (a locked file, permissions, a disk
  error) looks identical to "already gone" from a bare catch.
  `loadUserPlugins()` scans the filesystem directly to discover
  plugins — confirmed it has no separate persisted "which plugins
  exist" list to consult at all — so a `.lua` file left behind by a
  failed delete would get silently rediscovered and re-registered
  the next time plugins load, undoing an uninstall the user had
  already been told succeeded, with nothing telling them it
  happened. Fixed by attempting the delete FIRST, then actually
  confirming the file is gone (`statPath` for user plugins,
  `listPluginFiles()` for market ones — matching exactly how
  `loadUserPlugins()` itself discovers each kind) before ever
  touching the in-memory registry. A file still present after the
  delete attempt is now a real, reported failure that leaves the
  plugin exactly as it was — visible, manageable, not silently
  dropped from OXIS's own view of the world while surviving on disk.
- **`installPremium()` fake success — Priority 6, marketplace
  reliability audit.** The package could genuinely download and
  encrypt successfully while the plugin still failed to actually
  load (bad Lua source, a validation failure) — this used to
  `await loadPremiumPlugin(name)` without ever checking its result,
  so `installPremium()` resolved successfully regardless, and the
  caller unconditionally printed "installed & unlocked" either way.
  Now returns `loaded`/`loadMessage` (same honest pattern the free-
  plugin `install()` already used via its own `persisted`/
  `persistError`), and the command handler checks it: a genuine load
  failure now says so plainly, and points at `'plugin reload` to
  retry without re-downloading — verified that claim is accurate by
  reading `reload()`'s own implementation, since it reuses the
  already-decrypted, in-memory Lua source rather than needing to
  re-fetch or re-decrypt anything.
  **Noted, not fixed this pass**: `'plugin reload` bypasses the
  subscription-license check entirely (it calls
  `pluginManager.reload()` directly, not `market.loadPremiumPlugin()`)
  — confirmed there's no periodic background re-check anywhere else
  either (only three call sites for `checkLicense` total: install,
  load, and the explicit `'market status` command), meaning a premium
  plugin stays functional through a generic reload even after its
  subscription has lapsed mid-session, until the app itself restarts.
  Lower severity than a fake-success bug — checking licenses at
  startup rather than continuously is a common, accepted pattern —
  but worth flagging honestly rather than leaving unexamined.
- **The stale `release` task — Priority 4 of the spec-driven pass,
  found the actual root cause rather than guessing.** Turned out not
  to be leftover per-workspace persisted data at all (the first,
  more complex theory) but a hardcoded `oxis.task("release", ...)`
  in a built-in, shipped plugin (`git_advanced.lua`) — registered
  fresh every single time that plugin loads, for every workspace,
  since built-in plugin source is never separately cached/persisted
  (only its enabled/disabled flag is — see `persist()`'s own doc
  comment in `pluginManager.ts`), confirmed before assuming a fix
  here would actually reach existing installs automatically on their
  next update. Removed the line entirely — `git add -A && git commit
  ... && git push` is now fully redundant with what `'task commit`
  itself already does (commit AND push together, see above), which
  is exactly what the spec asked for: "the intended default Git-
  related task is only 'task commit." Swept the rest of the codebase
  (Go backend, every `.lua` file, every `.ts`/`.tsx` file) for any
  other source of a `"release"` task string — none found.
- **`'task commit` invisible from the one place a person would
  actually look to see it exists, on Home's own workspace panel.**
  Traced the spec's "'task commit can disappear from the Home task
  display after it fails" concern and found `'task commit` itself
  was already fully robust to every scenario listed (success,
  failure, cancellation, restart, reload) — it's a direct,
  unconditional special case in the `'task` command handler, not an
  `oxis.task()` registry entry that could be lost. But it was never
  actually IN the task list Home's `WorkspacePanel` displays
  (`workspaceState.taskNames()`) or `'workspace info`'s own tasks
  line, precisely BECAUSE it isn't a registry entry — both only ever
  listed `oxis.task()`-registered tasks. Both now always show
  "commit" first, deduplicated in case a workspace ever also defines
  its own literal "commit" task, so it's never listed twice.
- **`'new`/`'touch` while a workspace was active — reported directly
  as "doesn't create a document, only works once I close the
  workspace."** `workspaceManager.documentsDir()` used to split
  between `created-documents/` and `workspaces/<name>/documents/`
  depending on whether a workspace was active — but a workspace's
  real, visible top-level location (per the Home file explorer) is
  `created-documents/`, and a workspace linked to an external project
  in particular has no obvious reason its own internal
  `workspaces/<name>/documents/` folder should be where a plain text
  document lands instead. The reported symptom matches exactly: the
  file wasn't failing to create, it was landing somewhere buried the
  user had no reason to go looking, which looked identical to it
  silently not being created at all. Simplified to always use
  `created-documents/` — confirmed `'new`/`'touch` are its only two
  callers, so nothing else could have depended on the old per-
  workspace behavior. `pluginsDir()` was deliberately left alone: a
  workspace's own created plugins loading in per-workspace is
  meaningful in a way a plain document has no equivalent for.
- **`'healthcheck` (and any plugin calling `oxis.run()` more than
  once in the same command handler) could produce garbled, colliding
  script output — the second launch line landing on top of the
  first, still-running one — a real bug caught by a screenshot, root-
  caused, and fixed, not patched over.** `scriptRunTracker.ts`'s
  `pending` map only ever TRACKED which markers to watch for and
  resolve; nothing actually stopped a second call from dispatching
  (calling `send(...)`) while a first was still pending.
  `dispatchOxisCmd` checks `isBusy()` before launching a new
  top-level `'`-command, but that only guards BETWEEN separate
  commands — it can't help when a single plugin's own Lua code calls
  `oxis.run()` more than once inside ONE command handler invocation
  (check disk space, then network, then git status, as three
  separate calls — a completely normal thing to write), which Lua
  has no way to serialize itself: `oxis.run()` is fire-and-forget
  from Lua's own side, there's no `await` a Lua script can write.
  Both calls fired their `send(...)` immediately, back to back, into
  the one shared PTY. Fixed by actually queuing dispatch, not just
  tracking it — each call now chains onto an internal queue and only
  sends once whatever was queued before it has genuinely finished, so
  multiple `oxis.run()` calls from one plugin now run one after
  another like real sequential script lines, instead of colliding.
  Also fixed a new edge case my own fix introduced before shipping
  it: cancelling (Ctrl+C) while multiple calls were queued used to
  only stop the currently-active one — anything still queued behind
  it would still go ahead and dispatch once its turn came. Added a
  generation counter cancel() bumps, so anything still waiting
  resolves as cancelled without ever sending its command. Verified
  the whole thing — serialized dispatch, sequential completion, and
  cancellation actually stopping both the active call and everything
  still queued — against a direct simulation of the real logic before
  finalizing, not just reasoned about.
- **The actual root cause of `'task commit` hanging with a visible,
  empty `git.exe` popup window — a real, screenshotted report, not a
  guess.** `exec.Command`/`exec.CommandContext` never set anything to
  suppress the console window Windows allocates by default for a
  spawned console program, on any of the four places in `app.go`
  that spawn one: `RunCommand` (the actual `'task commit` path),
  `cloneSourceInBackground`'s git clone, `ListProcesses`'
  `tasklist`/`ps`, and `KillProcess`'s `taskkill` — Wails itself has
  no console of its own, so Windows creates a brand new one for the
  child process every time. Fixed with a shared `hideWindow()` helper
  (`syscall.SysProcAttr.HideWindow`, the documented standard fix),
  split into `hidewindow_windows.go`/`hidewindow_other.go` following
  the same platform-file convention already used for the PTY code —
  the field doesn't exist on non-Windows builds at all, so this
  couldn't be set unconditionally in `app.go` directly. Verified with
  a real Go build (`go build ./...`, `go vet ./...`, both clean); a
  full Windows cross-compile hit the same known sandbox network
  restriction as earlier PTY work (a transitive `golang.org/x/sys`
  dependency this environment can't reach) — `gofmt` confirms valid
  syntax for the new files, but this specific fix still deserves one
  real Windows test before fully trusting it end to end.
- **CRITICAL — the single most severe bug found this entire session,
  in the core Lua↔JS bridge: an ordinary Lua array literal like
  `{10, 20, 30}` could silently lose values and convert to a
  malformed object instead of an array.** Not a rare edge case —
  reproduced directly against the exact fengari version this project
  uses (0.1.5, confirmed matching) and it broke on the *first, most
  basic test case*: fengari's `lua_next` iterates that table's keys
  as 3, 2, 1 (reverse), not 1, 2, 3, and `luaToJS`'s old array-
  detection logic assumed sequential order — checking each key AS
  ENCOUNTERED against an incrementing counter. Reversed order broke
  it completely: key 3 arrived first, didn't match counter 1, flipped
  an `isArray` flag to false permanently, and every value already
  pushed into the in-progress array — including a real one, 20, for
  key 2 — was silently discarded when the function returned the
  object instead. `{10, 20, 30}` converted to `{"1":10,"3":30}`,
  dropping `20` entirely. This is the core value-conversion function
  behind `oxis.dashboard()`, `oxis.workflow()`'s `steps` table,
  `oxis.setOption()`, and `oxis.net.request()` — any plugin passing
  an ordinary Lua array to any of these could have silently lost
  data. Fixed by collecting every table entry first, then deciding
  array-vs-object from the resulting KEY SET (exactly `{1..maxKey}`,
  no gaps) rather than the order entries happened to arrive in — a
  property of the whole table, not sensitive to iteration order at
  all. Verified against fengari directly across eight cases before
  and after the fix: plain sequential literals, out-of-order key
  assignment, a value removed and reassigned, sparse tables (correctly
  stay objects), plain string-keyed tables, and an empty table (kept
  converting to `[]`, matching this function's own prior behavior for
  that one specific case, since Lua doesn't distinguish an empty
  array from an empty object).
- **Poor design: a command handler that threw an exception was
  completely invisible to the user — the central dispatch point for
  every single command in the app silently swallowed it.**
  `commandRegistry.ts`'s `execute()` caught the exception and only
  ever `console.error`'d it — a real user would just see their
  command do nothing at all, no error, no output, nothing, since it
  never reached `installGlobalErrorCapture()`'s window-level listener
  either (it was already caught, not uncaught) — meaning a buggy
  command was invisible from 'diagnostics, invisible in the terminal,
  invisible everywhere a real user could actually look. Fixed:
  errors now go through `recordError()` (the same 'diagnostics list
  every other app-level error uses) and a new `command_error` event
  the active terminal listens for to print a real, visible
  `✗ 'name' failed: ...` line. While in there, also removed
  `session_saved`/`session_restored` from `OxisEvent`'s own union
  type — both fully dead now that `sessionManager.ts` is gone (see
  above), `session_restored` in particular was never emitted at all,
  a stale entry from before this pass.
- **`themeManager.export(name)` could silently export under the wrong
  name — a subtle spread-order bug, reproduced concretely before
  fixing.** `{ name, ...t }` lets `t`'s own properties override
  earlier ones with the same key — for an imported theme (which
  retains its own internal `name` field from its original JSON, see
  `import()`), that internal field silently won over the `name`
  parameter the function was actually asked to export under whenever
  the two diverged. Reproduced with a concrete case (a theme carrying
  a different internal name than the key it was looked up under)
  before touching the source: exported name came back wrong. Fixed
  by moving `name` to the end of the spread so it always wins,
  matching the function's own obvious intent — verified the fix with
  the same reproduction case afterward.
- **Poor design, not a crash: Home's "recent activity" row was
  completely flooded with startup noise on every single launch,
  never showing anything the user actually did.** `plugin_loaded`
  fired unconditionally at the end of every `load()` call, including
  every one of the ~20+ plugins loaded fresh at startup (both the
  regular `loadUserPlugins()` path and the separate
  `loadAllPremiumPlugins()` one) — `workspaceState.ts` logs
  `plugin "X" reloaded` for each one into a 6-entry-capped activity
  list, so the very first thing a user saw on Home after any fresh
  launch was a handful of misleading "reloaded" messages for plugins
  they never touched, not their own actual recent actions (a task
  run, a theme switch, a workspace load). Fixed with an optional
  `silent` parameter threaded through `load()` and both bulk-load
  call sites — a genuine individual enable/reload/install still logs
  normally; only the bulk, nothing-the-user-actually-did case is now
  silenced.
- **`sessionManager.ts` — entirely dead code, removed, and the
  README's own claims about what it did were stale even before that.**
  `sessionManager.save({ tabs, activeTab, theme, ... })` ran on every
  single theme change or Home/Shell view switch, writing to
  localStorage — but `sessionManager.load()` was never called
  anywhere in the whole codebase, and `sessionManager.clear()` ran at
  every app startup *before* any load could have happened anyway, so
  the entire round-trip was structurally meaningless: save something,
  wipe it on the next launch, never read it back in between, ever.
  Theme persistence already worked correctly and completely
  independently of this, through `themeManager.ts`'s own
  `oxis-theme` localStorage key — confirmed before removing anything,
  so nothing was actually lost. `tabs`/`activeTab` were separately
  pointless given OXIS has no real multi-tab support to persist in
  the first place. Deleted the file, its import, both call sites, and
  fixed five separate stale README references that described it as a
  real, working feature (a directory-listing entry, a table row, a
  whole "Manual Session Control" code example, and an events-table
  row for `session_restored` — an event that, it turns out, was
  *never even emitted* by the file being removed, meaning that
  specific claim was stale documentation from well before this fix).
- **Ctrl+R reverse-i-search lost the user's position on every keystroke
  once they'd cycled to an older match — a real bug, reproduced and
  fixed, not just theoretical.** `searchAppend`/`searchBackspace`
  always called `_findFrom(entries.length - 1)`, meaning refining the
  query WHILE already browsing an older match (via `searchOlder`)
  jumped straight back to the newest matching entry instead of
  refining from wherever the user actually was — bash's own reverse-
  i-search stays on the current match if it still satisfies the
  longer query, or moves to the next-older one if it doesn't; this
  never did either, it just discarded position on every character.
  Reproduced concretely with a real history array before fixing:
  cycling to "git push" then typing one more character to refine the
  query jumped back to "git status" (a newer, unrelated entry)
  instead of staying near "git push". Fixed by searching from the
  current `rsPos` instead of always the newest entry — verified both
  the "current match still satisfies the refined query" case (stays
  put, correctly) and the "current match no longer satisfies it" case
  (moves to the next-older match, correctly) with concrete simulated
  scenarios before changing the actual source.
- **Command Palette: two real bugs reported directly — arrow-key
  navigation never scrolled the list, and Escape didn't close it.**
  (1) `selected` only ever moved a CSS highlight class; nothing ever
  brought that item back into view once arrowing past whatever was
  currently visible in the scrollable list. Fixed with a
  `scrollIntoView({ block: "nearest" })` on the selected item
  whenever `selected` changes — "nearest" specifically so it doesn't
  yank the list around once the selection is already visible, only
  scrolling the minimum needed to bring an off-screen item back.
  (2) Escape not closing the palette was a genuinely confusing one:
  the input's own `onKeyDown` already had a correct Escape case, and
  arrow keys/Enter through that exact same handler DID work — meaning
  the input genuinely had focus and was receiving keydown events, so
  something was specifically intercepting Escape rather than
  blocking keys generally. Checked every other Escape handler and
  every capture-phase `window` listener in the file (the keybinds
  system, the live-preview fullscreen handler, the browser-shortcut
  blocker) without finding a specific culprit that should have been
  reachable from this input via normal event bubbling. Rather than
  ship a guess, applied the same pattern already proven for the live
  preview's own fullscreen Escape handling: a dedicated, capture-
  phase, window-level listener scoped to whenever the palette is
  mounted, independent of DOM focus or React's synthetic bubbling —
  this closes the palette on Escape regardless of what else in the
  app might otherwise be catching the keypress first. Documented
  honestly as a robust fix for a confirmed symptom, not a fix
  targeted at a root cause I could pinpoint with certainty.
- **Multi-byte UTF-8 characters split across a PTY read boundary got
  visibly corrupted into replacement characters — a real bug,
  reproduced and confirmed before fixing, not just a theoretical
  concern.** Both `pty_unix.go` and `pty_windows.go` read PTY output
  into an 8192-byte buffer and converted it straight to a Go string
  (`string(buf[:n])`) every time — if a real multi-byte character (an
  emoji, a non-English filename, accented characters, CJK output from
  any tool that prints them) happened to land exactly across that
  boundary, each half got `json.Marshal`'d separately before ever
  reaching the frontend, and Go's JSON encoder silently replaces
  invalid UTF-8 with U+FFFD — the character was already gone by the
  time the two chunks could have been concatenated, not just
  temporarily split. Reproduced concretely: `"hello 🎉 world"` split
  mid-emoji became `"hello ���� world"` on the wire in a standalone
  test before any fix was applied. Fixed with a shared
  `splitIncompleteUTF8()` (`pty.go`) that holds back an incomplete
  trailing sequence and prepends it to the next read, so a chunk is
  only ever turned into a string once it can't possibly be cut
  mid-character. Verified three ways: a dedicated unit test for the
  split function itself (ASCII, a 4-byte emoji, a 3-byte CJK
  character cut after 2 bytes, an empty buffer, and a genuinely
  invalid lead byte all covered), a real Go build of the fixed
  `pty_unix.go` path, and a `gofmt` syntax check of `pty_windows.go`
  (couldn't fully build-verify that one — cross-compiling for Windows
  needs a dependency this environment's network allowlist blocks,
  `golang.org/x/sys` specifically; the fix is identical in both files
  and the shared helper is the same fully-tested code either way).
- **SECURITY — a DNS-rebinding vulnerability in the local PTY server's
  Host-header check, found doing a broad audit pass.** `isLocalhost()`
  (`internal/server/server.go`) — the ONLY remaining gate on the `/ws`
  PTY endpoint, since `CheckOrigin` already allows every origin
  unconditionally by design — used `strings.HasPrefix(host,
  "127.0.0.1")`, a prefix match rather than an exact one. A Host
  header like `127.0.0.1.attacker.com` or `localhost.attacker.com`
  satisfies that prefix check while naming a completely different,
  attacker-controlled domain — exactly the shape of a DNS-rebinding
  attack against a local server: a malicious page open in the same
  browser gets a domain it controls to resolve to 127.0.0.1, then
  sends a request whose Host header names its own domain, which the
  old check would have accepted as "localhost enough." Fixed with an
  exact match against the hostname with the port properly stripped
  via `net.SplitHostPort` (comparing the whole `r.Host` string,
  port included, against `"127.0.0.1"` would never have matched
  anything, which is presumably why the prefix check existed in the
  first place — stripping the port is the actual fix, not relaxing
  the comparison). Verified with a real, standalone Go test covering
  both the legitimate localhost variants (with/without port, IPv6
  `::1`) and the specific attack-pattern hostnames — all pass.
- **`'market update` could leave a plugin permanently broken with no
  way back — reported directly by a user reviewing the code**:
  `saveBackup()` silently swallowed a `localStorage` failure (full or
  unavailable) and the update proceeded anyway; if the new version
  then failed to load, `rollbackPlugin()` had no backup to restore,
  leaving a broken, disabled plugin with no automatic or manual way
  back to the version that worked. Fixed by refusing the update
  outright, before anything is touched, whenever the backup itself
  can't actually be saved — costs nothing in that case specifically,
  since nothing has been changed yet at that point. `saveBackup` now
  returns whether it actually succeeded instead of a caller having no
  way to know; checked for any other caller of it (none — this was
  the only one).
- **The MSI/NSIS installers only ever shipped `oxis.exe` — `dist/logo.png`
  (produced by the same local build, `build-go.js`'s own Step 6) never
  made it into `Program Files\OXIS` at all, a real gap distinct from
  the earlier data-directory fix.** `logo.png` is now installed
  alongside `oxis.exe` in both installer paths (a conditional
  component, same "only if it exists" pattern the icon already used,
  so a build missing it doesn't fail the whole MSI) and cleaned up on
  NSIS uninstall (WiX handles this automatically for its own
  components, no separate uninstall line needed there). **Also found
  and fixed my own bug while re-verifying the earlier Downloads-
  fallback fix**: a stale, now-incorrect doc comment above
  `AppDirPath` had been left in place describing the OLD, uncached
  behavior — worse, removing it had also deleted the actual
  `appDirOnce`/`appDirCached`/`appDirErr` variable declarations the
  function needs, which would have failed to compile. Caught and
  fixed before it went anywhere, re-verified with a real `go build
  ./...` — clean.
- **`Ctrl+F` for on-screen output search was completely unreachable —
  a genuine bug, not just a lint nag, caught by a real build warning
  ("this case clause will never be evaluated because it duplicates
  an earlier case clause").** Two `case "f":` existed in the exact
  same `switch(k.toLowerCase())` block — the first (readline's
  forward-char, a standard binding worth keeping) always matched
  first, so the second (`openOutputSearch()`) could never run, no
  matter how it was reached. `ctrl` in this handler is `e.ctrlKey &&
  !e.altKey` — it doesn't exclude Shift, and `.toLowerCase()`
  normalizes `"F"` back to `"f"` either way, so a plain second case
  keyed on Shift wouldn't have worked either. Fixed by folding both
  into the one `"f"` case, branching on `e.shiftKey` — **Ctrl+F**
  stays forward-char, **Ctrl+Shift+F** now actually opens output
  search. Updated every doc comment and the README's keybind table
  that still said plain Ctrl+F for this.
- **Re-confirmed (after being asked to double-check) that `npm run
  build` no longer auto-triggers the MSI/WiX build** — the fix from
  earlier this session is still fully intact; no lingering
  `build-msi.js` call anywhere in `build-go.js`. The GitHub Actions
  Linux workflow was never affected by this in the first place — it
  only ever called `build-linux.sh` (binary + `.deb`), completely
  separate from the Windows installer path.
- **The app's own UI still said "GitLab merge request" throughout the
  Market publishing flow, weeks after the actual backend was migrated
  to GitHub — found via a full sweep after a user screenshot caught
  one instance on Home.** More than just that one button: help text,
  status messages (`'plugin publish`/`unpublish`), `'help plugin`'s
  notes, `publish.ts`'s own doc comments and every user-facing
  string, `market.ts`'s doc comment, and two stale `updateCheckOnStartup`-adjacent
  comments/descriptions still describing the OLD gitlab.com-based
  update checker (also migrated to GitHub earlier this session, just
  never had these leftover mentions cleaned up). Also renamed the
  `mergeRequestUrl` field to `pullRequestUrl` for consistency —
  **and found a real, would-be-breaking bug while doing that
  specific rename**: the backend (`submit-plugin.js`/
  `delete-plugin.js`) still sent `mergeRequestUrl` in its JSON
  response; had I renamed only the client's read side, the two would
  have silently stopped agreeing on a field name and every submission
  response would have come back with an undefined PR link. Fixed on
  both sides together, verified with a full sweep for any other
  reference to the old field name (none found) and a clean
  `tsc --noEmit`. Left every `'workspace github`/`'workspace gitlab`
  reference untouched throughout — that's a real, working, unrelated
  feature (a USER'S OWN project's git host choice, nothing to do with
  which platform OXIS itself is hosted on).
- **CRITICAL — the actual root cause of "installing via the MSI leaves
  users with no created documents, no plugins, no workspaces": found,
  fixed, and verified with a real Go build (this environment now has
  a working Go toolchain — installed specifically to verify this,
  since it's the most consequential fix of the session and deserved
  better than the usual "written but not compiled" caveat).**
  `AppDirPath()` resolved to wherever `oxis.exe` itself lives — fine
  for a portable `dist/` folder, but an MSI install runs from
  `C:\Program Files\OXIS`, which Windows protects from writes by a
  normal (non-elevated) user session under UAC. Every attempt to
  create `workspaces/`, `created-plugins/`, `created-documents/` there
  was silently failing — the app wasn't missing files, it could never
  write any in the first place. Fixed in `internal/wailsapp/app.go`:
  `AppDirPath()` now does a real write-test (create+delete a temp
  file, not just checking permission bits, which UAC virtualization
  can make lie) and falls back to a directory under the user's own
  Downloads folder when the exe's own directory isn't writable —
  cached once per process (`sync.Once`), not re-checked on every
  call, since this function is hot and a filesystem write-test on
  every single call would itself become a real performance cost.
  `go build ./...` and `go vet` both clean.
- **The MSI installer's desktop shortcut was defined but never
  installed** — `OxisDesktopShortcut` existed as a real `<Component>`
  in the WiX script but was never referenced by any `<Feature>`, and
  WiX/MSI never installs a component nothing references, no matter
  how correctly it's defined elsewhere. Fixed in both
  `scripts/build-msi.js` (the actual generator) and the static
  `dist/oxis-product.wxs` snapshot. The Start Menu shortcut was
  correctly wired already — only the desktop one was silently
  missing.
- **Installer no longer bundles the whole project source — that's
  the running app's job now, not the installer's.** Previously,
  `npm run build` always also built a full Windows installer
  (`heat.exe` harvesting the entire project into `dist/source`, then
  into the `.msi`/`.exe` itself) as an automatic side effect, even
  when nobody asked for an installer — a real, reported problem, and
  slower/heavier than it needed to be for something most people never
  open. Removed entirely: `build-go.js` no longer auto-triggers
  `build-msi.js` (that's `npm run build:msi` now, explicitly, only
  when wanted), and `build-msi.js` itself no longer bundles source at
  all — matching how the GitHub Actions Linux build has only ever
  produced the binary/`.deb`, nothing more. Source delivery moved to
  the app itself instead: the very AppDirPath() fallback above clones
  this project's GitHub source into the Downloads-based data
  directory in the background, the first time (and only the first
  time) that fallback is actually needed — so someone running a
  portable `dist/` folder, where the fallback never triggers, never
  pays for a clone they don't need either. Best-effort and silent (no
  git on PATH, no network, or a failed clone all just skip quietly)
  — this is a nice-to-have alongside the actually-important fix
  above, never something that should be able to block or destabilize
  the app itself.
- **Continuing the permission/dependency system audit — found two
  real, related bugs, both a direct consequence of adding "shell" as
  a permission namespace earlier this session and not propagating it
  everywhere it needed to go.** (1) `'plugin permissions <name> grant
  shell` / `revoke shell` was silently rejected as invalid usage — a
  hardcoded `VALID` array in the command handler (separate from
  `PermissionNamespace`'s own type definition) was never updated when
  "shell" was added, so there was no way to manually grant/revoke it
  or see it in the `'plugin permissions <name>` status listing, even
  though it's a real, working permission elsewhere. (2) A plugin
  manifest declaring `permissions: shell` would have that entry
  silently vanish — `manifest.ts`'s own separate `ALL_NAMESPACES` list
  (used to filter the parsed `permissions:` field) had the same gap,
  and filters out anything not in it with no error or warning to the
  plugin author. Both lists now include `"shell"`; checked dependency
  parsing and cycle detection (`checkCompatibility`) for the same
  drift pattern and found them fine — dependency names aren't
  validated against a fixed enum the way permission namespaces are,
  so there was nothing there to drift.
- **`cmd/oxi/versioninfo.json`'s numeric version didn't match its own
  display string — real build warning, reported from an actual
  Windows build log.** `goversioninfo` (the tool that embeds the icon
  and version metadata into `oxis.exe`) warned that `FixedFileInfo`
  (the structured, numeric version Windows itself reads) said
  `1.2.0.0` while `StringFileInfo` (the human-readable version shown
  in the .exe's own Properties dialog) said `1.2.1` — a stale patch
  number left at `0` from whenever these two were last bumped
  independently instead of together. Fixed by setting `Patch: 1` in
  both `FixedFileInfo.FileVersion` and `FixedFileInfo.ProductVersion`
  to actually match. This is exactly the drift this file's own
  process (documented in README § Auto-Update as "bump VERSION in
  build-go.js AND cmd/oxi/versioninfo.json") is prone to — two places
  that have to be kept in sync by hand — worth watching for again
  next version bump, not something this fix prevents from recurring.
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