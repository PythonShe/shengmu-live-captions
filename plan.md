# 声幕 · 基于远端 0.5.6 重做本地 0.5.7~0.5.10 迁移方案

## 1. 拍板定案

| 决策项 | 结论 |
|---|---|
| 基准分支 | 以 `origin/master`（`c8fdab4`，v0.5.6）为唯一代码基底，切新分支 `port/0.5.10` 逐阶段移植；本地原 `master`（`d97884c`）保留在 `backup/pre-merge-0.5.10` 备查 |
| 迁移范围 | 仅迁 `0.5.7`（DeepL）、`0.5.8`（阶段译文 + 英文单行 + DeepSeek 锁 `deepseek-flash`）、`0.5.9`（回看窗口实时跟随）、`0.5.10`（去 `balance` + 量宽余量 + 高度缓动），以及 `.pit/` 与 `paseo/15~18.md`；`wip/0.6.0-utterance-pause` 暂不纳入本次迁移 |
| Buffer 送翻去留 | 按 `0.5.8` 实测结论移除 API 模式下的 `buffer-translation` 独立送翻、预取复用（`reusePrefetched`）与 popup「半句预翻译」开关，统一由生长行阶段译文 + 重译限流（`8 字符 / 400 ms`）提供半句中文 |
| DeepSeek 模型策略 | 锁定 `deepseek-flash`（`fixedModel: true`，忽略存储旧值 `deepseek-chat`，popup 模型框置灰禁用），同时保留远端的 `disableThinking: true` |
| 目标版本与浮层版本 | `package.json` 与 `extension/manifest.json` 升至 `0.5.10`；`extension/content/content-overlay.js` 的 `OVERLAY_VERSION` 由远端 `9` 升至 `10` |

---

## 2. 为什么不能直接 `git merge`：远端重构与本地改动的落点映射

远端 `origin/master` 领先分叉点 `cd82964` 共 84 个提交（+19515 / −4405），已将平铺的 `extension/*.js` 拆分为分层目录，并引入全量 `chrome.i18n` 三语化（`zh_CN` / `en` / `zh_TW`）、增量字幕广播（`caption-delta.js`）、Chrome 内置翻译器与阿里百炼 ASR/翻译。直接 `git merge` 会产生 21 个冲突（含 3 个 modify/delete），本地 `0.5.7~0.5.10` 的核心改动点必须按远端新模块边界重新落位：

| 本地旧文件（`backup/pre-merge-0.5.10`） | 本地改动内容 | 远端新架构对应落点（`origin/master`） |
|---|---|---|
| `extension/translation-api.js` (+243) | 0.5.7 DeepL 协议分支、0.5.8 DeepSeek 锁定 `deepseek-flash` | `extension/lib/translation-api.js` + `extension/lib/i18n-message.js` + `extension/_locales/{zh_CN,en,zh_TW}/messages.json` |
| `extension/popup.html` (+11)<br>`extension/popup.js` (+98) | DeepL 选项、模型框按 `requiresModel`/`fixedModel` 禁用、删「半句预翻译」开关、显式报未知服务商 | `extension/popup/popup.html` + `extension/popup/popup.js` + `extension/background/settings-store.js` + 三个 `_locales` |
| `extension/caption-utils.js` (+211) | `reconcileLineTranslations`、`composeLiveSource`、`shouldRetranslateLine`、`selectDisplayCaption` 新 `pending` 语义 | `extension/lib/caption-utils.js` |
| `extension/service-worker.js` (+379/−302) | 阶段译文调度、删 buffer 送翻、生长行重译限流、阶段译文不入历史、`commitRuntimeLinesToHistory`、`billedCharacters` 统计 | 拆入 4 处：<br>1. `extension/lib/transcript-reducer.js`<br>2. `extension/lib/translation-scheduler.js`（并移除 `extension/lib/buffer-translation.js` 接入）<br>3. `extension/background/session-lifecycle.js`<br>4. `extension/background/service-worker.js` |
| `extension/overlay-history.js` (+21) | 0.5.9 `planHistoryRows(previousIds, nextIds)` | `extension/content/overlay-history.js` |
| `extension/content-overlay.js` (+419) | 0.5.8 英文单行尾部对齐 + 水平渐隐；0.5.9 回看窗口实时跟随；0.5.10 去 `balance` + 12px 余量 + 160ms 高度缓动 | `extension/content/content-overlay.js`（保留远端 `applyCaptionMessage` 增量接收、hover 绑定滚轮与 `t()` i18n） |

---

## 3. 分阶段实施计划（5 个阶段）

每个阶段完成后必须跑通 `pnpm run verify`（语法 + ESLint + `tsc` + 全量单测）与 `pnpm run smoke`，通过后再做一次独立 commit 进入下一阶段。

### 阶段 0：分支准备与零冲突资产搬运

1. **保存与切分支**：
   - 确认 `backup/pre-merge-0.5.10` 指向当前 `d97884c`。
   - 从 `origin/master`（`c8fdab4`）创建并切换到 `port/0.5.10`：`git switch -c port/0.5.10 origin/master`。
2. **搬运无冲突文档与踩坑记录**：
   - 从 `backup/pre-merge-0.5.10` 检出：
     - `.pit/pits/chrome-uia-2caea5.md`
     - `.pit/pits/dev-395f5a.md`
     - `.pit/pits/dpi-unaware-python-317843.md`
     - `paseo/15-deepl-0.5.7.md`
     - `paseo/16-stage-translation-0.5.8.md`
     - `paseo/17-scrollback-live-0.5.9.md`
     - `paseo/18-overlay-bounce-0.5.10.md`
   - 在 `paseo/README.md` 索引表追加 `15~18` 四篇文档（远端最新为 `14-zero-setup-0.5.6.md`，编号刚好顺接）。
3. **阶段门禁**：运行 `pnpm run verify`（269 项测试）与 `pnpm run smoke`（11 项），确认远端基线全绿。

---

### 阶段 1：移植 0.5.7 DeepL 引擎 + 0.5.8 DeepSeek 锁定 `deepseek-flash`

1. **`extension/lib/translation-api.js`**：
   - `TRANSLATION_PROVIDERS`：
     - 为既有 `chrome`、`deepseek`、`openai`、`bailian`、`custom` 补齐 `protocol: "openai"`（`chrome` 为 `builtin: true`）与 `requiresModel` 字段；
     - `deepseek` 预设改为 `model: "deepseek-flash"`、`fixedModel: true`（保留 `disableThinking: true`）；
     - 新增 `deepl` 预设：`id: "deepl"`、`protocol: "deepl"`、`baseUrl: "https://api.deepl.com/v2"`、`model: ""`、`requiresApiKey: true`、`requiresModel: false`、`disableThinking: false`、`keyUrl: "https://www.deepl.com/your-account/keys"`。
   - `normalizeTranslationSettings` / `resolveTranslationConfig`：
     - `preset.requiresModel === false` 时 `translationModel` 恒归零 `""`；
     - `preset.fixedModel === true` 时 `translationModel` 恒取 `preset.model`（自动将存储里的旧 `deepseek-chat` 归一为 `deepseek-flash`）；
     - 新增 `safeTranslationBaseUrl`（URL 非法时回退预设，不抛未捕获异常）。
   - DeepL 请求与响应链路：
     - 移植 `deeplBaseUrl`（Key 以 `:fx` 结尾且地址仍为官方预设时自动切 `https://api-free.deepl.com/v2`，手改地址优先）、`deeplTranslateUrl`、`buildDeepLRequestBody`（`text[]` + `target_lang` + 仅含英文原文的免计费 `context`）、`parseDeepLResponse`；
     - 抽出 `postJson` 供 OpenAI 与 DeepL 两条协议分支共用超时与 `AbortSignal`；
     - `mapHttpError` 新增 `456 -> code: "quota"`（本地化消息键 `translation_http_456`）；
     - `requestDeepLTranslation` 支持 `target_lang: "ZH-HANS"` 被 HTTP 400 拒绝时自动回退 `"ZH"` 重试一次；
     - 返回 `usage.billedCharacters`（累加 `translations[].billed_characters`）。
   - **类型与分层约束**：所有新增函数补齐 JSDoc 类型注释以通过 `tsc -p .`；错误统一使用 `LocalizedError` / `msg(...)`，不写硬编码中文。
2. **`extension/lib/caption-utils.js` & `extension/background/settings-store.js`**：
   - `DEFAULT_SETTINGS.translationApiKeys` 与 `normalizeApiKeys` 补齐 `deepl: ""`（与远端新增的 `bailian: ""` 并存）。
3. **`extension/lib/translation-scheduler.js`**：
   - `NON_RETRYABLE_CODES` 加入 `"quota"`；
   - `emptyUsage()`、`addUsage()`、`restore()` 补齐 `billedCharacters: 0` 累加与恢复。
4. **`extension/popup/popup.html`、`extension/popup/popup.js`、`extension/_locales/{zh_CN,en,zh_TW}/messages.json`**：
   - `_locales` 三语词典补齐：`provider_deepl`、DeepL `:fx` Key 提示、未知服务商报错、456 额度耗尽报错、DeepL 计费字符数用量格式等消息键；
   - `popup.html` 的 `#translation-provider` 下拉加入 DeepL `<option value="deepl">`；
   - `popup.js`：移植 `requireProviderPreset` / `modelForPreset`；当 `preset.requiresModel === false` 或 `preset.fixedModel === true` 时禁用 `#translation-model` 输入框；未知 provider 时显式报错并禁用下拉，不静默回退 `deepseek`；用量行在 `billedCharacters > 0` 时展示计费字符数。
5. **单测更新**：
   - 移植 `tests/translation-api.test.js` 的 DeepL 5 项测试与 `deepseek-flash` 固定模型测试（适配远端 `errorMessage` / `renderWith` 断言方式）；
   - 更新 `tests/caption-utils.test.js`、`tests/service-worker.integration.test.js` 中的 `translationApiKeys` 结构断言。
6. **阶段门禁**：`pnpm run verify` + `pnpm run smoke` 全绿。

---

### 阶段 2：移植 0.5.8 阶段译文单调递进 + 英文单行组合 + 移除 Buffer 送翻

1. **`extension/lib/caption-utils.js`**：
   - 移植 `reconcileLineTranslations(rawLines, previousLines, options)`：
     - 为每行维护 `translatedSource`（当前 `translation` 对应的英文源文快照）；
     - 源文变长时保留上一版 `translation` 并置 `translationPending = true`，不清零；
     - `mergeCaptionFragments` 合并行时记录 `fragmentIds`，合并单元超 180 字符裂开时首行与新尾行按 `fragmentIds` 承接旧译文，杜绝倒退回短译文。
   - 移植 `composeLiveSource(lineSource, bufferSource)`：最新行英文与 `bufferSource` 尾部拼接（词级重叠去重）。
   - 更新 `selectDisplayCaption(current)`：
     - 译文槽只读最新行 `translation`（含阶段译文），移除 `bufferTranslation` 抢槽逻辑；
     - `lineId` 恒取 `latestLine.id`；
     - `source` 槽改为 `composeLiveSource(latestLine?.source, current.bufferSource)`；
     - `pending` 定义为 `Boolean(latestLine && (latestLine.translationPending || (latestLine.source && !latestLine.translation)))`，`bufferSource` 非空不再触发 `pending`。
   - 移植 `shouldRetranslateLine(entry, currentSource, now)`：导出 `TRANSLATION_RETRANSLATE_MIN_NEW_CHARS = 8`、`TRANSLATION_RETRANSLATE_MIN_INTERVAL_MS = 400`。
2. **`extension/lib/transcript-reducer.js`**：
   - `reduceTranscriptUpdate` 改用 `reconcileLineTranslations`（支持从 `previous.lines` 与 `knownLines` 取历史状态）；
   - API 模式下 `bufferTranslation` 恒为 `""`；
   - `lineSignature(source, translation, translationPending = false)` 纳入 `Boolean(translationPending)`；
   - `linesChangedSince(lines, knownLines)` 过滤掉 `line.translationPending === true` 的行（阶段译文不入 IndexedDB 历史与 SRT，待 `translationPending` 转 `false` 时自动落盘）。
3. **`extension/lib/translation-scheduler.js`（及 `extension/lib/buffer-translation.js`）**：
   - 移除 `createBufferTranslation` 实例、`prefetch` / `reusePrefetched`、`scheduleBuffer` / `flushBuffer` / `cancelBuffer` / `abortStaleBuffer`（删除 `extension/lib/buffer-translation.js` 与 `tests/buffer-translation.test.js`，或保留空壳视引用而定；推荐直接删除并清理 import，保持代码干净）；
   - `collectPending()`：
     - 放行 `!line.translation || line.translationPending` 的行；
     - 已入队行在 `line.source !== existing.source` 时更新 `existing.source` 与 `existing.promptText = stripSpeechFillers(line.source)`，重置 `attempts = 0`，保留 `existing.requestedSource` 与 `existing.lastRequestedAt`；
   - `waitingEntries()` & 重译限流：
     - 对已有阶段译文（`line.translation && line.translationPending`）的等待项，调用 `shouldRetranslateLine(entry, line.source, now())`；
     - 若返回 `hold: true`，启动 `wakeTimer` 在 `waitMs` 后补调 `scheduleLines(0)`，不丢弃更新；
   - `requestBatch()`：发请求前记录 `entry.requestedSource = entry.source`、`entry.lastRequestedAt = now()`；保留远端的 `TRANSLATION_LINE_CONCURRENCY = 2`、分半重试 `isSplittableTranslationError` 与共享 `cooldown`；
   - `applyLineTranslations()`：
     - 当响应返回时若 `line.source !== entry.source`（请求期间 ASR 行又变长了）：不再 `continue` 丢弃！只要 `entry.source.length >= (line.translatedSource || "").length`，就将 `text` 作为**阶段译文**写入 `line.translation`，置 `translatedSource: entry.source`、`translationPending: true`，更新 `queued.source = line.source` 并触发 `publishCaptions`（不调 `enqueueHistory`，不从 `pending` 删除），随后 worker 下一轮继续按限流重译最新源文；
     - 当 `line.source === entry.source` 时：置 `translationPending: false`、`translatedSource: entry.source`，写入 `knownLines` 与 `enqueueHistory`，并从 `pending` 移除。
4. **`extension/background/session-lifecycle.js` & `extension/background/service-worker.js`**：
   - `handleTranscriptUpdate` 去掉 `scheduler.abortStaleBuffer()` 与 `scheduler.scheduleBuffer()`；
   - 新增并暴露 `commitRuntimeLinesToHistory()`：在 `finalize` 的 `scheduler.settle()` 之后、`history.flush(true)` 之前，将 `store.state.current.lines` 中仍带 `translationPending` 的行置为 `translationPending: false`（无译文的置 `translationFailed: true`），通过 `linesChangedSince` 补写进 `history.record(...)`，确保停止采集时屏上的阶段译文不会丢失；
   - `service-worker.js` 创建 `scheduler` 时移除 `partialEnabled`。
5. **`extension/popup/popup.html`、`extension/popup/popup.js`、`extension/background/settings-store.js`**：
   - `popup.html` 与 `popup.js` 删除 `#translation-translate-partial` 复选框及其读写绑定；
   - `settings-store.js` 的 `TRANSLATION_SETTING_KEYS` 移除 `"translationTranslatePartial"`（`caption-utils.js` 的 `DEFAULT_SETTINGS` 保留该字段以兼容旧存储）。
6. **单测更新**：
   - `tests/caption-utils.test.js`：移植阶段译文、分裂承接、`composeLiveSource`、`shouldRetranslateLine` 用例；
   - `tests/transcript-reducer.test.js`、`tests/translation-scheduler.test.js`、`tests/service-worker.integration.test.js`：对齐阶段译文上屏、限流唤醒、阶段译文不入历史、`finalize` 落盘的断言。
7. **阶段门禁**：`pnpm run verify` + `pnpm run smoke` 全绿。

---

### 阶段 3：移植 0.5.9 滚轮回看窗口实时跟随（tail-follow）

1. **`extension/content/overlay-history.js`**：
   - 新增纯函数 `planHistoryRows(previousIds, nextIds)` → 返回 `{ order, added, removed }`，并挂入 `ShengmuOverlayHistory` 导出。
2. **`extension/content/content-overlay.js`**：
   - 保留远端 0.5.6 的增量字幕解码 `applyCaptionMessage`、hover 按需绑定 wheel 监听（`syncWheelListener`）与 `t()` i18n 文案；
   - `HISTORY_API` 降级 shim 补齐 `planHistoryRows`；
   - 删除 `scrollbackSnapshot` 与 `renderedScrollbackKey`，改用 `scrollbackRows = []`；
   - 移植 `historyRowText`（双语模式下未译行不重复印英文）、`createHistoryRow`（挂 `data-line-id`）、`patchHistoryRow`（仅在文本或 class 真变时写 DOM）、`syncScrollbackRows`（按 `planHistoryRows` 原地增删改节点）、`clearScrollbackRows`；
   - `renderScrollback` 每帧从 `scrollbackEntries()` 取最新 `scrollBack` 行（排除正在生长的实时尾行），只在行集合或文本真变时重算 `scrollTop` 与 `.overflowing`；滚到 `scrollBack = 0` 时隐藏面板、清空行节点并设 `wheelCooldownUntil`。
3. **单测更新**：
   - `tests/overlay-history.test.js`：移植 `planHistoryRows` 的 3 组单测。
4. **阶段门禁**：`pnpm run verify` + `pnpm run smoke` 全绿。

---

### 阶段 4：移植 0.5.10 浮层换行与高度缓动 + 0.5.8 英文单行样式 + 版本收口

1. **`extension/content/content-overlay.js`**：
   - **0.5.8 英文单行槽位**：
     - `.source` 固定单行（`max-height: 1.38em`）、交叉轴 `align-items: flex-end` 使溢出落在左侧、`.source.overflowing` 用水平 `to right` 渐隐；
     - `markCaptionOverflow` 同时检查垂直溢出（`rect.height - element.clientHeight > 1`）与水平溢出（`rect.width - element.clientWidth > 1`）；
     - 旧 worker 兼容分支同步新规则并内联 `composeLiveSource`，删除 `sameUtterance`。
   - **0.5.10 消除折行回弹与高度瞬跳**：
     - CSS：删掉 `.translation` 与 `.prev-translation` 的 `text-wrap: balance`；`.caption-stack` 去掉常驻 `transition: width`，仅保留 `.caption-stack.shrinking` 的 `170ms` 宽度过渡；`.caption-shell` 增加 `transition: height 160ms cubic-bezier(0.22, 1, 0.36, 1)`，并在 `.caption-shell.resizing` 下强制 `.prev-translation, .translation { flex: 0 0 auto; }`；
     - JS 常量：新增 `SHELL_WIDTH_SLACK_PX = 12`、`SHELL_HEIGHT_RESIZE_LOCK_MS = 200`、`SHELL_HEIGHT_EPSILON_PX = 2`；
     - JS 函数：`measureShellWidth` 加上 `SHELL_WIDTH_SLACK_PX`；`applyShellWidth(width, animate)` 仅在缩窄时挂 `.shrinking`；新增 `measureShellNaturalHeight` 与 `syncShellHeight`（从可见槽位文本盒求和算自然高度，变化 `< 2px` 忽略，变化时写内联高度并挂 `.resizing` 200ms 后重算 `refreshCaptionOverflow`）；
     - 生命周期：`buildOverlay`、`teardown` 清理 `shellShrinkTimer` / `shellWidthSettleTimer` / `shellHeightResizeTimer` 并复位 `shellWidthPx` / `shellHeightPx`；`handleWindowResize` 同步调用 `syncShellHeight(false)`；
     - `OVERLAY_VERSION` 由 `9` 升为 `10`。
2. **版本与文档收口**：
   - `package.json`、`extension/manifest.json`：`"version": "0.5.10"`；
   - `AGENTS.md`、`README.md`、`paseo/01-translation-api-design.md`：合并远端 0.5.6（分层目录、`node scripts/services.mjs`、内置翻译/百炼 ASR、i18n）与本地 0.5.7~0.5.10（DeepL、阶段译文、回看实时跟随、高度缓动、`OVERLAY_VERSION = 10`）的规范说明。
3. **阶段门禁**：`pnpm run verify` + `pnpm run smoke` 全绿。

---

## 4. 端到端实测与审阅门禁（全部阶段完成后执行）

1. **防缓存重载（必做，pit `dev-395f5a`）**：
   - 停止 dev 浏览器，清理 `chrome-profile/Default/Service Worker` 与 `chrome-profile/Default/Code Cache`，带 `--disable-features=CalculateNativeWinOcclusion` 重启 dev 浏览器并确保页面 `visibilityState === "visible"`。
2. **真实样本与探针验收**：
   - `.research/layout-synthetic.py`：长句↔短句切换、四模式切换、缩窄 420ms 延时 + 170ms 过渡、内联高度与实测高度一致；
   - `.research/rebound-probe.py`：跑固定样本 `GHEBkhT1K7A-05m41-07m41.wav` 与 `Gq2r7x5qgmg-poe-24m00-26m00.wav`（DeepL 后端），确认译文/英文 `A→B→A = 0`、同一文本折行回弹 `= 0`、缺译 `= 0`；
   - `.research/scrollback-live-probe.py`：滚轮上滑打开历史面板采样 60s，确认新行实时滑入、DOM 节点重建 `= 0`、`A→B→A = 0`、滚回底部面板隐藏。
3. **跨模型代码审阅（AGENTS.md 硬约束）**：
   - 在独立 workspace + 独立 worktree 上交由 `code review` 模型审阅 `origin/master..port/0.5.10` 全量 diff；
   - 修复全部 P0 / P1 问题并复测通过后，再将 `port/0.5.10` 合回 `master`。
