import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8787;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "data.json");

const EXPIRY = { "1d": 86400_000, "7d": 7 * 86400_000, "30d": 30 * 86400_000, "forever": null };

// ---- store ----
let db = { connections: {}, shares: {} };
try {
  if (fs.existsSync(DATA_FILE)) db = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
} catch { /* fresh */ }
const save = () => fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));

const isActive = (s) => {
  if (!s || s.revokedAt) return false;
  if (s.expiresAt && Date.now() > s.expiresAt) return false;
  return true;
};
const shareCode = () => crypto.randomBytes(9).toString("base64url");
const uid = (p = "") => p + crypto.randomBytes(6).toString("hex");

// ---- http ----
const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.end();

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
      db.shares[code] = { code, connectionId: conn.id, createdAt: Date.now(), expiresAt, revokedAt: null, claims: 0 };
      save();
      const host = req.headers.host;
      return json(200, { code, link: `http://${host}/?connect=${code}`, expiresAt });
    }
    // "Connections I shared" management page data
    if (req.method === "GET" && u.pathname === "/api/shares") {
      const list = Object.values(db.shares).map((s) => ({
        ...s,
        active: isActive(s),
        connectionName: db.connections[s.connectionId]?.name ?? "(deleted)",
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
      return json(200, { connectionId: s.connectionId, connectionName: c?.name, expiresAt: s.expiresAt, ownerOnline: (owners.get(s.connectionId)?.size ?? 0) > 0 });
    }
    // Cloud backup status (repo config + last sync + suggested private repo)
    if (req.method === "GET" && u.pathname === "/api/publish") {
      const login = ghLogin();
      return json(200, { config: loadPublishConfig(), status: loadPublishStatus(), watching: !!publishWatcher, suggestedRepo: login ? `${login}/claude-session` : null });
    }
    // Cloud backup preview: folder -> files that "Push to GitHub" would upload.
    if (req.method === "POST" && u.pathname === "/api/publish/preview") {
      const b = await body();
      const argv = ["publish.js", "--preview", "--no-auth"];
      if (b.connection) argv.push("--connection", b.connection);
      const r = spawnSync(process.execPath, argv, { cwd: __dirname, encoding: "utf8" });
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
      const argv = ["publish.js", ...target, "--branch", cfg.branch, ...(b.create ? ["--create"] : []), "--status-file", PUBLISH_STATUS];
      const r = spawnSync(process.execPath, argv, { cwd: __dirname, encoding: "utf8" });
      const output = ((r.stdout || "") + (r.stderr || "")).trim().slice(-2000);
      return json(200, { ok: r.status === 0, output });
    }
    // Static frontend
    let f = u.pathname === "/" ? "/index.html" : u.pathname;
    const fp = path.join(__dirname, "public", path.normalize(f).replace(/^\/+/, ""));
    if (req.method === "GET" && fs.existsSync(fp) && fs.statSync(fp).isFile()) {
      const ext = path.extname(fp);
      const ctype = ext === ".html" ? "text/html"
        : ext === ".js" ? "application/javascript"
        : ext === ".css" ? "text/css"
        : ext === ".json" ? "application/json" : "text/plain";
      res.writeHead(200, { "Content-Type": ctype });
      return res.end(fs.readFileSync(fp));
    }
    return json(404, { error: "not found" });
  })().catch((e) => json(500, { error: String(e) }));
});

// ---- relay ----
const wss = new WebSocketServer({ server, path: "/relay" });
const owners = new Map(); // connectionId -> Set<ws>
const guests = new Map(); // code -> Set<ws>

// ---- cloud backup watcher (auto-pushes new sandbox files) ----
const PUBLISH_FILE = path.join(__dirname, "publish.json");
const PUBLISH_STATUS = path.join(__dirname, "publish-status.json");
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
  const argv = ["publish.js", ...target, "--branch", cfg.branch || "main", "--watch", "--interval", "30", "--status-file", PUBLISH_STATUS];
  publishWatcher = spawn(process.execPath, argv, { cwd: __dirname, stdio: ["ignore", "pipe", "pipe"] });
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
          if (g._guestId === m.to && g._connectionId === cid && g.readyState === 1)
            g.send(JSON.stringify({ type: m.type, data: m.data }));
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
    if (!guests.has(code)) guests.set(code, new Set());
    guests.get(code).add(ws);
    const targets = () => owners.get(s.connectionId) ?? new Set();
    ws.on("message", (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      // Re-check revocation/expiry on every message (instant kick)
      const cur = db.shares[code];
      if (!isActive(cur)) {
        try { ws.send(JSON.stringify({ type: "revoked" })); } catch {}
        return ws.close(4403, "revoked-or-expired");
      }
      if (m.type !== "input" && m.type !== "resize" && m.type !== "connect") return;
      for (const o of targets())
        if (o.readyState === 1)
          o.send(JSON.stringify({ type: m.type, from: ws._guestId, code, data: m.data, cols: m.cols, rows: m.rows }));
    });
    const notifyOwner = (type) => {
      for (const o of targets())
        if (o.readyState === 1)
          o.send(JSON.stringify({ type, from: ws._guestId, code }));
    };
    ws.on("close", () => { guests.get(code)?.delete(ws); notifyOwner("disconnect"); });
    notifyOwner("connect");
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
