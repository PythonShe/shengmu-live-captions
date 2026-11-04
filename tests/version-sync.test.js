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

// An already injected page keeps the overlay instance whose version matches, so
// a behaviour change without a bump silently keeps running the old build. The
// extension version is not enough on its own: the overlay version tracks the
// injected DOM/CSS rather than the release.
test("the content overlay declares a numeric OVERLAY_VERSION", () => {
  const source = fs.readFileSync(
    new URL("../extension/content/content-overlay.js", import.meta.url),
    "utf8"
  );
  const match = source.match(/const OVERLAY_VERSION = (\d+);/);
  assert.ok(match, "OVERLAY_VERSION must stay a plain integer literal");
  assert.ok(
    Number(match[1]) >= 10,
    "bump OVERLAY_VERSION whenever the injected overlay changes behaviour"
  );
});
