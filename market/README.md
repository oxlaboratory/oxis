# market/

Reference snapshot of the index served at
[oxis-market.pages.dev](https://oxis-market.pages.dev) — `index.json`
here is exactly what `frontend/src/plugins/market.ts` fetches at
`GET {MARKET_BASE}/index.json`.

This folder isn't built or deployed by anything in this repo — the
live site is its own Cloudflare Pages project. It's kept here so the
schema `market.ts` expects has one canonical, versioned example
sitting next to the client that consumes it.

Each entry's `file` (e.g. `plugins/network.lua`) is fetched from
`{MARKET_BASE}/{file}` when a user runs `'market install <name>`.
