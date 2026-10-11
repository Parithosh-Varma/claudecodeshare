// One-command share: ensures the relay is up, reuses or creates a
// connection, and runs the owner agent in the foreground.
// Usage: npm run share -- [name|connection-id]
import { spawn } from "node:child_process";

const PORT = process.env.PORT || 8787;
const BASE = `http://localhost:${PORT}`;
const WANT = process.argv[2] || "dev-machine";
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
let conn = null;
if (WANT.startsWith("c_")) {
  conn = conns.find((c) => c.id === WANT);
  if (!conn) {
    console.error(`no such connection: ${WANT}`);
    console.error("available:", conns.map((c) => `${c.id} (${c.name})`).join(", ") || "(none)");
    process.exit(1);
  }
  console.log(`using connection ${conn.id} (${conn.name})`);
} else {
  conn = conns.find((c) => c.name === WANT) ?? conns[0];
}
if (conn && !WANT.startsWith("c_")) {
  console.log(`reusing connection ${conn.id} (${conn.name})`);
} else if (!conn) {
  conn = await api("POST", "/api/connections", { name: WANT });
  console.log(`created connection ${conn.id} (${conn.name})`);
}

console.log(`starting agent (Ctrl-C to stop) ...`);
const agent = spawn("node", ["agent.js", conn.id], { stdio: "inherit" });
const shutdown = () => {
  try { agent.kill(); } catch {}
  if (childServer) { try { process.kill(-childServer.pid); } catch {} }
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
await new Promise((resolve) => agent.on("exit", resolve));
if (childServer) { try { process.kill(-childServer.pid); } catch {} }
