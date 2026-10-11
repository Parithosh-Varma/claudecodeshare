# Second Seat — architecture

Three repos, one system. Anything with money around it lives private;
everything you need to self-host is open.

```
┌──────────── public: second-seat (this repo, MIT) ────────────┐
│  apps (runtime)              CLI              site            │
│  ├─ server.js  relay+API     ├─ bin/second-seat.js  entry    │
│  │   (serves dashboard or    │   (share|agent|publish|server │
│  │    headless status page)  │    subcommands, global-ready) │
│  ├─ agent.js   PTY executor  ├─ share.js      serve+share    │
│  ├─ paths.js   DATA_ROOT     ├─ publish.js    → GitHub       │
│  └─ test.js    49 checks     └─ tunnel.js     Cloudflare     │
│  landing/ marketing site (deploys to Pages + Workers)         │
└──────────────────────────────────────────────────────────────┘
┌──────────── private: second-seat-cloud ───────────────────────┐
│  cloudflare/  Worker relay + D1 (paid hosted service)         │
│  agent auth: OWNER_TOKEN · human auth: Google sessions         │
└──────────────────────────────────────────────────────────────┘
┌──────────── private: second-seat-frontend ────────────────────┐
│  dashboard/  console app (Pages)   landing/  (mirrors public) │
└──────────────────────────────────────────────────────────────┘
```

## Runtime layout (one machine)

```
relay (server.js :8787) ◄── outbound WS ── agent (PTY per guest)
   ▲ REST + WS /relay              └── sandbox/<conn-id>/  (guest files)
   │
   ├── guests (browser/xterm, share-code + optional Google login)
   └── owner dashboard (same origin, or hosted console via --tunnel)
```

State lives next to the code by default (`data.json`, `sandbox/`,
`transcripts/`, `.tunnel-url`). `paths.js` is the single source of
truth: `SEAT_DATA_DIR` (or `~/.second-seat` for global installs)
redirects all of it; `DATA_FILE` still wins for `data.json` (tests).
Checkouts stay in sync via symlinks (`public/`, `cloudflare/` point at
the private repos). The dashboard is **not** in the npm tarball — the
package is API-only and `postinstall` lays down `public/vendor/`, so a
global install serves the headless relay page and points at the hosted
console, exactly like a bare clone.

## Cloud layout (paid tier)

```
guests ──wss──► Worker relay (Durable Object room + D1 state)
                    ▲                    ▲
agent (OWNER_TOKEN)─┘                    └─ dashboard (Pages, Google session)
```

Google OAuth: any Gmail signs in; `OWNER_EMAILS` decides who is owner.
Share links stay bearer tokens, optionally restricted to listed emails.

## Deploys (from the repo that owns each piece)

- Landing: `wrangler pages deploy landing --project-name second-seat --force`
  (+ `wrangler deploy` at root for the workers.dev twin)
- Dashboard: `wrangler pages deploy dashboard --project-name second-seat-console --force`
- Relay worker: `wrangler deploy --config cloudflare/wrangler.toml`
- Secrets (never in git): `OWNER_TOKEN`, `SESSION_SECRET`,
  `GOOGLE_CLIENT_SECRET` via `wrangler secret put`
