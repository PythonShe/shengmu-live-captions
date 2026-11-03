# 02 · 独立代码评审（翻译 API 接入，v0.4.0 工作区）

评审方式：只读。读取 `extension/`、`scripts/`、`tests/`、`README.md`、`manifest.json`、`package.json`，以及 `git status` / `git diff`（含未跟踪文件）。仅执行 `npm test`、`node --check`，以及在临时目录（`%TEMP%\rh`，不在项目内）用内存桩 `history-db` 复现部分路径。未修改项目代码，未 git add/commit，未启动服务或 Chrome。

> **修复状态**：本报告是评审快照（当时 35/35）。之后的修复与回归结果见 `paseo/02-review-fixes.md`；最终测试为 40/40。

**快照说明**：评审期间 `extension/service-worker.js`、`translation-api.js`、`content-overlay.js`、`popup.js`、`caption-utils.js` 与测试文件仍在被修改（最后一次变动约 22:58）。下文行号对应 22:58 左右的快照；已修复项标注“当前快照已修”，合入前请以最终代码复核。

---

## 必须修

### M1 `feiyu.test` 疑似真实 Key，且未被忽略
- 位置：项目根 `feiyu.test`（35 字节）；`.gitignore` 未覆盖。
- 原因：内容格式为 `sk-` + 32 位十六进制，与 OpenAI/DeepSeek 风格 Key 一致，不是占位符。`paseo/00-environment.md` R3 把它描述为 `{{API_KEY_…}}` 占位符，这一描述与实际内容不符。`git add -A` 会把它带进提交。
- 修法：先确认是否为有效 Key；若是，立即到服务商后台吊销并重新生成。删除该文件或移出仓库，并加入 `.gitignore`。同时更正 `paseo/00-environment.md` 的 R3 描述。
- 未输出 Key 本身。

### M2 停止收尾时，超时后的在途译文会丢失，缺译统计与最终译文不一致
- 位置：`extension/service-worker.js:952-978`（`settleTranslations`），以及 `finalizeSession`（约 1040 行起，`summarizeHistorySession` 在 settle 之后调用）。
- 原因：`settleTranslations` 到期（默认 6 s）后不会等待或中止在途的 `flushLineTranslations` 请求，直接 `applyPendingFallbacks()` 并进入汇总。在途请求随后返回时，`generation` 已在 `resetTranslationMemory` 中递增，译文被丢弃；汇总已把该行计为缺译。
- 复现（临时桩，快照约 22:50）：DeepSeek 式延迟 7 s 的单行，停止后 `stop` 在 6.0 s 返回，会话状态 `incomplete`，`translationMissing=1`；7 s 后该行历史记录仍无译文。这与 `paseo/01` 中“偶发最后一条缺译”的已知问题相符。
- 修法：停止时对在途请求调用 `AbortController`（或保留其 Promise），在 settle 截止前等待其结束；截止后中止并计入缺译，再做汇总。汇总前不得再有 `applyLineTranslations` 写入。补一条“停止时在途请求”的集成测试。

### M3 API Key 可能发往非预期端点或以明文 HTTP 发出
- 位置：`extension/translation-api.js:101`（`normalizeTranslationBaseUrl` 只校验协议为 http/https）；`extension/service-worker.js:156-169`（`saveSettings`）。
- 原因：
  - 已修：切换服务商且 patch 未带 `translationBaseUrl` 时，`saveSettings` 会重置为预设地址（当前快照已修）。
  - 未修：`translationBaseUrl` 对所有服务商共用一份。把 DeepSeek 地址改成自定义地址后，DeepSeek 的 Key 会被发往该地址；UI 没有提示。
  - 未修：任何非回环的 `http://` 地址都允许同时携带 Bearer Key，等于明文传输。
- 修法：
  - 设置存储改为按服务商保存地址（与 `translationApiKeys` 同构的 `translationBaseUrls`），或至少在地址与预设不同时弹出确认；
  - 若已配置 Key，则拒绝非回环的 `http://`（`127.0.0.1`/`localhost`/`[::1]` 除外），报错提示改用 https。
- 补测试：切换服务商后 Key 只发往对应预设地址；`http://` 远程地址带 Key 时被拒绝。

### M4 测试未覆盖问题所在的队列与停止路径，合入门槛不足
- 位置：`tests/service-worker.integration.test.js`（仅 3 个用例：get-state、save-settings 脱敏、测试连接）；`tests/translation-api.test.js`（16 个用例，覆盖纯函数与单次请求）。
- 缺口：
  - 行翻译队列：重试与退避、缺译判定、空译文槽位、条数不足、截断（`finish_reason=length`）；
  - 半句预翻译；
  - 停止收尾（含在途请求，即 M2）；
  - 0.3.x 设置迁移到 `server`（`service-worker.js:99-106`）；
  - SW 重启后从 `runtimeState` 恢复；
  - 请求体读取阶段超时（已修，缺回归用例）；
  - 切换服务商后端点（M3）。
- 修法：为上述各条各加一个用例（mock 服务可复用 `tests/translation-api.test.js` 的 `startServer`）。M2、M3 的修复应伴随对应用例。

---

## 建议修

### S1 SW 被回收后不会恢复翻译队列
- 位置：`extension/service-worker.js:87-140`（`initialize`）。
- 原因：`translationPending`、重试/防抖定时器、`knownLineSignatures` 都在内存中，回收后丢失。恢复后只有下一条 transcript 或停止时才会重新收集待译行，无新字幕时待译行会一直停着。
- 修法：`initialize()` 在恢复 `runtimeState` 且 `active` 时调用 `scheduleLineTranslations(0)`（并同样触发 buffer），并在注释中说明依赖 `runtimeState.current.lines` 重建。

### S2 `-AsrOnly` 下 WLK 已在运行时，脚本仍报告“ASR only”
- 位置：`scripts/Start-Services.ps1:145-147`，以及末尾输出对象（约 209 行起）。
- 原因：若 WLK 是之前带翻译参数启动的，`-AsrOnly` 只打印警告，输出仍写 `TranslationModel='ASR only'`，与实际不符。
- 修法：检测到已运行时抛错并提示 `-Restart`，或输出真实状态（例如 `Wlk='running (translation enabled?)'`）。

### S3 服务端模式 + `-AsrOnly` 时，每行都会计为缺译
- 位置：`extension/service-worker.js` 的 `finalizeSession`（缺译统计），`caption-utils.js:328` `lineNeedsTranslation`。
- 原因：用户选择“本地服务端”却只启动了 ASR，结束时会话被标为 `incomplete`，原因不明。
- 修法：开始采集前若 `translationMode=server` 且 8013 健康检查失败，给出明确提示；`probeServices` 结果可在 popup 中展示。

### S4 数字行回退解析可能错位
- 位置：`extension/translation-api.js`，`parseTranslationOutput`（约 328-367 行）中的 `parseNumberedLines` 回退。
- 原因：非 JSON 回答只要行数 ≥ 期望条数就被接受，`[1] …` 这类编号不在正则中，结果可能把解释性文字当译文，且按下标错位。
- 修法：回退路径要求行数与期望完全相等，否则 `count_mismatch`；编号正则补充 `\[\d+\]`。

### S5 DeepSeek 思考模式与自定义服务商组合会死路
- 位置：`extension/translation-api.js` 中 `disableThinking`（服务商预设，约 15-43 行）与 `buildTranslationRequestBody`。
- 原因：服务商选“自定义”但地址指向 `api.deepseek.com`，或使用 `deepseek-reasoner`，请求不会带 `thinking:{type:"disabled"}`，返回 `thinking_only`，UI 无开关可关。
- 修法：按 host 判断 DeepSeek 并自动关闭思考；`reasoner` 模型给出明确提示。

### S6 隐私告知缺失
- 位置：`extension/popup.html` 翻译引擎面板。
- 原因：字幕文本会发送到第三方服务商，UI 与 README 未明确说明。
- 修法：在选择非本地服务时显示一行提示（发送内容：识别出的英文字幕与少量上下文）。

### S7 工作区改动混杂，需拆分提交
- 位置：`extension/pcm-worklet.js`、`extension/offscreen.js`（超时常量）、`test-assets/tab_capture/target.html`、`extension/content-overlay.js`（失败态样式）等。
- 原因：与翻译 API 无直接关系的改动混在同一工作区；`.serena/` 未忽略。
- 修法：分拆为独立提交；`.serena/` 加入 `.gitignore`。

### S8 文档数字与事实不符
- 位置：`paseo/01-translation-api-design.md`（“25 个用例”，实际 `translation-api.test.js` 为 16 个）；`paseo/00-environment.md`（测试数 11，当前 35）；`paseo/00` R3（见 M1）。
- 修法：更新为当前数字，并在 `paseo/03-verification.md` 中记录实际运行结果。

---

## 可选

- **O1** 结束后的 settle 循环（`service-worker.js:952-978`）在失败后会立即再次调用 `flushLineTranslations`，绕过重试退避。可改为等待 `translationRetryTimer` 到期。
- **O2** `flushBufferTranslation`（`service-worker.js:881-882`）在 `translationPending.size > 0` 时整体让路。单条卡在重试中时半句预翻译会被延迟，可仅在同一行冲突时让路。
- **O3** `knownLineSignatures` 只增不减（`service-worker.js:557`、`:628`），长场次会持续增长。可在 epoch 切换或超过上限时裁剪。
- **O4** `pcm-worklet.js`：停止时不足 100 ms 的尾部音频不会发送，影响极小，可在 stop 时 flush 剩余缓冲。
- **O5** `caption-utils.js:363` `buildSrt` 对缺译行回退为英文原文，SRT 中会中英混杂。可标注或跳过，并在导出提示中说明缺译数。
- **O6** 只读/非变更消息的发送方校验不统一：`toggle-overlay`、`show-overlay`、`hide-overlay`、`open-monitor`、`probe-services`（`service-worker.js:1555-1577`）未检查 sender。页面无法直接调用这些消息，风险低，建议统一为 `isExtensionPageSender` 检查。
- **O7** `chrome.storage.local` 中的 Key 为明文，只能依赖浏览器配置目录的访问控制。README 已说明“只保存在本机”，但未提示明文存储的含义，建议补充一句。
- **O8** popup 中 Key 输入框未失焦即关闭 popup 会丢失输入（`popup.js` Key 的 change 处理，约 355-368 行）。可在 `pagehide` 时保存。
- **O9** 会话中途把模式从 API 切到服务端，待译行被静默留下未译。可在切换时计入缺译或提示。
- **O10** `max_tokens` 与 `max_completion_tokens` 的兼容已在当前快照修复（`translation-api.js:437-441`、`:541-552`）；请补回归用例。

---

## 当前快照已修复（需用测试固化）

- 请求体读取阶段超时：`translation-api.js:453-479`，`bodyText` 读取已在超时保护内。临时桩复现（headers 后 body 挂起）：修复前流水线冻结，修复后超时并进入重试。
- 输出截断：`translation-api.js:592` 检查 `finish_reason === "length"`；截断 JSON 不再回退为行解析（`:343-352`）。
- 条数不足：`translation-api.js:358-364` 返回 `count_mismatch`，不再静默补空串。
- 空译文槽位无限重试：`service-worker.js:609-613` 将空槽计入 `emptyEntries`。修复前临时桩中一条 `[MUSIC]` 会在每批中被反复发送。
- 切换服务商时地址不继承：`service-worker.js:156-169`。
- 地址中的用户名/密码与 query/hash 被拒绝或清除：`translation-api.js:104-108`。
- 广播脱敏：`caption-utils.js:110-121`，`sanitizeSettingsPatch`（`:67-75`）对非扩展页发送方只保留展示类字段。
- `content-overlay` 对失败态与待译态分开展示（当前快照）。

---

## npm test 与合入判断

- `npm test`：**35 / 35 通过**，0 失败。
- `node --check extension/*.js`：全部通过。
- 注意：测试通过不代表队列与停止路径正确；上文 M2、M4 所涉路径目前没有用例覆盖。真实 DeepSeek Key 与 Chrome 端到端链路尚未验证。

**判断：暂不建议合入。**
- 合入前必须完成：M1（处理 `feiyu.test` 并确认是否吊销 Key）、M2（停止时在途译文）、M3（端点/明文 HTTP）、M4（回归用例）。
- M1 完成前不要执行任何 `git add`，否则 Key 会进入索引。
- 上述必须项完成后，可合入代码部分；建议项可随后续提交处理，但 S7 的拆分建议在提交前完成。
