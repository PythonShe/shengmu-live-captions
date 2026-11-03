import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { DISPLAY_MODES, normalizeSettings } from "../extension/lib/caption-utils.js";
import {
  DISPLAY_MODE_LABELS,
  DISPLAY_MODE_ORDER,
  DISPLAY_MODE_SHORT_LABELS,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  capturePresentation,
  clampFontSize,
  formatBytes,
  formatDuration,
  formatElapsed,
  nextDisplayMode,
  overlayStatusLabel
} from "../extension/lib/ui-model.js";
import { zh } from "./helpers/i18n.js";

const overlaySource = readFileSync(
  new URL("../extension/content/content-overlay.js", import.meta.url),
  "utf8"
);

// The overlay is an injected classic script, so its copies are read from the
// source text and evaluated in isolation.
function overlayFunction(name, argName) {
  const match = overlaySource.match(
    new RegExp(`function ${name}\\(\\) \\{[\\s\\S]*?\\n  \\}\\n`)
  );
  assert.ok(match, `${name} not found in content-overlay.js`);
  return new Function(argName, `${match[0]}\nreturn ${name}();`);
}

test("display modes cover exactly the settings vocabulary", () => {
  const expected = [...DISPLAY_MODES].sort();
  assert.deepEqual([...DISPLAY_MODE_ORDER].sort(), expected);
  assert.deepEqual(Object.keys(DISPLAY_MODE_LABELS).sort(), expected);
  assert.deepEqual(Object.keys(DISPLAY_MODE_SHORT_LABELS).sort(), expected);
});

test("nextDisplayMode cycles and wraps", () => {
  let mode = DISPLAY_MODE_ORDER[0];
  const seen = [];
  for (let i = 0; i < DISPLAY_MODE_ORDER.length; i += 1) {
    mode = nextDisplayMode(mode);
    seen.push(mode);
  }
  assert.equal(mode, DISPLAY_MODE_ORDER[0]);
  assert.equal(new Set(seen).size, DISPLAY_MODE_ORDER.length);
});

test("font size bounds match normalizeSettings", () => {
  assert.equal(clampFontSize(5), FONT_SIZE_MIN);
  assert.equal(clampFontSize(500), FONT_SIZE_MAX);
  assert.equal(clampFontSize(40), 40);
  assert.equal(normalizeSettings({ fontSize: 1 }).fontSize, FONT_SIZE_MIN);
  assert.equal(normalizeSettings({ fontSize: 999 }).fontSize, FONT_SIZE_MAX);
});

test("capturePresentation words each state once", () => {
  assert.equal(capturePresentation(null, zh).label, "准备就绪");
  const stopped = { active: false, status: "incomplete", detail: "3 条缺译" };
  assert.equal(capturePresentation(stopped, zh).label, "已停止，存在缺译");
  assert.equal(capturePresentation(stopped, zh).summary, "3 条缺译");
  assert.equal(capturePresentation(stopped, zh).dotClass, "warning");

  const live = { active: true, status: "capturing", wsConnected: true };
  assert.equal(capturePresentation(live, zh).label, "实时翻译中");
  assert.equal(capturePresentation(live, zh).dotClass, "live");
  assert.equal(
    capturePresentation({ ...live, wsConnected: false }, zh).label,
    "等待字幕服务"
  );
  assert.equal(
    capturePresentation({ active: true, status: "reconnecting" }, zh).detail,
    "正在自动重连"
  );
  assert.equal(
    capturePresentation({ active: true, status: "error", detail: "boom" }, zh).summary,
    "boom"
  );
  assert.equal(
    capturePresentation({
      active: true,
      status: "capturing",
      audio: { deliveredRatio: 0.987 }
    }, zh).ratio,
    "音频 99%"
  );
});

test("the overlay status chip matches overlayStatusLabel for every state", () => {
  const states = [
    null,
    { active: false },
    { active: false, status: "incomplete" },
    { active: false, status: "error" },
    { active: true, status: "starting" },
    { active: true, status: "reconnecting" },
    { active: true, status: "error" },
    { active: true, status: "capturing", wsConnected: true },
    { active: true, status: "capturing", wsConnected: false }
  ];
  const run = overlayFunction("statusLabel", "runtimeState");
  for (const state of states) {
    assert.equal(run(state), overlayStatusLabel(state), JSON.stringify(state));
  }
});

test("the overlay mode button labels, cycle and font bounds match ui-model", () => {
  const run = overlayFunction("currentModeLabel", "settings");
  for (const mode of DISPLAY_MODE_ORDER) {
    assert.equal(run({ displayMode: mode }), DISPLAY_MODE_SHORT_LABELS[mode]);
  }
  const modes = overlaySource.match(/const MODES = (\[[^\]]*\]);/);
  assert.ok(modes, "MODES not found in content-overlay.js");
  assert.deepEqual(JSON.parse(modes[1]), DISPLAY_MODE_ORDER);
  assert.ok(
    overlaySource.includes(`Math.max(${FONT_SIZE_MIN}, Math.min(${FONT_SIZE_MAX},`),
    "overlay font clamp drifted from ui-model"
  );
});

test("formatters", () => {
  assert.equal(formatBytes(0), "0 KB");
  assert.equal(formatBytes(5 * 1024 ** 2), "5 MB");
  assert.equal(formatBytes(1.5 * 1024 ** 3), "1.50 GB");
  assert.equal(formatDuration(45_000, zh), "45 秒");
  assert.equal(formatDuration(125_000, zh), "2 分 5 秒");
  assert.equal(formatDuration(3_900_000, zh), "1 小时 5 分");
  assert.equal(formatElapsed(0), "");
  assert.equal(formatElapsed(1_000, 66_000), "01:05");
  assert.equal(formatElapsed(1, 3_725_001), "1:02:05");
});
