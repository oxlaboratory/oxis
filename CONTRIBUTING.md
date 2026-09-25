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
npm run dev       # rebuild + relaunch the app on every change
npm run build     # frontend + dist/oxis(.exe)
```

The frontend is embedded into the Go binary, so `npm run dev` does a
full rebuild on each change rather than hot reloading. For UI-only work
you can also open `http://127.0.0.1:1420` in a browser while OXIS runs.

## Making a change

1. Fork the repository and create a branch from `main`
   (`fix/plugin-loading`, `feature/workspace-export`, `docs/readme`).
2. Keep the change focused. Don't reformat unrelated code.
3. Check it still builds and works:
   ```bash
   cd frontend && npx tsc --noEmit && cd ..
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
- open a pull request by hand that adds `cloudflare/plugins/<name>.lua`,
  an entry in `cloudflare/index.json`, and a card in
  `cloudflare/index.html`.

Every submission is reviewed before it goes live. Plugins must do what
their description says, declare the permissions they use, and must not
collect data or act destructively without telling the user. Never
include keys, tokens or passwords.

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
project's [Apache License 2.0](license).
