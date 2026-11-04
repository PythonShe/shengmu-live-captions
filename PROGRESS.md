# 项目进度记录 (PROGRESS.md)

## 2026-11-04 · 移植阶段 4：浮层高度缓动 + 英文单行 + 版本收口（0.5.10）

任务书：`plan.md` 阶段 4。分支 `port/0.5.10`。

### 已修改文件
- `extension/content/content-overlay.js`：
  - CSS：删 `.translation` / `.prev-translation` 的 `text-wrap: balance`；`.caption-stack` 去掉常驻 `transition: width`，只留 `.caption-stack.shrinking` 的 170 ms；`.caption-shell` 加 `transition: height 160ms cubic-bezier(0.22, 1, 0.36, 1)`；新增 `.caption-shell.resizing .prev-translation, .translation { flex: 0 0 auto }`；`.source` 改单行（`max-height: 1.38em`、`nowrap`、`align-items: flex-end`）+ `.source.overflowing` 水平 `to right` 渐隐。
  - JS：新增 `SHELL_WIDTH_SLACK_PX = 12`、`SHELL_WIDTH_TRANSITION_MS = 170`、`SHELL_HEIGHT_RESIZE_LOCK_MS = 200`、`SHELL_HEIGHT_EPSILON_PX = 2`；`applyShellWidth(width, animate)` 只在缩窄时挂 `.shrinking`；`scheduleShellShrink` 在宽度落地后补一次 `syncShellHeight` + `refreshCaptionOverflow`；新增 `measureShellNaturalHeight` / `syncShellHeight`；`markCaptionOverflow` 同时判垂直与水平溢出；`handleWindowResize` 与 `render` 都调 `syncShellHeight`；`buildOverlay` / `teardown` 清理四个定时器并复位 `shellWidthPx` / `shellHeightPx`；`OVERLAY_VERSION` 9 → 10；旧 worker 分支内联 `composeLiveSource` 并改成与新 `selectDisplayCaption` 一致的 pending 语义。
- `package.json` / `extension/manifest.json`：`0.5.6` → `0.5.10`。
- `AGENTS.md`：按 0.5.10 现状重写 Commands（pnpm、测试数、探针/启动采集注意）、分层表（`background/` `lib/` `storage/` `content/` `scripts/`）、模型档位与 WLK 参数落点、浮层宽高/英文槽/阶段译文/tail-follow 红线、DeepL 说明。
- `README.md`：版本 0.5.10、翻译引擎表加 DeepL、字幕行为补 4 条。
- `paseo/01-translation-api-design.md`：新增「0.5.7~0.5.10 现状」节（分层落点、DeepL、阶段译文、回看/浮层）。
- `paseo/18-overlay-bounce-0.5.10.md`：把 `160ms ease-out` 改成与代码一致的 `cubic-bezier(0.22, 1, 0.36, 1)`。
- `.pit/pits/research-chrome-extension-c9e4ff.md`：更正绕法——`chrome.action.openPopup()` 不授予 activeTab，实测要用 `Ctrl+Shift+Y`（`_execute_action`）打开面板再点开始。

### 已执行验证
- `pnpm run verify` 284 项（283 pass / 1 skip）、`pnpm run smoke` 11 项。
- 防缓存重载（pit `dev-395f5a`）：关 9223 浏览器 → 删 `chrome-profile/Default/{Service Worker,Code Cache}` → `pnpm dev-browser` 重启。
- 实测（固定样本 `GHEBkhT1K7A-05m41-07m41.wav`、DeepL 后端、60 s bilingual）：英文槽高度恒 28 px、source `A→B→A` 0、译文 `A→B→A` 0、空译文 0、same-text wrap rebounds 0、height bounces 8（1↔2 行，属预期）、`top changes = line changes`（14/14）、无预留空白行、译文最多 3 行；dual 模式 100 s 复测 rebounds 0 / wrap rebounds 0。

### 未执行 / 待后续
- 未跑 `.research/layout-synthetic.py`（长句↔短句、四模式切换、缩窄 420 ms 时序）。
- 未在 server 模式（WLK 自带译文）下复测浮层。
- 全量跨模型审阅（`origin/master..port/0.5.10`）待阶段 4 审阅完成后统一做。

## 2026-11-04 · 移植阶段 3：滚轮回看窗口实时跟随（0.5.9）

任务书：`plan.md` 阶段 3。分支 `port/0.5.10`。

### 已修改文件
- `extension/content/overlay-history.js`：新增纯函数 `planHistoryRows(previousIds, nextIds)` → `{ order, added, removed }`，挂入 `ShengmuOverlayHistory` 导出。
- `extension/content/content-overlay.js`：
  - 删 `scrollbackSnapshot` / `renderedScrollbackKey` / `scrollbackView()`，改 `scrollbackRows`（与 `.history-line` 一一对应的行对象数组）；
  - `HISTORY_API` 降级 shim 补 `planHistoryRows`（运行期委托，缺 `overlay-history.js` 时整表重建，仍可用）；
  - `maxScrollBack` 直接读 `scrollbackEntries().length`；`openScrollback` 不再冻结列表；
  - 新增 `historyRowText`（双语模式未译行不把英文重复印进译文槽）、`createHistoryRow`（挂 `data-line-id`）、`patchHistoryRow`（文本真变才写）、`syncScrollbackRows`（按 plan 复用节点）、`clearScrollbackRows`；
  - `renderScrollback` 每帧从 `scrollbackEntries()` 取最新 `scrollBack` 行（排除正在生长的实时尾行），只在行集合或文本真变时重算 `scrollTop` 与 `.overflowing`；chip 文案继续走 `t()`；
  - `buildOverlay` / `resetSessionHistory` / `teardown` 与滚轮归零处同步复位。
- `tests/overlay-history.test.js`：+3 例（滑动窗口与上下滚、无变化与清空、中间行消失时只拆该节点），11 项通过。
- `AGENTS.md` §2：回看期描述由 `scrollbackSnapshot` 冻结改为 tail-follow + `data-line-id` 节点复用。

### 已执行验证
- `pnpm run verify`：284 项（阶段 2 的 281 + 3），283 pass / 1 skip / 0 fail；`pnpm run smoke` 11 项全过（含 overlay 注入与 shadow root）。
- 首次 verify 有 1 项 `tests/service-manager.test.js` 偶发失败（WhisperLiveKit 端口时序），单跑与复跑均通过，与本阶段改动无关，未记 pit（根因未证）。

### 行为变化
- 面板不再冻结：新句从底部滑入、最老一行从顶部滑出，行数恒等于 `scrollBack`（上限 40）。
- 行节点按 `data-line-id` 复用，晚到译文原地刷新，不整表重建。
- 双语模式下未译行不再把英文同时印在原文槽和译文槽。
- `OVERLAY_VERSION` 本阶段不动（按 plan 阶段 4 由 `9` 升 `10` 收口）。

### 实测（dev 9223 + 真实 tabCapture + 固定样本 `GHEBkhT1K7A-05m41-07m41.wav` + DeepL 后端）
- 启动姿势：`node scripts/services.mjs dev-browser --port 9223` 重载扩展 → 打开 `extension/subtitle/subtitle.html` → 激活 player tab → `chrome.action.openPopup()` 后点 `#primaryButton`（UIA 找不到工具栏图标；旧 `.research` 探针硬编码 `subtitle.html` 旧路径，已记 pit `research-chrome-extension-c9e4ff`）。探针复制到仓库外改路径后跑 60 s。
- 结果：面板 60 s 内行数恒 8、打开后新进 20 行、每行节点重建 0、译文 A→B→A 0、面板高恒 283 px；深滚后 30 行、重建 0；滚回最新后 `hidden=true`、行数 0。与 `paseo/17` 的判据一致。
- 未跑 `rebound-probe.py`（浮层本体回弹，属阶段 4 验收）。

### 未执行 / 待后续
- 未在 server 模式（WLK 自带译文）下复测面板实时性。

### 跨模型审阅（`fef5b13..2cab460`，qwen3.7-plus，只读 worktree）
- P1 旧 worker shim 的 `planHistoryRows` 恒返回 `removed: []`，滑出行的节点会残留在 DOM 里 → 改成按 `nextSet` 过滤 `removed`，`added` 仍为全量（降级路径整表重建）。
- P2 `resetSessionHistory()` 未清 `scrollbackRows` → 补 `clearScrollbackRows()`。
- 自查补的一处：行滑入/滑出使面板高度变化时 `historyRectCache` 未失效，滚轮命中区还是旧矩形，新增区域滚轮会漏到页面 → `changed` 时先清 cache 再取 `lastPanelRect`。
- 复跑 `pnpm run verify`（283 pass / 1 skip）+ `pnpm run smoke`（11 pass）全过。

## 2026-11-04 · 阶段 2 跨模型审阅：0 条 P0/P1 + 修掉测试里的裸 NUL

审阅人：paseo `Code Review` profile（`pi/magpie/opencode-go/qwen3.7-plus`，thinking medium），独立 `--new-workspace` + `git worktree` 快照 `C:/Users/moule/Documents/ChatGPT/shengmu-review-058-stage2`（detach `d4a079c`），只读约束写在 prompt 里；审完 `git status` 干净，未动手。范围 `9df92c2..d4a079c`。

### 审阅结论（3 条必须修 → 复核后 0 条）
- 原报 P0（`content-overlay.js` 内联 `selectDisplayCaption` 与 `caption-utils.js` 不一致）→ 降 P2：`latestCaption()` 先取 `current.displayCaption`，内联副本只是旧 worker 降级 shim（AGENTS.md §1 要求保留），`caption-utils.js` 注释已写「change both」。
- 原报 P1（`finalize` 里 offscreen 丢失分支跳过 `commitRuntimeLinesToHistory`）→ 不成立：`finalize` 内无 `hasDocument` 分支；offscreen 丢失由 `recover` 调 `finalize("error")`，走完整路径，settle → commit → seal 必执行。
- 原报 P1（`recover` 把 `translationPending` 行写进历史）→ 不成立：`linesChangedSince` 首句即 `translationPending === true → false`，恢复路径同样过滤。
- 原报 P2「缺 wakeTimer 集成测试」→ 不成立：`tests/translation-scheduler.test.js:162-190` 已覆盖 hold → 400 ms 唤醒 → 重译落终态。

### 本轮实际修复
- `tests/translation-scheduler.test.js:104` 的 signature 断言里写进了两个裸 NUL 字节（本意 `\u0000` 转义），git / `rg` 把整个文件当 binary，diff 不可读、审阅者直接跳过该文件。已改成转义写法（`node --check` + `node --test tests/translation-scheduler.test.js` 12 项通过）。

### 遗留 P2（记录，不在阶段 2 处理）
- `shouldRetranslateLine` 用字符数算增量（8 字符 ≈ 英文 1~2 词），当前只支持英文 ASR，可接受。
- `resolveTranslationConfig` 仍输出 `translatePartial`，全仓无消费者（`DEFAULT_SETTINGS` 保留该键是为了兼容旧存储）。
- `content-overlay.js` 旧 worker fallback 与新 `selectDisplayCaption` 行为有差异（`bufferSource` 非空时旧代码屏蔽行译文）；无实测样本覆盖旧 worker 场景，不动。

## 2026-11-04 · 移植阶段 2：阶段译文单调递进 + 英文单行源槽 + 停用 buffer 送翻（0.5.8）

任务书：`plan.md` 阶段 2。分支 `port/0.5.10`。

### 已修改文件
- `extension/lib/caption-utils.js`：
  - `mergeCaptionFragments` 记 `fragmentIds`（单元拆分时新行可承接旧译文），合并后不再清空 `translation`，只置 `translationPending`；
  - 新增 `reconcileLineTranslations(previousLines, nextLines, { useApi, knownLines })`（行保留译文并记 `translatedSource`，源文变长只标 pending）、`shouldRetranslateLine(line, guard, { now })`、常量 `TRANSLATION_RETRANSLATE_MIN_NEW_CHARS = 8` / `TRANSLATION_RETRANSLATE_MIN_INTERVAL_MS = 400`、`composeLiveSource(lineSource, bufferSource)`；
  - `selectDisplayCaption` 改为读最新行译文（阶段译文优先），源槽 = 行文本 + buffer 尾部拼接，`pending` 不再由 buffer 非空触发。
- `extension/lib/transcript-reducer.js`：`lineSignature(source, translation, translationPending)`；`linesChangedSince` 过滤 `translationPending === true`（阶段译文与未译行都不入 IndexedDB/SRT）；`reduceTranscriptUpdate` 改走 `reconcileLineTranslations`；API 模式 `bufferTranslation` 恒为 `""`。
- `extension/lib/translation-scheduler.js`：删除 `createBufferTranslation` 实例与 `scheduleBuffer`/`flushBuffer`/`cancelBuffer`/`abortStaleBuffer`/`reusePrefetched`/prefetch；`collectPending` 放行 `translation && translationPending` 的行；`waitingEntries` 接入重译限流并在被限流时 `scheduleTranslationWake`（`wakeTimer`）；`requestBatch` 发送前记 `retranslateGuards`；`applyLineTranslations` 把源文已变的响应当作阶段译文上屏（不再丢弃）、只有源文匹配时才写 `knownLines` 与历史。
- `extension/background/session-lifecycle.js`：`handleTranscriptUpdate` 去掉 buffer 相关调用；新增 `commitRuntimeLinesToHistory()`（`finalize` 里 `settle()` 之后、`historySealed` 之前把屏上阶段译文/未译行定稿写入历史，未译行记 `translationFailed`）。
- `extension/background/service-worker.js`：创建 scheduler 时移除 `partialEnabled`。
- `extension/background/settings-store.js`：`TRANSLATION_SETTING_KEYS` 移除 `translationTranslatePartial`（`caption-utils` 的 `DEFAULT_SETTINGS` 保留该字段兼容旧存储）。
- `extension/popup/popup.html` / `popup.js`：删除「半句预翻译」开关及其绑定；`_locales` 三语删 `popup_partial` / `popup_partial_hint`。
- 删除 `extension/lib/buffer-translation.js`（远端无对应单测文件，测试都在 `tests/translation-scheduler.test.js`）。

### 已执行验证
- `pnpm run verify`：281 项（1 skip）全过；`pnpm run smoke` 11 项全过。
- 测试同步：删除 4 个 buffer 送翻用例；新增阶段译文上屏/限流唤醒/`reconcileLineTranslations`/`composeLiveSource`/`shouldRetranslateLine` 用例；`asr-sessions`、`session-lifecycle`、`service-worker.restart`、`transcript-reducer` 的断言改成“未译行与阶段译文不落盘，`finalize` 补齐”。

### 行为变化（与 0.5.6 基线不同，属于 0.5.8 设计）
- 英文源槽 = 最新行 + buffer 尾部（不再用 buffer 替换整行）；`pending` 只在“屏上中文落后于源文”时为真。
- 历史与 SRT 只收“译文与源文匹配”的行；停止采集时由 `commitRuntimeLinesToHistory` 把屏上版本定格写入。
- 同一句在 `8 字符 / 400 ms` 限流窗口内只重译一次，被限流时由 `wakeTimer` 补发，不会丢更新。

### 未执行 / 待后续
- 阶段 3（回看实时跟随）、阶段 4（浮层缓动 + 版本收口）未动。
- 跨模型 `code review` 仍在全部阶段后统一做。
- 未跑真实样本探针（`.research/rebound-probe.py` 等，存在 Windows 本机栈）。

## 2026-11-04 · 移植阶段 0~1：分支基底 + DeepL 协议分支（0.5.7）+ DeepSeek 锁 `deepseek-flash`

任务书：仓库根 `plan.md`（以 `origin/master` = `c8fdab4`（v0.5.6）为唯一代码基底，逐阶段重做 0.5.7~0.5.10）。本分支 `port/0.5.10`，起点就是 `origin/master`。

### 阶段 0（分支与零冲突资产）
- 本地旧 0.5.10 线保留在 `backup/pre-merge-0.5.10`（`d97884c`）；文档改动另提交在 `master`（`353a9aa`）。
- 从备份分支检出 `.pit/pits/{chrome-uia-2caea5,dev-395f5a,dpi-unaware-python-317843}.md` 与 `paseo/{15-deepl-0.5.7,16-stage-translation-0.5.8,17-scrollback-live-0.5.9,18-overlay-bounce-0.5.10}.md`。
- `paseo/README.md` 索引表补 15~18 四行（顺接远端 `14-zero-setup-0.5.6.md`）。
- `plan.md` 随分支搬运，供后续阶段对齐。

### 阶段 1（0.5.7 DeepL + 0.5.8 DeepSeek 锁模型）
- `extension/lib/translation-api.js`：
  - `TRANSLATION_PROVIDERS` 全量补 `protocol` / `requiresModel`；`deepseek` 改 `model: "deepseek-flash"` + `fixedModel: true`；新增 `deepl` 预设（`protocol: "deepl"`、`api.deepl.com/v2`、`requiresModel: false`、`keyUrl`）。
  - 新增 `safeTranslationBaseUrl`；`normalizeTranslationSettings` 按 `requiresModel === false` 归零模型、`fixedModel` 强制预设模型（旧存储里的 `deepseek-chat` 自动归一）。
  - `resolveTranslationConfig` 补 `protocol` / `requiresModel`，DeepL 经 `deeplBaseUrl` 切 host（`:fx` Key + 地址仍是官方预设 → `api-free.deepl.com`，手改地址优先）。
  - 新增 `deeplTranslateUrl`、`buildDeepLRequestBody`（`text[]` + `target_lang` + 免计费 `context` 只放英文原文 + `show_billed_characters`）、`parseDeepLResponse`、`DEEPL_TARGET_LANG = "ZH-HANS"`。
  - 抽出 `postJson`（OpenAI / DeepL 共用超时与 AbortSignal 转发），`postChatCompletion` 退化为薄封装；新增 `translateWithDeepL`（`ZH-HANS` 被 400 拒绝时回退 `ZH` 重试一次，累计 `usage.billedCharacters`）；`translateTexts` 按 `protocol` 分流。
  - `mapHttpError` 新增 `456 -> code: "quota"`；`normalizeUsage` 补 `billedCharacters`；`translationConfigIssue` 只在 `requiresModel !== false` 时要求模型。
- `extension/lib/translation-scheduler.js`：`NON_RETRYABLE_CODES` 加 `quota`；`emptyUsage`/`addUsage`/`restore` 补 `billedCharacters`。
- `extension/popup/popup.js`：新增 `modelForPreset`；`requiresModel === false` 或 `fixedModel` 时禁用模型输入框；未知 provider 显式报错并禁用下拉（不再静默回退 DeepSeek）；DeepL 展示计费字符数（`popup_usage_characters`）与 `:fx` Key 提示；开始采集/测试按钮不再对 DeepL 强制要求模型。
- `extension/popup/popup.html`：服务商下拉新增 `deepl`。
- `extension/_locales/{zh_CN,en,zh_TW}/messages.json`：各 +5 键（`provider_deepl`、`translation_error_quota`、`popup_usage_characters`、`popup_deepl_key_hint`、`popup_provider_unknown`），三语参数集一致。
- `tests/`：`translation-api.test.js` 新增 DeepL 5 项 + DeepSeek 固定模型 1 项；把“同端点不同模型重学请求形状”改用 OpenAI 预设（DeepSeek 已锁模型，无法在同端点复现两种形状）；`caption-utils` / `service-worker.integration` / `translation-scheduler` 的 `translationApiKeys`、`translationApiKeyConfigured`、`deepseek-chat→deepseek-flash`、`usage.billedCharacters` 断言同步。

### 已执行验证
- `pnpm run verify`：语法检查 + ESLint + `tsc`（两个 project）+ 275 项单测全过（269 基线 + 6 新增，1 项 skip）。
- `pnpm run smoke`：11 项全过。

### 未执行 / 待后续
- 阶段 2（阶段译文 + 删 buffer 送翻）、阶段 3（回看实时跟随）、阶段 4（浮层缓动 + 版本收口）未动。
- 按 `plan.md` 第 4 节，跨模型 `code review` 统一在全部阶段做完后对 `origin/master..port/0.5.10` 全量 diff 执行；本阶段尚未送审。
- DeepL 尚未用真实 Key 端到端实测（单测用本地 mock server）。

## 2026-11-03 · 0.5.6：零配置（Chrome 内置识别与翻译、阿里云百炼、Windows 助手）、多语言界面、后台拆分与门禁

设计/验收记录：`paseo/14-zero-setup-0.5.6.md`。目标是终端用户装上扩展即可使用，不运行脚本、不填 Key、不要求本地显卡。

### 已修改文件
- `extension/background/`：`service-worker.js` 拆为 `settings-store.js`、`runtime-store.js`、`session-lifecycle.js`、`message-router.js`（`MESSAGE_ROUTES` 发送方策略表）、`history-sync.js`、`views.js`、`offscreen-client.js`，新增 `asr-auth.js`（百炼 Key 经 DNR 会话规则加到握手头）与 `i18n.js`。
- `extension/lib/`：新增 `translation-scheduler.js`、`transcript-reducer.js`、`translation-cooldown.js`、`caption-delta.js`、`asr-sessions.js`、`ui-model.js`、`i18n-message.js`；`translation-api.js` 固定 system prompt、记住端点请求形状、解析 `Retry-After`、新增 Chrome 内置翻译与通义千问；`glossary.js` 新增占位词保护与还原。
- `extension/offscreen/`：识别后端 `wlk` / `chrome` / `bailian`，新增 `web-speech.js`；内置翻译 RPC；ASR 套接字积压超过 64 KiB 时丢包计数。
- `extension/popup/` `extension/subtitle/` `extension/ui/i18n.js`：识别引擎选择、百炼 Key 与地域、内置翻译模型下载、DeepSeek Key 提示、Windows「启动控制服务」；全部文案改走 `chrome.i18n`。
- `extension/content/content-overlay.js`：状态与模式文案改为文案键，`OVERLAY_VERSION` 8 → 9。
- `extension/_locales/{zh_CN,en,zh_TW}/messages.json`（新增，416 条）；`extension/manifest.json`：`default_locale`、`__MSG_*__`、`optional_permissions: nativeMessaging`、0.5.5 → 0.5.6。
- `scripts/services.mjs` `scripts/local-service/`：Node 运行时取代 PowerShell 脚本（已删除）；控制服务返回 `errorCode` / `messageKey`。
- `scripts/native-host/`（新增）与 `install-windows.cmd`：Windows 本机消息助手及安装脚本，同时登记给 Chrome 与 Edge。`scripts/require-node.mjs`（新增）：Node 24.22.2 下限。
- `scripts/smoke-extension.mjs`、`.github/workflows/ci.yml`、`eslint.config.js`、`tsconfig.json`、`pnpm-workspace.yaml`：冒烟、CI 矩阵、分层 lint、`lib/` 类型检查；npm 改为 pnpm。
- `tests/`：113 项 → 269 项，新增共享 `chrome` mock、`i18n` 文案一致性测试、各新模块单测。
- `README.md`：快速开始改为零配置路径，新增识别引擎表，本地模型降为可选；`paseo/README.md`：索引与常用命令。

### 已执行验证
- `pnpm run verify`：85 个脚本语法检查、ESLint、类型检查通过，269 项单元测试全部通过；`pnpm run smoke`：11 项全部通过；CI 9 个任务通过。
- DeepSeek 前缀缓存（同一 14 次请求脚本，冷启动）：命中率 35.3% → 61.9%，未命中输入 token −35%，p50 延迟不变（约 300 ms），0 失败。
- 增量广播：稳态单次发布 97 KB → 4.6 KB。
- Chrome 155：本机识别模型安装 19 秒、首个中间结果 0.8 秒、短语偏置有效，`speech.wav` 端到端输出 8 行；内置翻译模型下载 21 秒，之后创建 73 ms、每行约 4 ms，经后台 → offscreen 测试译出「您好，欢迎来到今天的直播。」；占位词还原焚界者、神圣石、贤主，单行 18 ms。
- DNR：百炼握手头只出现在 offscreen 文档的请求上。`nativeMessaging` 为可选权限，安装扩展不出现新增权限警告。
- 多语言：`--lang=en-US` 下面板、字幕页与扩展名称为英文，`$1` 参数替换正常。

### 未执行 / 待后续
- 未在 WLK + 本地 9B 下跑固定样本验收（开发机为 Mac，没有 `.research/` 栈）；缺译、`deliveredRatio`、延迟三项需在 Windows 上复测。
- 百炼未用真实 Key 端到端测试识别与通义千问翻译。
- Windows 上需人工确认：Node 拉起 WLK / llama-server 是否闪窗口、llama-server 参数与路径、0.5.5 遗留的无 PID 文件进程、代理下断点续传、`install-windows.cmd` 登记与「启动控制服务」按钮。
- zh_TW 界面未在浏览器里查看（macOS 上 `--lang` 不生效），只经过文案一致性测试。
- `AGENTS.md` 未随本次更新（维护者文件），其中的版本号、npm 命令与测试数已过时。


## 2026-11-03 · 0.5.5：去灰化、语义单元合并、语气词三道、采集埋点

设计/验收记录：`paseo/13-subtitle-flow-0.5.5.md`。起因是实际使用反馈四条（译文整行变灰、断句导致中文不连贯、语气词被直译、切页后采集失效），前三者判定为同一条流水线的时间结构问题，统一改；第四条先埋点，按「复现再修」搁置。

### 已修改文件
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\extension\utterance.js`（新增，148 行）：`needsCompletion`（≤4 词/≤25 字符/逗号或虚词收尾）、`startsContinuation`（从属连接词 + 分词白名单）、`isSpeechShard`、`planTranslationBatch`（碎片与其完成行同批、尾部碎片 hold 2 s）。
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\extension\speech-cleanup.js`（新增，168 行）：`stripSpeechFillers`（送翻前清洗，只改发送文本）与 `polishTranslation`（上屏/落盘前清洗，两种模式共用，非空输入不返回空串）。
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\extension\caption-utils.js`：新增 `mergeCaptionFragments`（行级合并，间隔 2.0 s / 4 行 / 180 字符，沿用首行 id），常量 `FRAGMENT_*`。
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\extension\translation-api.js`：`recentTranslationContext` 支持未译行、窗口 4 行 / 480 字符、可排除当前批次；prompt 新增规则 5（片段同属一句、译文衔接不重复）与规则 6（承接 context、补足主语），规则 2 改为删除语气词/口头禅/结巴/自我打断。
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\extension\service-worker.js`：API 模式下先 `mergeCaptionFragments` 再走后续链路；`collectPendingLineTranslations` 存 `promptText` 与 `queuedAt`；`flushLineTranslations` 用 `planTranslationBatch` 选批并排除当前批 id；译文过 `polishTranslation`；buffer 翻译不再被行队列饿死（积压 >2 才让位）。
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\extension\content-overlay.js`：`.translation.stale` 全亮、dual 上一句 0.82、新增 `data-awaiting` 角落小点（700 ms 延迟出现、2.4 s 呼吸、尊重 reduced-motion）、`syncAwaitingDot` 与 teardown 清理、`OVERLAY_VERSION` 5→6。
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\extension\offscreen.js`：`audioStats` 增 `peak`/`trackMuted`，track 增 `muted`/`unmuted` 上报与 `[capture-diag]` 日志。
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\tests\utterance.test.js`（新增 10 例）、`tests\speech-cleanup.test.js`（新增 6 例）、`tests\caption-utils.test.js`（+3）、`tests\translation-api.test.js`（+3）。
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\package.json` `extension\manifest.json`：0.5.4 → 0.5.5；`AGENTS.md`：版本、113 测试、新模块、灰化/合并/prompt/节流四条规范。
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\paseo\13-subtitle-flow-0.5.5.md`（新增）：基线、判据红线、两道踩坑、验收数据、自动化验证工具、未做项。

### 已执行验证
- `npm test`：113 项全通过；`extension/*.js` 全部 `node --check` 通过。
- 基线（改动前，固定样本 100 s）：`.translation.stale` 65%、碎片行 33%、孤儿句 3、译文变化 0.42/s。
- 0.5.5 端到端（API 模式 + 本地 9B + 同一 wav）：译文 color 只有 `rgb(255,253,244)`（灰化消失）、碎片行 0~6%、孤儿句 0、中文语气词 0、译文变化 0.19~0.34/s；合并后出现整句译文（`a real Khulgurran runesmith. and riddled with excitement…` → 一条完整中文）。
- 离线对照 `.research/p1p2-offline-check.mjs`：同一组碎片，旧 prompt 输出"他找到了。"式悬空句，新 prompt 输出承接上下文的完整译句。
- 采集埋点实测：静音会话 `peak 0` 而 `deliveredRatio 0.999`；正常会话 `peak 0.62~0.87`，证明 peak 是区分两者的必要指标。

### 未执行 / 待后续
- 第四条自愈（导航后重取 streamId、热替换音频源、一键续采）未实现：用户实测已无法复现，按要求搁置；埋点已就位。
- 本地 9B 下 `data-awaiting` 出现率 80%（旧版灰化 65%），屏幕不再变灰但会慢一拍；未用云端 DeepSeek 额度复测延迟。
- 同位语（`a real Kalgurin runesmith.`）无法向前合并，仍单独成行。
- `.research/` 下自动化工具（reload-extension / start-capture / baseline-attach / config-api-mode / run-probe）为本地文件，不入库。

### 跨模型审阅（qwen3.7-plus，`review=code review`）
- 结论：无 P0/P1，可提交。它自行修了 3 个 P2（`translation-api.js` 两语句挤一行、删掉未使用的 `joinBatchSources` 及其测试、纠正 PROGRESS 里的测试数）。审计其改动：删掉的导出无任何引用，格式修复无副作用，测试数已同步为 113。
- 它违反只读约束改了文件并 `git add` 了新文件；下次审阅需在 prompt 里加更硬的约束。

### 已提交并推送
- `05408db` `feat(0.5.5): de-grey stale translations, merge ASR fragments, strip fillers`（`master` → `origin/master`，GPG Good signature，15 文件 +924/−100）。
- 提交前发现 3 个文件的行尾被 Python 改写转成 CRLF（`git diff --stat` 整文件重写），已按 HEAD 版本对齐回 LF 并复核。
- 本机 `HTTP(S)_PROXY=127.0.0.1:7897` 无监听，push 需临时走实际端口 `7891`；已记 pit（`git-push-proxy-d37de8`）。
- `82b3cb6` `docs: track AGENTS.md and the paseo design notes`：`.gitignore` 解除 `/AGENTS.md`、把 `/paseo/` 收窄为 `/paseo/evidence/`，AGENTS.md 与 16 篇 paseo 设计文档、mock server 一并入库（19 文件 +1966/−2）；`paseo/README.md` 由迁移期快照改写为文档索引页。`paseo.json` 仍留在 `.git/info/exclude`。


## 2026-10-31 · 0.5.4：术语库全链路 + 《流放之路》313 条国服词库定稿

设计/验收记录：`paseo/11-glossary-0.5.3.md`（链路）、`paseo/12-poe-glossary-0.5.4.md`（词库数据与判据）、`GLOSSARY-ISSUES.md`（框架问题复核）。两部分改动合并在 0.5.4 交付：链路由上一会话完成、词库由本会话定稿。

### 术语链路（上一会话，未提交）
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\extension\translation-api.js`：新增 `buildSystemPrompt`（部分译文提示、领域背景、术语硬约束三条按需追加）；`buildTranslationRequestBody` 用 `matchGlossaryTerms` 按当前 batch 命中后注入 `glossary` 映射，未命中且无领域提示时请求体与 0.5.3 一致；`translateTexts` 透传 `glossaryEntries` / `domainHint`。
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\extension\service-worker.js`：`translationConfig()` 附带 `glossaryEntries`、`domainHint`；新增 `buildSessionWsUrl` 把 `buildAsrContextPrompt` 结果写进 WS `?context=`（关闭术语库时删除该参数）；术语设置变更纳入 `translationSettingsChanged`。
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\scripts\local-service\server.mjs`：`POST /start` 接收 `glossary`，经 `sanitizeWlkGlossary`（去控制字符、压空白、截 4000）后传 `-Glossary`；新增 `startedGlossarySignature`，术语表变化或模式切换时补 `-Restart`；`/stop` 与异常路径清空签名。
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\extension\popup.html` `popup.js` `popup.css`：新增「术语库」折叠区（总开关、PoE 预设勾选、生效条数摘要、领域提示、自定义多行框、TXT/CSV 导入导出）；启动采集与「一键启动」前强制同步术语字段；本地服务端模式下提示需重载才能生效。
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\tests\translation-api.test.js` `tests\service-worker.integration.test.js`：+4 例覆盖提示词注入、按批命中、mock API 往返。

### 词库定稿（本会话）
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\extension\glossary-poe.js`（新增，345 行）：`POE_PRESET_ENTRIES` 313 条，覆盖世界观/种族/首领 35、职业与升华 55、通货与制作 55、核心机制 37、装备宝石药剂基底 39、基石天赋 15、技能宝石 38、终局赛季 24、顶流传奇 12、游戏模式 3。全部译名取自 `poe2db.tw/cn`（优先）与 `poedb.tw/cn` 条目页 `<title>`，分类页取同站导航，概念词用含该机制的技能/关键字页正文佐证。
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\extension\glossary.js`：删除内联的 97 条 `POE_PRESET_ENTRIES`，改为从 `glossary-poe.js` 引入（文件回落到 493 行，数据与逻辑分离）。其余逻辑未动。
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\extension\popup.html`：PoE 预设描述改为词库实际内容（节杖、引路石、符文结界、焚界者、异界图鉴、313 条）。
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\tests\glossary.test.js`：新增「shipped PoE preset matches the official Simplified Chinese client」1 例（条数 ≥300、主拼写与别名去重、target 无 `;`/换行、源词无 WLK 不可表达的 `;`/`=`/`->`、10 条国服译名抽查、ASR 预算内必须含 6 个高危专名且不得含同音错词）。
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\GLOSSARY-ISSUES.md`：追加「0.5.4 复核」表，逐条标注框架问题 1/2 已修或已规避、3/7 仍存在、4/5/6 已规避或定口径。
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\package.json` `extension\manifest.json`：0.5.3 → 0.5.4。
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\AGENTS.md` `README.md`：版本号、文档锚点、`npm test` 数量、分层表新增 `glossary-poe.js`、新增「词库数据红线」一条。
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\paseo\12-poe-glossary-0.5.4.md`（新增）：数据来源与判据、三梯队与预算实测、别名策略、剔除词、已知分歧、验证结果。

### 已执行验证
- `npm test`：92 项全通过（0.5.3 的 90 项 + 预设数据校验与多义取舍 2 项）。
- `node --check`：`extension/*.js`、`scripts/local-service/server.mjs`、`tests/*.js` 全通过。
- 词库规模与预算：313 条；`buildAsrContextPrompt` 357 字符（上限 360，装入前 35 条专名，`Wraeclast` 到 `Warrior`）；`serializeWlkGlossary` 4000 字符 / 200 对（上限 4000，恰好触顶，覆盖前约 150 条词条）。
- 真实语料冒烟（`.research/poe-041/transcripts.md` 77 行英文）：11 行命中、15 次命中，含 `Path of Exile`、`PoE2`、`dominating blow`、`convoking wand`、`bone rings`、`scepter`、`spirit`、`Isamite`、`orb of augmentation`。

### 未执行 / 待后续
- 未做浏览器实测：本次词库为纯数据改动，链路需在 Dev 浏览器或真实直播里复测一次（术语是否按预期出现在 API 请求与浮层译文）。
- 未拆 PoE 1 / PoE 2 预设包：同名不同译统一按 PoE 2 口径，若后续以一代直播为主需再评估。
- WLK 4000 字符只覆盖前约 150 条，后半截仅靠按句匹配生效；要彻底解决需取消启动参数静态全量传参（记在 `GLOSSARY-ISSUES.md` 第 3 条）。
- 未补集成测试：`server.mjs` 的术语签名重启判定与 WS `?context=` 的开关仍靠 `node --check` 与人工核对。

### 跨模型审阅（GPT-6 Luna，`review=code review`）
- 结论：有阻塞（1 个 P1），修完后可提交。完整分级表见 `paseo/12-poe-glossary-0.5.4.md` §9。
- P1（已修）：`popup.js` 导入术语文件允许 512 KB，却把序列化结果直接 `slice(0, 32 KB)`，超限会截断在词条中间且仍报「导入 N 条」。改为按整行截取，报告保留/丢弃条数，一条都放不下时直接报错不落库。
- P2（已修）：`server.mjs` 的 `startedGlossarySignature` 为 `null`（控制服务重启、WLK 仍在线）且当前词表为空时不重启，旧词表会继续生效 —— 去掉 `null` 特判，签名不符即 `-Restart`。
- P2（已修）：`Kalguur` 曾被当作 `Kalguuran` 的同义拼写（卡古兰人），会把地名误改成人群称谓，已移除别名。
- P2（已修）：测试只查主拼写重复、条数只断言 ≥300 —— 改为遍历全部 `sources` 查重并锁定 313 条。
- P2（记录不改）：`translation-api.js` 依赖 `glossary.js` 属可复用的领域纯函数（零 `chrome.*`/DOM），已在 `AGENTS.md` 分层表写明属例外。
- P2（记录不改）：`Spirit Gem`＝精神宝石、`Uncut Spirit Gem`＝未切割的精魂宝石 是解包自身不一致，词库照抄；`Breach`/`Expedition`/`Harvest`/`Ritual`/`Legion`/`Rage` 的日常词误命中用测试写死（直播语境优先）。
- 顺带修正：`Lineage Support` 改用条目页全称「血脉辅助宝石」。
- 已提交并推送：`ead7c47` `feat(0.5.4): ship the Path of Exile glossary and wire it into both engines`（GPG 签名验签 Good signature，16 文件 +1230/−101）、`d3f5e9b` 记录提交号、`e0580e9` pit 记录（`master` → `origin/master`）。`paseo/`、`AGENTS.md`、`.research/`、`test-assets/`、`chrome-profile/`、`logs/` 仍不入库。

## 2026-10-31 · 0.5.3：术语库基建（解析/匹配/序列化 + 设置字段，不含术语表内容）

设计/验收记录：`paseo/11-glossary-0.5.3.md`。范围由用户拍板：只做基建层，内置 PoE 预设留空壳，popup 面板 / 翻译注入 / ASR context / `-Glossary` 打通留到下一步。

### 已修改文件
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\extension\glossary.js`（新增，443 行）：零 `chrome.*`/DOM 纯函数。`GLOSSARY_PRESETS`（`poe` 空壳 + `domainHint`）、`parseGlossaryText`（`->`/`=>`/`=`/`,`/制表符分隔、`|` 别名、`#`/`//` 注释、引号遮罩（引号内逗号/竖线不切分）、CSV 表头跳过与引号还原、同主拼写后写覆盖）、`collectGlossaryEntries`（预设 + 自定义合并，自定义优先）、`matchGlossaryTerms`（词边界、英文复数/所有格折叠、长词优先 + 字符区间遮挡、每批 ≤24 条、正则缓存）、`buildGlossaryMap`、`buildGlossaryTermPattern`、`buildAsrContextPrompt`（仅 ASCII 英文源词，≤360 字符）、`serializeWlkGlossary`（别名展开成独立 `source -> target`，洗 `;；`，≤4000 字符）、`exportGlossaryText`（text/csv 双格式，均能原样读回）。
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\extension\caption-utils.js`：`DEFAULT_SETTINGS` 增 `glossaryEnabled`/`glossaryPresetIds`/`glossaryDomainHint`/`customGlossary`；`normalizeSettings` 增三条归一（未知/重复预设 id 丢弃、领域提示压空白截 120、自定义词条截 32 KB）；新增 `MAX_GLOSSARY_DOMAIN_HINT_CHARS`。术语字段不进 `TAB_ALLOWED_SETTING_KEYS`。
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\tests\glossary.test.js`（新增）：21 例，覆盖解析各格式、CSV 表头与引号、覆盖优先级、复数/所有格/`ies`、短词边界（`ES` 不碰 `best`/`test`）、长词遮挡（`Orb of Augmentation` 压 `Orb`）、`maxMatches`、空输入、`poe-041` 真实误听句（`Path of Excel`/`Isamite`/`dominating blow`）、ASR 提示词预算、WLK 序列化清洗与不可表达源词跳过、字面竖线、emoji 与弯引号、text/csv 往返。
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\tests\caption-utils.test.js`：+5 例（术语设置默认与非法预设 id、预算截断、`sanitizeSettingsPatch` 拦截术语字段、`settingsForBroadcast` 保留术语字段、`settingsForCaptions` 剥离 `customGlossary`）。
- `extension/service-worker.js`：`broadcastCaptionState` 与 `injectOverlay` 的 init 改用 `settingsForCaptions`，发往标签页的对象不再携带 32 KB 自定义词条（审阅 P2）。
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\package.json` `extension/manifest.json`：版本 0.5.2 → 0.5.3。
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\AGENTS.md`：首段版本与文档锚点、`npm test` 数量 57→80、分层表加 `glossary.js`、§4 增两条术语库红线。
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\paseo\11-glossary-0.5.3.md`（新增）：数据模型、解析/匹配规则、三个序列化器、空壳预设约定、真实语料验证、下一步。

### 已执行验证
- `npm test`：87 项全通过（本次 +26：`tests/glossary.test.js` 21 例 + `tests/caption-utils.test.js` 5 例）。
- `node --check`：`extension/glossary.js`、`extension/caption-utils.js`、`tests/glossary.test.js` 通过。
- 真实语料冒烟（`.research/poe-041/transcripts.md` 66 条英文行 + 对话里列出的 12 条 PoE 词条作 fixture）：10 行命中、11 次命中，含 `Path of Exile`×3 / `Path of Excel`×1 / `runesmithing`×3 / `Isamite`×2 等；1000+ 字符超长行命中 6 条不卡；`buildAsrContextPrompt` 196 字符、`serializeWlkGlossary` 316 字符，均未触顶。
- 已知不命中（设计内）：`sectors are thematically perfect`（实为 `scepters`）不靠别名纠错——`sector` 是真实英文常用词，登记别名会在其他语境误伤，留待「领域提示 + 模型纠偏」。

### 未执行 / 待后续决定
- 术语库下一步 4 项均未做（见 `paseo/11-glossary-0.5.3.md` §8）：`translation-api.js` 注入、`service-worker.js` 传词条与 WS `?context=`、`server.mjs` + `Start-Services.ps1` 的 `-Glossary` 打通与 `-Restart` 判定、popup 术语库面板。
- 预设词库内容（60~100 条）未写；360 字符 ASR 预算装不下全部专名时，需要一个「核心专名优先」的分级字段，待词条内容定稿后再选型（词条级 `core` 标记 vs 预设包级 `asrTerms[]` 短名单）。
- 跨模型审阅（GPT-6 Luna，`review=code review`）两轮完成：首轮无 P0、P1 两条 + P2 三条，全部已修；复审确认可提交，又指出两个引号遮罩边界 P2（emoji 代理对错位、弯引号误当字段引号），一并修掉并补往返用例。审阅第三条 P1（新增测试被 `.gitignore` 忽略、不会随仓库交付）成立，已把 `/tests/` 移出 `.gitignore`，测试随后续提交入库。详见 `paseo/11-glossary-0.5.3.md` §9。
- `.gitignore` 移除 `/tests/`：`tests/` 全部 7 个文件随之入库（此前自 0.4.x 起被忽略）；`paseo/`、`AGENTS.md`、`.research/`、`test-assets/` 仍为本地。
- 已提交并推送：`b30863c` `feat(0.5.3): add glossary infrastructure and track the test suite`（`master` → `origin/master`，GPG 签名验签 `G`）。`paseo/`、`AGENTS.md`、`.research/`、`test-assets/`、`chrome-profile/`、`logs/` 仍不入库。
- 未做浏览器实测：本次不含 UI 与运行时链路。`extension/glossary.js` 目前只被 `caption-utils.js` 引入两个常量（预设 id 列表、自定义词条长度上限），匹配与序列化函数尚无运行时调用者，扩展实际行为与 0.5.2 一致。

## 2026-10-31 · 0.5.2：ASR 参数、显示锁、浮层宽度、透明度滑块（Helium 实测）

设计/验收记录：`paseo/10-asr-width-opacity-0.5.2.md`。

### 已修改文件
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\scripts\Start-Services.ps1`：WLK 参数 `--buffer_trimming_sec 4→10`、`--localagreement-beam-size 1→3`、新增 `--confidence-validation`；`--asr-coalesce-min-s` 试过 0.3 后按实测回退 0.5（0.3 会让 54% 的行碎成 “The.” 级片段）。
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\scripts\local-service\server.mjs`：`/start` 接受 `translationMode` + `apiTranslationConfigured`；`api` 且已配 Key 时传 `-AsrOnly`（不启 8013），并在模式切换时先停旧服务 / 用 `-Restart` 避免 Start-Services 报错。
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\extension\caption-utils.js`：`selectDisplayCaption` 不再让新英文等旧译文（原文槽最新、译文槽保留上一句并置 `pending`）；新增 `normalizeOpacity`（域 `0.05~1`，`0` 不再被吞成默认值）。
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\extension\content-overlay.js`：新增 `.caption-stack` 承载工具栏与字幕框，`.stage` 退为定位锚点（`min(68vw, 860px)`）；canvas `measureText` 量宽 + 240~860 px 贴合、变宽立即/变窄延时 420 ms；`.translation.stale`（上一句，同字号降透明）与 `.translation.pending`（空占位）分流；`--overlay-opacity` 联动背景/边框/阴影/`backdrop-filter` 与历史面板。
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\extension\popup.html` `popup.js`：新增「不透明度」滑块（180 ms 防抖落库）；本地模型区按 API/本地模式调整文案与启停条件。
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\extension\manifest.json` `package.json`：版本 0.5.1 → 0.5.2。
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\README.md` `AGENTS.md` `paseo/10-asr-width-opacity-0.5.2.md`：文档与规范同步。
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\tests\caption-utils.test.js`：新增/改写 `selectDisplayCaption` 4 例与 `normalizeOpacity` 1 例。

### 已执行验证
- `npm test`：60 项全通过；`node --check` 覆盖 `extension/*.js`、`server.mjs`、`tests/*.js` 全通过；`Start-Services.ps1` PowerShell 解析 0 错误。
- 120 秒固定样本（`vkCu3V81N74-15m00-17m00.wav`）×3 配置，Helium + 扩展 + WLK + 本地 9B：采用配置 24 行、首英文 0.80 s、首中文 1.55 s、译文滞后 P50 1.25 s / P95 2.61 s、结束缺译 0、`Resetting buffer` 0。
- UI 实时采样（`.research/v052-ui-check.py`）：`.caption-shell` 出现 240→860 px 共 18 档随句长变化，`.stage` 固定 860 px；透明度滑块 8% → `blur(0.88px)`、86% → `blur(9.46px)`，`.translation.stale` 在 65/100 采样中生效且与上一句译文一致。

### 未执行 / 待后续决定
- 跨模型审阅（GPT-6 Luna）已完成：无 P0，1 个 P1、6 个 P2；P1 与 5 个 P2 已修并重测，剩 1 个 P2（ASR-only 下 API 失败时 popup 仍显示“实时翻译中”）记入 backlog。详见 `paseo/10-asr-width-opacity-0.5.2.md` §8。
- 最终浏览器复测在 `scripts/Start-DevBrowser.ps1`（Chrome + `chrome-profile`）上完成，未再打断 Helium 里的直播；Helium 侧由用户自行观察。
- 已提交并推送：`defe4fc` `feat(0.5.2): stop dropping ASR audio, hug the caption box, add opacity slider`（`master` → `origin/master`，GPG 签名）。`.research/`、`tests/`、`paseo/`、`AGENTS.md` 在 `.gitignore` 中，这些改动不进版本库。
- 在线直播（Twitch）只做了人眼链路，未作为转写验收源。
- 短行合并（把 “The.” 与下一行合并再翻译）未实现，需单独设计。
- Helium 自带拦截器会挡以标签页方式打开 `chrome-extension://<id>/popup.html`；该标签页若成为活动标签，点“开始”会报“此页面不支持标签页音频采集”。已记入 `.pit`（`tabcapture-97fd44`）。
- `Start-LocalService.ps1` 在本次会话两次出现“服务已起来但 PowerShell 包装进程不返回”（120 s 后才被中断），疑似脚本末尾健康轮询/句柄继承问题，与本次改动无关，未深查。

## 2026-10-31 · 重写项目级 `AGENTS.md`（参照 Sonelis Station `CLAUDE.md` 电报式极简风格）

### 已修改文件
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\AGENTS.md`：砍掉八股套话与顶层巨型四列表，压缩为 63 行（约 3.8 KB，体积缩减超 55%）电报式高密度规范，完整保留命令、代码规则、浮层/降噪阈值、分层表、三处模型同步、节流预算与安全红线。
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\PROGRESS.md`：更新进度记录。

### 已执行验证
- `npm test`：57 项测试全部通过（耗时 ~718 ms）。
- `node --check`：全量检查 `extension/*.js`、`scripts/local-service/server.mjs`、`tests/*.test.js` 语法全部通过。
- Phase 4 12 条红线自检：12/12 全部 `PASS`（83 行 ≤ 120 行上限）。

### 未执行 / 待后续决定
- 本地 GPU 端到端启动命令（`.\scripts\Start-Services.ps1`、`.\scripts\Start-LocalService.ps1`、`.\scripts\Start-DevBrowser.ps1`）属于有状态硬件/浏览器服务命令，本次仅做静态脚本路径与参数核对，未拉起常驻进程。
- `package.json` 尚未串联一键 `check` 脚本（当前仅有 `"test": "node --test tests/*.test.js"`），按约定未擅自修改 `package.json`，已在交付报告中给出补齐建议。
