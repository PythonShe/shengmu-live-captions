# 声幕 (Shengmu)

Chrome MV3 实时字幕翻译扩展（v0.5.12）：`tabCapture` 采集标签页英文音频，经 `offscreen` 送识别后端（默认 Chrome 本机识别，可选阿里云百炼或本地 WhisperLiveKit `127.0.0.1:8010`），由翻译提供方（Chrome 内置、DeepSeek（锁 `deepseek-flash`）、OpenAI、通义千问、DeepL、自定义 OpenAI 兼容端点、WLK 内置或本地 `llama-server` `127.0.0.1:8013`）译为中文，渲染至 Shadow DOM 浮层与 IndexedDB 历史页。核心设计：`paseo/01-translation-api-design.md`、`paseo/14-zero-setup-0.5.6.md`、`paseo/15-deepl-0.5.7.md`、`paseo/16-stage-translation-0.5.8.md`、`paseo/17-scrollback-live-0.5.9.md`、`paseo/18-overlay-bounce-0.5.10.md`、`paseo/22-deepl-glossary-0.5.12.md`。

## 0. Commands

```sh
# From repo root (pnpm; Node 24.22.2+)
pnpm run verify      # node --check + ESLint + tsc（只看 lib/）+ 363 项单测（1 skip）
pnpm run smoke       # 无头 Chrome 加载扩展，11 项
pnpm test            # 只跑单测
pnpm services:start [--asr-only] [--translation-model 9b-q4km|2b-iq4xs] [--asr-model large-v3-turbo|medium]
pnpm services:stop | status | serve | serve-stop      # 本地模型与控制服务 8014
pnpm dev-browser --port 9223 --url 'https://www.youtube.com/'
node scripts/services.mjs help
```

- `pnpm run verify` 与 `pnpm run smoke` 每次改动必过。`service-worker.js`、`popup.js`、`subtitle.js`、`content-overlay.js`、`offscreen.js`、`server.mjs` 未被单测全量 import，靠 `node --check` 兜底语法。
- 改完扩展代码重载：`node scripts/services.mjs dev-browser --port 9223`（会重新 `loadUnpacked`）。`.research/` 下的旧探针/`reload-extension.py` 仍指向分层前的 `chrome-extension://<id>/subtitle.html`，会打开 `chrome-error://` 空页（pit `research-chrome-extension-c9e4ff`），实测时把探针复制到仓库外改成 `subtitle/subtitle.html`。
- 实测启动采集：Chrome 前台按 `Ctrl+Shift+Y`（manifest `_execute_action`）打开面板再点「开始」；`chrome.action.openPopup()` 不算用户调用，`getMediaStreamId` 仍报 activeTab 未授权。
- 跑 CDP 鼠标/滚轮探针前确认页面 `visibilityState === "visible"`，后台/遮挡窗口会让 `Input.dispatchMouseEvent` 挂起（环境踩坑查 `.pit/` / `trap_lookup`）。
- 改动使 `paseo/*.md` 或 `README.md` 失真时同次更新；冲突时编号靠后的 `paseo/09-*.md` 优先于早期文档；`.research/*/CLAUDE.md` 属冻结上游参考，不适用主仓；`.research/` 是冻结的旧线资产，只读不改。
- `chrome-profile/`、`logs/`、`.runtime/`、`*.part` 与 `.research/` 严禁手改或清空；版本号同步 `package.json`、`extension/manifest.json` 与 `content-overlay.js` 的 `OVERLAY_VERSION`。
- 进程模型：`popup` 经 `127.0.0.1:8014`（`scripts/local-service/server.mjs`）调 `service-manager.mjs` 启停本地模型；`offscreen` 连 `ws://127.0.0.1:8010/asr?target_language=zh`（或 Chrome 本机识别 / 百炼 WebSocket），经 `chrome.runtime` / `chrome.tabs.sendMessage` 向 `popup`、`subtitle`、`content-overlay` 广播状态。

## 1. Code Rules

- 原生 ES Modules（`package.json` `"type": "module"`；仅 `content/overlay-history.js`、`content/content-overlay.js`、`offscreen/pcm-worklet.js` 为 IIFE/Worklet）。禁引入打包器、TS 编译或 runtime `node_modules`。
- 分层：`extension/` 按入口分目录（`background/`、`offscreen/`、`content/`、`popup/`、`subtitle/`、`storage/`），入口之间只经 `chrome.runtime` / `chrome.storage.local` 通信；`lib/` 为纯函数模块，禁 `chrome.*` 与浏览器 DOM API。
- 浮层注入固定 `files: ["content/overlay-history.js", "content/content-overlay.js"]`；`content-overlay.js` 必须保留 `globalThis.ShengmuOverlayHistory` 空值降级 `HISTORY_API` shim 并在 `syncHistoryLog` / `planHistoryRows` 动态委托（防扩展未 reload 时旧 Worker 单文件注入抛 `TypeError`）。
- 跨边界调用禁空 `catch {}` 或仅打 `console.error`（仅豁免 `server.mjs` 的 `appendJobLog` 与 `.part`/`server.pid` 清理）：
  - 翻译失败抛 `TranslationApiError`（`code`、`status`、`message`）并写 `runtimeState.current.translationError`；
  - 译文上屏/落盘前必过 `polishTranslation`（`lib/speech-cleanup.js`），API 模式走 `applyLineTranslations`，server 模式走 `handleTranscriptUpdate`，两条路径都要；送翻前原文过 `stripSpeechFillers`（只清洗 `entry.promptText`，显示屏历史英文保持原样）。`stripSpeechFillers` 返回空时必须回退原文，否则该行会被当成失败重试；
  - 浮层注入/初始化失败经幂等 `applyOverlayFailure(runtimeState, error)` 写 `runtimeState.overlayError`，同时调 `broadcastToExtension({ type: "status" })` 与 `broadcastCaptionState()`；
  - IndexedDB 写入经 `HistoryWriteQueue` 串行化，失败批次自动放回队首重试并保留较新译文；
  - `8014` 控制服务路由统一返回 `{ ok: boolean, error?: string }`。

## 2. Overlay, Transcript UI & ASR Noise

详细规范：`paseo/07-ui-fixes-0.4.3.md`、`paseo/09-overlay-injection-0.5.1.md`。

- 浮层挂 Shadow DOM，以 `globalThis.__shengmuCaptionOverlay` 与 `OVERLAY_VERSION` (`11`；4→5 为 0.5.2 DOM/CSS 重构，5→6 为 0.5.5 stale 槽全亮，9→10 为 0.5.10 高度缓动 + 去 `text-wrap: balance`，10→11 为 0.5.11 广播风视觉 + `.source` 内拆出 `.source-stash`) 判重；替换旧实例前必调 `existing?.teardown?.()` 解绑 `window` 监听。
- 视觉（0.5.11 广播风，`paseo/19-broadcast-visuals-0.5.11.md`）：字体走 `.stage` 上的 `--caption-sans`（HarmonyOS Sans SC→MiSans→PingFang SC→Microsoft YaHei，700）/ `--caption-latin`（Inter→Segoe UI，500），禁回退衬线（Windows 落 SimSun 横画被推流编码打断）；译文 `#fff`、英文 `rgb(180 212 244 / .92)`、上一句 `rgb(203 213 225 / .88)`、`.source-stash` 56%，文字色禁再乘 `--overlay-opacity`（自身不透明度 ≥ 0.88，否则透底发脏）；描边只用 `text-shadow`（`--caption-outline-strong` 8 向 / `--caption-outline-soft` 4 向），禁用 `-webkit-text-stroke`（侵蚀字白、字形发胖）；底板中性黑曜石 `180deg rgb(14 18 26) → rgb(8 11 16)` + `border-radius: 14px` + `14px 22px` 对称内边距，禁恢复左侧金条、右上金线与 `saturate(0.8)`。
- 英文未定稿尾巴：`composeLiveSourceParts` 拆 `{ stable, stash }`（`lib/caption-utils.js` 与 `content-overlay.js` 内联副本各一份，必同步），`selectDisplayCaption` 输出 `sourceStable`/`sourceStash`，浮层经 `setSourceText` 把 stash 包进 `.source .caption-text > span.source-stash`；`.caption-text` 的 `textContent` 必须仍等于 `composeLiveSource` 的单串，否则 `measureSlotWidth` 量窄触发假折行。
- 宽度：`.stage` 只是定位锚点（`min(68vw, 860px)`），真正绘制的是 `.caption-stack` 里的 `.caption-shell`；JS 用 canvas `measureText` 量最宽可见槽位 + `SHELL_WIDTH_SLACK_PX = 12`（吸收 Canvas 与真实排版的差值）→ 240~860px，**变宽立即生效**、变窄延时 `SHELL_SHRINK_DELAY_MS = 420 ms` 并只在那时挂 `.caption-stack.shrinking`（`170 ms` 宽度过渡）。禁改回在 DOM 上量宽，禁把 slack 调成 0。
- 高度：`.caption-shell` 高度始终显式（px），由 `syncShellHeight` 从可见槽文本盒求和得出（`measureShellNaturalHeight`，封顶 `max-height: min(70vh, 680px)`）；变化 `< SHELL_HEIGHT_EPSILON_PX = 2` 忽略，变化时写内联高度并挂 `.resizing`（`SHELL_HEIGHT_RESIZE_LOCK_MS = 200 ms`，比 CSS `height 160ms cubic-bezier(0.22, 1, 0.36, 1)` 多 40 ms 余量）后重算 `refreshCaptionOverflow`。`.resizing` 期间 `.prev-translation`/`.translation` 必须 `flex: 0 0 auto`，否则动画期文字被顶走。禁改回 `height: auto` 量完再设值（会打断在途 transition）。
- 英文槽固定单行：`.source` `max-height: 1.38em` + `white-space: nowrap` + 交叉轴 `align-items: flex-end`（溢出落在左侧），`.source.overflowing` 用水平 `to right` 渐隐；`markCaptionOverflow` 同时判垂直溢出与水平溢出（`rect.width - element.clientWidth > 1`）。
- `selectDisplayCaption`：源槽 = 最新行英文 + `composeLiveSource` 拼上的 buffer 尾部（词级重叠去重，buffer 不再替换整行）；译文槽只读最新行自身的 `translation`（含阶段译文），未到时才回退上一句并置 `stale`。`.translation.pending` = 空占位，`.translation.stale` = 上一句（同字号**不降透明**），“还在翻”只由 `.caption-shell[data-awaiting="1"]::before` 角落小点表达（`syncAwaitingDot`，等待 >700ms 才出现）；勿把 stale 文本套 `pending` 小字号样式。`content-overlay.js` 里旧 worker 分支的内联副本必须与新规则一致（`composeLiveSource` 也是内联副本）。
- 0.5.8 阶段译文（单调递进）：行字段 `translation` / `translatedSource` / `translationPending`（= 译文落后于源文）/ `fragmentIds`；`reconcileLineTranslations` 每帧从上一帧接管译文（源文变长也不清零），`mergeCaptionFragments` 合并时只置 `translationPending` 不清译文；在途响应回来时源文已变长则作为阶段译文上屏，不丢弃。只有 `translationPending === false` 的行进 IndexedDB 与 SRT，停止采集时 `commitRuntimeLinesToHistory` 把屏上版本定格补写。重译限流按后端分档（`resolveRetranslateThrottle`）：配置带 `apiKey` → `TRANSLATION_RETRANSLATE_PAID_MIN_NEW_CHARS = 24` / `_PAID_MIN_INTERVAL_MS = 1200`（每次重译重发整句，按字符计费，实测白烧 4.3 倍字符）；无 Key（Chrome 内置、无 Key 的自定义本地端点）→ `8` / `400`。被限流时必须由 `wakeTimer` 补一发，不得静默丢弃。API 模式已删除整套 buffer 送翻（`lib/buffer-translation.js` 与「半句预翻译」开关都已不存在），buffer 只进英文槽。
- 超长 ASR 行（`paseo/23-long-row-segmentation.md`）：关闭说话人分离时 WLK 只在静音处结束一行，与标点无关；行活过 `--retention-seconds` 后开头被裁，`start` 与由它推出的行 id 每帧变化。API 模式下 `lib/caption-segment.js` 在合句之前把超长行切成 ≤`FRAGMENT_MAX_CHARS` 的句子（`<id>#<序号>`），被裁的行按文本接回原 id。**红线：`cutSentences` 的每个判断只能看到切点后一个词，追加文本不得移动已有切点**，否则行 id 会漂移（有测试逐词验证）。server 模式不切（译文按 WLK 的行对齐）。
- 0.5.5 起 ASR 碎片在进入翻译/浮层/历史/SRT 之前先合并：`mergeCaptionFragments`（`lib/caption-utils.js` + `lib/utterance.js` 的 `startsContinuation`/`needsCompletion`）把「不完整行」与其后继合成一句，合并后行 id 沿用首行；**仅 API 模式合并**（server 模式的译文由 WLK 按自己的分段对齐，合并会丢弃译文）。判据红线：`startsContinuation` 只认 and/but/or/that/which/with/because/if/when/while 等从属连接词与 `PARTICIPLE_CONNECTORS` 白名单现在分词（禁 so/from/in/for）；封口只由「该行自身 needsCompletion」决定，否则整段会被粘成一行。
- 透明度 `settings.opacity` 域 `0.05~1`（`normalizeOpacity`，`0` 不许回退默认值）；`--overlay-opacity` 同时驱动 `.caption-shell` 背景/边框/阴影/`backdrop-filter` 与 `.history` 背景（后者保底 `max(0.62, ...)` 保持可读）；UI 入口只在 popup `#opacity` 滑块，浮层工具栏不再加。
- `.caption-shell` 锁死 `max-height: min(70vh, 680px)`；正文包裹 `.caption-text`（限行：译文 3 行、原文单行、双行模式上一句 2 行），超长经 `markCaptionOverflow` 渐隐裁切；历史面板每条译文 2 行、原文 1 行。
- 浮层历史 `HISTORY_LIMIT = 60`、上滚 `MAX_SCROLLBACK = 40`；回看面板 tail-follow：恒显示最新 `scrollBack` 行（新行从底部进、最老从顶部滑出），行节点带 `data-line-id` 按 `planHistoryRows` 增删改复用（禁 `replaceChildren` 整表重建），滚回 `scrollBack = 0` 时隐藏并清空节点。
- `subtitle.js` 分页 `PAGE_SIZE = 250`、搜索上限 `MAX_SEARCH_RESULTS = 1000`，DOM 更新走 `planTranscriptDiff` (`append | slide | rebuild`)。
- `isNoiseTranscript(text, duration)`：纯符号无条件丢弃；小数/时间码（如 `7.8.`、`00:12`）仅在 `duration <= 1.5s` 时丢弃；普通整数与无有效时长行保留。

## 3. Architecture

### 3.0 Size & Layering

新文件软上限 600 行；存量超限文件（`service-worker.js`、`content-overlay.js`、`subtitle.js`、`popup.js`、`translation-api.js`）禁在修 bug 时顺手拆分。

| Path | Holds |
|---|---|
| `extension/background/` `offscreen/` `content/` `popup/` `subtitle/` `ui/` | 入口与协调层；同级页面脚本严禁相互 import，仅经 `chrome.runtime` / `chrome.storage.local` 通信。`background/` 拆为 `settings-store.js`（设置、迁移、Key 规则）、`runtime-store.js`（运行态唯一所有者）、`session-lifecycle.js`（开始/停止/收尾/重启恢复）、`message-router.js`（`MESSAGE_ROUTES` 发送方策略表）、`history-sync.js`、`views.js`、`offscreen-client.js`、`asr-auth.js`（百炼 Key 的 DNR 会话规则）、`usage-service.js`、`deepl-glossary-service.js`（DeepL glossary 单例：删后建）、`i18n.js` |
| `extension/lib/` | 领域纯函数与队列（`caption-utils`、`transcript-reducer`、`translation-scheduler`、`translation-api`、`translation-cooldown`、`caption-delta`、`utterance`、`speech-cleanup`、`asr-sessions`、`glossary`、`glossary-poe`、`history-write-queue`、`ui-model`、`i18n-message`）；严禁 `chrome.*` 与 DOM API |
| `extension/storage/history-db.js` | IndexedDB `shengmu-caption-history` (v1: `sessions`, `lines`)；磁盘 schema 与 `chrome.storage.local` 顶层键（`settings`, `runtimeState`, `historyRevision`, `overlayPositions`, `usageLedger`, `deeplGlossary`）冻结，新增设置走 `normalizeSettings` / `migrateLegacySettings` |
| `extension/content/overlay-history.js` `content-overlay.js` | classic script（IIFE），浮层与回看面板；`overlay-history.js` 必须先执行 |
| `scripts/` | Node 运行时：`services.mjs`（CLI）、`local-service/`（`service-manager.mjs` 启停、`server.mjs` 控制服务 `127.0.0.1:8014`、`config.mjs` 模型档位与 WLK 参数）、`dev-browser.mjs` / `load-extension.mjs`、`smoke-extension.mjs`、`native-host/` |

广播边界：`settingsForBroadcast` 给扩展页面（含 `customGlossary`）；往标签页发的（`broadcastCaptionState`、`injectOverlay` init）必须用 `settingsForCaptions`，剥离 32 KB 自定义词条。

### 3.1 Model Sync & Runtime Cadences

- 本地模型档位（翻译 `9b-q4km | 2b-iq4xs`，ASR `large-v3-turbo | medium`）在 `extension/lib/caption-utils.js`（`LOCAL_TRANSLATION_MODELS` / `LOCAL_ASR_MODELS`）与 `scripts/local-service/config.mjs`（`TRANSLATION_MODELS` / `ASR_MODELS`）锁步同步，`tests/service-manager.test.js` 校验；单点试验传 `--translation-model-path`。
- WS 重连新 epoch 经 `shiftTimecode` / `mergeCaptionLines` 累加为连续会话时间码；`finalize` 单次加锁（等在途译文 ≤ `TRANSLATION_STOP_TIMEOUT_MS = 15000 ms`）并清空 `overlayError` 与 `tabId`。
- 节流预算：`pcm-worklet.js` 按 `100 ms`（`1600` 帧 @ 16 kHz）批处理发帧；完成行翻译防抖 `160 ms`（批 ≤ 6 行、`TRANSLATION_LINE_CONCURRENCY = 2`）；成长行重译按后端分档：无 Key `8 字符 / 400 ms`、带 Key `24 字符 / 1200 ms`（`resolveRetranslateThrottle`，被限流时 `wakeTimer` 补发）；状态持久化 `350 ms`；历史落盘 `700 ms`。
- WLK 参数（`scripts/local-service/config.mjs`，改动前先跑 120 s 样本对比）：`--asr-coalesce-min-s 0.5`（降到 `0.3` 会让 54% 的字幕变成 “The.” 级碎片）、`--localagreement-beam-size 3`、`--buffer_trimming_sec 10`（`4` 会每 4 s 腰斩音频并触发 `Resetting buffer`）、`--confidence-validation`。
- 用量（`paseo/21-usage-panel.md`）：`lib/usage-ledger.js`（纯函数：按本地日 + `provider:model` 分桶、90 天保留、汇总）与 `lib/provider-usage.js`（纯函数：端点与响应形状）可单测；`background/usage-service.js` 负责 `chrome.storage.local.usageLedger` 读写（节流 2 s 合并，避免每请求写盘）、远端查询与 5 分钟缓存。`scheduler` 每次请求成功后经 `recordUsage` 回调记账，**不依赖它会话内 `usage`**（停采会清空）。`get-usage` 仅在扩展页可调（返回账号额度）。远端能力：DeepL `GET /v2/usage`（`character_count` / `character_limit`）、DeepSeek `GET /user/balance`（需从 baseUrl 去掉 `/v1`，仅认 `*.deepseek.com` 主机）、百炼**无 API**（`console_only`，额度看控制台或 `bl usage`）、OpenAI 需管理员 Key。缓存必按 provider 区分（曾把 DeepL 数字回给 DeepSeek）。
- 翻译 prompt（`lib/translation-api.js`）：规则 4 声片段可能是一句连续语音，规则 5 要求相邻片段译文衔接、不重复上一片段，规则 6 要求承接 `context`（含未译行的原文，`MAX_CONTEXT_CHARS` 480、默认 4 行）且不重复前文；规则 2 明确删除语气词/口头禅/结巴重复/自我打断。`partial`/领域/术语规则从 7 开始编号，测试按该编号断言。`recentTranslationContext(lines, limit, excludeIds)` 必传当前批次 id 集合，否则同一句会既在 `segments` 又在 `context` 里。DeepL 走独立协议分支（`protocol: "deepl"`、`target_lang: ZH-HANS` 被 400 拒绝时回退 `ZH` 一次、`usage.billedCharacters` 计费字符）；`deepseek` 预设 `fixedModel: true` 锁 `deepseek-flash`，`requiresModel: false` 的服务商（DeepL）模型恒为空。
- 百炼模型是**封闭下拉**：`BAILIAN_TRANSLATION_MODELS`（`qwen3.7-flash`、`qwen-mt-flash`、`qwen-mt-plus`、`qwen-mt-lite`）由 `normalizeTranslationSettings` 归一，存储里别的 id 一律回落 `qwen3.7-flash`（`qwen-mt-turbo` 在 cn 地域实测 404 `model_not_found`，故不入表；不要再放回）。popup 在百炼时把 `#translationModel` 换成 `#translationModelSelect`（其它服务商仍是自由输入），两处取值统一走 `selectedModelValue(preset)`。`resolveTranslationProtocol` 按模型名前缀把 `protocol` 切成 `qwen-mt`。该协议**禁发 `system` 消息**（百炼规定），`segments` 按 `\n` 一行一段拼成单条 user 消息，术语走 `translation_options.terms`、领域走 `domains`，**无 `context`**（跨行衔接交给模型）；回复由 `parseQwenMtOutput` 按行切并校验行数，不匹配抛 `count_mismatch` 进 `SPLITTABLE_ERROR_CODES` 拆半重试。实测 2 行批：`qwen3.7-flash` 1.0~1.37 s / 550 token，`qwen-mt-flash` 0.25~0.36 s / ~100 token；真机 120 s 首中文 p50 <1 s。硬约束：`qwen3.7-flash` **默认开思考**，不传 `enable_thinking: false` 要 30~37 s（reasoning 近万字符），任何新协议分支禁丢该字段；`qwen-mt-*` 无思考开关，不注入。
- 翻译模式联动：popup 调 `8014 /start` 时传 `translationMode` + `apiTranslationConfigured`；`api` 且 `apiTranslationConfigured === true` → `server.mjs` 以 asr-only 启 WLK（不启 8013，显存全给 ASR，失去 WLK 兜底译文）；`api` 无 Key 或 `server` 模式 → 照常起本地翻译模型作兜底。WLK 不暴露翻译模式，`server.mjs` 用 `startedWlkMode` 记上次启动模式，模式不符时必须重启（要 ASR-only 一律重启；要翻译且 8013 未监听也重启），停服失败必须返回 500 不得继续启动。

## 4. Security & Verification

- DeepL 术语库（`paseo/22-deepl-glossary-0.5.12.md`）：DeepL 不能改 prompt，术语只能走 glossary。`lib/deepl-glossary.js` 把词条展开成 `sources[]`×target 并**追加全小写变体**（DeepL 大小写敏感），`serializeDeepLGlossaryTsv` 出 TSV，`deepLGlossaryFingerprint` 判重；`background/deepl-glossary-service.js` 只在**扩展页面板点「同步到 DeepL」**时执行（Free 层只允许 1 个 glossary，重建＝先 DELETE 旧 id 再 POST，绝不能改成设置变更即自动重建，否则会反复删别人的库）。创建必须 `source_lang: EN` + `target_lang: ZH`（root code，`ZH-HANS` 会被拒）；翻译请求带 `glossary_id` 时必须同时带 `source_lang: EN`，400 提到 glossary 时 `translateWithDeepL` 去 id 重试一次。456 = 账号已有 1 个 glossary，错误码 `glossary_quota`，面板原样显示服务端话术。
- 术语库（`paseo/11`、`paseo/12`）：`lib/glossary.js` 零 `chrome.*`/DOM；`GLOSSARY_PRESETS` 内置 `poe`（313 条国服解包官译与同音别名，词表在 `glossary-poe.js` 数据模块），新增领域加一项，`GLOSSARY_PRESET_IDS` 自动派生；`resolveEffectiveGlossary` 汇总词条（自定义优先于预设）；设置键 `glossaryEnabled`/`glossaryPresetIds`/`glossaryDomainHint`(≤120 字符)/`customGlossary`(≤32 KB) 藏在 `settings` 内且**不入** `TAB_ALLOWED_SETTING_KEYS`（防网页侧改词条注入 Prompt）。
- 词库数据红线：`glossary-poe.js` 只放数据、不放逻辑；译名唯一判据是 `poedb.tw/cn` 与 `poe2db.tw/cn` 条目页 `<title>`（冲突按 PoE 2，分类页取同站导航，概念词用含该机制的技能/关键字页正文佐证）；取不到中文标题的词一律不收，禁止凭记忆补写；纯日常单字（`Hit`/`Kill`/`Life`/`Mana`/`Spark`/`Arc` 等）禁入表；`sources[1..]` 只放同音误听与正则推不出的变形，且永不进 ASR 热词；顺序即预算——前 35 条 `sources[0]` 必须装进 360 字符，改动后 `pnpm test` 的预设校验会拦住越界与重复。
- 术语匹配硬约束：词边界 + 英文复数/所有格折叠 + **长词优先且区间遮挡**（`Orb` 与 `Orb of Augmentation` 同时存在时只注入长者）、每批 ≤ 24 条、每条每批只上报一次；`matched` 保留 ASR 误听原拼写供模型纠错；`buildAsrContextPrompt` 仅收 ASCII 英文源词且 ≤ 360 字符（WLK 会话 `context` 上限 1000）；`serializeWlkGlossary` 必须把 `|` 别名**展开**成独立 `source -> target` 对，源词含 `; : = ->` 或换行时**跳过**（WLK 会在这些位置截断/切条，静默改写等于投一个永不命中的词）；`exportGlossaryText` 的 text/csv 两条路径都必须给「会被读成行语法」的源词加引号（`| ， ＝ -> 制表符 引号` 与行首 `#`/`//`），否则 `A=B` 导出再导入会变成别的词条。
- API Key 与写保护：广播必经 `settingsForBroadcast` 剥离明文 `translationApiKeys`（仅下发 `translationApiKeyConfigured`）；非扩展页 sender 经 `isExtensionPageSender` 拦截并用 `sanitizeSettingsPatch` 限展示字段，拒绝非扩展页 `refresh-overlay`；改任一 provider `baseUrl` 同步清空其 Key；公网带 Key 强制 `https://`（仅豁免 `http://127.0.0.1`、`localhost`、`[::1]`）。
- `8014` 控制服务：仅绑 `127.0.0.1`；严守 `originAllowed`（仅空 Origin 或 `chrome-extension://`）与 `sec-fetch-site === "cross-site"` 403；`/stop` 与退出先 `kill` 在途 `jobChild`；启动 WLK 必注 `HF_HUB_DISABLE_XET=1`（防本机代理下 HF Xet 死锁）。
- 实测验收：用 `test-assets/quality-samples/*poe*.wav` 固定音频（无 `.research/` 的机器同样可跑；禁以含随机广告的在线 YouTube 作转写验收源），须满足缺译 `0`、`deliveredRatio ≥ 0.999`、本地延迟 `1~3 s`（`paseo/03-verification.md`）。样本来源与播放器用法见 `test-assets/quality-samples/README.md`。禁未经指令执行 `git push`。
