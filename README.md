# claudecodeshare

Self-hosted relay to access **your own** dev machines remotely (phone / browser / second laptop), with **independent, revocable, expiring guest links** for pair programming.

PandaNpc-style sharing, reframed for compliant use: **1 seat = 1 human**. Each collaborator uses their **own** model quota unless your provider's team/enterprise plan explicitly allows pooling. Works with any terminal tool — `opencode` + your own API keys, local shells, and your own licensed Claude Code / Codex sessions.

## Why this exists

- Access your dev machine from anywhere (outbound WebSocket only, no port-forward).
- Invite a collaborator for a bounded time: 1d / 7d / 30d / forever, revoke anytime.
- Revoke is thorough: that token's guests drop instantly; you and other shares are unaffected.

## What it is not

- Not a way to split one Claude Max / Codex Plus-Pro subscription across strangers. Both are single-user plans; doing so risks bans. Only pool quota where the plan allows it (team/enterprise seats, or pay-per-token keys like `opencode` where each guest brings their own key).
- Not a sandbox. A guest link = arbitrary command + file R/W in the agent's workdir. Only share with people you trust, use a dedicated directory/container, set the shortest expiry, revoke when done.

## Architecture

```
guest browser --wss--> relay (server.js) <--wss-- agent (agent.js, on your dev machine) -> shell/claude
                    REST: connections / share / claim / revoke
```

- `server.js`: static UI + REST + WebSocket bridge. Stores `connections` and `shares{code, connectionId, expiresAt, revokedAt, claims}` in `data.json`. Validates every guest message against revocation/expiry; sweeps expired shares every 15s.
- `agent.js`: runs beside your code. One isolated shell per guest (`./sandbox/<connectionId>`). Swap one line (`SHELL_CMD`) to drive `claude` instead of `sh`.
- `public/index.html`: minimal UI — create, share with expiry, "Connections I shared" (copy/revoke), claim via `?connect=CODE`, terminal.

## Trust & control

- **Waiting room**: tick "Approve each guest" when sharing. Claimants wait until you Approve/Deny them in the sidebar (or via `POST /api/pending/approve`). Decisions persist across relay restarts.
- **Per-guest kick**: "Guests online" lists live guests; Kick drops one PTY, everyone else stays.
- **Share modes**: Full (default), Read-only (input ignored), or Approve commands (each Enter-line waits in the "Command approvals" inbox until you allow/deny it).
- **Session transcripts**: everything relayed is appended to `transcripts/<connection>/<code>-<guest>.log`, viewable in the dashboard.
- **Guest confinement** (macOS): the guest shell runs under a Seatbelt profile — all of `/Users` is denied except its sandbox folder; API keys/tokens never enter its environment; its prompt shows `guest@shared` instead of your user@host. Each connection's sandbox also gets its own opencode service port so guests never collide with yours. `ps` output cannot be hidden by Seatbelt — guests can see process names.
- **Idle timeouts**: shells idle over `IDLE_TIMEOUT_MS` (default 30 min) close themselves.
- **Restart survival**: PTYs survive relay drops; the browser auto-rejoins with the same guest id and lands back in its live shell.
- **Files**: owner and guest file browsers with download + base64 upload, rooted at the sandbox (traversal rejected).
- **Notifications**: optional Telegram bot / Discord webhook ping on guest request / join / leave.
- **Rename/delete machines**: sidebar buttons; delete kills that machine's shares and guests (sandbox files are kept).

## Quickstart

One command (starts the relay if needed, reuses or creates your
connection, runs the agent — Ctrl-C stops everything it started):

```sh
npm install
npm run share [-- name|connection-id]   # no arg = share every connection
```

Reach guests outside your network via a free Cloudflare tunnel
(no account, no domain — URL changes each restart):

```sh
npm run share -- --tunnel
```

Or step by step:

```sh
node server.js &                 # relay+UI on http://localhost:8787
curl -X POST localhost:8787/api/connections -H 'Content-Type: application/json' -d '{"name":"dev-machine"}'
# -> {"id":"c_..."}
CONNECTION_ID=c_... node agent.js   # owner executor (uses ./sandbox/c_...)
# open UI -> Share (pick expiry) -> send link
# redeemer: open http://host/?connect=CODE -> Claim + connect
```

Run the lifecycle test (share → claim → exec → revoke-isolation → expiry):

```sh
npm test
```

## Publishing sessions to GitHub

Whatever a session produces lives in `sandbox/<connection-id>/` on your
machine. The sidebar's **Cloud backup** card pushes it all up:

- Click **Push everything** → see exactly which folders and files will go
  up → confirm. First push creates a **private** repo (default
  `<you>/claude-session`); every later push reuses it and just adds or
  updates folders — never a new repo.
- Each session gets a stable, readable folder (`dev-machine-c2ff7e/…`),
  so repeat pushes update in place instead of duplicating.
- Tick **auto-push new files** once and everything Claude makes from then
  on goes up by itself (survives server restarts).

CLI equivalent: `npm run publish -- <owner/repo> [--connection c_...]
[--create] [--watch]`. Auth uses `gh` (OS keyring; PAT asked once if
needed, never written to disk). A `.gitignore` for secrets is added
automatically. Only your token, only your repo — a guest must never paste
their PAT into someone else's shared machine.

## API

- `POST /api/connections {name}` → `{id}`
- `GET /api/connections` → list with `shared` badge flag
- `POST /api/connections/:id/share {expiry: 1d|7d|30d|forever}` → `{code, link, expiresAt}`
- `GET /api/shares` → management list (name, claims, expiry, active)
- `POST /api/shares/:code/revoke` → `{ok}` + instant guest kick
- `POST /api/claim {code, guestId}` → `{connectionId, ...}` or 403 expired/revoked, 404 invalid
- Waiting room: `GET /api/pending`, `POST /api/pending/approve {code, guestId, approve}`
- Guests: `GET /api/guests`, `POST /api/guests/kick {code, guestId}`
- Approvals: `GET /api/proposals`, `POST /api/proposals/decide {id, approve}`
- Transcripts: `GET /api/transcripts`, `GET /api/transcripts/:file`
- Files: `GET /api/files?connection=|?code=[&path=]`, `POST /api/files {connection|code, path, content(base64)}`
- Machines: `PATCH /api/connections/:id {name}`, `DELETE /api/connections/:id`
- Notify: `GET|POST /api/notify`, `POST /api/notify/test`
- `WS /relay?role=owner&connectionId=` and `WS /relay?role=guest&code=&guestId=`

## Hardening before any real use

- Put the agent in Docker per connection, read-only mount + allowlisted commands.
- Replace `data.json` with Postgres/Redis, add real auth (owner token, per-guest identity), TLS, rate limits, audit log of inputs.
- Add per-share scope (read-only view vs. approve-only vs. full exec).

## License

MIT — see `LICENSE`. You are responsible for complying with your model provider's terms.
