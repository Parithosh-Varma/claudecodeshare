// Where Second Seat keeps its files.
// - Repo checkout (`node share.js` / `npm run share`): state lives next to the code.
// - Global install (`second-seat` bin): the npm prefix is read-only, so the bin
//   sets SEAT_DATA_DIR=~/.second-seat and all state goes there.
// DATA_FILE env still wins for data.json (the test suite uses it).
// The data root is created on import so first-run saves never fail.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PKG_ROOT = path.dirname(fileURLToPath(import.meta.url));
export const DATA_ROOT = process.env.SEAT_DATA_DIR || PKG_ROOT;
try { fs.mkdirSync(DATA_ROOT, { recursive: true }); } catch { /* read-only oddity; callers handle errors */ }

export const DATA_FILE = process.env.DATA_FILE || path.join(DATA_ROOT, "data.json");
export const TUNNEL_FILE = path.join(DATA_ROOT, ".tunnel-url");
export const TRANSCRIPTS_DIR = path.join(DATA_ROOT, "transcripts");
export const NOTIFY_FILE = path.join(DATA_ROOT, "notify.json");
export const PUBLISH_FILE = path.join(DATA_ROOT, "publish.json");
export const PUBLISH_STATUS = path.join(DATA_ROOT, "publish-status.json");
export const SANDBOX_ROOT = path.join(DATA_ROOT, "sandbox");
export const CLOUD_ROOT = path.join(DATA_ROOT, ".cloud");
export const PUBLIC_DIR = path.join(PKG_ROOT, "public");
export const sandboxOf = (cid) => path.join(SANDBOX_ROOT, cid);
