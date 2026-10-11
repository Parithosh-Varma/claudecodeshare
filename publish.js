// Owner-side publisher: pushes whatever lands in a sandbox (e.g. files
// Claude/opencode created during a shared session) straight to GitHub.
// Auth reuses `gh` (OS keyring). If not logged in, it asks for a PAT once
// and pipes it to `gh auth login --with-token` — the token is never
// written to disk by this script.
//
// Usage:
//   npm run publish -- <owner/repo> [--connection c_...] [--branch main]
//                     [--create] [--watch] [--interval 15] [--no-push]
//
// WARNING: only publish to repos YOU own with a token YOU created. A guest
// should never paste their PAT into someone else's shared machine — the
// owner sees all input. Owner pushes to owner's repo, then transfers.
import { spawnSync, spawn } from "node:child_process";
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
const REPO = args.find((a) => !a.startsWith("--") && a.includes("/"));
if (!REPO) {
  console.error("usage: npm run publish -- <owner/repo> [--connection c_...] [--branch main] [--create] [--watch] [--interval 15] [--no-push]");
  process.exit(1);
}
const CONNECTION = flag("--connection", null);
const BRANCH = flag("--branch", "main");
const CREATE = flag("--create", false);
const WATCH = flag("--watch", false);
const INTERVAL = Number(flag("--interval", 15)) * 1000;
const NO_PUSH = flag("--no-push", false);

const sh = (cmd, opts = {}) => spawnSync("sh", ["-c", cmd], { stdio: "pipe", encoding: "utf8", ...opts });

// ---- auth: gh keyring first, PAT prompt only as fallback ----
const scrubbedEnv = () => {
  const e = { ...process.env };
  delete e.GITHUB_TOKEN; delete e.GH_TOKEN; // stale env tokens break gh
  return e;
};
function ghStatus(env) {
  const r = spawnSync("gh", ["auth", "status"], { stdio: "pipe", encoding: "utf8", env });
  const out = (r.stdout || "") + (r.stderr || "");
  return r.status === 0 && !/Failed to log in/i.test(out);
}
const gh = (args, opts = {}) => spawnSync("gh", args, { stdio: "pipe", encoding: "utf8", env: GH_ENV, ...opts });
let GH_ENV = process.env;
if (ghStatus(process.env)) GH_ENV = process.env;
else if (ghStatus(scrubbedEnv())) { GH_ENV = scrubbedEnv(); console.log("note: ignoring stale GITHUB_TOKEN env var, using keyring login"); }
else GH_ENV = null;
function ghAuthed() { return GH_ENV !== null; }
async function promptPAT() {
  // No-echo read so the token never shows on screen.
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  process.stdout.write("GitHub personal access token (input hidden, needs 'repo' scope): ");
  try { process.stdin.setRawMode(true); } catch {}
  const token = await new Promise((resolve) => {
    let t = "";
    process.stdin.on("data", (c) => {
      const s = c.toString();
      if (s === "\r" || s === "\n" || s === "\u0004") { try { process.stdin.setRawMode(false); } catch {} rl.close(); resolve(t); }
      else if (s === "\u0003") { process.exit(1); }
      else if (s === "\u007f") { t = t.slice(0, -1); }
      else { t += s; }
    });
  });
  console.log();
  return token.trim();
}
if (!ghAuthed()) {
  if (!process.stdin.isTTY) {
    console.error("gh is not logged in and there's no terminal to enter a token.");
    console.error("Fix: run `gh auth login` once in your terminal, or set a valid GITHUB_TOKEN.");
    process.exit(1);
  }
  console.log("gh is not logged in here.");
  const token = await promptPAT();
  if (!token) { console.error("no token entered"); process.exit(1); }
  const r = spawnSync("gh", ["auth", "login", "--with-token"], { input: token, stdio: ["pipe", "inherit", "inherit"], encoding: "utf8", env: scrubbedEnv() });
  GH_ENV = scrubbedEnv();
  if (r.status !== 0 || !ghAuthed()) { console.error("GitHub login failed"); process.exit(1); }
  console.log("logged in via gh (token kept in OS keyring, not on disk)");
}

// ---- targets: one sandbox or all ----
const sandboxRoot = path.join(__dirname, "sandbox");
let dirs = [];
if (CONNECTION) {
  dirs = [path.join(sandboxRoot, CONNECTION)];
} else {
  if (!fs.existsSync(sandboxRoot)) { console.error("no sandbox/ yet — run a session first"); process.exit(1); }
  dirs = fs.readdirSync(sandboxRoot).map((d) => path.join(sandboxRoot, d))
    .filter((d) => fs.statSync(d).isDirectory());
}
if (dirs.length === 0) { console.error("nothing to publish"); process.exit(1); }
for (const d of dirs) {
  if (!fs.existsSync(d)) { console.error(`no such sandbox: ${d}`); process.exit(1); }
}

// ---- git identity from gh (local to each repo, nothing global) ----
const me = gh(["api", "user", "-q", ".login"]).stdout.trim() || "claudecodeshare";

function ensureRepo(dir) {
  if (!fs.existsSync(path.join(dir, ".git"))) {
    sh(`git init -b ${BRANCH}`, { cwd: dir });
    sh(`git config user.name "${me}"`, { cwd: dir });
    sh(`git config user.email "${me}@users.noreply.github.com"`, { cwd: dir });
    // Don't publish secrets by accident.
    const gi = path.join(dir, ".gitignore");
    if (!fs.existsSync(gi)) fs.writeFileSync(gi, ".env\n.env.*\n*.pem\n*.key\nnode_modules/\n");
    console.log(`[${path.basename(dir)}] git init`);
  }
  const remotes = sh("git remote", { cwd: dir }).stdout.trim().split("\n");
  if (!remotes.includes("origin")) {
    if (CREATE) {
      console.log(`creating github.com/${REPO} ...`);
      const r = spawnSync("gh", ["repo", "create", REPO, "--public", "--source", dir, "--push"], { stdio: "inherit", env: GH_ENV });
      if (r.status !== 0) process.exit(1);
      return true;
    }
    sh(`git remote add origin https://github.com/${REPO}.git`, { cwd: dir });
  }
  return false;
}

function publishOnce(dir) {
  const tag = path.basename(dir);
  const created = ensureRepo(dir);
  if (created) return true; // --push already handled it
  sh("git add -A", { cwd: dir });
  const status = sh("git status --porcelain", { cwd: dir }).stdout.trim();
  if (!status) return true; // clean — nothing to do, not a failure
  const msg = `checkpoint ${new Date().toISOString()} (${tag})`;
  if (sh(`git commit -m "${msg}"`, { cwd: dir }).status !== 0) return false;
  console.log(`[${tag}] committed: ${msg}`);
  if (NO_PUSH) { console.log(`[${tag}] --no-push, skipping push`); return true; }
  const head = sh("git rev-parse --abbrev-ref HEAD", { cwd: dir }).stdout.trim() || BRANCH;
  const r = spawnSync("git", ["push", "-u", "origin", `HEAD:${head === "HEAD" ? BRANCH : head}`], { cwd: dir, stdio: "inherit" });
  if (r.status === 0) console.log(`[${tag}] pushed to github.com/${REPO}`);
  else console.error(`[${tag}] push failed (repo exists? try --create for a new repo)`);
  return r.status === 0;
}

console.log(`publishing ${dirs.length} sandbox(es) -> github.com/${REPO}${WATCH ? ` (watch every ${INTERVAL / 1000}s)` : ""}`);
if (!WATCH) {
  let ok = true;
  for (const d of dirs) ok = publishOnce(d) && ok;
  process.exit(ok ? 0 : 1);
}
// Watch mode: poll for changes, commit+push whatever Claude just made.
const lastCommit = new Map();
setInterval(() => {
  for (const d of dirs) {
    try {
      const status = sh("git status --porcelain", { cwd: d }).stdout.trim();
      if (status && status !== lastCommit.get(d)) {
        lastCommit.set(d, status);
        publishOnce(d);
      }
    } catch (e) { console.error(`[${path.basename(d)}] ${e.message}`); }
  }
}, INTERVAL);
console.log("watching (Ctrl-C to stop) ...");
for (const d of dirs) publishOnce(d);
setInterval(() => {}, 1 << 30); // keep alive
