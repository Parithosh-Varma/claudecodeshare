import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { WebSocketServer } from "ws";
import {
  PKG_ROOT, DATA_FILE, TUNNEL_FILE, TRANSCRIPTS_DIR, NOTIFY_FILE,
  PUBLISH_FILE, PUBLISH_STATUS, PUBLIC_DIR, sandboxOf,
} from "./paths.js";

const PORT = process.env.PORT || 8787;

const EXPIRY = { "1d": 86400_000, "7d": 7 * 86400_000, "30d": 30 * 86400_000, "forever": null };

// ---- store ----
let db = { connections: {}, shares: {} };
try {
  if (fs.existsSync(DATA_FILE)) db = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
} catch { /* fresh */ }
const save = () => fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));

// Public base URL for share links. When a Cloudflare tunnel is up,
// .tunnel-url holds it (so localhost owners still hand out public links).
// Behind any proxy, honor X-Forwarded-Proto for the scheme.
function publicBase(req) {
  try {
    const saved = fs.readFileSync(TUNNEL_FILE, "utf8").trim();
    if (saved) return saved.replace(/\/+$/, "");
  } catch {}
  const proto = req.headers["x-forwarded-proto"] || "http";
  return `${proto}://${req.headers.host || `localhost:${PORT}`}`;
}

const isActive = (s) => {
  if (!s || s.revokedAt) return false;
  if (s.expiresAt && Date.now() > s.expiresAt) return false;
  return true;
};
const shareCode = () => crypto.randomBytes(9).toString("base64url");
const uid = (p = "") => p + crypto.randomBytes(6).toString("hex");
if (!db.decisions) db.decisions = {};

// ---- trust & control: approval, modes, proposals, transcripts, notify ----
const shareMode = (s) => (s && (s.mode === "readonly" || s.mode === "approve") ? s.mode : "full");
const shareApproval = (s) => (s && s.approval === "manual" ? "manual" : "auto");
const pendingKey = (code, guestId) => `${code}:${guestId}`;
const pending = new Map(); // key -> {code, guestId, connectionId, waitingSince, timer}
const waiting = new Map(); // key -> Set<ws> (connected but not yet approved)
const proposals = new Map(); // id -> {id, code, guestId, connectionId, raw, at}
const safeName = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);

// Owner -> * guests fan-out (used by HTTP routes; WS callbacks predate it).
function tellOwners(connectionId, obj) {
  const text = JSON.stringify(obj);
  for (const o of owners.get(connectionId) ?? [])
    if (o.readyState === 1) { try { o.send(text); } catch {} }
}

// Session transcripts: every relayed chunk + membership event, per guest.
let tlogCount = 0;
function tlog(connectionId, code, guestId, dir, data) {
  try {
    const cdir = path.join(TRANSCRIPTS_DIR, safeName(connectionId));
    fs.mkdirSync(cdir, { recursive: true });
    const line = JSON.stringify({ t: Date.now(), dir, data: String(data).slice(0, 4000) }) + "\n";
    const f = path.join(cdir, `${safeName(code)}-${safeName(guestId)}.log`);
    fs.appendFile(f, line, () => {});
    if (++tlogCount % 100 === 0) {
      fs.stat(f, (e, st) => {
        if (!e && st.size > 5 * 1024 * 1024) fs.rename(f, f + ".old", () => {});
      });
    }
  } catch { /* transcripts must never break the relay */ }
}

// Join notifications (Telegram / Discord), fire-and-forget.
const loadNotify = () => { try { return JSON.parse(fs.readFileSync(NOTIFY_FILE, "utf8")); } catch { return { telegram: null, discord: null }; } };
function sendNotify(text) {
  const cfg = loadNotify();
  const jobs = [];
  try {
    if (cfg.telegram?.botToken && cfg.telegram?.chatId) {
      jobs.push(fetch(`https://api.telegram.org/bot${cfg.telegram.botToken}/sendMessage`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: cfg.telegram.chatId, text }),
        signal: AbortSignal.timeout(8000),
      }));
    }
    if (cfg.discord?.webhook) {
      jobs.push(fetch(cfg.discord.webhook, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: text }),
        signal: AbortSignal.timeout(8000),
      }));
    }
  } catch { /* never break the relay */ }
  if (jobs.length) Promise.allSettled(jobs).catch(() => {});
}

// Waiting room: called at claim time and at WS open (idempotent).
// Returns 'approved' | 'pending' | 'denied'.
function ensurePending(code, guestId, connectionId) {
  db.decisions ||= {};
  const prior = db.decisions[code]?.[guestId];
  if (prior === "approved" || prior === "denied") return prior;
  const key = pendingKey(code, guestId);
  if (pending.has(key)) return "pending";
  const entry = { code, guestId, connectionId, waitingSince: Date.now(), timer: null };
  entry.timer = setTimeout(() => {
    pending.delete(key);
    db.decisions[code] ||= {};
    db.decisions[code][guestId] = "denied";
    save();
    for (const ws of waiting.get(key) ?? []) {
      try { ws.send(JSON.stringify({ type: "denied", reason: "no response from owner" })); } catch {}
      try { ws.close(4403, "approval-timeout"); } catch {}
    }
    waiting.delete(key);
    tlog(connectionId, code, guestId, "event", "approval timed out");
  }, 10 * 60 * 1000).unref();
  pending.set(key, entry);
  return "pending";
}

// File transfer, rooted at a connection's sandbox (traversal-proof).
function sandboxPath(cid, p) {
  if (!p || typeof p !== "string" || p.length > 512) return null;
  if (p.split("/").includes("..")) return null; // reject escapes outright (403), not just neutralize
  const norm = path.normalize("/" + p).replace(/^\/+/, "");
  if (!norm || norm === "." || norm.startsWith("..")) return null;
  const root = sandboxOf(cid);
  const full = path.join(root, norm);
  if (!full.startsWith(root + path.sep)) return null;
  return full;
}
function listFiles(root) {
  const out = [];
  const walk = (d, rel) => {
    if (out.length >= 500) return;
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const rp = rel ? rel + "/" + e.name : e.name;
      const fp = path.join(d, e.name);
      if (e.isDirectory()) walk(fp, rp);
      else { try { const st = fs.statSync(fp); out.push({ path: rp, size: st.size, mtime: st.mtimeMs }); } catch {} }
    }
  };
  walk(root, "");
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

// ---- http ----
const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  // CORS: the hosted console lives on a different origin (pages.dev) and calls
  // this relay with credentials:'include'. Browsers reject Access-Control-*
  // "*" in that mode, so echo the caller's origin instead — without this the
  // console's /auth/me probe fails outright and gets misread as "cloud relay,
  // signed out", which wrongly raises the sign-in gate.
  const origin = req.headers.origin;
  res.setHeader("Access-Control-Allow-Origin", origin || "*");
  if (origin) res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Vary", "Origin");
  if (req.method === "OPTIONS") return res.writeHead(204).end();

  const json = (code, obj) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  const body = () => new Promise((resolve) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
      try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); }
    });
  });

  (async () => {
    // Create connection (owner side)
    if (req.method === "POST" && u.pathname === "/api/connections") {
      const b = await body();
      const id = "c_" + crypto.randomBytes(6).toString("hex");
      db.connections[id] = { id, name: b.name || "dev-machine", createdAt: Date.now() };
      save();
      return json(200, db.connections[id]);
    }
    // List connections (with Shared badge state + agent presence)
    if (req.method === "GET" && u.pathname === "/api/connections") {
      const list = Object.values(db.connections).map((c) => ({
        ...c,
        shared: Object.values(db.shares).some((s) => s.connectionId === c.id && isActive(s)),
        ownerOnline: (owners.get(c.id)?.size ?? 0) > 0,
      }));
      return json(200, list);
    }
    // Share a connection -> independent revocable token
    const mShare = u.pathname.match(/^\/api\/connections\/([^/]+)\/share$/);
    if (req.method === "POST" && mShare) {
      const conn = db.connections[mShare[1]];
      if (!conn) return json(404, { error: "no such connection" });
      const b = await body();
      let expiresAt = null;
      if (b.expiresInMs != null) expiresAt = Date.now() + Number(b.expiresInMs);
      else if (b.expiry && b.expiry !== "forever") expiresAt = Date.now() + (EXPIRY[b.expiry] ?? EXPIRY["7d"]);
      const code = shareCode();
      db.shares[code] = {
        code, connectionId: conn.id, createdAt: Date.now(), expiresAt, revokedAt: null, claims: 0,
        approval: b.approval === "manual" ? "manual" : "auto",
        mode: ["full", "readonly", "approve"].includes(b.mode) ? b.mode : "full",
      };
      save();
      return json(200, { code, link: `${publicBase(req)}/?connect=${code}`, expiresAt, approval: db.shares[code].approval, mode: db.shares[code].mode });
    }
    // "Connections I shared" management page data
    if (req.method === "GET" && u.pathname === "/api/shares") {
      const list = Object.values(db.shares).map((s) => ({
        ...s,
        approval: shareApproval(s),
        mode: shareMode(s),
        active: isActive(s),
        connectionName: db.connections[s.connectionId]?.name ?? "(deleted)",
        link: `${publicBase(req)}/?connect=${s.code}`,
      }));
      return json(200, list);
    }
    // Revoke: thorough — kicks everyone on this code, owner + other codes unaffected
    const mRev = u.pathname.match(/^\/api\/shares\/([^/]+)\/revoke$/);
    if (req.method === "POST" && mRev) {
      const s = db.shares[mRev[1]];
      if (!s) return json(404, { error: "no such share" });
      s.revokedAt = Date.now();
      save();
      disconnectGuestsByCode(s.code, 4403, "revoked");
      return json(200, { ok: true });
    }
    // Claim (redeemer side)
    if (req.method === "POST" && u.pathname === "/api/claim") {
      const b = await body();
      const s = db.shares[b.code];
      if (!s) return json(404, { error: "invalid code" });
      if (s.revokedAt) return json(403, { error: "revoked" });
      if (s.expiresAt && Date.now() > s.expiresAt) return json(403, { error: "expired" });
      s.claims += 1;
      save();
      const c = db.connections[s.connectionId];
      const guestId = typeof b.guestId === "string" && b.guestId ? b.guestId : null;
      if (shareApproval(s) === "manual" && guestId) {
        if (ensurePending(b.code, guestId, s.connectionId) === "pending") {
          const n = db.connections[s.connectionId]?.name ?? "(deleted)";
          sendNotify(`🔔 ${guestId} requested access to ${n} — approve in the dashboard`);
        }
      }
      return json(200, { connectionId: s.connectionId, connectionName: c?.name, expiresAt: s.expiresAt, ownerOnline: (owners.get(s.connectionId)?.size ?? 0) > 0, mode: shareMode(s), approval: shareApproval(s) });
    }
    // ---- trust & control ----
    // Waiting room
    if (req.method === "GET" && u.pathname === "/api/pending") {
      const list = [...pending.values()].map((p) => ({
        code: p.code, guestId: p.guestId, connectionId: p.connectionId,
        connectionName: db.connections[p.connectionId]?.name ?? "(deleted)",
        waitingSince: p.waitingSince,
      }));
      return json(200, list);
    }
    if (req.method === "POST" && u.pathname === "/api/pending/approve") {
      const b = await body();
      const { code, guestId, approve } = b;
      const key = pendingKey(code, guestId);
      const p = pending.get(key);
      if (p) { clearTimeout(p.timer); pending.delete(key); }
      db.decisions ||= {};
      db.decisions[code] ||= {};
      db.decisions[code][guestId] = approve ? "approved" : "denied";
      save();
      const set = waiting.get(key);
      waiting.delete(key);
      const s = db.shares[code];
      if (approve && s && isActive(s)) {
        for (const ws of set ?? []) {
          if (ws.readyState !== 1) continue;
          if (!guests.has(code)) guests.set(code, new Set());
          guests.get(code).add(ws);
          ws._joined = true;
          ws._connectedAt = Date.now();
          try { ws.send(JSON.stringify({ type: "approved" })); } catch {}
          tlog(s.connectionId, code, guestId, "event", "approved by owner");
          tellOwners(s.connectionId, { type: "connect", from: ws._guestId, code });
          const n = db.connections[s.connectionId]?.name ?? "(deleted)";
          sendNotify(`✅ ${guestId} joined ${n}`);
        }
      } else {
        for (const ws of set ?? []) {
          try { ws.send(JSON.stringify({ type: "denied", reason: "denied by owner" })); } catch {}
          try { ws.close(4403, "denied"); } catch {}
        }
        if (s) tlog(s.connectionId, code, guestId, "event", "denied by owner");
      }
      return json(200, { ok: true });
    }
    // Guests online + per-guest kick
    if (req.method === "GET" && u.pathname === "/api/guests") {
      const list = [];
      for (const [code, set] of guests)
        for (const g of set)
          list.push({
            code, guestId: g._guestId, connectionId: g._connectionId,
            connectionName: db.connections[g._connectionId]?.name ?? "(deleted)",
            connectedAt: g._connectedAt ?? null,
          });
      return json(200, list);
    }
    if (req.method === "POST" && u.pathname === "/api/guests/kick") {
      const b = await body();
      let found = false;
      for (const ws of guests.get(b.code) ?? []) {
        if (ws._guestId !== b.guestId) continue;
        found = true;
        try { ws.send(JSON.stringify({ type: "kicked" })); } catch {}
        try { ws.close(4403, "kicked"); } catch {}
      }
      for (const ws of waiting.get(pendingKey(b.code, b.guestId)) ?? []) {
        found = true;
        try { ws.send(JSON.stringify({ type: "denied", reason: "kicked by owner" })); } catch {}
        try { ws.close(4403, "kicked"); } catch {}
      }
      if (found) {
        const s = db.shares[b.code];
        if (s) tlog(s.connectionId, b.code, b.guestId, "event", "kicked by owner");
      }
      return json(200, { ok: found });
    }
    // Approve-mode command proposals
    if (req.method === "GET" && u.pathname === "/api/proposals") {
      const list = [...proposals.values()].map((p) => ({
        id: p.id, code: p.code, guestId: p.guestId, connectionId: p.connectionId,
        connectionName: db.connections[p.connectionId]?.name ?? "(deleted)",
        line: p.raw.replace(/[\r\n]+$/, "").slice(0, 200), at: p.at,
      }));
      return json(200, list);
    }
    if (req.method === "POST" && u.pathname === "/api/proposals/decide") {
      const b = await body();
      const p = proposals.get(b.id);
      if (!p) return json(404, { error: "no such proposal" });
      proposals.delete(b.id);
      if (b.approve) {
        tellOwners(p.connectionId, { type: "input", from: p.guestId, code: p.code, data: p.raw });
        tlog(p.connectionId, p.code, p.guestId, "event", "proposal approved");
      } else {
        for (const ws of guests.get(p.code) ?? []) {
          if (ws._guestId === p.guestId && ws.readyState === 1)
            try { ws.send(JSON.stringify({ type: "notice", text: "command denied by owner" })); } catch {}
        }
        tlog(p.connectionId, p.code, p.guestId, "event", "proposal denied");
      }
      return json(200, { ok: true });
    }
    // Session transcripts
    if (req.method === "GET" && u.pathname === "/api/transcripts") {
      const list = [];
      let cids = [];
      try { cids = fs.readdirSync(TRANSCRIPTS_DIR); } catch { /* none */ }
      for (const cid of cids) {
        let files = [];
        try { files = fs.readdirSync(path.join(TRANSCRIPTS_DIR, cid)); } catch { continue; }
        for (const f of files) {
          if (!f.endsWith(".log")) continue;
          const m = f.match(/^(.+)-([A-Za-z0-9_-]+)\.log$/);
          if (!m) continue;
          let st = null;
          try { st = fs.statSync(path.join(TRANSCRIPTS_DIR, cid, f)); } catch { continue; }
          list.push({
            connectionId: cid, connectionName: db.connections[cid]?.name ?? "(deleted)",
            code: m[1], guestId: m[2], file: `${cid}/${f}`,
            size: st.size, updatedAt: st.mtimeMs,
          });
        }
      }
      list.sort((a, b) => b.updatedAt - a.updatedAt);
      return json(200, list);
    }
    const mTranscript = u.pathname.match(/^\/api\/transcripts\/(.+)$/);
    if (req.method === "GET" && mTranscript) {
      const parts = mTranscript[1].split("/");
      if (parts.length !== 2 || parts.some((x) => x !== path.basename(x))) return json(400, { error: "bad file" });
      const fp = path.join(TRANSCRIPTS_DIR, parts[0], parts[1]);
      if (!fp.startsWith(TRANSCRIPTS_DIR + path.sep)) return json(400, { error: "bad file" });
      let st = null;
      try { st = fs.statSync(fp); } catch { return json(404, { error: "not found" }); }
      if (!st.isFile()) return json(404, { error: "not found" });
      const CAP = 200 * 1024;
      const content = st.size > CAP
        ? fs.readFileSync(fp, { encoding: "utf8", flag: "r" }).slice(-CAP)
        : fs.readFileSync(fp, "utf8");
      return json(200, { content, truncated: st.size > CAP });
    }
    // File transfer (owner: ?connection=, guest: ?code= — both rooted at the sandbox)
    if (req.method === "GET" && u.pathname === "/api/files") {
      const qConn = u.searchParams.get("connection");
      const qCode = u.searchParams.get("code");
      const qPath = u.searchParams.get("path");
      let cid = null;
      if (qConn) {
        if (!db.connections[qConn]) return json(404, { error: "no such connection" });
        cid = qConn;
      } else if (qCode) {
        const s = db.shares[qCode];
        if (!s) return json(404, { error: "invalid code" });
        if (!isActive(s)) return json(403, { error: "revoked-or-expired" });
        cid = s.connectionId;
      } else return json(400, { error: "connection or code required" });
      if (!qPath) return json(200, { files: listFiles(sandboxOf(cid)) });
      const full = sandboxPath(cid, qPath);
      if (!full) return json(403, { error: "outside sandbox" });
      let st = null;
      try { st = fs.statSync(full); } catch { return json(404, { error: "not found" }); }
      if (!st.isFile()) return json(404, { error: "not found" });
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": st.size, "Content-Disposition": `attachment; filename="${path.basename(full)}"` });
      return res.end(fs.readFileSync(full));
    }
    if (req.method === "POST" && u.pathname === "/api/files") {
      const b = await body();
      let cid = null;
      if (b.connection) {
        if (!db.connections[b.connection]) return json(404, { error: "no such connection" });
        cid = b.connection;
      } else if (b.code) {
        const s = db.shares[b.code];
        if (!s) return json(404, { error: "invalid code" });
        if (!isActive(s)) return json(403, { error: "revoked-or-expired" });
        cid = s.connectionId;
      } else return json(400, { error: "connection or code required" });
      const full = sandboxPath(cid, b.path);
      if (!full) return json(403, { error: "outside sandbox" });
      if (typeof b.content !== "string") return json(400, { error: "content required" });
      let buf = null;
      try { buf = Buffer.from(b.content, "base64"); } catch { return json(400, { error: "bad content" }); }
      if (buf.length > 10 * 1024 * 1024) return json(413, { error: "file too large (10MB max)" });
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, buf);
      return json(200, { ok: true, size: buf.length });
    }
    // Rename / delete machines
    const mConn = u.pathname.match(/^\/api\/connections\/([^/]+)$/);
    if (mConn && req.method === "PATCH") {
      const c = db.connections[mConn[1]];
      if (!c) return json(404, { error: "no such connection" });
      const b = await body();
      if (typeof b.name === "string" && b.name.trim()) c.name = b.name.trim().slice(0, 64);
      save();
      return json(200, c);
    }
    if (mConn && req.method === "DELETE") {
      const cid = mConn[1];
      if (!db.connections[cid]) return json(404, { error: "no such connection" });
      delete db.connections[cid];
      for (const s of Object.values(db.shares)) {
        if (s.connectionId !== cid) continue;
        disconnectGuestsByCode(s.code, 4404, "connection deleted");
        dropWaitingByCode(s.code, "connection deleted");
        delete db.shares[s.code];
        if (db.decisions) delete db.decisions[s.code];
      }
      for (const o of owners.get(cid) ?? []) { try { o.close(4404, "connection deleted"); } catch {} }
      owners.delete(cid);
      save();
      return json(200, { ok: true });
    }
    // Join notifications
    if (req.method === "GET" && u.pathname === "/api/notify") {
      return json(200, { config: loadNotify() });
    }
    if (req.method === "POST" && u.pathname === "/api/notify") {
      const b = await body();
      const cfg = {
        telegram: b.telegram?.botToken && b.telegram?.chatId ? { botToken: b.telegram.botToken, chatId: b.telegram.chatId } : null,
        discord: b.discord?.webhook ? { webhook: b.discord.webhook } : null,
      };
      fs.writeFileSync(NOTIFY_FILE, JSON.stringify(cfg, null, 2));
      return json(200, { ok: true });
    }
    if (req.method === "POST" && u.pathname === "/api/notify/test") {
      const cfg = loadNotify();
      if (!cfg.telegram && !cfg.discord) return json(200, { ok: false, error: "no channels configured" });
      sendNotify("✅ test from Second Seat — notifications are on");
      return json(200, { ok: true });
    }
    // Cloud backup status (repo config + last sync + suggested private repo)
    if (req.method === "GET" && u.pathname === "/api/publish") {
      const login = ghLogin();
      return json(200, { config: loadPublishConfig(), status: loadPublishStatus(), watching: !!publishWatcher, suggestedRepo: login ? `${login}/claude-session` : null });
    }
    // Cloud backup preview: folder -> files that "Push to GitHub" would upload.
    if (req.method === "POST" && u.pathname === "/api/publish/preview") {
      const b = await body();
      const argv = [path.join(PKG_ROOT, "publish.js"), "--preview", "--no-auth"];
      if (b.connection) argv.push("--connection", b.connection);
      const r = spawnSync(process.execPath, argv, { encoding: "utf8" });
      try { return json(200, { folders: JSON.parse(r.stdout || "[]") }); }
      catch { return json(500, { error: "preview failed" }); }
    }
    // Cloud backup: push every sandbox to one repo, optionally keep watching.
    // Runs owner-side (where the files are). Configure once, it auto-pushes.
    if (req.method === "POST" && u.pathname === "/api/publish") {
      const b = await body();
      if (!b.repo && !b.remote) return json(400, { error: "give owner/repo" });
      const cfg = { repo: b.repo || null, remote: b.remote || null, branch: b.branch || "main", watch: !!b.watch };
      fs.writeFileSync(PUBLISH_FILE, JSON.stringify(cfg, null, 2));
      const target = cfg.remote ? ["--remote", cfg.remote] : [cfg.repo];
      if (cfg.watch) {
        startPublishWatcher(cfg);
        return json(200, { ok: true, watching: true, output: `auto-push on -> ${cfg.repo || cfg.remote}` });
      }
      stopPublishWatcher();
      const argv = [path.join(PKG_ROOT, "publish.js"), ...target, "--branch", cfg.branch, ...(b.create ? ["--create"] : []), "--status-file", PUBLISH_STATUS];
      const r = spawnSync(process.execPath, argv, { encoding: "utf8" });
      const output = ((r.stdout || "") + (r.stderr || "")).trim().slice(-2000);
      return json(200, { ok: r.status === 0, output });
    }
    // Static frontend (ships in the private dashboard package; global npm
    // installs are headless — API works, UI points at the hosted console)
    let f = u.pathname === "/" ? "/index.html" : u.pathname;
    const fp = path.join(PUBLIC_DIR, path.normalize(f).replace(/^\/+/, ""));
    if (req.method === "GET" && fs.existsSync(fp) && fs.statSync(fp).isFile()) {
      const ext = path.extname(fp);
      const ctype = ext === ".html" ? "text/html"
        : ext === ".js" ? "application/javascript"
        : ext === ".css" ? "text/css"
        : ext === ".json" ? "application/json" : "text/plain";
      res.writeHead(200, { "Content-Type": ctype });
      return res.end(fs.readFileSync(fp));
    }
    if (req.method === "GET" && (u.pathname === "/" || u.pathname === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end(`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Second Seat relay</title><body style="font-family:system-ui;max-width:560px;margin:4rem auto;padding:0 1.5rem"><h1>Second Seat relay is running.</h1><p>This install ships without the dashboard UI &mdash; use the <a href="https://second-seat-console.pages.dev">hosted console</a>, or point any dashboard at this relay (<code>${u.host || ""}</code>).</p><p>API: <code>GET /api/connections</code> &middot; share via <code>POST /api/connections/:id/share</code></p></body>`);
    }
    return json(404, { error: "not found" });
  })().catch((e) => json(500, { error: String(e) }));
});

// ---- relay ----
const wss = new WebSocketServer({ server, path: "/relay" });
const owners = new Map(); // connectionId -> Set<ws>
const guests = new Map(); // code -> Set<ws>

// ---- cloud backup watcher (auto-pushes new sandbox files) ----
let publishWatcher = null;
function loadPublishConfig() {
  try { return JSON.parse(fs.readFileSync(PUBLISH_FILE, "utf8")); } catch { return null; }
}
function loadPublishStatus() {
  try { return JSON.parse(fs.readFileSync(PUBLISH_STATUS, "utf8")); } catch { return null; }
}
function stopPublishWatcher() {
  if (publishWatcher) { try { publishWatcher.kill(); } catch {} publishWatcher = null; }
}
function startPublishWatcher(cfg) {
  stopPublishWatcher();
  const target = cfg.remote ? ["--remote", cfg.remote] : [cfg.repo];
  const argv = [path.join(PKG_ROOT, "publish.js"), ...target, "--branch", cfg.branch || "main", "--watch", "--interval", "30", "--status-file", PUBLISH_STATUS];
  publishWatcher = spawn(process.execPath, argv, { stdio: ["ignore", "pipe", "pipe"] });
  publishWatcher.stdout.on("data", (d) => process.stdout.write("[publish] " + d));
  publishWatcher.stderr.on("data", (d) => process.stderr.write("[publish] " + d));
  publishWatcher.on("exit", () => { publishWatcher = null; });
}
process.on("SIGINT", () => { stopPublishWatcher(); process.exit(0); });
process.on("SIGTERM", () => { stopPublishWatcher(); process.exit(0); });

let suggestedCache = null, suggestedAt = 0;
function ghLogin() {
  if (suggestedCache && Date.now() - suggestedAt < 60000) return suggestedCache;
  try {
    const env = { ...process.env };
    delete env.GITHUB_TOKEN; delete env.GH_TOKEN;
    const r = spawnSync("gh", ["api", "user", "-q", ".login"], { encoding: "utf8", env });
    suggestedCache = (r.stdout || "").trim() || null;
  } catch { suggestedCache = null; }
  suggestedAt = Date.now();
  return suggestedCache;
}

function guestsOfConnection(cid) {
  const out = [];
  for (const set of guests.values())
    for (const g of set)
      if (g._connectionId === cid && g.readyState === 1) out.push(g);
  return out;
}

function disconnectGuestsByCode(code, wsCode, reason) {
  for (const ws of guests.get(code) ?? []) {
    try { ws.send(JSON.stringify({ type: "revoked", reason })); } catch {}
    try { ws.close(wsCode, reason); } catch {}
  }
  dropWaitingByCode(code, reason);
}
function dropWaitingByCode(code, reason) {
  for (const [key, set] of waiting) {
    if (!key.startsWith(code + ":")) continue;
    for (const ws of set) {
      try { ws.send(JSON.stringify({ type: "revoked", reason })); } catch {}
      try { ws.close(4403, reason); } catch {}
    }
    waiting.delete(key);
  }
}
// Expire sweep: expired shares drop their guests, like revoke
setInterval(() => {
  for (const s of Object.values(db.shares)) {
    if (!s.revokedAt && s.expiresAt && Date.now() > s.expiresAt) disconnectGuestsByCode(s.code, 4401, "expired");
  }
}, 15_000).unref();

wss.on("connection", (ws, req) => {
  const u = new URL(req.url, "http://x");
  const role = u.searchParams.get("role");
  ws._id = uid(role === "owner" ? "owner_" : "guest_");

  if (role === "owner") {
    const cid = u.searchParams.get("connectionId");
    if (!db.connections[cid]) return ws.close(4404, "no such connection");
    ws._role = "owner"; ws._connectionId = cid;
    if (!owners.has(cid)) owners.set(cid, new Set());
    const wasOffline = owners.get(cid).size === 0;
    owners.get(cid).add(ws);
    if (wasOffline)
      for (const g of guestsOfConnection(cid))
        try { g.send(JSON.stringify({ type: "owner-online" })); } catch {}
    ws.on("message", (raw) => {
      // owner -> specific guest: {type:'output'|'exit', to, data}
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      for (const set of guests.values())
        for (const g of set)
          if (g._guestId === m.to && g._connectionId === cid && g.readyState === 1) {
            g.send(JSON.stringify({ type: m.type, data: m.data }));
            tlog(cid, g._code, m.to, m.type === "exit" ? "event" : "out", m.data ?? m.type);
          }
    });
    ws.on("close", () => {
      owners.get(cid)?.delete(ws);
      if ((owners.get(cid)?.size ?? 0) === 0)
        for (const g of guestsOfConnection(cid))
          try { g.send(JSON.stringify({ type: "owner-offline" })); } catch {}
    });
    ws.send(JSON.stringify({ type: "ready", id: ws._id }));
    return;
  }

  if (role === "guest") {
    const code = u.searchParams.get("code");
    const s = db.shares[code];
    if (!s) return ws.close(4404, "invalid code");
    if (s.revokedAt) return ws.close(4403, "revoked");
    if (s.expiresAt && Date.now() > s.expiresAt) return ws.close(4401, "expired");
    ws._role = "guest"; ws._code = code;
    ws._guestId = u.searchParams.get("guestId") || ws._id;
    ws._connectionId = s.connectionId;
    ws._joined = false;
    const key = pendingKey(code, ws._guestId);
    const targets = () => owners.get(s.connectionId) ?? new Set();
    const notifyOwner = (type) => {
      for (const o of targets())
        if (o.readyState === 1)
          o.send(JSON.stringify({ type, from: ws._guestId, code }));
    };
    const join = () => {
      if (ws._joined) return;
      if (!guests.has(code)) guests.set(code, new Set());
      guests.get(code).add(ws);
      ws._joined = true;
      ws._connectedAt = Date.now();
      notifyOwner("connect");
      tlog(s.connectionId, code, ws._guestId, "event", "joined");
      const n = db.connections[s.connectionId]?.name ?? "(deleted)";
      sendNotify(`✅ ${ws._guestId} joined ${n}`);
    };
    const propose = (raw) => {
      const mine = [...proposals.values()].filter((p) => p.code === code && p.guestId === ws._guestId);
      if (mine.length >= 20) {
        try { ws.send(JSON.stringify({ type: "notice", text: "approval queue full — wait for the owner" })); } catch {}
        return;
      }
      const id = uid("p_");
      proposals.set(id, { id, code, guestId: ws._guestId, connectionId: s.connectionId, raw, at: Date.now() });
      tlog(s.connectionId, code, ws._guestId, "event", "proposal: " + raw.replace(/[\r\n]+$/, "").slice(0, 200));
      try { ws.send(JSON.stringify({ type: "notice", text: "sent to owner for approval" })); } catch {}
    };
    ws.on("message", (raw) => {
      if (!ws._joined) return; // waiting-room guests can't send anything yet
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      // Re-check revocation/expiry on every message (instant kick)
      const cur = db.shares[code];
      if (!isActive(cur)) {
        try { ws.send(JSON.stringify({ type: "revoked" })); } catch {}
        return ws.close(4403, "revoked-or-expired");
      }
      if (m.type !== "input" && m.type !== "resize" && m.type !== "connect") return;
      if (m.type === "input" && typeof m.data === "string") {
        tlog(s.connectionId, code, ws._guestId, "in", m.data);
        const mode = shareMode(cur);
        if (mode === "readonly") {
          if (!ws._roNoticed) {
            ws._roNoticed = true;
            try { ws.send(JSON.stringify({ type: "notice", text: "read-only share — input is ignored" })); } catch {}
          }
          return;
        }
        if (mode === "approve") {
          // Lone control characters (Ctrl-C etc.) pass through so guests can interrupt.
          if (m.data.length === 1 && m.data.charCodeAt(0) < 32) {
            for (const o of targets())
              if (o.readyState === 1)
                o.send(JSON.stringify({ type: m.type, from: ws._guestId, code, data: m.data, cols: m.cols, rows: m.rows }));
            return;
          }
          ws._lineBuf = (ws._lineBuf || "") + m.data;
          let nl;
          let proposed = false;
          while ((nl = ws._lineBuf.search(/[\r\n]/)) !== -1) {
            propose(ws._lineBuf.slice(0, nl + 1));
            ws._lineBuf = ws._lineBuf.slice(nl + 1);
            proposed = true;
          }
          if (!proposed && ws._lineBuf.length > 4096) {
            propose(ws._lineBuf);
            ws._lineBuf = "";
          }
          return;
        }
      }
      for (const o of targets())
        if (o.readyState === 1)
          o.send(JSON.stringify({ type: m.type, from: ws._guestId, code, data: m.data, cols: m.cols, rows: m.rows }));
    });
    ws.on("close", () => {
      guests.get(code)?.delete(ws);
      waiting.get(key)?.delete(ws);
      if (ws._joined) {
        notifyOwner("disconnect");
        tlog(s.connectionId, code, ws._guestId, "event", "left");
        const n = db.connections[s.connectionId]?.name ?? "(deleted)";
        sendNotify(`👋 ${ws._guestId} left ${n}`);
      }
    });
    const decision = db.decisions?.[code]?.[ws._guestId];
    if (decision === "denied") {
      try { ws.send(JSON.stringify({ type: "denied", reason: "denied by owner" })); } catch {}
      return ws.close(4403, "denied");
    }
    if (shareApproval(s) === "auto" || decision === "approved") {
      join();
    } else {
      ensurePending(code, ws._guestId, s.connectionId);
      if (!waiting.has(key)) waiting.set(key, new Set());
      waiting.get(key).add(ws);
      try { ws.send(JSON.stringify({ type: "waiting" })); } catch {}
      tlog(s.connectionId, code, ws._guestId, "event", "waiting for approval");
    }
    ws.send(JSON.stringify({ type: "ready", id: ws._guestId }));
    return;
  }
  ws.close(4400, "role must be owner|guest");
});

const bootPublish = loadPublishConfig();
if (bootPublish?.watch && (bootPublish.repo || bootPublish.remote)) {
  console.log(`[publish] resuming auto-push -> ${bootPublish.repo || bootPublish.remote}`);
  startPublishWatcher(bootPublish);
}
server.listen(PORT, () => console.log(`relay+api on http://localhost:${PORT}`));
