// Owner-side executor (pandapaw equivalent).
// Runs on the dev machine that holds the subscriptions.
// Each remote guest gets an isolated PTY (real terminal, so TUIs like
// opencode / claude code render correctly); revoke/expiry kills only that PTY.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import WebSocket from "ws";
import * as pty from "node-pty";
import { sandboxOf } from "./paths.js";

const RELAY = process.env.RELAY || "ws://localhost:8787/relay";
// Cloud relay requires the owner token (wrangler secret put OWNER_TOKEN).
// Local node relay ignores the extra query param.
const OWNER_TOKEN = process.env.OWNER_TOKEN || "";
const CONNECTION_ID = process.env.CONNECTION_ID || process.argv[2];
if (!CONNECTION_ID) {
  console.error("usage: CONNECTION_ID=xxx node agent.js  (or node agent.js <connectionId>)");
  process.exit(1);
}
// Idle sessions die on their own so forgotten guests don't linger forever.
// Override with IDLE_TIMEOUT_MS (tests use a short one).
const IDLE_TIMEOUT_MS = Number(process.env.IDLE_TIMEOUT_MS || 30 * 60 * 1000);
const SWEEP_MS = Math.min(30_000, Math.max(1000, Math.floor(IDLE_TIMEOUT_MS / 2)));
const SHELL = resolveShell();

// Resolve to an absolute, executable shell up front so a broken/stripped
// PATH (spawn sh ENOENT) can never take the agent down.
function resolveShell() {
  const candidates = [process.env.SHELL_CMD, process.env.SHELL, "/bin/zsh", "/bin/bash", "/bin/sh"].filter(Boolean);
  const pathDirs = (process.env.PATH || "/usr/bin:/bin").split(":").filter(Boolean);
  for (const c of candidates) {
    if (c.includes("/")) {
      try { fs.accessSync(c, fs.constants.X_OK); return c; } catch { /* try next */ }
    } else {
      for (const dir of pathDirs) {
        const full = path.join(dir, c);
        try { fs.accessSync(full, fs.constants.X_OK); return full; } catch { /* try next */ }
      }
    }
  }
  return "sh";
}

const sandbox = sandboxOf(CONNECTION_ID);
fs.mkdirSync(sandbox, { recursive: true });
const guestTmp = path.join(sandbox, ".tmp");
fs.mkdirSync(guestTmp, { recursive: true });

// Neutral guest identity: the prompt must not leak the host's username or
// hostname (default zsh shows user@host, and Apple's /etc/zshrc emits OSC7
// sequences containing both). HOME is the sandbox, so ~ = shared folder.
if (process.platform === "darwin") {
  const zshrc = path.join(sandbox, ".zshrc");
  try {
    fs.accessSync(zshrc);
  } catch {
    fs.writeFileSync(zshrc, `# Created by Second Seat: neutral guest identity.
# ~ below is the shared folder (HOME is remapped), not the host's home.
precmd_functions=()
chpwd_functions=()
PROMPT='guest@shared %~ %# '
RPROMPT=''
`);
  }
}

// Guest opencode gets its own service port per connection (derived from the
// connection id), preseeded into the sandbox HOME. Otherwise every guest's
// opencode collides with the owner's :49374 — which both breaks it and tells
// the guest another session is running. Never overrides a guest's own choice.
// Guest opencode gets its own service port per connection (derived from the
// connection id), preseeded into the sandbox HOME. Otherwise every guest's
// opencode collides with the owner's :49374 — which both breaks it and tells
// the guest another session is running. Never overrides a guest's own choice.
//
// The port space is wide AND bind-tested. A hash % 1000 collides at ~51% by
// 38 connections, and two connections landing on one port means the second
// guest reaches the first guest's service (loopback is open by design, see the
// confinement note below) and reads that guest's conversation history and
// tabs. Bind-testing before writing makes that collision self-healing.
const PORT_LO = 49500, PORT_HI = 65000;
const portFree = (p) => new Promise((res) => {
  const s = net.createServer();
  s.once("error", () => res(false));
  s.once("listening", () => s.close(() => res(true)));
  s.listen(p, "127.0.0.1");
});
async function guestPort(id) {
  const base = PORT_LO + (parseInt(id.replace(/^c_/, "").slice(0, 12), 16) % (PORT_HI - PORT_LO));
  for (let i = 0; i <= PORT_HI - PORT_LO; i++) {
    const p = PORT_LO + ((base - PORT_LO + i) % (PORT_HI - PORT_LO));
    if (await portFree(p)) return p;
  }
  return base; // every port busy; let opencode pick and log the conflict
}
try {
  const cfgDir = path.join(sandbox, ".config", "opencode");
  fs.mkdirSync(cfgDir, { recursive: true });
  const svcFile = path.join(cfgDir, "service.json");
  let svc = {};
  try { svc = JSON.parse(fs.readFileSync(svcFile, "utf8")); } catch { /* fresh */ }
  if (svc.port == null) {
    svc.port = await guestPort(CONNECTION_ID);
    fs.writeFileSync(svcFile, JSON.stringify(svc, null, 2));
  }
  console.log(`[agent] guest opencode port: ${svc.port}`);
} catch (e) { console.warn("[agent] could not preseed opencode port:", e.message); }

// ---- guest confinement ----
// The guest shell must never reach the host's files (~/Downloads, ~/.ssh,
// the repo root holding data.json with other share codes, ...).
// On macOS we wrap the shell in a Seatbelt profile: everything under /Users
// is off-limits except this connection's sandbox dir. Ancestor dirs get
// metadata-only access so getcwd/pwd keep working (listing/reading them
// is still denied). Elsewhere (system binaries, /opt, /tmp, network) the
// guest keeps normal access so real tools (node, opencode, ...) still run.
// NOTE: Seatbelt cannot hide the process table (no such operation; blocking
// sysctl breaks the shell and node), so guests can see process names.
// Full isolation needs containers — see README.
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
let confined = false, spawnFile = SHELL, spawnArgs = [];
if (process.env.ALLOW_UNCONFINED !== "1" && process.platform === "darwin") {
  try {
    fs.accessSync(SANDBOX_EXEC, fs.constants.X_OK);
    const ancestors = [];
    for (let d = sandbox; d.startsWith("/Users/") && d !== "/Users"; d = path.dirname(d)) ancestors.unshift(d);
    ancestors.unshift("/Users");
    const profile = "(version 1)(allow default)"
      + '(deny file* (subpath "/Users"))'
      + `(allow file-read-metadata ${ancestors.map((d) => `(subpath "${d}")`).join("")})`
      + `(allow file* (subpath "${sandbox}"))`;
    spawnFile = SANDBOX_EXEC;
    spawnArgs = ["-p", profile, SHELL];
    confined = true;
  } catch { /* fall through to unconfined with a warning below */ }
}
if (confined) console.log(`[agent] confinement: seatbelt, files limited to ${sandbox}`);
else console.warn("[agent] WARNING: running UNCONFINED (ALLOW_UNCONFINED=1 or no sandbox-exec) — guests can read host files");

// Guest env: start from ours but scrub anything that would hand over the
// owner's identity or quota: API keys/tokens, agent-forwarding sockets, and
// shell history locations. HOME points at the sandbox so guests configure
// their own tools/keys in isolation (their own quota, not yours).
// USER/LOGNAME/HOSTNAME are neutralized so prompts and TUIs don't leak them.
const SECRET_RE = /API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE[_-]?KEY|SSH_AUTH_SOCK|SSH_AGENT_PID/i;
function guestEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (SECRET_RE.test(k)) continue;
    env[k] = v;
  }
  env.HOME = sandbox;
  env.ZDOTDIR = sandbox;
  // opencode walks up from cwd looking for a project root before it starts,
  // lstat-ing (and needing read access to) every ancestor directory. Seatbelt
  // only grants ancestors metadata, so that walk dies with EPERM and every
  // opencode command 500s. Disable the walk: guests keep global config from
  // HOME and their own auth; only per-project opencode.json lookup is lost.
  // (Other tools do this discovery lazily and are unaffected either way.)
  env.OPENCODE_CONFIG_PROJECT_DISABLE = "1";
  env.HISTFILE = path.join(sandbox, ".zsh_history");
  env.TMPDIR = guestTmp + "/";
  env.TERM = "xterm-256color";
  env.USER = "guest";
  env.LOGNAME = "guest";
  env.HOSTNAME = "shared-machine";
  return env;
}

// Sessions survive relay disconnects (see connect()): a guest that rejoins
// with the same id gets their live shell back, output gap included.
const sessions = new Map(); // guestId -> {pty, lastActive, pending}
let currentWs = null; // owner relay socket; null between reconnects

function sendTo(id, msg) {
  const ws = currentWs;
  if (ws && ws.readyState === 1) {
    try { ws.send(JSON.stringify({ to: id, ...msg })); return true; } catch { /* fall through */ }
  }
  return false;
}

function killSession(id, note) {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  if (note) sendTo(id, { type: "exit", data: `\r\n[${note}]\r\n` });
  try { s.pty.kill(); } catch {}
  console.log(`[agent] session ended: ${id}${note ? ` (${note})` : ""}`);
}

function touch(id) {
  const s = sessions.get(id);
  if (s) s.lastActive = Date.now();
}

function ensureSession(id, cols = 80, rows = 24) {
  const existing = sessions.get(id);
  if (existing) { touch(id); return existing.pty; }
  console.log(`[agent] new session for ${id} (cwd=${sandbox}, shell=${SHELL})`);
  let p;
  try {
    p = pty.spawn(spawnFile, spawnArgs, {
      name: "xterm-256color",
      cols, rows,
      cwd: sandbox,
      env: guestEnv(),
    });
  } catch (e) {
    // Never crash the agent: tell this guest and stay up for everyone else.
    console.error(`[agent] failed to start shell for ${id}: ${e.message}`);
    sendTo(id, { type: "exit", data: `\r\n[failed to start shell: ${e.message}]\r\n` });
    return null;
  }
  const sess = { pty: p, lastActive: Date.now(), pending: "" };
  sessions.set(id, sess);
  p.onData((d) => {
    sess.lastActive = Date.now();
    if (!sendTo(id, { type: "output", data: d })) {
      // Relay is down: hold a bounded gap buffer, flush on reconnect.
      if (sess.pending.length < 65536) sess.pending += d;
    }
  });
  p.onExit(({ exitCode }) => {
    sessions.delete(id);
    sendTo(id, { type: "exit", data: `\r\n[process exited (${exitCode})]\r\n` });
  });
  p.write(`echo 'connected to ${CONNECTION_ID} as ${id}'\r`);
  return p;
}

// Idle sweep: forgotten shells close themselves.
setInterval(() => {
  const now = Date.now();
  for (const id of [...sessions.keys()]) {
    const s = sessions.get(id);
    if (s && now - s.lastActive > IDLE_TIMEOUT_MS) killSession(id, "idle timeout — session closed");
  }
}, SWEEP_MS).unref();

let backoffAttempts = 0;
function connect() {
  const ws = new WebSocket(`${RELAY}?role=owner&connectionId=${CONNECTION_ID}${OWNER_TOKEN ? `&token=${encodeURIComponent(OWNER_TOKEN)}` : ""}`);
  ws.on("open", () => {
    currentWs = ws;
    backoffAttempts = 0;
    console.log(`[agent] serving ${CONNECTION_ID} via ${RELAY}`);
    // Flush output buffered while the relay was down.
    for (const [id, s] of sessions) {
      if (s.pending) { const gap = s.pending; s.pending = ""; sendTo(id, { type: "output", data: gap }); }
    }
  });
  ws.on("message", (raw) => {
    try {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.type === "ready") return;
    if (m.type === "connect") { ensureSession(m.from, m.cols, m.rows); return; }
    if (m.type === "disconnect") { killSession(m.from); return; }
    if (m.type === "resize") {
      const s = sessions.get(m.from);
      if (s && m.cols && m.rows) { try { s.pty.resize(m.cols, m.rows); } catch {} }
      return;
    }
    if (m.type === "input") {
      const p = ensureSession(m.from);
      if (!p) return;
      touch(m.from);
      try { p.write(m.data); } catch {}
    }
    } catch (e) { console.error("[agent] message handler error:", e.message); }
  });
  ws.on("close", (code, reason) => {
    if (currentWs === ws) currentWs = null;
    if (code === 4404) {
      // Connection was deleted server-side: stop, don't hot-loop forever.
      // Exit 44 tells share.js not to respawn this agent.
      console.error(`[agent] connection ${CONNECTION_ID} gone (${reason || "deleted"}), stopping`);
      process.exit(44);
    }
    // Sessions stay alive: same-id guests reattach on reconnect.
    const delay = Math.min(2000 * 2 ** backoffAttempts, 30000);
    backoffAttempts += 1;
    console.log(`[agent] relay closed (${code}${reason ? " " + reason : ""}), reconnecting in ${Math.round(delay / 1000)}s (sessions kept)`);
    setTimeout(connect, delay);
  });
  ws.on("error", () => {});
}
connect();
