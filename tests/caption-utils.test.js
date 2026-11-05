import assert from "node:assert/strict";
import test from "node:test";

import {
  EMPTY_RUNTIME_STATE,
  MAX_GLOSSARY_DOMAIN_HINT_CHARS,
  OVERLAY_UNAVAILABLE_DETAIL,
  applyOverlayFailure,
  buildSrt,
  isNoiseTranscript,
  lineNeedsTranslation,
  mergeCaptionLines,
  migrateLegacySettings,
  normalizeCaptionLines,
  normalizeSettings,
  composeLiveSource,
  composeLiveSourceParts,
  composeLiveSourceText,
  planTranscriptDiff,
  reconcileLineTranslations,
  sanitizeSettingsPatch,
  shouldRetranslateLine,
  selectDisplayCaption,
  settingsForBroadcast,
  settingsForCaptions,
  shiftTimecode,
  transcriptDuration
} from "../extension/lib/caption-utils.js";
import { MAX_CUSTOM_GLOSSARY_CHARS } from "../extension/lib/glossary.js";

test("a fresh install needs no setup: Chrome speech and the built-in translator", () => {
  const settings = normalizeSettings({});
  assert.equal(settings.asrBackend, "chrome");
  assert.equal(settings.translationMode, "api");
  assert.equal(settings.translationProvider, "chrome");
  assert.equal(settings.translationModel, "builtin");
  assert.equal(settings.translationBaseUrl, "");
  assert.equal(settings.translationTranslatePartial, true);
  assert.deepEqual(settings.translationApiKeys, {
    chrome: "",
    deepseek: "",
    openai: "",
    bailian: "",
    custom: "",
    deepl: ""
  });
});

test("an existing install keeps WhisperLiveKit and DeepSeek after the upgrade", () => {
  const migrated = migrateLegacySettings({
    translationMode: "api",
    translationApiKeys: { deepseek: "dk" },
    fontSize: 30
  });
  assert.equal(migrated.asrBackend, "wlk");
  assert.equal(migrated.translationProvider, "deepseek");
  // The stored model is normalised to the preset's fixed flash id.
  assert.equal(migrated.translationModel, "deepseek-flash");
  assert.equal(migrated.translationBaseUrl, "https://api.deepseek.com/v1");
  assert.equal(migrated.translationApiKeys.deepseek, "dk");
  assert.equal(migrateLegacySettings({}).asrBackend, "chrome");
  assert.equal(migrateLegacySettings(undefined).translationProvider, "chrome");
});

test("server translation needs WhisperLiveKit; other backends fall back to api mode", () => {
  assert.equal(normalizeSettings({ asrBackend: "wlk", translationMode: "server" }).translationMode, "server");
  assert.equal(normalizeSettings({ asrBackend: "chrome", translationMode: "server" }).translationMode, "api");
  assert.equal(normalizeSettings({ asrBackend: "nope" }).asrBackend, "chrome");
  assert.equal(normalizeSettings({ bailianRegion: "intl" }).bailianRegion, "intl");
  assert.equal(normalizeSettings({ bailianRegion: "moon" }).bailianRegion, "cn");
});

test("local model selection defaults to 9B/large-v3-turbo and rejects unknown ids", () => {
  const defaults = normalizeSettings({});
  assert.equal(defaults.localTranslationModel, "9b-q4km");
  assert.equal(defaults.localAsrModel, "large-v3-turbo");

  const picked = normalizeSettings({
    localTranslationModel: "2b-iq4xs",
    localAsrModel: "medium"
  });
  assert.equal(picked.localTranslationModel, "2b-iq4xs");
  assert.equal(picked.localAsrModel, "medium");

  const invalid = normalizeSettings({
    localTranslationModel: "../../evil.gguf",
    localAsrModel: "whisper-huge"
  });
  assert.equal(invalid.localTranslationModel, "9b-q4km");
  assert.equal(invalid.localAsrModel, "large-v3-turbo");

  // The popup reads settings back through the broadcast helper.
  assert.equal(
    settingsForBroadcast({ localTranslationModel: "2b-iq4xs" })
      .localTranslationModel,
    "2b-iq4xs"
  );
});

test("display mode keeps the dual-line translation option", () => {
  assert.equal(normalizeSettings({ displayMode: "dual" }).displayMode, "dual");
  assert.equal(
    normalizeSettings({ displayMode: "klingon" }).displayMode,
    "bilingual"
  );
  assert.equal(
    settingsForBroadcast({ displayMode: "dual" }).displayMode,
    "dual"
  );
});

test("planTranscriptDiff appends, slides the window, and rebuilds otherwise", () => {
  assert.deepEqual(planTranscriptDiff(["a", "b"], ["a", "b", "c"]), {
    rebuild: false,
    drop: 0
  });
  assert.deepEqual(planTranscriptDiff(["a", "b", "c"], ["b", "c", "d"]), {
    rebuild: false,
    drop: 1
  });
  assert.deepEqual(planTranscriptDiff(["a", "b", "c"], ["a", "b", "c"]), {
    rebuild: false,
    drop: 0
  });
  assert.deepEqual(planTranscriptDiff([], ["a"]), {
    rebuild: false,
    drop: 0
  });
  assert.deepEqual(planTranscriptDiff(["a", "b"], ["x", "y"]), {
    rebuild: true,
    drop: 0
  });
  assert.deepEqual(planTranscriptDiff(["a", "b", "c"], ["a"]), {
    rebuild: true,
    drop: 0
  });
  assert.deepEqual(planTranscriptDiff(["a", "b", "c"], ["b", "x", "c"]), {
    rebuild: true,
    drop: 0
  });
});

test("content scripts cannot redirect translation settings or overwrite keys", () => {
  const patch = {
    displayMode: "chinese",
    fontSize: 40,
    translationMode: "api",
    translationBaseUrl: "https://attacker.example/v1",
    translationApiKeys: { deepseek: "stolen" }
  };
  assert.deepEqual(sanitizeSettingsPatch(patch), {
    displayMode: "chinese",
    fontSize: 40
  });
  assert.deepEqual(
    sanitizeSettingsPatch(patch, { fromExtensionPage: true }),
    patch
  );
});

test("glossary settings stay inside `settings` and reject unknown presets", () => {
  const defaults = normalizeSettings({});
  assert.equal(defaults.glossaryEnabled, true);
  assert.deepEqual(defaults.glossaryPresetIds, []);
  assert.equal(defaults.glossaryDomainHint, "");
  assert.equal(defaults.customGlossary, "");

  const picked = normalizeSettings({
    glossaryEnabled: false,
    glossaryPresetIds: ["poe", "poe", "../../evil", 42],
    glossaryDomainHint: "  Path of Exile\n(流放之路)  ",
    customGlossary: "Spirit -> 精魂"
  });
  assert.equal(picked.glossaryEnabled, false);
  assert.deepEqual(picked.glossaryPresetIds, ["poe"]);
  assert.equal(picked.glossaryDomainHint, "Path of Exile (流放之路)");
  assert.equal(picked.customGlossary, "Spirit -> 精魂");

  // Only `glossaryEnabled: false` disables it; anything else is "on".
  assert.equal(normalizeSettings({ glossaryEnabled: undefined }).glossaryEnabled, true);
  assert.equal(normalizeSettings({ glossaryEnabled: 0 }).glossaryEnabled, true);
});

test("custom glossary text and the domain hint are clipped to their budgets", () => {
  const long = "x".repeat(MAX_CUSTOM_GLOSSARY_CHARS + 500);
  assert.equal(
    normalizeSettings({ customGlossary: long }).customGlossary.length,
    MAX_CUSTOM_GLOSSARY_CHARS
  );
  assert.equal(
    normalizeSettings({ glossaryDomainHint: "y".repeat(400) }).glossaryDomainHint
      .length,
    MAX_GLOSSARY_DOMAIN_HINT_CHARS
  );
});

test("content scripts cannot write glossary settings", () => {
  const patch = {
    displayMode: "bilingual",
    glossaryEnabled: false,
    customGlossary: "Spirit -> 精魂",
    glossaryDomainHint: "Path of Exile"
  };
  assert.deepEqual(sanitizeSettingsPatch(patch), { displayMode: "bilingual" });
  assert.deepEqual(
    sanitizeSettingsPatch(patch, { fromExtensionPage: true }),
    patch
  );
});

test("settingsForBroadcast keeps glossary settings so the popup can render them", () => {
  const publicSettings = settingsForBroadcast({
    glossaryPresetIds: ["poe"],
    glossaryDomainHint: "Path of Exile",
    customGlossary: "Spirit -> 精魂"
  });
  assert.deepEqual(publicSettings.glossaryPresetIds, ["poe"]);
  assert.equal(publicSettings.glossaryDomainHint, "Path of Exile");
  assert.equal(publicSettings.customGlossary, "Spirit -> 精魂");
});

test("page-side captions never receive the full custom glossary text", () => {
  const settings = {
    glossaryEnabled: false,
    glossaryPresetIds: ["poe"],
    glossaryDomainHint: "Path of Exile",
    customGlossary: "Spirit -> 精魂"
  };
  const forCaptions = settingsForCaptions(settings);
  assert.equal("customGlossary" in forCaptions, false);
  assert.equal(forCaptions.glossaryEnabled, false);
  assert.deepEqual(forCaptions.glossaryPresetIds, ["poe"]);
  assert.equal(forCaptions.glossaryDomainHint, "Path of Exile");
  // Extension pages still get the whole value.
  assert.equal(settingsForBroadcast(settings).customGlossary, "Spirit -> 精魂");
});

test("legacy settings migrate to server mode without changing fresh defaults", () => {
  assert.equal(
    migrateLegacySettings({ wsUrl: "ws://127.0.0.1:8010/asr" }).translationMode,
    "server"
  );
  assert.equal(migrateLegacySettings({}).translationMode, "api");
  assert.equal(
    migrateLegacySettings({ translationMode: "api" }).translationMode,
    "api"
  );
});

test("settingsForBroadcast never exposes API keys", () => {
  const publicSettings = settingsForBroadcast({
    translationProvider: "deepseek",
    translationApiKeys: { deepseek: "secret-key", openai: "other-key" }
  });
  assert.equal("translationApiKeys" in publicSettings, false);
  assert.deepEqual(publicSettings.translationApiKeyConfigured, {
    chrome: false,
    deepseek: true,
    openai: true,
    bailian: false,
    custom: false,
    deepl: false
  });
  assert.equal(JSON.stringify(publicSettings).includes("secret-key"), false);
});

test("shiftTimecode converts reconnect-local time to session time", () => {
  assert.equal(shiftTimecode("0:00:12.40", 81.2), "0:01:33.60");
  assert.equal(shiftTimecode("0:00:01.98", 0), "0:00:01.98");
});

test("normalizeCaptionLines keeps IDs stable and shifts display time", () => {
  const normalized = normalizeCaptionLines(
    {
      lines: [
        {
          start: "0:00:05.00",
          end: "0:00:07.25",
          text: "hello",
          translation: "你好"
        }
      ]
    },
    {
      sessionId: "session",
      epochId: "epoch-2",
      epochStartedAt: 12_000,
      sessionStartedAt: 1_000,
      updatedAt: 1
    }
  );

  assert.equal(normalized.lines[0].id, "session:epoch-2:0:00:05.00");
  assert.equal(normalized.lines[0].start, "0:00:16.00");
  assert.equal(normalized.lines[0].end, "0:00:18.25");
  assert.equal(normalized.lines[0].order, 17_000);
  assert.equal(normalized.lines[0].translationPending, false);
});

test("isNoiseTranscript drops short silent-source fragments but keeps real words", () => {
  // Letterless pause fragments: decimal/clock shapes shorter than a spoken word.
  assert.equal(isNoiseTranscript("7.8.", 0.4), true);
  assert.equal(isNoiseTranscript("3.14", 0.9), true);
  assert.equal(isNoiseTranscript("0:12", 1.2), true);
  // Letterless symbols carry no text at all, whatever the duration.
  for (const noise of ["...", "", "   ", "%$#", "-", "♪", "🎵"]) {
    assert.equal(isNoiseTranscript(noise, 10), true, `expected noise: ${noise}`);
  }
  // Unknown duration is not evidence of noise: the line is kept.
  for (const kept of ["7.8.", "3.14", "12:34"]) {
    assert.equal(isNoiseTranscript(kept), false, `expected kept: ${kept}`);
    assert.equal(isNoiseTranscript(kept, null), false, `expected kept: ${kept}`);
    assert.equal(isNoiseTranscript(kept, 0), false, `expected kept: ${kept}`);
    // A long line that happens to be a number is speech.
    assert.equal(isNoiseTranscript(kept, 6), false, `expected speech: ${kept}`);
  }
  for (const real of [
    "Yes.",
    "No",
    "你好",
    "C3PO",
    "Okay!",
    // Plain integers are never dropped: only decimal and clock shapes are noise.
    "42",
    "1,024",
    "2024",
    "The raid starts at 7.8 seconds"
  ]) {
    assert.equal(isNoiseTranscript(real, 0.4), false, `expected speech: ${real}`);
  }
});

test("transcriptDuration refuses missing or reversed timestamps", () => {
  assert.equal(transcriptDuration({ start: "0:00:01.00", end: "0:00:03.50" }), 2.5);
  assert.equal(transcriptDuration({ start: "0:00:03.00", end: "0:00:01.00" }), null);
  assert.equal(transcriptDuration({ start: "0:00:03.00", end: "0:00:03.00" }), null);
  assert.equal(transcriptDuration({}), null);
  assert.equal(transcriptDuration(null), null);
  // One-sided or unparsable timestamps are unknown, not "one second long".
  assert.equal(transcriptDuration({ end: "0:00:01.00" }), null);
  assert.equal(transcriptDuration({ start: "0:00:01.00" }), null);
  assert.equal(transcriptDuration({ start: "abc", end: "0:00:02.00" }), null);
  assert.equal(transcriptDuration({ start: "0:00:01.00", end: "garbage" }), null);
  // Numeric seconds are accepted as well (parseTimecode supports both).
  assert.equal(transcriptDuration({ start: 1, end: 3.5 }), 2.5);
  assert.equal(transcriptDuration({ start: 1, end: Number.NaN }), null);
});

test("normalizeCaptionLines drops short noise lines and keeps untimed numbers", () => {
  const normalized = normalizeCaptionLines(
    {
      lines: [
        // 0.5 s of pause that the ASR rendered as a decimal.
        { start: "0:00:01.00", end: "0:00:01.50", text: "7.8." },
        // Same shape, but six seconds long: real speech, must survive.
        { start: "0:00:03.00", end: "0:00:09.00", text: "3.14" },
        // No timestamps at all, or only one side: unknown duration, never dropped.
        { text: "7.8." },
        { end: "0:00:09.50", text: "7.8." },
        { start: "0:00:09.60", text: "7.8." },
        { start: "0:00:10.00", end: "0:00:12.00", text: "Hello there." }
      ],
      buffer_transcription: "7.8.",
      buffer_translation: ""
    },
    { sessionId: "session", epochId: "epoch-1", epochStartedAt: 1, sessionStartedAt: 1 }
  );

  assert.deepEqual(
    normalized.lines.map((line) => line.source),
    ["3.14", "7.8.", "7.8.", "7.8.", "Hello there."]
  );
  // Buffers have no duration, so a number-shaped buffer is kept as well.
  assert.equal(normalized.bufferSource, "7.8.");
});

test("normalizeCaptionLines marks source-only lines as pending translation", () => {
  const normalized = normalizeCaptionLines(
    {
      lines: [
        {
          start: "0:00:05.00",
          end: "0:00:07.25",
          text: "hello",
          translation: ""
        }
      ]
    },
    { sessionId: "session", epochId: "epoch-1" }
  );

  assert.equal(normalized.lines[0].translationPending, true);
  assert.equal(lineNeedsTranslation(normalized.lines[0]), true);
});

test("selectDisplayCaption appends the uncommitted tail instead of replacing the row", () => {
  const caption = selectDisplayCaption({
    lines: [
      {
        id: "line-1",
        source: "The stable sentence.",
        translation: "稳定的译文。"
      }
    ],
    bufferSource: "A newer unfinished sentence",
    bufferTranslation: ""
  });

  // The buffer only carries the words after the committed row, so the English
  // slot is the row plus the tail: replacing the row made it jump 88 times a
  // minute on real samples.
  assert.deepEqual(caption, {
    lineId: "line-1",
    source: "The stable sentence. A newer unfinished sentence",
    sourceStable: "The stable sentence.",
    sourceStash: "A newer unfinished sentence",
    translation: "稳定的译文。",
    error: "",
    pending: false,
    failed: false
  });
});

test("composeLiveSourceParts splits the committed row from the uncommitted tail", () => {
  const append = composeLiveSourceParts("The stable sentence.", "A newer unfinished sentence");
  assert.deepEqual(append, {
    stable: "The stable sentence.",
    stash: "A newer unfinished sentence"
  });
  assert.equal(composeLiveSourceText(append), composeLiveSource("The stable sentence.", "A newer unfinished sentence"));

  // The buffer only repeats the row's tail: nothing new to dim.
  assert.deepEqual(composeLiveSourceParts("one two three", "two three"), {
    stable: "one two three",
    stash: ""
  });
  // The buffer overlaps the tail and then adds words.
  assert.deepEqual(composeLiveSourceParts("one two three", "three four five"), {
    stable: "one two three",
    stash: "four five"
  });
  // Nothing committed yet: the whole slot is the stash.
  assert.deepEqual(composeLiveSourceParts("", "only buffer"), {
    stable: "only buffer",
    stash: ""
  });
  assert.deepEqual(composeLiveSourceParts("only row", ""), { stable: "only row", stash: "" });
});

test("selectDisplayCaption does not wait for the translation of a committed line", () => {
  const caption = selectDisplayCaption({
    lines: [
      { id: "line-1", source: "First sentence.", translation: "第一句。" },
      { id: "line-2", source: "Second sentence.", translation: "" }
    ]
  });

  assert.deepEqual(caption, {
    lineId: "line-2",
    source: "Second sentence.",
    sourceStable: "Second sentence.",
    sourceStash: "",
    translation: "第一句。",
    error: "",
    pending: true,
    failed: false
  });
});

test("selectDisplayCaption drops the pending flag once the matching translation lands", () => {
  const caption = selectDisplayCaption({
    lines: [
      { id: "line-1", source: "First sentence.", translation: "第一句。" },
      { id: "line-2", source: "Second sentence.", translation: "第二句。" }
    ]
  });

  assert.equal(caption.lineId, "line-2");
  assert.equal(caption.source, "Second sentence.");
  assert.equal(caption.translation, "第二句。");
  assert.equal(caption.pending, false);
});

test("selectDisplayCaption never copies a translation into the source slot", () => {
  const caption = selectDisplayCaption({
    lines: [{ id: "line-1", source: "", translation: "只有译文。" }]
  });

  assert.equal(caption.source, "");
  assert.equal(caption.translation, "只有译文。");
  assert.equal(caption.pending, false);
});

test("normalizeSettings keeps the overlay opacity inside 0.05..1", () => {
  assert.equal(normalizeSettings({ opacity: 0 }).opacity, 0.05);
  assert.equal(normalizeSettings({ opacity: 2 }).opacity, 1);
  assert.equal(normalizeSettings({ opacity: 0.4 }).opacity, 0.4);
});

test("selectDisplayCaption leaves the first pending translation empty", () => {
  const caption = selectDisplayCaption({
    lines: [],
    bufferSource: "First sentence",
    bufferTranslation: ""
  });

  assert.deepEqual(caption, {
    lineId: null,
    source: "First sentence",
    sourceStable: "First sentence",
    sourceStash: "",
    translation: "",
    error: "",
    pending: true,
    failed: false
  });
});

test("selectDisplayCaption marks a permanently failed line as failed, not pending", () => {
  const caption = selectDisplayCaption({
    lines: [
      {
        id: "line-1",
        source: "[MUSIC]",
        translation: "",
        translationFailed: true
      }
    ],
    translationError: "翻译 API 返回了空译文"
  });
  assert.equal(caption.failed, true);
  assert.equal(caption.pending, false);
  assert.match(caption.error, /空译文/);
});

test("mergeCaptionLines keeps reconnected epochs in session order", () => {
  const first = normalizeCaptionLines(
    {
      lines: [{ start: "0:01:20.00", end: "0:01:22.00", text: "first" }]
    },
    {
      sessionId: "session",
      epochId: "epoch-1",
      epochStartedAt: 1_000,
      sessionStartedAt: 1_000
    }
  ).lines;
  const second = normalizeCaptionLines(
    {
      lines: [{ start: "0:00:02.00", end: "0:00:04.00", text: "second" }]
    },
    {
      sessionId: "session",
      epochId: "epoch-2",
      epochStartedAt: 90_000,
      sessionStartedAt: 1_000
    }
  ).lines;

  assert.deepEqual(
    mergeCaptionLines(first, second).map((line) => line.source),
    ["first", "second"]
  );
  assert.equal(second[0].start, "0:01:31.00");
});

test("buildSrt uses continuous timestamps after reconnect", () => {
  const lines = normalizeCaptionLines(
    {
      lines: [
        {
          start: "0:00:01.00",
          end: "0:00:03.00",
          text: "second epoch",
          translation: "第二段"
        }
      ]
    },
    {
      sessionId: "session",
      epochId: "epoch-2",
      epochStartedAt: 121_000,
      sessionStartedAt: 1_000
    }
  ).lines;
  lines[0].order = 122_000;

  assert.match(
    buildSrt(lines),
    /00:02:01,000 --> 00:02:03,000/
  );
});

test("applyOverlayFailure records and clears the overlay error idempotently", () => {
  const state = structuredClone(EMPTY_RUNTIME_STATE);
  assert.equal(state.overlayError, "");

  assert.equal(
    applyOverlayFailure(state, new Error("Cannot inject")),
    true
  );
  assert.equal(state.overlayError, "Cannot inject");
  assert.equal(state.detail, OVERLAY_UNAVAILABLE_DETAIL);

  // Repeating the same failure must not schedule another broadcast.
  assert.equal(applyOverlayFailure(state, "Cannot inject"), false);
  assert.equal(state.detail, OVERLAY_UNAVAILABLE_DETAIL);

  assert.equal(applyOverlayFailure(state, null), true);
  assert.equal(state.overlayError, "");
  assert.equal(state.detail, "");
  assert.equal(applyOverlayFailure(state, null), false);

  // A later failure must not clobber an unrelated detail line on success.
  state.detail = "实时";
  assert.equal(applyOverlayFailure(state, "boom"), true);
  assert.equal(state.detail, OVERLAY_UNAVAILABLE_DETAIL);
  assert.equal(applyOverlayFailure(state, null), true);
  assert.equal(state.detail, "");
  assert.equal(applyOverlayFailure(null, "boom"), false);
});

test("mergeCaptionFragments joins a dangling fragment with the row that completes it", async () => {
  const { mergeCaptionFragments } = await import("../extension/lib/caption-utils.js");
  const lines = [
    { id: "a", source: "Pharaoh finally meets Danig, a real Kalgurin runesmith.", start: "0:00:01.00", end: "0:00:04.00" },
    { id: "b", source: "with the ancient", start: "0:00:04.50", end: "0:00:05.20" },
    { id: "c", source: "knowledge that he has found.", start: "0:00:05.40", end: "0:00:07.00" },
    { id: "d", source: "From here on, Pharaoh joins the expedition.", start: "0:00:07.20", end: "0:00:10.00" }
  ];
  const merged = mergeCaptionFragments(lines);
  // "with the ancient" continues the sentence before it and "knowledge that he
  // has found." completes it, so all three rows become one subtitle line.
  assert.deepEqual(merged.map((line) => line.id), ["a", "d"]);
  assert.equal(
    merged[0].source,
    "Pharaoh finally meets Danig, a real Kalgurin runesmith. with the ancient knowledge that he has found."
  );
  assert.equal(merged[0].end, "0:00:07.00");
  assert.equal(merged[0].fragmentLines, 3);
  // A new sentence that merely starts with a preposition stays separate.
  assert.equal(merged[1].source, lines[3].source);
});

test("mergeCaptionFragments stops after the sentence that completes the unit", async () => {
  const { mergeCaptionFragments } = await import("../extension/lib/caption-utils.js");
  const lines = [
    { id: "a", source: "so I think people will be experimenting.", start: "0:00:01.00", end: "0:00:03.00" },
    { id: "b", source: "with these for a long time.", start: "0:00:03.20", end: "0:00:05.00" },
    { id: "c", source: "Once you get to King's March in Act 4, Pharaoh finally meets Danig.", start: "0:00:05.20", end: "0:00:08.00" },
    { id: "d", source: "a real Kalgurin runesmith.", start: "0:00:08.20", end: "0:00:09.00" }
  ];
  const merged = mergeCaptionFragments(lines);
  // "a real Kalgurin runesmith." is an appositive of the previous sentence; no
  // suffix rule can attach it backwards, so it stays its own line.
  assert.deepEqual(merged.map((line) => line.id), ["a", "c", "d"]);
  assert.equal(merged[0].source, "so I think people will be experimenting. with these for a long time.");
  assert.equal(merged[1].source, lines[2].source);
});

test("mergeCaptionFragments respects the gap, size and line limits", async () => {
  const { mergeCaptionFragments } = await import("../extension/lib/caption-utils.js");
  const far = [
    { id: "a", source: "and then", start: "0:00:01.00", end: "0:00:02.00" },
    { id: "b", source: "the map opens.", start: "0:00:09.00", end: "0:00:10.00" }
  ];
  assert.equal(mergeCaptionFragments(far).length, 2);

  const many = Array.from({ length: 6 }, (_, index) => ({
    id: `l${index}`,
    source: `frag ${index}`,
    start: `0:00:0${index}.00`,
    end: `0:00:0${index}.50`
  }));
  const merged = mergeCaptionFragments(many, { maxLines: 3 });
  assert.equal(merged.length, 2);
  assert.equal(merged[0].fragmentLines, 3);
});

test("mergeCaptionFragments keeps a grown unit's stage translation instead of dropping it", async () => {
  const { mergeCaptionFragments } = await import("../extension/lib/caption-utils.js");
  const lines = [
    { id: "a", source: "and riddled with excitement", translation: "而且充满兴奋", start: "0:00:01.00", end: "0:00:02.00" },
    { id: "b", source: "he wants to learn.", start: "0:00:02.20", end: "0:00:03.50" }
  ];
  const merged = mergeCaptionFragments(lines);
  assert.equal(merged.length, 1);
  // The stage translation stays on screen while the unit grows; the merge only
  // marks it stale. reconcileLineTranslations does the same for the runtime
  // copy of the row.
  assert.equal(merged[0].translation, "而且充满兴奋");
  assert.equal(merged[0].translationPending, true);
  assert.deepEqual(merged[0].fragmentIds, ["a", "b"]);
});

test("composeLiveSource appends the uncommitted tail without duplicating it", () => {
  assert.equal(composeLiveSource("hello there", "how are you"), "hello there how are you");
  // The buffer only repeats the row's tail: nothing to add.
  assert.equal(composeLiveSource("hello there", "there"), "hello there");
  assert.equal(composeLiveSource("hello there", "there how"), "hello there how");
  assert.equal(composeLiveSource("", "just the buffer"), "just the buffer");
  assert.equal(composeLiveSource("only the row", ""), "only the row");
});

test("selectDisplayCaption keeps a stage translation and flags it as waiting", () => {
  const caption = selectDisplayCaption({
    lines: [
      { id: "line-1", source: "First sentence.", translation: "第一句。" },
      {
        id: "line-2",
        source: "Your first job is to design mechanics for the league.",
        translation: "你的首要任务是设计机制。",
        translatedSource: "Your first job is to design mechanics",
        translationPending: true
      }
    ]
  });

  // The stage translation must not be dropped in favour of the previous
  // sentence, and the pending flag tells the overlay the Chinese is behind.
  assert.equal(caption.lineId, "line-2");
  assert.equal(caption.source, "Your first job is to design mechanics for the league.");
  assert.equal(caption.translation, "你的首要任务是设计机制。");
  assert.equal(caption.pending, true);
});

test("selectDisplayCaption does not treat a non-empty buffer as a wait", () => {
  const caption = selectDisplayCaption({
    lines: [{ id: "line-1", source: "Settled sentence.", translation: "已定稿。" }],
    bufferSource: "and then"
  });
  // WhisperLiveKit keeps a buffer almost all the time; a dot that glows on
  // every buffer would read as a permanent failure.
  assert.equal(caption.pending, false);
  assert.equal(caption.source, "Settled sentence. and then");
});

test("reconcileLineTranslations keeps a stage translation while the row grows", () => {
  const previous = [
    {
      id: "line-1",
      source: "Your first job",
      translation: "你的首要任务",
      translatedSource: "Your first job",
      translationPending: false
    }
  ];
  const next = [
    { id: "line-1", source: "Your first job is to design mechanics", translation: "" }
  ];

  const [line] = reconcileLineTranslations(previous, next, { useApi: true });
  assert.equal(line.translation, "你的首要任务");
  assert.equal(line.translatedSource, "Your first job");
  assert.equal(line.translationPending, true);
});

test("reconcileLineTranslations clears the pending flag once the source matches", () => {
  const previous = [
    {
      id: "line-1",
      source: "Your first job is to design mechanics",
      translation: "你的首要任务是设计机制。",
      translatedSource: "Your first job is to design mechanics",
      translationPending: true
    }
  ];
  const next = [{ id: "line-1", source: "Your first job is to design mechanics" }];

  const [line] = reconcileLineTranslations(previous, next, { useApi: true });
  assert.equal(line.translation, "你的首要任务是设计机制。");
  assert.equal(line.translationPending, false);
});

test("reconcileLineTranslations gives a split-off row the unit's stage translation", () => {
  // The unit was "on your item. and even handcrafted runes", and row b grew far
  // enough for the unit to exceed the size limit and split again. Row b never
  // existed on its own, so it has no previous copy of itself.
  const previous = [
    {
      id: "a",
      source: "on your item. and even handcrafted runes",
      translation: "你的物品上。甚至还有手工制作的符文。",
      translatedSource: "on your item. and even handcrafted runes",
      translationPending: true,
      fragmentIds: ["a", "b"]
    }
  ];
  const next = [
    { id: "a", source: "on your item." },
    { id: "b", source: "and even handcrafted runes with no purpose" }
  ];

  const [, split] = reconcileLineTranslations(previous, next, { useApi: true });
  assert.equal(split.id, "b");
  assert.equal(split.translation, "你的物品上。甚至还有手工制作的符文。");
  assert.equal(split.translationPending, true);
});

test("reconcileLineTranslations keeps WhisperLiveKit translations in server mode", () => {
  const [line] = reconcileLineTranslations(
    [],
    [{ id: "line-1", source: "hello there", translation: "你好" }],
    { useApi: false }
  );
  assert.equal(line.translation, "你好");
  assert.equal(line.translationPending, false);
});

test("reconcileLineTranslations can read a row that left the runtime window", () => {
  const knownLines = new Map([
    [
      "gone",
      { id: "gone", source: "an older sentence", translation: "更早的一句。", translatedSource: "an older sentence" }
    ]
  ]);
  const [line] = reconcileLineTranslations([], [{ id: "gone", source: "an older sentence" }], {
    useApi: true,
    knownLines
  });
  assert.equal(line.translation, "更早的一句。");
});

test("shouldRetranslateLine waits for new text or enough time", () => {
  const line = { translation: "阶段译文", source: "hello there world" };
  // Nothing requested yet: go.
  assert.equal(shouldRetranslateLine(line, null), true);
  // A row with no Chinese yet never waits.
  assert.equal(
    shouldRetranslateLine(
      { translation: "", source: "hello there world" },
      { source: "hello", at: 1_000 },
      { now: 1_050 }
    ),
    true
  );
  // Two more words and 50 ms later: still too early.
  assert.equal(
    shouldRetranslateLine(line, { source: "hello there", at: 1_000 }, { now: 1_050 }),
    false
  );
  // Eight new characters is enough even inside the interval.
  assert.equal(
    shouldRetranslateLine(
      { translation: "阶段译文", source: "hello there world and more" },
      { source: "hello there", at: 1_000 },
      { now: 1_050 }
    ),
    true
  );
  // Enough time is enough even without new text.
  assert.equal(
    shouldRetranslateLine(line, { source: "hello there world", at: 1_000 }, { now: 1_500 }),
    true
  );
});
