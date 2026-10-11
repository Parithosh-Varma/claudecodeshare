// npm prepack: the dashboard's canonical home is the sibling frontend repo
// (public/ is a symlink there). npm cannot pack symlinks, so materialize it
// into a real public/ directory for the tarball. postpack restores the link.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pub = path.join(root, "public");
const marker = path.join(root, ".public-materialized");

const st = fs.lstatSync(pub);
if (!st.isSymbolicLink()) {
  console.log("prepack: public/ is already a real directory, nothing to do");
  process.exit(0);
}
const target = fs.readlinkSync(pub);
const abs = path.resolve(root, target);
if (!fs.existsSync(path.join(abs, "index.html"))) {
  console.error(`prepack: frontend checkout missing at ${abs} — cannot pack dashboard`);
  process.exit(1);
}
fs.writeFileSync(marker, JSON.stringify({ link: target }));
fs.rmSync(pub, { recursive: true, force: true });
fs.mkdirSync(pub, { recursive: true });
fs.cpSync(abs, pub, { recursive: true });
console.log(`prepack: materialized ${target} -> public/`);
