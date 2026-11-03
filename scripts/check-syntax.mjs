// Runs `node --check` over every script, on any OS. Most extension entry files
// are never imported by the unit tests, so this is their only parse check.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIRS = ["extension", "scripts", "tests", "paseo"];

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : walk(full);
    return /\.(?:js|mjs)$/.test(entry.name) ? [full] : [];
  });
}

const files = DIRS.flatMap((dir) => walk(path.join(ROOT, dir)));
const failures = files.filter((file) => {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) process.stderr.write(result.stderr);
  return result.status !== 0;
});

console.log(`node --check: ${files.length - failures.length}/${files.length} files ok`);
process.exit(failures.length ? 1 : 0);
