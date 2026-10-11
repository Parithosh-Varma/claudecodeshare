// One-command share: ensures the relay is up, then runs an owner agent
// for every connection (or just one with [name|connection-id]).
// Usage: npm run share [-- name|connection-id] [--tunnel]
//   --tunnel  expose the relay via Cloudflare quick tunnel so guests
//             outside your network can reach it (share links use the URL).
import { spawn } from "node:child_process";
import { startTunnel, stopTunnel } from "./tunnel.js";

const PORT = process.env.PORT || 8787;
const BASE = `http://localhost:${PORT}`;
const ARGS = process.argv.slice(2);
const WANT = ARGS.find((a) => !a.startsWith("--"));
const WANT_TUNNEL = ARGS.includes("--tunnel");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const api = (m, p, b) => fetch(BASE + p, {
  method: m, headers: { "Content-Type": "application/json" },
  body: b ? JSON.stringify(b) : undefined,
}).then(async (r) => {
  if (!r.ok) throw new Error(`${m} ${p} -> ${r.status}`);
  return r.json();
});

async function serverUp() {
  try { await api("GET", "/api/connections"); return true; }
  catch { return false; }
}

let childServer = null;
if (!(await serverUp())) {
  console.log(`starting relay on :${PORT} ...`);
  childServer = spawn("node", ["server.js"], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "ignore", "inherit"],
    detached: true,
  });
  childServer.unref();
  for (let i = 0; i < 25 && !(await serverUp()); i++) await sleep(200);
  if (!(await serverUp())) { console.error("relay failed to start"); process.exit(1); }
  console.log("relay is up");
} else {
  console.log("relay already running");
}

let tunnel = null;
if (WANT_TUNNEL) {
  try {
    tunnel = await startTunnel(PORT);
    console.log(`public URL: ${tunnel.url}  (share links use it; guests need no setup)`);
  } catch (e) {
    console.error(`tunnel failed: ${e.message} — continuing on LAN only`);
  }
}

let conns = await api("GET", "/api/connections");
let targets = [];
if (WANT && WANT.startsWith("c_")) {
  const conn = conns.find((c) => c.id === WANT);
  if (!conn) {
    console.error(`no such connection: ${WANT}`);
    console.error("available:", conns.map((c) => `${c.id} (${c.name})`).join(", ") || "(none)");
    process.exit(1);
  }
  targets = [conn];
  console.log(`sharing connection ${conn.id} (${conn.name})`);
} else if (WANT) {
  targets = conns.filter((c) => c.name === WANT);
  if (targets.length === 0) {
    const conn = await api("POST", "/api/connections", { name: WANT });
    console.log(`created connection ${conn.id} (${conn.name})`);
    targets = [conn];
  } else {
    console.log(`sharing ${targets.length} connection(s) named "${WANT}"`);
  }
} else {
  targets = conns;
  if (targets.length === 0) {
    const conn = await api("POST", "/api/connections", { name: "dev-machine" });
    console.log(`created connection ${conn.id} (${conn.name})`);
    targets = [conn];
  } else {
    console.log(`sharing all ${targets.length} connection(s)`);
  }
}

console.log("starting agent(s) (Ctrl-C to stop) ...");
const agents = new Map(); // connId -> child
let shuttingDown = false;
function startAgent(conn) {
  if (shuttingDown || agents.has(conn.id)) return;
  console.log(`  - ${conn.id} (${conn.name})`);
  const a = spawn("node", ["agent.js", conn.id], { stdio: "inherit" });
  agents.set(conn.id, a);
  a.on("exit", (code) => {
    agents.delete(conn.id);
    if (shuttingDown) return;
    if (code === 44) { console.log(`[share] agent for ${conn.id} stopped (connection gone)`); return; }
    console.log(`[share] agent for ${conn.id} exited (${code ?? "signal"}), restarting in 2s`);
    setTimeout(() => startAgent(conn), 2000);
  });
}
for (const conn of targets) startAgent(conn);

// Pick up connections created after startup (e.g. via the dashboard's
// "+ New" button) so `npm run share` keeps serving everything.
const poll = setInterval(async () => {
  if (shuttingDown) return;
  try {
    const conns = await api("GET", "/api/connections");
    const wanted = WANT && WANT.startsWith("c_")
      ? conns.filter((c) => c.id === WANT)
      : WANT
        ? conns.filter((c) => c.name === WANT)
        : conns;
    for (const conn of wanted) {
      if (!agents.has(conn.id)) {
        console.log(`[share] new connection ${conn.id} (${conn.name}) — starting agent`);
        startAgent(conn);
      }
    }
    for (const id of [...agents.keys()]) {
      if (!conns.some((c) => c.id === id)) {
        console.log(`[share] connection ${id} deleted — stopping agent`);
        try { agents.get(id)?.kill(); } catch {}
        agents.delete(id);
      }
    }
  } catch {}
}, 5000);

const shutdown = () => {
  shuttingDown = true;
  clearInterval(poll);
  for (const a of agents.values()) try { a.kill(); } catch {}
  if (tunnel) stopTunnel(tunnel.child);
  if (childServer) { try { process.kill(-childServer.pid); } catch {} }
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
// Agents respawn on unexpected exit; run until signal.
await new Promise(() => {});
