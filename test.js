// Lifecycle test: share -> claim -> exec -> revoke isolates -> expiry rejected.
// Spawns server + agent on a test port, no external services.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

const PORT = 8788;
const BASE = `http://localhost:${PORT}`;
const RELAY = `ws://localhost:${PORT}/relay`;
// Isolated store so tests never touch the real data.json
const TEST_DATA = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ccshare-")), "data.json");
const api = (m, p, b) => fetch(BASE + p, {
  method: m, headers: { "Content-Type": "application/json" },
  body: b ? JSON.stringify(b) : undefined,
}).then(async (r) => ({ status: r.status, j: await r.json().catch(() => ({})) }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function launch(cmd, args, env) {
  const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  p.stdout.on("data", (d) => process.env.VERBOSE && process.stdout.write("[srv] " + d));
  p.stderr.on("data", (d) => process.env.VERBOSE && process.stderr.write("[srv-err] " + d));
  return p;
}
async function waitFor(fn, timeout = 8000) {
  const t0 = Date.now();
  for (;;) {
    try { await fn(); return; } catch (e) {
      if (Date.now() - t0 > timeout) throw e;
      await sleep(200);
    }
  }
}
const results = [];
const check = (name, ok, extra = "") => { results.push([ok ? "PASS" : "FAIL", name, extra]); if (!ok) process.exitCode = 1; };

let server, agent;
try {
  server = launch("node", ["server.js"], { PORT: String(PORT), DATA_FILE: TEST_DATA });
  await waitFor(async () => { const r = await fetch(BASE + "/api/connections"); if (!r.ok) throw new Error("not up"); });

  // 1. create connection
  const { j: conn } = await api("POST", "/api/connections", { name: "test-machine" });
  check("create connection", !!conn.id, conn.id || "");

  // 2. start owner agent
  agent = launch("node", ["agent.js", conn.id], { RELAY });
  await sleep(1200);

  // 3. share (long-lived) + claim
  const { j: s1 } = await api("POST", `/api/connections/${conn.id}/share`, { expiry: "7d" });
  check("share generates code+link", !!s1.code && !!s1.link, s1.code || "");
  const c1 = await api("POST", "/api/claim", { code: s1.code, guestId: "alice" });
  check("claim valid code", c1.status === 200, JSON.stringify(c1.j));
  check("claim reports agent online", c1.j.ownerOnline === true, JSON.stringify(c1.j));

  // 4. guest exec round-trip through owner agent
  const out = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`${RELAY}?role=guest&code=${s1.code}&guestId=alice`);
    let buf = "";
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error("no output, got: " + buf)); }, 8000);
    ws.on("open", () => ws.send(JSON.stringify({ type: "input", data: "echo hello-ROUNDTRIP-123\n" })));
    ws.on("message", (raw) => {
      try { buf += JSON.parse(raw.toString()).data || ""; } catch {}
      if (buf.includes("hello-ROUNDTRIP-123")) { clearTimeout(timer); ws.close(); resolve(buf); }
    });
    ws.on("error", reject);
    ws._testWs = true; globalThis.__ws1 = ws;
  });
  check("guest input executes on owner machine", out.includes("hello-ROUNDTRIP-123"));

  // 5. revoke isolates: revoked guest kicked, second share unaffected
  const { j: s2 } = await api("POST", `/api/connections/${conn.id}/share`, { expiry: "7d" });
  await api("POST", "/api/claim", { code: s2.code, guestId: "bob" });
  const bobClosed = new Promise((resolve) => {
    const ws = new WebSocket(`${RELAY}?role=guest&code=${s2.code}&guestId=bob`);
    ws.on("close", (code) => resolve(code));
    setTimeout(() => resolve("timeout"), 8000);
    globalThis.__ws2 = ws;
  });
  const aliceWs = new WebSocket(`${RELAY}?role=guest&code=${s1.code}&guestId=alice2`);
  await new Promise((r) => aliceWs.on("open", r));
  await api("POST", `/api/shares/${s1.code}/revoke`);
  const claimedAfterRevoke = await api("POST", "/api/claim", { code: s1.code, guestId: "mallory" });
  check("revoked code cannot be re-claimed", claimedAfterRevoke.status === 403, JSON.stringify(claimedAfterRevoke.j));
  await sleep(800);
  check("revoked guest disconnected", aliceWs.readyState === WebSocket.CLOSED || aliceWs.readyState === WebSocket.CLOSING);
  try { aliceWs.close(); } catch {}
  // bob's share still claimable (independent token)
  const bobReclaim = await api("POST", "/api/claim", { code: s2.code, guestId: "bob2" });
  check("other share unaffected by revoke", bobReclaim.status === 200);
  try { globalThis.__ws2?.close(); } catch {}

  // 6. expiry rejected
  const { j: sExp } = await api("POST", `/api/connections/${conn.id}/share`, { expiresInMs: 300 });
  await sleep(600);
  const expClaim = await api("POST", "/api/claim", { code: sExp.code, guestId: "late" });
  check("expired code rejected", expClaim.status === 403, JSON.stringify(expClaim.j));

  // 7. invalid code rejected
  const bad = await api("POST", "/api/claim", { code: "nope123", guestId: "x" });
  check("invalid code rejected", bad.status === 404);

  // 8. agent presence: killing the agent flags offline + notifies guests
  const watcher = new WebSocket(`${RELAY}?role=guest&code=${s2.code}&guestId=watcher`);
  await new Promise((r) => watcher.on("open", r));
  const offlineNotice = new Promise((resolve) => {
    watcher.on("message", (raw) => {
      try { if (JSON.parse(raw.toString()).type === "owner-offline") resolve(true); } catch {}
    });
    setTimeout(() => resolve(false), 6000);
  });
  try { agent?.kill(); agent = null; } catch {}
  check("guest notified when agent goes offline", await offlineNotice);
  await sleep(400);
  const afterKill = await api("POST", "/api/claim", { code: s2.code, guestId: "zoe" });
  check("claim reports agent offline", afterKill.status === 200 && afterKill.j.ownerOnline === false, JSON.stringify(afterKill.j));
  try { watcher.close(); } catch {}
} catch (e) {
  check("no harness exception", false, String(e));
} finally {
  try { globalThis.__ws1?.close(); } catch {}
  try { globalThis.__ws2?.close(); } catch {}
  try { agent?.kill(); } catch {}
  try { server?.kill(); } catch {}
}
console.log(results.map((r) => r.join(" | ")).join("\n"));
process.exit(process.exitCode || 0);
