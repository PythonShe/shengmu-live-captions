import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Chrome only reports a bad path at runtime (a blank popup, a failed
// executeScript, an offscreen document that never loads), and most entry
// files are not imported by the unit tests, so resolve every reference here.

const ROOT = fileURLToPath(new URL("../extension/", import.meta.url));

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

const files = walk(ROOT);
const rel = (file) => path.relative(ROOT, file).split(path.sep).join("/");
const exists = (file) => fs.existsSync(file) && fs.statSync(file).isFile();

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'\\])\/\/.*$/gm, "$1");
}

test("manifest entry points exist", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
  const entries = [manifest.background?.service_worker, manifest.action?.default_popup];
  for (const entry of entries) {
    assert.ok(entry, "manifest entry missing");
    assert.ok(exists(path.join(ROOT, entry)), `manifest points at missing ${entry}`);
  }
});

test("html pages reference existing scripts and styles", () => {
  for (const file of files.filter((item) => item.endsWith(".html"))) {
    const html = fs.readFileSync(file, "utf8");
    for (const match of html.matchAll(/\b(?:src|href)="([^"#?:]+)"/g)) {
      const target = path.resolve(path.dirname(file), match[1]);
      assert.ok(exists(target), `${rel(file)} references missing ${match[1]}`);
    }
  }
});

test("relative module imports resolve", () => {
  for (const file of files.filter((item) => item.endsWith(".js"))) {
    const source = stripComments(fs.readFileSync(file, "utf8"));
    const pattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'](\.{1,2}\/[^"']+)["']/g;
    for (const match of source.matchAll(pattern)) {
      const target = path.resolve(path.dirname(file), match[1]);
      assert.ok(exists(target), `${rel(file)} imports missing ${match[1]}`);
    }
  }
});

test("extension-root paths passed to chrome APIs exist", () => {
  // getURL, offscreen.createDocument, scripting.executeScript and the URL
  // constants all take paths relative to the extension root, not the file.
  let checked = 0;
  for (const file of files.filter((item) => item.endsWith(".js"))) {
    const source = stripComments(fs.readFileSync(file, "utf8"));
    for (const match of source.matchAll(/["']([\w-]+(?:\/[\w.-]+)*\.(?:js|html|css))["']/g)) {
      if (match[1].startsWith(".")) continue;
      checked += 1;
      assert.ok(exists(path.join(ROOT, match[1])), `${rel(file)} uses missing ${match[1]}`);
    }
  }
  assert.ok(checked >= 5, `expected to find the root-relative paths, found ${checked}`);
});
