// npm postpack: undo materialize-public.js — put the symlink back.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pub = path.join(root, "public");
const marker = path.join(root, ".public-materialized");

if (!fs.existsSync(marker)) process.exit(0);
const { link } = JSON.parse(fs.readFileSync(marker, "utf8"));
fs.rmSync(pub, { recursive: true, force: true });
fs.symlinkSync(link, pub);
fs.rmSync(marker, { force: true });
console.log(`postpack: restored public/ -> ${link}`);
