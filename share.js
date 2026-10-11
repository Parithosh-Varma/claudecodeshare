// One-command share: ensures the relay is up, then runs an owner agent
// for every connection (or just one with [name|connection-id]).
// Usage: npm run share [-- name|connection-id]
import { spawn } from "node:child_process";

const PORT = process.env.PORT || 8787;
const BASE = `http://localhost:${PORT}`;
const WANT = process.argv[2]; // optional: name or c_... id; omit = all connections
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
const agents = targets.map((conn) => {
  console.log(`  - ${conn.id} (${conn.name})`);
  return spawn("node", ["agent.js", conn.id], { stdio: "inherit" });
});
const shutdown = () => {
  for (const a of agents) try { a.kill(); } catch {}
  if (childServer) { try { process.kill(-childServer.pid); } catch {} }
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
await Promise.all(agents.map((a) => new Promise((resolve) => a.on("exit", resolve))));
if (childServer) { try { process.kill(-childServer.pid); } catch {} }
