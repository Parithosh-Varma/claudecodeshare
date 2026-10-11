// Lifecycle test: share -> claim -> exec -> revoke isolates -> expiry rejected.
// Spawns server + agent on a test port, no external services.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { PKG_ROOT, SANDBOX_ROOT } from "./paths.js";

const PORT = 8788;
const BASE = `http://localhost:${PORT}`;
const RELAY = `ws://localhost:${PORT}/relay`;
// Isolated store so tests never touch the real data.json
const TEST_DATA = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ccshare-")), "data.json");
let __connId = null; // test connection id, removed from sandbox/ in finally
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
  server = launch("node", [path.join(PKG_ROOT, "server.js")], { PORT: String(PORT), DATA_FILE: TEST_DATA });
  await waitFor(async () => { const r = await fetch(BASE + "/api/connections"); if (!r.ok) throw new Error("not up"); });

  // 1. create connection
  const { j: conn } = await api("POST", "/api/connections", { name: "test-machine" });
  __connId = conn.id;
  check("create connection", !!conn.id, conn.id || "");

  // 2. start owner agent
  agent = launch("node", [path.join(PKG_ROOT, "agent.js"), conn.id], { RELAY });
  await sleep(1200);

  // 3. share (long-lived) + claim
  const { j: s1 } = await api("POST", `/api/connections/${conn.id}/share`, { expiry: "7d" });
  check("share generates code+link", !!s1.code && !!s1.link, s1.code || "");
  const c1 = await api("POST", "/api/claim", { code: s1.code, guestId: "alice" });
  check("claim valid code", c1.status === 200, JSON.stringify(c1.j));
  check("claim reports agent online", c1.j.ownerOnline === true, JSON.stringify(c1.j));

  // 3b. tunnel: share links embed the public URL when .tunnel-url exists
  {
    fs.writeFileSync(".tunnel-url", "https://demo-abc123.trycloudflare.com/\n");
    const { j: st } = await api("POST", `/api/connections/${conn.id}/share`, { expiry: "7d" });
    check("share link uses tunnel URL", st.link === `https://demo-abc123.trycloudflare.com/?connect=${st.code}`, st.link);
    fs.rmSync(".tunnel-url", { force: true });
  }

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

  // helper: open a guest socket with a message collector
  const openGuest = (code, guestId) => new Promise((resolve, reject) => {
    const ws = new WebSocket(`${RELAY}?role=guest&code=${code}&guestId=${guestId}`);
    const seen = [];
    ws.on("message", (raw) => { try { seen.push(JSON.parse(raw.toString())); } catch {} });
    ws.on("open", () => resolve({ ws, seen }));
    ws.on("error", reject);
  });
  const seenText = (seen) => seen.map((m) => m.data || "").join("");

  // 4c. waiting room: manual approval gates the shell
  const { j: sMan } = await api("POST", `/api/connections/${conn.id}/share`, { expiry: "7d", approval: "manual" });
  check("manual share records approval mode", sMan.approval === "manual");
  await api("POST", "/api/claim", { code: sMan.code, guestId: "g1" });
  const g1 = await openGuest(sMan.code, "g1");
  await sleep(800);
  check("manual share holds guest in waiting room", g1.seen.some((m) => m.type === "waiting"));
  g1.ws.send(JSON.stringify({ type: "input", data: "echo SHOULD-NOT-APPEAR\n" }));
  await sleep(1200);
  check("waiting guest gets no shell", !seenText(g1.seen).includes("SHOULD-NOT-APPEAR"));
  const pend = await api("GET", "/api/pending");
  check("pending lists waiting guest", pend.j.some((p) => p.guestId === "g1" && p.code === sMan.code));
  await api("POST", "/api/pending/approve", { code: sMan.code, guestId: "g1", approve: true });
  const g1out = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(seenText(g1.seen)), 9000);
    const iv = setInterval(() => {
      if (g1.seen.some((m) => m.type === "approved")) {
        try { g1.ws.send(JSON.stringify({ type: "input", data: "echo APPROVED-OK\n" })); } catch {}
      }
      if (seenText(g1.seen).includes("APPROVED-OK")) { clearTimeout(timer); clearInterval(iv); resolve(seenText(g1.seen)); }
    }, 300);
  });
  check("approved guest gets a shell", g1out.includes("APPROVED-OK"));
  try { g1.ws.close(); } catch {}
  await api("POST", "/api/claim", { code: sMan.code, guestId: "g2" });
  const g2 = await openGuest(sMan.code, "g2");
  await sleep(600);
  await api("POST", "/api/pending/approve", { code: sMan.code, guestId: "g2", approve: false });
  const denied = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 6000);
    const iv = setInterval(() => {
      if (g2.seen.some((m) => m.type === "denied") || g2.ws.readyState === WebSocket.CLOSED) { clearTimeout(timer); clearInterval(iv); resolve(true); }
    }, 200);
  });
  check("denied guest is turned away", denied);
  try { g2.ws.close(); } catch {}

  // 4d. per-guest kick
  const gk = await openGuest(s1.code, "kickme");
  await sleep(800);
  const gl = await api("GET", "/api/guests");
  check("guests list shows online guest", gl.j.some((g) => g.guestId === "kickme"));
  await api("POST", "/api/guests/kick", { code: s1.code, guestId: "kickme" });
  const kicked = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 6000);
    const iv = setInterval(() => {
      if (gk.seen.some((m) => m.type === "kicked") || gk.ws.readyState === WebSocket.CLOSED) { clearTimeout(timer); clearInterval(iv); resolve(true); }
    }, 200);
  });
  check("kicked guest is disconnected", kicked);
  try { gk.ws.close(); } catch {}

  // 4e. read-only mode drops input
  const { j: sRo } = await api("POST", `/api/connections/${conn.id}/share`, { expiry: "7d", mode: "readonly" });
  check("readonly share records mode", sRo.mode === "readonly");
  await api("POST", "/api/claim", { code: sRo.code, guestId: "ro" });
  const gro = await openGuest(sRo.code, "ro");
  await sleep(600);
  gro.ws.send(JSON.stringify({ type: "input", data: "echo RO-MARKER\n" }));
  await sleep(1500);
  check("read-only guest input is ignored", !seenText(gro.seen).includes("RO-MARKER") && gro.seen.some((m) => m.type === "notice"));
  try { gro.ws.close(); } catch {}

  // 4f. approve mode holds lines until the owner decides
  const { j: sAp } = await api("POST", `/api/connections/${conn.id}/share`, { expiry: "7d", mode: "approve" });
  await api("POST", "/api/claim", { code: sAp.code, guestId: "ap" });
  const gap = await openGuest(sAp.code, "ap");
  await sleep(600);
  gap.ws.send(JSON.stringify({ type: "input", data: "echo APPROVE-ME-42\n" }));
  await sleep(1200);
  const props = await api("GET", "/api/proposals");
  const prop = props.j.find((p) => p.guestId === "ap");
  check("approve-mode line held as proposal", !!prop && prop.line.includes("APPROVE-ME-42"));
  check("held line not executed yet", !seenText(gap.seen).includes("APPROVE-ME-42"));
  await api("POST", "/api/proposals/decide", { id: prop.id, approve: true });
  const apOut = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(seenText(gap.seen)), 9000);
    const iv = setInterval(() => {
      if (seenText(gap.seen).includes("APPROVE-ME-42")) { clearTimeout(timer); clearInterval(iv); resolve(seenText(gap.seen)); }
    }, 300);
  });
  check("approved line executes", apOut.includes("APPROVE-ME-42"));
  try { gap.ws.close(); } catch {}

  // 4g. transcripts record the session
  await sleep(500);
  const tr = await api("GET", "/api/transcripts");
  const aliceTr = tr.j.find((t) => t.guestId === "alice");
  check("transcript recorded", !!aliceTr);
  if (aliceTr) {
    const fileParam = aliceTr.file.split("/").map(encodeURIComponent).join("/");
    const tc = await api("GET", `/api/transcripts/${fileParam}`);
    check("transcript contains session output", !!(tc.j.content && tc.j.content.includes("hello-ROUNDTRIP-123")));
  } else check("transcript contains session output", false);

  // 4h. file transfer in and out of the sandbox
  const up = await api("POST", "/api/files", { code: s1.code, path: "up/hello.txt", content: Buffer.from("file-bytes-123").toString("base64") });
  check("guest upload accepted", up.j.ok === true);
  const fl = await api("GET", `/api/files?code=${s1.code}`);
  check("upload listed", fl.j.files.some((f) => f.path === "up/hello.txt"));
  const dl = await fetch(BASE + `/api/files?code=${s1.code}&path=` + encodeURIComponent("up/hello.txt")).then((r) => r.text());
  check("download matches upload", dl === "file-bytes-123");
  const trav = await fetch(BASE + `/api/files?code=${s1.code}&path=` + encodeURIComponent("../../data.json"));
  check("path traversal rejected", trav.status === 403);

  // 4i. rename machine + notify config round-trip
  const rn = await api("PATCH", `/api/connections/${conn.id}`, { name: "renamed-box" });
  check("rename works", rn.j.name === "renamed-box");
  let priorNotify = null, hadNotify = false;
  try { priorNotify = fs.readFileSync("notify.json", "utf8"); hadNotify = true; } catch { /* none */ }
  globalThis.__priorNotify = hadNotify ? priorNotify : null;
  const nz = await api("POST", "/api/notify", { telegram: null, discord: null });
  const ng = await api("GET", "/api/notify");
  check("notify config round-trips", nz.j.ok === true && ng.j.config && ng.j.config.telegram === null);

  // 4b. guest confinement (macOS seatbelt): host files unreadable, sandbox writable.
  if (process.platform === "darwin") {
    const cout = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`${RELAY}?role=guest&code=${s1.code}&guestId=confinetest`);
      let buf = "";
      const timer = setTimeout(() => { try { ws.close(); } catch {} resolve(buf); }, 10000);
      ws.on("open", async () => {
        ws.send(JSON.stringify({ type: "input", data: "stty -echo\n" }));
        await sleep(400);
        ws.send(JSON.stringify({ type: "input", data: "ls /Users 2>&1; echo T2; touch confine-ok && echo T5; echo ZZEND\n" }));
      });
      ws.on("message", (raw) => {
        try { buf += JSON.parse(raw.toString()).data || ""; } catch {}
        // Input echo also contains ZZEND, so wait for the executed output.
        if (buf.includes("ZZEND") && !ws._zz) { ws._zz = true; setTimeout(() => { clearTimeout(timer); try { ws.close(); } catch {} resolve(buf); }, 1200); }
      });
      ws.on("error", reject);
    });
    const flat = cout.replaceAll("\r", "").replace(/\[[0-9;?]*[a-zA-Z]/g, "");
    check("guest cannot list /Users", /\/Users: Operation not permitted/.test(flat), flat.slice(-160));
    check("guest can write in sandbox", /^T5$/m.test(flat));
  }

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

  // 8. cloud backup endpoints exist
  const pub = await api("GET", "/api/publish");
  check("publish status endpoint", pub.status === 200 && "config" in pub.j && "watching" in pub.j && "suggestedRepo" in pub.j, JSON.stringify(pub.j));
  const pvc = await api("POST", "/api/publish/preview", {});
  check("publish preview endpoint", pvc.status === 200 && Array.isArray(pvc.j.folders), JSON.stringify(pvc.j).slice(0, 120));

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

  // 9. publish: every sandbox folder -> one repo, repeat pushes append (local bare remote, no network)
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ccpub-"));
    const bare = path.join(tmp, "cloud.git");
    const statusFile = path.join(tmp, "status.json");
    spawnSync("git", ["init", "--bare", bare], { stdio: "pipe" });
    const tdir = path.join(SANDBOX_ROOT, "t-pubtest");
    fs.mkdirSync(tdir, { recursive: true });
    fs.writeFileSync(path.join(tdir, "app.txt"), "v1\n");
    const runPub = (extra = []) => spawnSync("node", [path.join(PKG_ROOT, "publish.js"), "--remote", bare, "--connection", "t-pubtest", "--no-auth", "--status-file", statusFile, ...extra], { encoding: "utf8" });
    const r1 = runPub();
    const log1 = spawnSync("git", ["--git-dir", bare, "log", "--oneline"], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean);
    check("publish pushes sandbox folder to repo", r1.status === 0 && log1.length === 1, log1.join(";") || String(r1.stderr).slice(-200));
    fs.writeFileSync(path.join(tdir, "app.txt"), "v2\n");
    fs.writeFileSync(path.join(tdir, "notes.md"), "hi\n");
    const r2 = runPub();
    const log2 = spawnSync("git", ["--git-dir", bare, "log", "--oneline"], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean);
    check("repeat push appends to same repo", r2.status === 0 && log2.length === 2, `commits=${log2.length}`);
    const tree = spawnSync("git", ["--git-dir", bare, "ls-tree", "-r", "--name-only", "HEAD"], { encoding: "utf8" }).stdout;
    check("files land in a named folder", tree.includes("t-pubtest") && tree.includes("app.txt"), tree.trim().split("\n").slice(0, 5).join(","));
    const st = JSON.parse(fs.readFileSync(statusFile, "utf8"));
    check("publish status file written", st.ok === true && st.pushed === true, JSON.stringify(st).slice(0, 140));
    const pv = runPub(["--preview"]);
    check("publish preview lists files", pv.status === 0 && pv.stdout.includes("app.txt"), pv.stdout.slice(0, 140));
    fs.rmSync(tdir, { recursive: true, force: true });
    const safe = bare.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 80);
    fs.rmSync(path.join(".cloud", safe), { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // 10. relay restart survival: same-id guest keeps their live shell
  agent = launch("node", [path.join(PKG_ROOT, "agent.js"), conn.id], { RELAY });
  await sleep(1500);
  const surv = await openGuest(s2.code, "survivor");
  await sleep(600);
  surv.ws.send(JSON.stringify({ type: "input", data: "export SURVIVOR=stay-alive\n" }));
  await sleep(800);
  try { server?.kill(); } catch {}
  try { surv.ws.close(); } catch {}
  await sleep(1000);
  server = launch("node", [path.join(PKG_ROOT, "server.js")], { PORT: String(PORT), DATA_FILE: TEST_DATA });
  await waitFor(async () => { const r = await fetch(BASE + "/api/connections"); if (!r.ok) throw new Error("not up"); }, 15000);
  await waitFor(async () => {
    const r = await api("POST", "/api/claim", { code: s2.code, guestId: "survivor2" });
    if (r.j.ownerOnline !== true) throw new Error("agent not back");
  }, 15000);
  const surv2 = await openGuest(s2.code, "survivor");
  await sleep(600);
  surv2.ws.send(JSON.stringify({ type: "input", data: "echo $SURVIVOR\n" }));
  const survOut = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(seenText(surv2.seen)), 9000);
    const iv = setInterval(() => {
      if (seenText(surv2.seen).includes("stay-alive")) { clearTimeout(timer); clearInterval(iv); resolve(seenText(surv2.seen)); }
    }, 300);
  });
  check("shell state survives relay restart", survOut.includes("stay-alive"));
  try { surv2.ws.close(); } catch {}

  // 11. idle timeout closes forgotten shells (isolated connection)
  const { j: idleConn } = await api("POST", "/api/connections", { name: "idle-box" });
  const { j: idleShare } = await api("POST", `/api/connections/${idleConn.id}/share`, { expiry: "7d" });
  await api("POST", "/api/claim", { code: idleShare.code, guestId: "sleepy" });
  const idleAgent = launch("node", [path.join(PKG_ROOT, "agent.js"), idleConn.id], { RELAY, IDLE_TIMEOUT_MS: "1500" });
  await sleep(1500);
  const sl = await openGuest(idleShare.code, "sleepy");
  await sleep(600);
  const idleGone = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 8000);
    const iv = setInterval(() => {
      if (seenText(sl.seen).includes("idle timeout")) { clearTimeout(timer); clearInterval(iv); resolve(true); }
    }, 300);
  });
  check("idle shell closes itself", idleGone);
  sl.ws.send(JSON.stringify({ type: "input", data: "echo BACK-AGAIN\n" }));
  const backAgain = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 8000);
    const iv = setInterval(() => {
      const n = (seenText(sl.seen).match(/connected to/g) || []).length;
      if (n >= 2) { clearTimeout(timer); clearInterval(iv); resolve(true); }
    }, 300);
  });
  check("next input starts a fresh shell", backAgain);
  try { sl.ws.close(); } catch {}
  try { idleAgent.kill(); } catch {}
  try { fs.rmSync(path.join(SANDBOX_ROOT, idleConn.id), { recursive: true, force: true }); } catch {}
  try { fs.rmSync(path.join("transcripts", idleConn.id), { recursive: true, force: true }); } catch {}

  // 12. delete machine removes it, its shares and its guests
  const { j: delConn } = await api("POST", "/api/connections", { name: "doomed" });
  const { j: delShare } = await api("POST", `/api/connections/${delConn.id}/share`, { expiry: "7d" });
  await api("POST", "/api/claim", { code: delShare.code, guestId: "doomed-guest" });
  const dg = await openGuest(delShare.code, "doomed-guest");
  await sleep(600);
  await api("DELETE", `/api/connections/${delConn.id}`);
  const gone = await api("GET", "/api/connections");
  check("deleted machine gone", !gone.j.some((c) => c.id === delConn.id));
  const reclaim = await api("POST", "/api/claim", { code: delShare.code, guestId: "x" });
  check("deleted share unclaimable", reclaim.status === 404);
  await sleep(600);
  check("deleted-connection guest disconnected", dg.ws.readyState === WebSocket.CLOSED);
  try { dg.ws.close(); } catch {}
  try { fs.rmSync(path.join(SANDBOX_ROOT, delConn.id), { recursive: true, force: true }); } catch {}
  try { fs.rmSync(path.join("transcripts", delConn.id), { recursive: true, force: true }); } catch {}
} catch (e) {
  check("no harness exception", false, String(e));
} finally {
  try { globalThis.__ws1?.close(); } catch {}
  try { globalThis.__ws2?.close(); } catch {}
  try { agent?.kill(); } catch {}
  try { server?.kill(); } catch {}
  try { if (__connId) fs.rmSync(path.join(SANDBOX_ROOT, __connId), { recursive: true, force: true }); } catch {}
  try { if (__connId) fs.rmSync(path.join("transcripts", __connId), { recursive: true, force: true }); } catch {}
  try {
    if (globalThis.__priorNotify !== undefined) {
      if (globalThis.__priorNotify) fs.writeFileSync("notify.json", globalThis.__priorNotify);
      else fs.rmSync("notify.json", { force: true });
    }
  } catch {}
}
console.log(results.map((r) => r.join(" | ")).join("\n"));
process.exit(process.exitCode || 0);
