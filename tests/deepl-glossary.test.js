import assert from "node:assert/strict";
import test from "node:test";

import {
  DEEPL_GLOSSARY_MAX_TERM_BYTES,
  buildDeepLGlossaryPairs,
  deepLGlossaryFingerprint,
  serializeDeepLGlossaryTsv
} from "../extension/lib/deepl-glossary.js";

test("DeepL pairs expand aliases and add the lowercase spelling", () => {
  const pairs = buildDeepLGlossaryPairs([
    { sources: ["Spirit", "Spirits"], target: "精魂" },
    { sources: ["Orb of Augmentation"], target: "增幅之球" }
  ]);
  assert.deepEqual(pairs, [
    { source: "Spirit", target: "精魂" },
    // DeepL matches case-sensitively, so a sentence-initial lowercase ASR
    // output would otherwise miss the entry.
    { source: "spirit", target: "精魂" },
    { source: "Spirits", target: "精魂" },
    { source: "spirits", target: "精魂" },
    { source: "Orb of Augmentation", target: "增幅之球" },
    { source: "orb of augmentation", target: "增幅之球" }
  ]);

  const withoutVariants = buildDeepLGlossaryPairs(
    [{ sources: ["Spirit"], target: "精魂" }],
    { lowercaseVariants: false }
  );
  assert.deepEqual(withoutVariants, [{ source: "Spirit", target: "精魂" }]);
});

test("DeepL pairs drop anything that cannot be matched or serialised", () => {
  const long = "x".repeat(DEEPL_GLOSSARY_MAX_TERM_BYTES + 1);
  const pairs = buildDeepLGlossaryPairs([
    { sources: ["流放之路"], target: "流放之路" }, // no ASCII: the ASR is English
    { sources: ["Bad\tTab"], target: "坏" }, // TSV delimiter
    { sources: [long], target: "长" },
    { sources: ["NoTarget"], target: "   " },
    { sources: ["Kept"], target: "保留" }
  ]);
  assert.deepEqual(pairs, [
    { source: "Kept", target: "保留" },
    { source: "kept", target: "保留" }
  ]);
  assert.equal(serializeDeepLGlossaryTsv(pairs), "Kept\t保留\nkept\t保留");
});

test("the first spelling wins so custom terms beat presets", () => {
  // resolveEffectiveGlossary puts custom entries in front; a later duplicate
  // spelling must not overwrite the user's own target.
  const pairs = buildDeepLGlossaryPairs([
    { sources: ["Spirit"], target: "灵魂" },
    { sources: ["Spirit"], target: "精魂" }
  ]);
  assert.deepEqual(pairs, [
    { source: "Spirit", target: "灵魂" },
    { source: "spirit", target: "灵魂" }
  ]);
});

test("the fingerprint is order independent and changes with the content", () => {
  const a = buildDeepLGlossaryPairs([{ sources: ["Spirit"], target: "精魂" }]);
  const b = buildDeepLGlossaryPairs([
    { sources: ["spirit"], target: "精魂" },
    { sources: ["Spirit"], target: "精魂" }
  ]);
  assert.equal(deepLGlossaryFingerprint(a), deepLGlossaryFingerprint([...b].reverse()));

  const changed = buildDeepLGlossaryPairs([{ sources: ["Spirit"], target: "灵魂" }]);
  assert.notEqual(deepLGlossaryFingerprint(a), deepLGlossaryFingerprint(changed));
  assert.match(deepLGlossaryFingerprint(a), /^2-[0-9a-f]{8}$/);
});
