# 声幕 (Shengmu)

Chrome MV3 实时字幕翻译扩展（v0.5.5）：`tabCapture` 采集标签页英文音频，经 `offscreen` WebSocket 送本地 WhisperLiveKit (`127.0.0.1:8010`)，由外部 API（默认 DeepSeek）或本地 `llama-server` (`127.0.0.1:8013`) 译为中文，渲染至 Shadow DOM 浮层与 IndexedDB 历史页。核心设计：`paseo/01-translation-api-design.md`、`paseo/08-local-model-0.5.0.md`、`paseo/09-overlay-injection-0.5.1.md`、`paseo/10-asr-width-opacity-0.5.2.md`、`paseo/11-glossary-0.5.3.md`、`paseo/12-poe-glossary-0.5.4.md`、`paseo/13-subtitle-flow-0.5.5.md`。

## 0. Commands

```powershell
# From repo root
npm test                                                                 # node:test (113 tests, pure Node)
Get-ChildItem extension,scripts/local-service,tests -Include *.js,*.mjs -Recurse | % { node --check $_.FullName }
.\scripts\Start-Services.ps1 [-AsrOnly] [-Restart] [-TranslationModel 9b-q4km|2b-iq4xs] [-AsrModel large-v3-turbo|medium]
.\scripts\Stop-Services.ps1 [-TranslationPort 8013] [-WlkPort 8010]
.\scripts\Start-LocalService.ps1 [-Port 8014]                            # Stop: .\scripts\Stop-LocalService.ps1
.\scripts\Start-DevBrowser.ps1 -Port 9223 -Url 'https://www.youtube.com/'
```

- `npm test` 与 `node --check` 每次改动必过（`service-worker.js`、`popup.js`、`subtitle.js`、`content-overlay.js`、`offscreen.js`、`server.mjs` 未被单测全量 import，靠 `node --check` 兜底语法）。
- 跑 `.research/ui-smoke-*.py` CDP 鼠标/滚轮冒烟前，确认页面 `visibilityState === "visible"` 且带 `--disable-features=CalculateNativeWinOcclusion`，否则 `Input.dispatchMouseEvent` 挂起（环境踩坑查 `.pit/` / `trap_lookup`）。
- 改动使 `paseo/*.md` 或 `README.md` 失真时同次更新；冲突时编号靠后的 `paseo/09-*.md` 优先于早期文档；`.research/*/CLAUDE.md` 属冻结上游参考，不适用主仓。
- `scripts/local-service/server.pid`、`logs/`、`chrome-profile/`、`*.part` 与 `.research/` 严禁手改或清空；改版本号同步 `package.json` 与 `extension/manifest.json`。
- 进程模型：`popup` 经 `127.0.0.1:8014` (`server.mjs`) 调 PowerShell 脚本启停本地模型；`service-worker.js` 经 `offscreen.js` 连 `ws://127.0.0.1:8010/asr?target_language=zh`，通过 `chrome.runtime` / `chrome.tabs.sendMessage` 向 `popup`、`subtitle`、`content-overlay` 广播状态。

## 1. Code Rules

- 原生 ES Modules（`package.json` `"type": "module"`；仅 `overlay-history.js`、`content-overlay.js`、`pcm-worklet.js` 为 IIFE/Worklet）。禁引入打包器、TS 编译或 runtime `node_modules`。
- 浮层注入固定 `files: ["overlay-history.js", "content-overlay.js"]`；`content-overlay.js` 必须保留 `globalThis.ShengmuOverlayHistory` 空值降级 `HISTORY_API` shim 并在 `syncHistoryLog` 动态委托（防扩展未 reload 时旧 Worker 单文件注入抛 `TypeError`）。
- 跨边界调用禁空 `catch {}` 或仅打 `console.error`（仅豁免 `server.mjs` 的 `appendJobLog` 与 `.part`/`server.pid` 清理）：
  - 翻译失败抛 `TranslationApiError`（`code`、`status`、`message`）并写 `runtimeState.current.translationError`；
  - 译文上屏/落盘前必过 `polishTranslation`（`speech-cleanup.js`），API 模式走 `applyLineTranslations`/buffer 分支、server 模式走 `handleTranscriptUpdate`，两条路径都要；送翻前原文过 `stripSpeechFillers`（只清洗 `entry.promptText`，显示屏历史英文保持原样）。`stripSpeechFillers` 返回空时必须回退原文，否则该行会被当成失败重试；
  - 浮层注入/初始化失败经幂等 `applyOverlayFailure(runtimeState, error)` 写 `runtimeState.overlayError`，同时调 `broadcastToExtension({ type: "status" })` 与 `broadcastCaptionState()`；
  - IndexedDB 写入经 `HistoryWriteQueue` 串行化，失败批次自动放回队首重试并保留较新译文；
  - `8014` 控制服务路由统一返回 `{ ok: boolean, error?: string }`。

## 2. Overlay, Transcript UI & ASR Noise

详细规范：`paseo/07-ui-fixes-0.4.3.md`、`paseo/09-overlay-injection-0.5.1.md`。

- 浮层挂 Shadow DOM，以 `globalThis.__shengmuCaptionOverlay` 与 `OVERLAY_VERSION` (`6`，0.5.2 因 DOM/CSS 重构从 4 升到 5，0.5.5 因 stale 槽改全亮+角标再升) 判重；替换旧实例前必调 `existing?.teardown?.()` 解绑 `window` 监听。
- 宽度：`.stage` 只是定位锚点（`min(68vw, 860px)`），真正绘制的是 `.caption-stack` 里的 `.caption-shell`；JS 用 canvas `measureText` 量最宽可见槽位 → 240~860px，**变宽立即生效、变窄延时 `SHELL_SHRINK_DELAY_MS = 420 ms`**（防流式吐字时边框抽搐）。禁改回在 DOM 上量宽（`text-wrap: balance` 会让量宽与当前宽度互相喂饭而振荡）。
- `selectDisplayCaption` 必须让原文槽立刻显示最新英文（未定稿 buffer 优先），译文槽在译文未到时保留上一句并置 `pending`：`.translation.pending` = 空占位，`.translation.stale` = 上一句（同字号**不降透明**，0.5.5 起全亮），"还在翻"只由 `.caption-shell[data-awaiting="1"]::before` 角落小点表达（`syncAwaitingDot`，等待 >700ms 才出现）；勿把 stale 文本套 `pending` 小字号样式（每句都会跳一次高度）。
- 0.5.5 起 ASR 碎片在进入翻译/浮层/历史/SRT 之前先合并：`mergeCaptionFragments`（`caption-utils.js` + `utterance.js` 的 `startsContinuation`/`needsCompletion`）把「不完整行」与其后继合成一句，合并后行 id 沿用首行；**仅 API 模式合并**（server 模式的译文由 WLK 按自己的分段对齐，合并会丢弃译文）。判据红线：`startsContinuation` 只认 and/but/or/that/which/with/because/if/when/while 等从属连接词与 `PARTICIPLE_CONNECTORS` 白名单现在分词（禁 so/from/in/for）；封口只由「该行自身 needsCompletion」决定，否则整段会被粘成一行。
- 透明度 `settings.opacity` 域 `0.05~1`（`normalizeOpacity`，`0` 不许回退默认值）；`--overlay-opacity` 同时驱动 `.caption-shell` 背景/边框/阴影/`backdrop-filter` 与 `.history` 背景（后者保底 `max(0.62, ...)` 保持可读）；UI 入口只在 popup `#opacity` 滑块，浮层工具栏不再加。
- `.caption-shell` 锁死 `max-height: min(70vh, 680px)`；正文包裹 `.caption-text`（限行：译文 3 行、原文 2 行、双行模式上一句 2 行），超长经 `markCaptionOverflow` 顶部渐隐裁切；历史面板每条译文 2 行、原文 1 行。
- 浮层历史 `HISTORY_LIMIT = 60`、上滚 `MAX_SCROLLBACK = 40`；回看面板 tail-follow：恒显示最新 `scrollBack` 行（新行从底部进、最老从顶部滑出），行节点带 `data-line-id` 按 `planHistoryRows` 增删改复用（禁 `replaceChildren` 整表重建），滚回 `scrollBack = 0` 时隐藏并清空节点。
- `subtitle.js` 分页 `PAGE_SIZE = 250`、搜索上限 `MAX_SEARCH_RESULTS = 1000`，DOM 更新走 `planTranscriptDiff` (`append | slide | rebuild`)。
- `isNoiseTranscript(text, duration)`：纯符号无条件丢弃；小数/时间码（如 `7.8.`、`00:12`）仅在 `duration <= 1.5s` 时丢弃；普通整数与无有效时长行保留。

## 3. Architecture

### 3.0 Size & Layering

新文件软上限 600 行；存量超限文件（`service-worker.js`、`content-overlay.js`、`subtitle.js`、`popup.js`、`translation-api.js`）禁在修 bug 时顺手拆分。

| Path | Holds |
|---|---|
| `extension/service-worker.js` `popup.js` `subtitle.js` `content-overlay.js` `offscreen.js` | 入口与协调层；同级页面脚本严禁相互 import，仅经 `chrome.runtime` / `chrome.storage.local` 通信 |
| `extension/caption-utils.js` `glossary.js` `glossary-poe.js` `overlay-history.js` `history-write-queue.js` `utterance.js` `speech-cleanup.js` | 领域纯函数与队列（≥2 模块复用或需独立单测）；严禁引入 `chrome.*` 或浏览器 DOM API |
| `extension/history-db.js` | IndexedDB `shengmu-caption-history` (v1: `sessions`, `lines`)；磁盘 schema 与 `chrome.storage.local` 顶层键（`settings`, `runtimeState`, `historyRevision`, `overlayPositions`）冻结，新增设置走 `normalizeSettings` / `migrateLegacySettings` |
| `extension/translation-api.js` | 零扩展依赖协议层（OpenAI 兼容 `/chat/completions` 批译、清洗与重试）；可复用同样零 `chrome.*`/DOM 的 `glossary.js` 纯函数，严禁引入 `chrome.*` |
| `scripts/` | PowerShell 启停脚本与 `local-service/server.mjs` (`127.0.0.1:8014`) |

广播边界：`settingsForBroadcast` 给扩展页面（含 `customGlossary`）；往标签页发的（`broadcastCaptionState`、`injectOverlay` init）必须用 `settingsForCaptions`，剥离 32 KB 自定义词条。

### 3.1 Model Sync & Runtime Cadences

- 本地模型档位（翻译 `9b-q4km | 2b-iq4xs`，ASR `large-v3-turbo | medium`）在 `extension/caption-utils.js`、`scripts/local-service/server.mjs`、`scripts/Start-Services.ps1` 三处锁步同步（单点试验传 `-TranslationModelPath`）。
- WS 重连新 epoch 经 `shiftTimecode` / `mergeCaptionLines` 累加为连续会话时间码；`finalizeSession` 单次加锁（等在途译文 ≤ `TRANSLATION_STOP_TIMEOUT_MS = 15000 ms`）并清空 `overlayError` 与 `tabId`。
- 节流预算：`pcm-worklet.js` 按 `100 ms`（`1600` 帧 @ 16 kHz）批处理发帧；完成行翻译防抖 `160 ms`（≤ `6` 行/批），未定稿 buffer 防抖 `450 ms`（最小间隔 `1200 ms`，且仅当行队列积压 >`2` 才算在后，否则 buffer 会被行翻译饿死），状态持久化 `350 ms`，历史落盘 `700 ms`。
- WLK 参数（`Start-Services.ps1`，改动前先跑 120 s 样本对比）：`--asr-coalesce-min-s 0.5`（降到 `0.3` 会让 54% 的字幕变成 “The.” 级碎片）、`--localagreement-beam-size 3`、`--buffer_trimming_sec 10`（`4` 会每 4 s 腰斩音频并触发 `Resetting buffer`）、`--confidence-validation`。
- 翻译 prompt（`translation-api.js`）：规则 4 声片段可能是一句连续语音，规则 5 要求相邻片段译文衔接、不重复上一片段，规则 6 要求承接 `context`（含未译行的原文，`MAX_CONTEXT_CHARS` 480、默认 4 行）且不重复前文；规则 2 明确删除语气词/口头禅/结巴重复/自我打断。`partial`/领域/术语规则从 7 开始编号，测试按该编号断言。`recentTranslationContext(lines, limit, excludeIds)` 必传当前批次 id 集合，否则同一句会既在 `segments` 又在 `context` 里。
- 翻译模式联动：popup 启动本地服务时传 `translationMode` + `apiTranslationConfigured`；`api` 且 `apiTranslationConfigured === true` → `server.mjs` 加 `-AsrOnly`（不启 8013，显存全给 ASR，失去 WLK 兜底译文）；`api` 无 Key 或 `server` 模式 → 照常起本地翻译模型作兜底。WLK 不暴露翻译模式，`server.mjs` 用 `startedWlkMode` 记上次启动模式，模式不符时必须补 `-Restart`（要 ASR-only 一律重启；要翻译且 8013 未监听也重启），`runStopServices()` 失败必须返回 500 不得继续启动。

## 4. Security & Verification

- 术语库（`paseo/11-glossary-0.5.3.md`、`paseo/12-poe-glossary-0.5.4.md`）：`glossary.js` 零 `chrome.*`/DOM；`GLOSSARY_PRESETS` 内置 `poe`（313 条国服解包官译与同音别名，词表在 `glossary-poe.js` 数据模块），新增领域加一项，`GLOSSARY_PRESET_IDS` 自动派生；`resolveEffectiveGlossary` 汇总词条（自定义优先于预设）；设置键 `glossaryEnabled`/`glossaryPresetIds`/`glossaryDomainHint`(≤120 字符)/`customGlossary`(≤32 KB) 藏在 `settings` 内且**不入** `TAB_ALLOWED_SETTING_KEYS`（防网页侧改词条注入 Prompt）。
- 词库数据红线：`glossary-poe.js` 只放数据、不放逻辑；译名唯一判据是 `poedb.tw/cn` 与 `poe2db.tw/cn` 条目页 `<title>`（冲突按 PoE 2，分类页取同站导航，概念词用含该机制的技能/关键字页正文佐证）；取不到中文标题的词一律不收，禁止凭记忆补写；纯日常单字（`Hit`/`Kill`/`Life`/`Mana`/`Spark`/`Arc` 等）禁入表；`sources[1..]` 只放同音误听与正则推不出的变形，且永不进 ASR 热词；顺序即预算——前 35 条 `sources[0]` 必须装进 360 字符，改动后 `npm test` 的预设校验会拦住越界与重复。
- 术语匹配硬约束：词边界 + 英文复数/所有格折叠 + **长词优先且区间遮挡**（`Orb` 与 `Orb of Augmentation` 同时存在时只注入长者）、每批 ≤ 24 条、每条每批只上报一次；`matched` 保留 ASR 误听原拼写供模型纠错；`buildAsrContextPrompt` 仅收 ASCII 英文源词且 ≤ 360 字符（WLK 会话 `context` 上限 1000）；`serializeWlkGlossary` 必须把 `|` 别名**展开**成独立 `source -> target` 对，源词含 `; : = ->` 或换行时**跳过**（WLK 会在这些位置截断/切条，静默改写等于投一个永不命中的词）；`exportGlossaryText` 的 text/csv 两条路径都必须给「会被读成行语法」的源词加引号（`| ， ＝ -> 制表符 引号` 与行首 `#`/`//`），否则 `A=B` 导出再导入会变成别的词条。
- API Key 与写保护：广播必经 `settingsForBroadcast` 剥离明文 `translationApiKeys`（仅下发 `translationApiKeyConfigured`）；非扩展页 sender 经 `isExtensionPageSender` 拦截并用 `sanitizeSettingsPatch` 限展示字段，拒绝非扩展页 `refresh-overlay`；改任一 provider `baseUrl` 同步清空其 Key；公网带 Key 强制 `https://`（仅豁免 `http://127.0.0.1`、`localhost`、`[::1]`）。
- `8014` 控制服务：仅绑 `127.0.0.1`；严守 `originAllowed`（仅空 Origin 或 `chrome-extension://`）与 `sec-fetch-site === "cross-site"` 403；`/stop` 与退出先 `kill` 在途 `jobChild`；启动 WLK 必注 `HF_HUB_DISABLE_XET=1`（防本机代理下 HF Xet 死锁）。
- 实测验收：用 `.research/quality-samples/*poe*.wav` 本地固定音频（禁以含随机广告的在线 YouTube 作转写验收源），须满足缺译 `0`、`deliveredRatio ≥ 0.999`、本地延迟 `1~3 s`（`paseo/03-verification.md`）。禁未经指令执行 `git push`。
