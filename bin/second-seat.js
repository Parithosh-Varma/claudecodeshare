#!/usr/bin/env node
// Global entry point (`npm i -g second-seat` -> `second-seat ...`).
// The npm prefix is read-only, so all state (data.json, sandboxes,
// transcripts) goes to ~/.second-seat unless SEAT_DATA_DIR is set.
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

process.env.SEAT_DATA_DIR ??= path.join(os.homedir(), ".second-seat");
const pkgRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const [cmd, ...rest] = argv;

async function main() {
  if (!cmd || cmd === "share") {
    process.argv = [process.argv[0], path.join(pkgRoot, "share.js"), ...rest];
    await import(pathToFileURL(path.join(pkgRoot, "share.js")).href);
    return;
  }
  if (cmd === "agent") {
    process.argv = [process.argv[0], path.join(pkgRoot, "agent.js"), ...rest];
    await import(pathToFileURL(path.join(pkgRoot, "agent.js")).href);
    return;
  }
  if (cmd === "publish") {
    process.argv = [process.argv[0], path.join(pkgRoot, "publish.js"), ...rest];
    await import(pathToFileURL(path.join(pkgRoot, "publish.js")).href);
    return;
  }
  if (cmd === "server") {
    process.argv = [process.argv[0], path.join(pkgRoot, "server.js"), ...rest];
    await import(pathToFileURL(path.join(pkgRoot, "server.js")).href);
    return;
  }
  console.log(`second-seat — share your terminal, keep your keys.
usage:
  second-seat [share] [-- name|connection-id] [--tunnel] [--port N]  serve + share (default)
  second-seat agent <connection-id>                                  run one owner agent
  second-seat publish <owner/repo> [opts]                            push sandboxes to GitHub
  second-seat server                                                 run the relay only
state lives in ${process.env.SEAT_DATA_DIR} (override with SEAT_DATA_DIR=...)`);
}
await main().catch((e) => { console.error(e.message || e); process.exit(1); });
