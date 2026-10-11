// Owner-side executor (pandapaw equivalent).
// Runs on the dev machine that holds the Claude subscription.
// Each remote guest gets an isolated shell; revoke/expiry kills only that shell.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RELAY = process.env.RELAY || "ws://localhost:8787/relay";
const CONNECTION_ID = process.env.CONNECTION_ID || process.argv[2];
if (!CONNECTION_ID) {
  console.error("usage: CONNECTION_ID=xxx node agent.js  (or node agent.js <connectionId>)");
  process.exit(1);
}
// One-line swap to drive real Claude Code instead of a demo shell:
//   spawn("claude", [], { cwd: sandbox })
const SHELL_CMD = process.env.SHELL_CMD || "sh";
const SHELL_ARGS = process.env.SHELL_CMD ? [] : [];

const sandbox = path.join(__dirname, "sandbox", CONNECTION_ID);
fs.mkdirSync(sandbox, { recursive: true });

const sessions = new Map(); // guestId -> ChildProcess

function killSession(id) {
  const p = sessions.get(id);
  if (p) { try { p.kill(); } catch {} sessions.delete(id); console.log(`[agent] session ended: ${id}`); }
}

function ensureSession(ws, id) {
  if (sessions.has(id)) return sessions.get(id);
  console.log(`[agent] new session for ${id} (cwd=${sandbox})`);
  const p = spawn(SHELL_CMD, SHELL_ARGS, { cwd: sandbox, stdio: ["pipe", "pipe", "pipe"] });
  sessions.set(id, p);
  p.stdout.on("data", (d) => ws.send(JSON.stringify({ type: "output", to: id, data: d.toString() })));
  p.stderr.on("data", (d) => ws.send(JSON.stringify({ type: "output", to: id, data: d.toString() })));
  p.on("exit", (code) => {
    try { ws.send(JSON.stringify({ type: "exit", to: id, data: `process exited (${code})` })); } catch {}
    sessions.delete(id);
  });
  // greeting so redeemers see quota-owner context
  p.stdin.write(`echo 'connected to ${CONNECTION_ID} as ${id} (shared Claude relay MVP)'\n`);
  return p;
}

function connect() {
  const ws = new WebSocket(`${RELAY}?role=owner&connectionId=${CONNECTION_ID}`);
  ws.on("open", () => console.log(`[agent] serving ${CONNECTION_ID} via ${RELAY}`));
  ws.on("message", (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.type === "ready") return;
    if (m.type === "connect") { ensureSession(ws, m.from); return; }
    if (m.type === "disconnect") { killSession(m.from); return; }
    if (m.type === "input") {
      const p = ensureSession(ws, m.from);
      try { p.stdin.write(m.data); } catch {}
    }
  });
  ws.on("close", () => {
    for (const id of [...sessions.keys()]) killSession(id);
    console.log("[agent] relay closed, reconnecting in 2s");
    setTimeout(connect, 2000);
  });
  ws.on("error", () => {});
}
connect();
