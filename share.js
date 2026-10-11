// Second Seat rich CLI: one command starts everything.
// Usage: npm run share [-- name|connection-id] [--tunnel] [--port N]
//   no arg      share every connection (creates dev-machine if none)
//   --tunnel    expose via Cloudflare quick tunnel (guests outside your LAN)
import { spawn } from "node:child_process";
import chalk from "chalk";
import ora from "ora";
import boxen from "boxen";
import Table from "cli-table3";
import { startTunnel, stopTunnel } from "./tunnel.js";

const accent = chalk.hex("#c15f3c");
const ok = chalk.green("✔");
const warn = chalk.yellow("!");
const dim = chalk.dim;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ARGS = process.argv.slice(2);
const portArg = ARGS.indexOf("--port");
const PORT = process.env.PORT || (portArg !== -1 ? ARGS[portArg + 1] : null) || 8787;
const BASE = `http://localhost:${PORT}`;
const WANT = ARGS.find((a) => !a.startsWith("--"));
const WANT_TUNNEL = ARGS.includes("--tunnel");

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

console.log(boxen(chalk.bold("  Second Seat  ") + dim("share your terminal · keep your keys"), {
  padding: 1, borderColor: "gray", borderStyle: "round",
  title: "npm run share", titleAlignment: "center",
}));

// ---- relay ----
let childServer = null;
{
  const spin = ora("Checking relay").start();
  if (await serverUp()) {
    spin.succeed(`Relay already running on ${dim(`:${PORT}`)}`);
  } else {
    spin.text = `Starting relay on :${PORT}`;
    childServer = spawn("node", ["server.js"], {
      env: { ...process.env, PORT: String(PORT) },
      stdio: ["ignore", "ignore", "inherit"],
      detached: true,
    });
    childServer.unref();
    for (let i = 0; i < 25 && !(await serverUp()); i++) await sleep(200);
    if (!(await serverUp())) { spin.fail("Relay failed to start"); process.exit(1); }
    spin.succeed(`Relay is up on ${dim(`http://localhost:${PORT}`)}`);
  }
}

// ---- tunnel ----
let tunnel = null, publicBase = `http://localhost:${PORT}`;
if (WANT_TUNNEL) {
  const spin = ora("Opening Cloudflare tunnel").start();
  try {
    tunnel = await startTunnel(PORT);
    publicBase = tunnel.url;
    spin.succeed(`Public URL ${chalk.bold(tunnel.url)}`);
  } catch (e) {
    spin.warn(`Tunnel failed (${e.message}) — continuing on LAN only`);
  }
}

// ---- connections ----
const spin = ora("Resolving connections").start();
let conns = await api("GET", "/api/connections");
let targets = [];
if (WANT && WANT.startsWith("c_")) {
  const conn = conns.find((c) => c.id === WANT);
  if (!conn) {
    spin.fail(`No such connection: ${WANT}`);
    console.log(dim("available: ") + (conns.map((c) => `${c.id} (${c.name})`).join(", ") || "(none)"));
    process.exit(1);
  }
  targets = [conn];
  spin.succeed(`Sharing connection ${chalk.bold(conn.id)} ${dim(`(${conn.name})`)}`);
} else if (WANT) {
  targets = conns.filter((c) => c.name === WANT);
  if (targets.length === 0) {
    const conn = await api("POST", "/api/connections", { name: WANT });
    targets = [conn];
    spin.succeed(`Created + sharing ${chalk.bold(conn.id)} ${dim(`(${conn.name})`)}`);
  } else {
    spin.succeed(`Sharing ${chalk.bold(targets.length)} connection(s) named "${WANT}"`);
  }
} else {
  targets = conns;
  if (targets.length === 0) {
    const conn = await api("POST", "/api/connections", { name: "dev-machine" });
    targets = [conn];
    spin.succeed(`Created + sharing ${chalk.bold(conn.id)} ${dim("(dev-machine)")}`);
  } else {
    spin.succeed(`Sharing all ${chalk.bold(targets.length)} connection(s)`);
  }
}

// ---- status board ----
async function printBoard() {
  let shares = [];
  try { shares = await api("GET", "/api/shares"); } catch {}
  const t = new Table({
    head: [chalk.bold("connection"), chalk.bold("agent"), chalk.bold("active shares")],
    style: { head: [], border: ["gray"] },
    colWidths: [34, 10, 46],
    wordWrap: true,
  });
  for (const conn of targets) {
    const live = [...agents.keys()].includes(conn.id);
    const mine = shares.filter((s) => s.connectionId === conn.id && s.active);
    t.push([
      `${conn.name}\n${dim(conn.id)}`,
      live ? chalk.green("online") : dim("starting"),
      mine.length ? mine.map((s) => `${dim(publicBase + "/?connect=")}${s.code}`).join("\n") : dim("no links — Share in dashboard"),
    ]);
  }
  console.log(t.toString());
  console.log(dim(`dashboard: ${publicBase}/   ·   Ctrl-C stops everything this command started`));
}

// ---- agents ----
const agents = new Map(); // connId -> child
let shuttingDown = false, boardTimer = null;
function startAgent(conn) {
  if (shuttingDown || agents.has(conn.id)) return;
  const a = spawn("node", ["agent.js", conn.id], { stdio: "inherit" });
  agents.set(conn.id, a);
  a.on("exit", (code) => {
    agents.delete(conn.id);
    if (shuttingDown) return;
    if (code === 44) { console.log(dim(`[share] agent for ${conn.id} stopped (connection gone)`)); return void refreshBoard(); }
    console.log(warn, accent(`agent for ${conn.id} exited (${code ?? "signal"}), restarting in 2s`));
    setTimeout(() => startAgent(conn), 2000);
  });
}
for (const conn of targets) startAgent(conn);
await printBoard();

// Pick up connections created after startup (e.g. via the dashboard's
// "+ New" button) so `npm run share` keeps serving everything.
let lastSig = "";
async function refreshBoard() {
  try {
    const conns = await api("GET", "/api/connections");
    const wanted = WANT && WANT.startsWith("c_")
      ? conns.filter((c) => c.id === WANT)
      : WANT ? conns.filter((c) => c.name === WANT) : conns;
    const sig = wanted.map((c) => c.id).sort().join(",") + "|" + [...agents.keys()].sort().join(",");
    if (sig !== lastSig) {
      lastSig = sig;
      targets = wanted;
      await printBoard();
    }
    for (const conn of wanted) {
      if (!agents.has(conn.id)) {
        console.log(`${ok} new connection ${chalk.bold(conn.id)} ${dim(`(${conn.name})`)} — starting agent`);
        startAgent(conn);
      }
    }
    for (const id of [...agents.keys()]) {
      if (!conns.some((c) => c.id === id)) {
        console.log(`${warn} connection ${id} deleted — stopping agent`);
        try { agents.get(id)?.kill(); } catch {}
        agents.delete(id);
      }
    }
  } catch {}
}
const poll = setInterval(refreshBoard, 5000);

const shutdown = () => {
  shuttingDown = true;
  clearInterval(poll);
  if (boardTimer) clearInterval(boardTimer);
  for (const a of agents.values()) try { a.kill(); } catch {}
  if (tunnel) stopTunnel(tunnel.child);
  if (childServer) { try { process.kill(-childServer.pid); } catch {} }
  console.log(dim("\nstopped. bye!"));
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
// Agents respawn on unexpected exit; run until signal.
await new Promise(() => {});
