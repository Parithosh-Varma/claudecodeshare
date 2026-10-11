// Owner-side cloud backup: syncs every sandbox (whatever Claude/opencode
// made in any shared session) into folders of ONE GitHub repo and pushes.
// Staging clone lives in .cloud/ — sandboxes themselves are never git repos.
//
// Usage:
//   node publish.js <owner/repo> | --remote <url>
//     [--connection c_...] [--branch main] [--create]
//     [--watch] [--interval 15] [--no-push] [--no-auth]
//     [--status-file path]
//
// Auth reuses `gh` (OS keyring). If not logged in, it asks for a PAT once
// and pipes it to `gh auth login --with-token` — never written to disk.
//
// WARNING: only publish with a token YOU created, to a repo YOU own. A guest
// must never paste their PAT into someone else's shared machine.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf(n);
  return i === -1 ? d : (args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : true);
};
const REPO = args.find((a) => !a.startsWith("--") && a.includes("/")) || null;
const REMOTE_ARG = flag("--remote", null);
const PREVIEW_ONLY = args.includes("--preview");
if (!REPO && !REMOTE_ARG && !PREVIEW_ONLY) {
  console.error("usage: node publish.js <owner/repo> | --remote <url> [--connection c_...] [--branch main] [--create] [--watch] [--interval 15] [--no-push] [--no-auth] [--status-file path]");
  process.exit(1);
}
const CONNECTION = flag("--connection", null);
const BRANCH = flag("--branch", "main");
const CREATE = flag("--create", false);
const WATCH = flag("--watch", false);
const INTERVAL = Number(flag("--interval", 15)) * 1000;
const NO_PUSH = flag("--no-push", false);
const NO_AUTH = flag("--no-auth", false);
const STATUS_FILE = flag("--status-file", null);

const sh = (cmd, opts = {}) => spawnSync("sh", ["-c", cmd], { stdio: "pipe", encoding: "utf8", ...opts });

// ---- auth ----
const scrubbedEnv = () => {
  const e = { ...process.env };
  delete e.GITHUB_TOKEN; delete e.GH_TOKEN;
  return e;
};
function ghStatus(env) {
  const r = spawnSync("gh", ["auth", "status"], { stdio: "pipe", encoding: "utf8", env });
  const out = (r.stdout || "") + (r.stderr || "");
  return r.status === 0 && !/Failed to log in/i.test(out);
}
let GH_ENV = process.env;
if (!NO_AUTH) {
  if (ghStatus(process.env)) GH_ENV = process.env;
  else if (ghStatus(scrubbedEnv())) { GH_ENV = scrubbedEnv(); console.log("note: ignoring stale GITHUB_TOKEN env var, using keyring login"); }
  else GH_ENV = null;
}
const gh = (a, opts = {}) => spawnSync("gh", a, { stdio: "pipe", encoding: "utf8", env: GH_ENV || process.env, ...opts });
async function promptPAT() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  process.stdout.write("GitHub personal access token (input hidden, needs 'repo' scope): ");
  try { process.stdin.setRawMode(true); } catch {}
  return new Promise((resolve) => {
    let t = "";
    process.stdin.on("data", (c) => {
      const s = c.toString();
      if (s === "\r" || s === "\n" || s === "\u0004") { try { process.stdin.setRawMode(false); } catch {} rl.close(); resolve(t.trim()); }
      else if (s === "\u0003") process.exit(1);
      else if (s !== "\u007f") t += s;
      else t = t.slice(0, -1);
    });
  }).then((t) => { console.log(); return t; });
}
const PREVIEW = args.includes("--preview");
if (!PREVIEW && !NO_AUTH && GH_ENV === null) {
  if (!process.stdin.isTTY) {
    console.error("gh is not logged in and there's no terminal for a token. Run `gh auth login` first.");
    process.exit(1);
  }
  console.log("gh is not logged in here.");
  const token = await promptPAT();
  if (!token) { console.error("no token entered"); process.exit(1); }
  const r = spawnSync("gh", ["auth", "login", "--with-token"], { input: token, stdio: ["pipe", "inherit", "inherit"], encoding: "utf8", env: scrubbedEnv() });
  GH_ENV = scrubbedEnv();
  if (r.status !== 0 || !ghStatus(GH_ENV)) { console.error("GitHub login failed"); process.exit(1); }
  console.log("logged in via gh (token kept in OS keyring, not on disk)");
}
const me = (NO_AUTH || PREVIEW) ? "claudecodeshare" : (gh(["api", "user", "-q", ".login"]).stdout.trim() || "claudecodeshare");

// ---- sandboxes to back up ----
const sandboxRoot = path.join(__dirname, "sandbox");
let sandboxes = [];
if (CONNECTION) {
  const d = path.join(sandboxRoot, CONNECTION);
  if (!fs.existsSync(d)) { console.error(`no such sandbox: ${CONNECTION}`); process.exit(1); }
  sandboxes = [{ id: CONNECTION, dir: d }];
} else {
  if (!fs.existsSync(sandboxRoot)) { console.error("no sandbox/ yet — run a session first"); process.exit(1); }
  sandboxes = fs.readdirSync(sandboxRoot)
    .map((d) => ({ id: d, dir: path.join(sandboxRoot, d) }))
    .filter((s) => fs.statSync(s.dir).isDirectory());
}
if (sandboxes.length === 0) { console.error("nothing to back up"); process.exit(1); }

// ---- staging clone (the single cloud folder) ----
const stagingName = ((REPO || REMOTE_ARG || "preview").replace(/[^A-Za-z0-9_.-]+/g, "_")).slice(0, 80);
const cloudRoot = path.join(__dirname, ".cloud");
const staging = path.join(cloudRoot, stagingName);
fs.mkdirSync(cloudRoot, { recursive: true });

function remoteUrl() {
  if (REMOTE_ARG) return REMOTE_ARG;
  return `https://github.com/${REPO}.git`;
}
function ensureStaging() {
  if (!fs.existsSync(path.join(staging, ".git"))) {
    if (REPO && CREATE) {
      console.log(`creating private github.com/${REPO} ...`);
      const r = spawnSync("gh", ["repo", "create", REPO, "--private"], { stdio: "pipe", encoding: "utf8", env: GH_ENV });
      const msg = ((r.stderr || "") + (r.stdout || "")).toLowerCase();
      if (r.status !== 0 && !/already exists/.test(msg)) {
        console.error(`could not create repo: ${msg.trim().split("\n").pop()}`);
        process.exit(1);
      }
      console.log(r.status === 0 ? "private repo created" : "repo already exists, reusing it");
    }
    fs.rmSync(staging, { recursive: true, force: true });
    const r = spawnSync("git", ["clone", remoteUrl(), staging], { stdio: "pipe", encoding: "utf8" });
    if (r.status !== 0) {
      console.error(`clone failed: ${(r.stderr || "").trim().split("\n").pop()}`);
      console.error(REPO ? "repo missing? pass --create to make it." : "");
      process.exit(1);
    }
    sh(`git config user.name "${me}"`, { cwd: staging });
    sh(`git config user.email "${me}@users.noreply.github.com"`, { cwd: staging });
    const gi = path.join(staging, ".gitignore");
    const secrets = ".env\n.env.*\n*.pem\n*.key\nnode_modules/\n.DS_Store\n";
    if (!fs.existsSync(gi)) fs.writeFileSync(gi, secrets);
    console.log(`staging ready at .cloud/${stagingName}`);
  }
}

// Human-readable, stable folder per sandbox: <name>-<shortid>
// (display names come from data.json; falls back to the raw id).
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "session";
let connNames = {};
try { connNames = JSON.parse(fs.readFileSync(path.join(__dirname, "data.json"), "utf8")).connections || {}; } catch {}
const folderFor = (id) => `${slug(connNames[id]?.name || id)}-${id.replace(/^c_/, "").slice(0, 6)}`;
for (const s of sandboxes) s.folder = folderFor(s.id);
const notGit = (src) => {
  const parts = src.split(path.sep);
  return !parts.includes(".git");
};
function writeStatus(info) {
  if (!STATUS_FILE) return;
  try { fs.writeFileSync(STATUS_FILE, JSON.stringify({ repo: REPO || REMOTE_ARG, branch: BRANCH, updatedAt: Date.now(), folders: sandboxes.map((s) => ({ id: s.id, folder: s.folder })), ...info }, null, 2)); } catch {}
}

// ---- file preview (what "Push to GitHub" would upload) ----
function walkFiles(dir, base = "", out = [], cap = 300) {
  let totalFiles = 0, totalBytes = 0;
  const rec = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const full = path.join(d, e.name), r = rel ? rel + "/" + e.name : e.name;
      if (e.isDirectory()) rec(full, r);
      else {
        totalFiles++;
        let bytes = 0;
        try { bytes = fs.statSync(full).size; } catch {}
        totalBytes += bytes;
        if (out.length < cap) out.push({ path: r, bytes });
      }
    }
  };
  try { rec(dir, base); } catch {}
  return { files: out, totalFiles, totalBytes, truncated: out.length < totalFiles };
}
function previewAll() {
  return sandboxes.map((s) => ({ id: s.id, folder: s.folder, ...walkFiles(s.dir) }));
}
if (PREVIEW) {
  console.log(JSON.stringify(previewAll()));
  process.exit(0);
}

function syncOnce() {
  ensureStaging();
  // Refresh branch (remote may have moved)
  sh(`git fetch origin ${BRANCH} 2>/dev/null`, { cwd: staging });
  for (const s of sandboxes) {
    // Same folder every push: repeat pushes update it, never duplicate it.
    const dest = path.join(staging, s.folder);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    fs.cpSync(s.dir, dest, { recursive: true, filter: notGit });
  }
  sh("git add -A", { cwd: staging });
  const dirty = sh("git status --porcelain", { cwd: staging }).stdout.trim();
  if (!dirty) { writeStatus({ ok: true, pushed: false, note: "clean" }); return true; }
  const head = sh("git rev-parse --abbrev-ref HEAD", { cwd: staging }).stdout.trim();
  const branch = head && head !== "HEAD" ? head : BRANCH;
  if (sh(`git commit -m "backup ${new Date().toISOString()}"`, { cwd: staging }).status !== 0) {
    writeStatus({ ok: false, error: "commit failed" }); return false;
  }
  if (NO_PUSH) { writeStatus({ ok: true, pushed: false, note: "no-push" }); console.log("committed locally (--no-push)"); return true; }
  const r = spawnSync("git", ["push", "-u", "origin", `HEAD:${branch}`], { cwd: staging, stdio: "pipe", encoding: "utf8" });
  if (r.status === 0) {
    console.log(`pushed ${sandboxes.length} folder(s) -> ${REPO || REMOTE_ARG}`);
    writeStatus({ ok: true, pushed: true });
    return true;
  }
  const err = (r.stderr || "").trim().split("\n").pop();
  console.error(`push failed: ${err}`);
  writeStatus({ ok: false, error: err });
  return false;
}

console.log(`backing up ${sandboxes.length} sandbox(es) -> ${REPO || REMOTE_ARG}${WATCH ? ` (auto, every ${INTERVAL / 1000}s)` : ""}`);
if (!WATCH) process.exit(syncOnce() ? 0 : 1);
syncOnce();
setInterval(() => { try { syncOnce(); } catch (e) { console.error(e.message); } }, INTERVAL);
console.log("watching (Ctrl-C to stop) ...");
setInterval(() => {}, 1 << 30);
