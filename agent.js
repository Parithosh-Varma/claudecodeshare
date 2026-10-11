// Owner-side executor (pandapaw equivalent).
// Runs on the dev machine that holds the subscriptions.
// Each remote guest gets an isolated PTY (real terminal, so TUIs like
// opencode / claude code render correctly); revoke/expiry kills only that PTY.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import * as pty from "node-pty";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RELAY = process.env.RELAY || "ws://localhost:8787/relay";
const CONNECTION_ID = process.env.CONNECTION_ID || process.argv[2];
if (!CONNECTION_ID) {
  console.error("usage: CONNECTION_ID=xxx node agent.js  (or node agent.js <connectionId>)");
  process.exit(1);
}
const SHELL = process.env.SHELL_CMD || process.env.SHELL || "sh";

const sandbox = path.join(__dirname, "sandbox", CONNECTION_ID);
fs.mkdirSync(sandbox, { recursive: true });

const sessions = new Map(); // guestId -> pty.IPty

function killSession(id) {
  const p = sessions.get(id);
  if (p) { try { p.kill(); } catch {} sessions.delete(id); console.log(`[agent] session ended: ${id}`); }
}

function ensureSession(ws, id, cols = 80, rows = 24) {
  if (sessions.has(id)) return sessions.get(id);
  console.log(`[agent] new session for ${id} (cwd=${sandbox})`);
  const p = pty.spawn(SHELL, [], {
    name: "xterm-256color",
    cols, rows,
    cwd: sandbox,
    env: { ...process.env, TERM: "xterm-256color" },
  });
  sessions.set(id, p);
  p.onData((d) => {
    try { ws.send(JSON.stringify({ type: "output", to: id, data: d })); } catch {}
  });
  p.onExit(({ exitCode }) => {
    try { ws.send(JSON.stringify({ type: "exit", to: id, data: `\r\n[process exited (${exitCode})]\r\n` })); } catch {}
    sessions.delete(id);
  });
  p.write(`echo 'connected to ${CONNECTION_ID} as ${id}'\r`);
  return p;
}

function connect() {
  const ws = new WebSocket(`${RELAY}?role=owner&connectionId=${CONNECTION_ID}`);
  ws.on("open", () => console.log(`[agent] serving ${CONNECTION_ID} via ${RELAY}`));
  ws.on("message", (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.type === "ready") return;
    if (m.type === "connect") { ensureSession(ws, m.from, m.cols, m.rows); return; }
    if (m.type === "disconnect") { killSession(m.from); return; }
    if (m.type === "resize") {
      const p = sessions.get(m.from);
      if (p && m.cols && m.rows) { try { p.resize(m.cols, m.rows); } catch {} }
      return;
    }
    if (m.type === "input") {
      const p = ensureSession(ws, m.from);
      try { p.write(m.data); } catch {}
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
