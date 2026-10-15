# Contributing to OXIS

Thanks for helping out. Bug fixes, features, Lua plugins, docs and bug
reports are all welcome.

## Before you start

Check the [issues](https://github.com/oxlaboratory/oxis/issues) and
[pull requests](https://github.com/oxlaboratory/oxis/pulls) first. For
anything larger than a small fix, open an issue so the change can be
discussed before you spend time on it.

## Development setup

Requirements: Go 1.22+, Node.js 24+, and on Linux the GTK 3 and
WebKitGTK development packages (`libgtk-3-dev libwebkit2gtk-4.1-dev`).

```bash
git clone https://github.com/oxlaboratory/oxis.git
cd oxis
npm run setup     # checks tools, installs dependencies
npm run dev       # the app, with hot reload for the frontend
npm run build     # frontend + dist/oxis(.exe)
```

`npm run dev` runs the real window with its UI from Vite: frontend
changes appear as you save, with no reload, and the shells keep running.
Go changes rebuild the Go binary (a few seconds) and reopen the window;
its tabs come back. F12 opens the developer tools. The dev window has
its own profile, separate from an installed OXIS.

## Making a change

1. Fork the repository and create a branch from `main`
   (`fix/plugin-loading`, `feature/workspace-export`, `docs/readme`).
2. Keep the change focused. Don't reformat unrelated code.
3. Check it still builds and works:
   ```bash
   cd frontend && npx tsc --noEmit && npm test && cd ..
   go vet ./internal/... && go test ./internal/...
   npm run build
   ```
4. Test on Windows (PowerShell) and Linux (bash) where the change is
   platform-specific.
5. Update the README when behaviour or commands change.
6. Open a pull request against `main` describing what changed, why,
   and how you tested it.

CI builds Linux and Windows for every pull request.

## Code style

- TypeScript: strict mode; avoid `any`.
- Go: `gofmt`; prefer the standard library.
- Lua plugins: `snake_case`, one purpose per plugin, a description on
  every `oxis.command`.
- CSS: colours come from the theme variables (`var(--text)` etc.), not
  hard-coded hex values.
- Comments explain *why*, briefly. No debug output or dead code.

## Plugins

A plugin is a single `.lua` file. See the
[Plugin Development Guide](README.md#plugin-development-guide) for the
API and manifest format.

To get a plugin into the OXIS Market, either:

- run `'plugin publish <name>` inside OXIS, which validates the plugin
  and opens a pull request for you, or
- open a pull request by hand that adds `cloudflare/plugins/<name>.lua`
  and an entry in `cloudflare/index.json`.

The website builds the plugin's card from its `index.json` entry, so
there's no card to add by hand; it appears once the pull request is
merged.

Every submission is reviewed before it goes live. Plugins must do what
their description says, declare the permissions they use, and must not
collect data or act destructively without telling the user. Never
include keys, tokens or passwords.

## Versions and releases

OXIS follows [Semantic Versioning](https://semver.org): versions are
`MAJOR.MINOR.PATCH` and release tags are `vMAJOR.MINOR.PATCH`.

- **PATCH** (`2.0.0` → `2.0.1`): bug fixes and small corrections.
- **MINOR** (`2.0.1` → `2.1.0`, PATCH back to 0): substantial new
  features that keep supported APIs, plugins and settings working.
  Small features are grouped into one minor release.
- **MAJOR** (`2.8.4` → `3.0.0`, the others back to 0): breaking
  changes to supported APIs, plugin compatibility or configuration that
  need users or plugin authors to change things. A large feature or a
  refactor on its own isn't one.

**v2.0.0** is the new native OXIS: a Rust engine with a Dear ImGui
interface and Lua scripting (see [docs/v2/README.md](docs/v2/README.md)).
It's tagged only once that core is complete and tested; until then the
1.x line carries on.

For every release:

1. Read the current version from the code and the existing tags; never
   reuse or downgrade a version.
2. Pick the increment from what changed since the last release.
3. Update the version everywhere it lives (`package.json`, Cargo
   manifests, the installer, the build stamp, update checks, docs) and
   add a dated entry to `CHANGELOG.md`.
4. Run the tests and build the Windows and Linux artifacts; check they
   report the new version and that the update check recognises it.
5. Tag and publish with release notes and checksums.

Commits and merged pull requests don't each get a release, and a change
that doesn't warrant one leaves the version alone.

## Bug reports

Include the OXIS version (`'version`), your OS, steps to reproduce, what
you expected, what happened, and any error output (`'diagnostics` shows
recent errors).

## Security issues

Please don't report vulnerabilities in public issues. Use
[GitHub's private vulnerability reporting](https://github.com/oxlaboratory/oxis/security/advisories/new)
instead.

## License

By contributing you agree that your contribution is licensed under the
project's [Apache License 2.0](LICENSE).
