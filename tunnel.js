// Cloudflare quick tunnel (https://*.trycloudflare.com): no account,
// no domain, $0. Gives the relay a public URL so guests outside your
// network can reach it. The URL changes on every restart — share links
// created while it's up embed it automatically (see server publicBase).
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { TUNNEL_FILE } from "./paths.js";
export { TUNNEL_FILE };
const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

export function cloudflaredAvailable() {
  try {
    const r = spawnSync("cloudflared", ["--version"], { stdio: "pipe" });
    return r.status === 0;
  } catch { return false; }
}

export function startTunnel(port, { timeout = 45000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!cloudflaredAvailable()) {
      return reject(new Error("cloudflared not found — install it (brew install cloudflared) or run without --tunnel on LAN"));
    }
    const child = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${port}`, "--no-autoupdate"], { stdio: ["ignore", "pipe", "pipe"] });
    let done = false;
    const fail = (msg) => {
      if (done) return; done = true;
      try { child.kill(); } catch {}
      try { fs.rmSync(TUNNEL_FILE, { force: true }); } catch {}
      reject(new Error(msg));
    };
    const timer = setTimeout(() => fail("timed out waiting for tunnel URL (no internet?)"), timeout);
    const onData = (d) => {
      const m = String(d).match(URL_RE);
      if (m && !done) {
        done = true; clearTimeout(timer);
        try { fs.writeFileSync(TUNNEL_FILE, m[0] + "\n"); } catch {}
        resolve({ url: m[0], child });
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => fail(`cloudflared exited (${code}) before publishing a URL`));
    child.on("error", (e) => fail(`could not start cloudflared: ${e.message}`));
  });
}

export function stopTunnel(child) {
  try { child?.kill(); } catch {}
  try { fs.rmSync(TUNNEL_FILE, { force: true }); } catch {}
}
