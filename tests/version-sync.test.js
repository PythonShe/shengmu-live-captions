import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (relative) => JSON.parse(fs.readFileSync(new URL(relative, import.meta.url), "utf8"));

test("package.json and manifest.json carry the same version", () => {
  const pkg = read("../package.json");
  const manifest = read("../extension/manifest.json");
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(pkg.version, manifest.version);
});
