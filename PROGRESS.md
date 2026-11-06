# 项目进度记录 (PROGRESS.md)

## 2026-11-06 · 超长 ASR 行切句（连续讲话不分段）

设计与实测见 `paseo/23-long-row-segmentation.md`。

- 根因：关闭说话人分离时 WLK 只在静音处结束一行，与标点无关，`--buffer_trimming` 也管不到。
- 比原记录严重：真机上约 55 s、行长约 1250 字符时译文超过输出上限，此后不再发请求，历史里 2571 字符英文只有 338 字中文并记为失败。每次重译重发整行，发送字符是终态的 44~68 倍。
- 新发现：行活过 `--retention-seconds` 后 WLK 会裁掉开头，`start` 每帧变化，行 id 随之变化，每帧都成了一行新字幕（保留 30 s 复现：120 s 内 72 个行 id）。
- 改动：API 模式下 `lib/caption-segment.js` 把超长行切成 ≤180 字符的句子（`<id>#<序号>`），追加文本不移动已有切点；不超长的行原样通过。被裁剪的行按文本接回原 id。百炼和 Chrome 的行不会再长，`createLineAccumulator` 收到时就切好，消息窗口因此总能在句子开头裁剪。server 模式不切。未改 WLK 参数，未动浮层，所以不升 `OVERLAY_VERSION`。
- 回放（真实 WLK 帧）：`Gq2…` 1 行 2620 字符 → 20 行最长 179，发送字符 44.5× → 3.95×；`WIuIdulr…` 45.6× → 4.63×；对照 `vkCu3V81N74…` 4.5× → 2.86×。
- 真机（headless Chrome + tabCapture + WLK 0.2.26 mlx + DeepSeek，125 s）：`Gq2…` 16 行、缺译 0、失败 0、`deliveredRatio` 0.9992、首个译文 p50 2 s / p90 3 s / 最大 5 s；保留 30 s 时历史 17 行同一锚点、文本重复 0。修复前 token 更少只是因为翻译中途停了（`paseo/23` §5）。
- 验证：`pnpm run verify` 363 项（363 pass / 0 fail / 0 skip，macOS）、`pnpm run smoke` 11 项全过。
- 未验证：Windows 上的 WLK fork + faster-whisper、百炼与 Chrome 识别真机、`qwen-mt-*` 与 DeepL 切在句中的译文。

## 2026-11-05 · 0.5.12 · 百炼模型封闭下拉 + DeepL 术语库

两项 backlog 一起做，另加用户点名的 turbo 实测。基线 0.5.11（325 项 verify 前是 315）。

### 先查事实，再写代码

- 百炼翻译模型：官方现存 `qwen-mt-plus` / `qwen-mt-turbo` / `qwen-mt-flash` / `qwen-mt-lite`，都是 16k、无思考模式。实测（真实 Key、2 行真实字幕批 + terms + domains、各 5 次交错）：`qwen-mt-flash` 中位 **325 ms**、`qwen-mt-lite` **321 ms**、`qwen-mt-plus` **442 ms**，三者 5/5 返回 2 行、约 180 token；**`qwen-mt-turbo` 5/5 全是 404 `model_not_found`**（cn 地域），故不入面板白名单。全量数据 `.pr-test/probe-qwen-mt-models.json`。
- DeepL 术语库：网络上传言「API glossary 仅 Pro」，用仓库已存的 `:fx` Key 实测**免费层可用**：`POST /v2/glossaries` 201、带 `glossary_id` 翻译 `Spirit` 命中「精魂」、不带则「灵体」、`DELETE` 204。但免费层**只能存在 1 个** glossary（第二个 456 `Too many glossaries`，v3 同样 456 `Quota exceeded`）。另核实：创建必须 `source_lang: EN` + `target_lang: ZH`（root code，`ZH-HANS` 被拒），翻译时可用 `ZH-HANS` 并自动匹配 `ZH` 词典；条目大小写敏感；单条 ≤1024 字节。
- 百炼 ASR：`paraformer-realtime-v2` 的 `run-task` 里 `input` 官方写明固定 `{}`，没有 fun-asr 的 `input.context`，热词只能靠 `vocabulary_id`。按用户决定**先记入 plan 待查，本轮不实现**。

### 已修改文件

- `extension/lib/translation-api.js`：新增 `BAILIAN_TRANSLATION_MODELS`（4 项，封闭列表）并在 `normalizeTranslationSettings` 里把百炼的其它 id 归一到预设；新增 `deeplGlossaryUrl`；`buildDeepLRequestBody` 支持 `glossaryId`（自动补 `source_lang: EN`）；`translateWithDeepL` 带 `config.deeplGlossaryId`，400 提到 glossary 时去 id 重试一次。
- `extension/lib/deepl-glossary.js`（新增）：`buildDeepLGlossaryPairs`（展开 `sources[]`、追加全小写变体、丢弃含 tab/换行/非 ASCII/超长条目、同拼写先到先得）、`serializeDeepLGlossaryTsv`、`deepLGlossaryFingerprint`（FNV-1a + 条目数）。
- `extension/background/deepl-glossary-service.js`（新增）：`load/currentId/status/sync`；`chrome.storage.local.deeplGlossary` 存 `{glossaryId, fingerprint, count, updatedAt}`；`sync` 先 DELETE 旧 id 再 POST，456 映射 `glossary_quota` 并保留服务端原话。
- `extension/background/service-worker.js`：建服务、初始化时 `load()`、scheduler 的 `getConfig()` 注入 `deeplGlossaryId`、`test-translation-api` 也带同一 id、暴露 `syncDeepLGlossary` / `deepLGlossaryStatus`。
- `extension/background/message-router.js`：新增 `sync-deepl-glossary`、`get-deepl-glossary`，均 `extension-page`。
- `extension/popup/popup.html` / `popup.js`：百炼时把模型输入换成 `#translationModelSelect`（label `for` 动态切换，取值统一走 `selectedModelValue`）；术语库折叠区新增「同步到 DeepL」按钮与状态行（未同步 / 词条已变 / 已同步 N 条 + Free 只允许 1 个的说明）。
- `extension/_locales/{zh_CN,en,zh_TW}/messages.json`：各 +9 键（439 条，三语一致）。
- `package.json` / `extension/manifest.json`：0.5.11 → 0.5.12。
- 测试：`tests/deepl-glossary.test.js`（4 项，纯函数）、`tests/deepl-glossary-service.test.js`（5 项，mock storage/fetch，含 456 与 stale 判定）、`tests/translation-api.test.js` +2（白名单归一 / glossary 随请求与 400 降级）、`tests/message-router.test.js` 期望表 +2。
- 文档：`paseo/22-deepl-glossary-0.5.12.md`（新增）、`paseo/20` §6 补 4 模型实测与 turbo 404、`paseo/README.md` 索引、`README.md`（版本 + 术语库段补 DeepL）、`AGENTS.md`（版本、测试数 325、顶层键加 glossary、百炼封闭下拉、DeepL glossary 红线）、`plan.md` 重写。

### 验证

- `pnpm run verify` 325 项（324 pass / 1 skip / 0 fail）；`pnpm run smoke` 11 项全过。
- 真机（dev 9223，真实 `:fx` Key）：面板切 DeepL → 勾术语库 + PoE 预设 → 点同步 → `已同步 680 条术语到 DeepL`；CDP 抓 service worker 网络确认 `POST /v2/glossaries`（680 行 TSV、`source_lang: EN`、`target_lang: ZH`）与后续 `POST /v2/translate` 带 `glossary_id: bbeca0d7-…` + `source_lang: EN`；`GET /v2/glossaries` 显示 `shengmu-captions` / `entry_count: 680` / `ready: true`；「测试翻译 API」457 ms 正常返回。
- popup 下拉真机检查：`#translationModelSelect` 显示 4 项、`#translationModel` 隐藏、label `for` 正确。

### 未做 / 风险

- `paraformer-realtime-v2` 未实现（先查热词与断句，见 plan 第 2 节第 1 项）。
- DeepL 术语库不会自动跟随词条变更：面板只提示「词条已变化，重新同步后新术语才生效」。这是刻意取舍（Free 只有 1 个坑位，重建要删库）。
- 同步过程中先 DELETE 后 POST，中间窗口里在飞请求会带失效 id，靠 400 重试兜底；若 POST 失败则账号里暂时没有库。
- 探测脚本与原始数据在仓库外 `.pr-test/probe-deepl-glossary*.mjs`、`probe-qwen-mt-models.mjs`。

### 跨模型审阅（qwen3.7-plus · Code Review profile · 只读 worktree `shengmu-review-0512` @ `3257f54`）

范围 `42e9eac..3257f54`（23 文件 +1134/−59）：0 P0、1 P1、2 P2。

1. **P1（已修）**：`sync()` 先 DELETE 再 POST，若 POST 失败，`cached.glossaryId` 仍指向已被删掉的库 → 之后每个翻译批次都先 400 再重试，面板还显示「已同步」。改法比审阅建议更早一步：**DELETE 成功后立刻清空 `cached` 并写回存储**（这样 POST 任一种失败都不会留死 id；而 DELETE 自己失败时旧库还在，保留 id 才是对的）。新增回归测试 `a failed recreate drops the deleted id instead of keeping a dead one`（去掉修复会红，已验证）。
2. **P2（记录，不改）**：存储里旧值 `qwen-plus` / `qwen-mt-turbo` 被静默归一为 `qwen3.7-flash`，面板下拉直接显示新值、没有一次性提示。判断：这两者一个没免费额度、一个 404，回落后功能只会更好；为一次性迁移加 i18n 键与渲染分支不值得。面板值本身是可见的。
3. **P2（不是 bug）**：`deepLGlossaryFingerprint` 用 `charCodeAt` 遍历，对 surrogate pair 是确定双射；且 `usablePair` 已过滤非 ASCII 源词，输入里根本不会出现非 BMP 字符。

审阅者核实无异议的关键项：`initialize()` 的 `Promise.all` 时序安全（路由先 `await ready()`）、`deeplGlossaryId` 只被 scheduler 与 `test-translation-api` 消费、DeepL 两条降级正则（`target_lang`/`language` 与 `glossary`）互不交叉、去重顺序与 `resolveEffectiveGlossary` 一致、`TextEncoder` 在 MV3 worker 可用、popup 的 label `for` 与 `selectedModelValue` 两条保存路径都正确、三语 9 个新键占位符一致、审阅 worktree `git status` 干净且 `pnpm test` 全过。

- 修复后 `pnpm run verify` 326 项（325 pass / 1 skip / 0 fail）。

## 2026-11-05 · 用量面板（本地 90 天账本 + DeepL/DeepSeek 账号额度）

- 背景：`runtimeState.translation.usage` 只有会话内可见，`stop-capture` 会清空；面板看不到「今日/本月」和账号额度。
- 先查清楚各家能查到什么（不臆造）：DeepL 有 `GET /v2/usage`（`character_count`/`character_limit`），DeepSeek 有 `GET /user/balance`（在 `/v1` 前缀之外，只认 `*.deepseek.com`），**百炼没有用量 API**（控制台页 + `bl` CLI，需 AccessKey），OpenAI 需管理员 Key。
- 分层实现：
  - `extension/lib/usage-ledger.js`（纯函数）：按本地日 + `provider:model` 分桶、90 天保留、坏数据降级、今日/本月汇总。
  - `extension/lib/provider-usage.js`（纯函数）：端点构造（DeepL `:fx` 走 api-free、DeepSeek 去 `/v1`）与响应归一。
  - `extension/background/usage-service.js`：`chrome.storage.local.usageLedger` 读写（节流 2 s 合并）、远端查询与 5 分钟缓存、`record/flush/snapshot`。
  - `translation-scheduler.js` 新增 `recordUsage(delta, config)` 回调；`message-router` 新增 `get-usage`（仅 `extension-page`，因为返回的是账号额度）。
  - popup 新增 `#usageLedger` 一行：今日/本月 + 远端；换 provider/模型后立即强制刷新。
  - i18n 三语新增 11 个键；`AGENTS.md` 顶层键冻名单加 `usageLedger`。
- 真机修了一个 bug：远端缓存只按时间缓存，切到 DeepSeek 时把 DeepL 的 551,077 字符原样显示。现在缓存命中要求 provider 相同，并补了单测（临时去掉判据会红，已验证）。
- 实测：DeepL `551,077 / 1,000,000 字符（55%）`；DeepSeek `CNY 99.95`；百炼 `console_only`；用 DeepSeek 跑 30 s 后本地账本 `today.requests = 2 / 1041 prompt / 109 completion`（桶 `deepseek:deepseek-flash`）；面板文案三种 provider 都正确渲染。
- 验证：`pnpm run verify` 313 项（312 pass / 1 skip）、`pnpm run smoke` 11 项全过。新增 12 项单测（ledger 6、provider-usage 3、usage-service 3）。
- 文档：`paseo/21-usage-panel.md`（能力表 + 数据模型 + 刷新策略 + 已知限制）、`paseo/README.md` 索引。

### 跨模型审阅（qwen3.7-plus，Code Review profile，只读 worktree `shengmu-review-usage` @ `90d1536`）

范围 `f062750..90d1536`（19 文件）：0 P0、0 P1、6 P2，全部已修：

1. `addUsage` 用的是 `getConfig()` 而不是请求时的 config → 在途期间换 provider 会把用量记到新桶；改为 `addUsage(value, config)` 由 `requestBatch` 传入，并补了一条回归测试（改回 `getConfig()` 会红，已验证）。顺带把测试里的 `getConfig` 改成每次返回新对象，否则「设置对象共享引用」会掩盖这个 bug。
2. 远端缓存不判 apiKey / 设置变更 → `saveSettings` 里无条件 `usage.invalidateRemote()`（provider、Key、地址任一变更都可能换账号）。
3. popup 在 `await` 期间可能并发多个 `get-usage` → 加 `usageLedgerInFlight` 标志。
4. service worker 被 MV3 回收时 pending 桶会丢 → 加 `chrome.runtime.onSuspend` 调 `usage.flush()`（Chrome 不保证等完，尽力而为）。
5. `AGENTS.md` 测试数还是 284 → 改为当前实际值。
6. 关闭上面的缓存失效覆盖。

审阅者核实无异议项：拆半重试不会双重记账（拆半路径直接 `return { split: true }`）；`flushChain` 串行化正确、`flush()` 与定时器无竞争；三个 storage 键各写各的、无全量覆盖；DeepL `:fx` 路由与 DeepSeek 主机判定正确；`get-usage` 仅扩展页且不回传 Key、`usageLedger` 不会被 `settingsForBroadcast` 广播；三语 i18n 占位符与传参完全匹配。

- 修复后 `pnpm run verify` 314 项（313 pass / 1 skip）、`pnpm run smoke` 11 项全过。

## 2026-11-05 · 百炼默认模型换 `qwen3.7-flash` + 接入 `qwen-mt-*` 专用翻译协议

- 默认值：`TRANSLATION_PROVIDERS.bailian.model` 由 `qwen-plus` 改为 `qwen3.7-flash`（老别名没有免费额度，开了「用完即停」会直接报错）。只影响没存过模型的用户；已存 `qwen-plus` 的不自动迁移（用户可能是故意选的），面板里改一下即可。
- 慢的定位（先量后改）：百炼裸请求 551~589 ms，但真实链路（`SYSTEM_PROMPT` 646 字符 + context + JSON 输出）1125~1244 ms；面板测试 1488 ms。**推理是关的**——`enable_thinking: false` 时 1.04/1.14 s，传 `true` 或省略字段时 29.7~36.7 s、reasoning 近 1 万字符，这组 A/B 写进了 AGENTS.md 红线。
- 压缩 prompt 试过又回滚：9 条规则压到 6 条（646→388 字符），交替 A/B 5+5 次结果旧 1207 ms / 新 1323 ms，input token 550→406 但没有速度收益（延迟由输出 100~150 个中文字决定），不值得多改文档与测试断言，已回滚。
- 新协议：`resolveTranslationProtocol` 按模型名前缀把 `protocol` 切成 `qwen-mt`，用户在百炼的模型框里填 `qwen-mt-flash` 即生效（Key/地址不变）。新增 `buildQwenMtRequestBody`（单条 user 消息、`\n` 一行一段、`translation_options.terms/domains`、无 system）与 `parseQwenMtOutput`（按行切、行数不符抛 `count_mismatch` 进拆半重试）。无 context，跨行衔接交给模型，取舍已写入 `paseo/20` §6。
- 实测：`qwen-mt-flash` 2 行批 246~362 ms（qwen3.7-flash 同口径 1007~1370 ms）；面板测试 197/209/211 ms（原 1488 ms）；术语 `Spirit/Orb of Augmentation/Divination card` 全部命中，领域传入生效。
- 真机 120 s（WLK + `qwen-mt-flash` + `vkCu3V81N74-poe-05m15-07m15.wav`）：10 行 / 10 有译文、缺译 0、失败 0、截断 0、`deliveredRatio` 0.99916、历史 10 行一致、**首中文 avg 0.7 s / p50 <1 s**、`overlayStale` 7/120（DeepL 同口径 58/120）。译文抽查通顺，但同一段里 `tome` 出现「典籍/大部头书」两译、`Alder League`/`Alder Lake` 按 ASR 原样翻——这就是没有 context 的代价。
- 验证：`pnpm run verify` 301 项（300 pass / 1 skip）、`translation-api.test.js` 50 项（新增 5 项：协议切换、请求体形状、输出切分与错数、端到端 mock、拆半可重试）。`pnpm run smoke` 待本次提交前重跑。
- 真机环境坑：dev Chrome 重启后 `chrome.runtime.reload()` 会让页面标签消失，必须重新开 subtitle 页；页面被遮挡时 `visibilityState` 变 `hidden`，需 CDP `Page.bringToFront` 后再采集。

### 跨模型审阅（qwen3.7-plus，Code Review profile，只读 worktree `shengmu-review-mt` @ `83b92ab`）

范围 `14a96b4..83b92ab`（6 文件）：0 P0、0 P1、3 P2。三条处理结果：

1. `parseQwenMtOutput` 的 `if (stripped.length === count && …)` 不可达（`stripped.length === lines.length` 恒等，前一行已处理 `lines.length === count`）——**已删**。
2. 编号剥离会误伤「译文本身以 `3.` 开头」的行——已知取舍，**不改**，已在代码注释与 `paseo/20` §6 记明。
3. `AGENTS.md` 写 `0.20~0.36 s` 与实测 `246~362 ms` 不一致——**已改** `0.25~0.36 s`。

审阅者核实无异议的关键项：`count_mismatch` 确实进拆半重试（拆分到底后 `count <= 1` 短路，不会无限拆）；协议切换只作用于 `openai` 基础协议，DeepL/Chrome 内置不受影响，custom 端点命名 `qwen-mt-*` 也会正确切且已有测试；请求端压平内部换行与解析端一致；`terms` 走 JSON 对象无分隔符注入风险（不适用 WLK 那套 `|` 规则）；非 200 / 非 JSON / 空 content / `finish_reason=length` 各有对应 code；不注入 `enable_thinking`。

- 修复后 `pnpm run verify` 301 项（300 pass / 1 skip）、`translation-api.test.js` 50 项全过。

## 2026-11-05 · 重译限流按后端分档 + 百炼免费额度选型入库

- 拍板：主力是付费 API 且挂后台常开，按上一轮成本核算选方案 B——按后端分档，而不是全局放宽（全局放会白丢本地模型跟手度）。
- 实现：`extension/lib/caption-utils.js` 新增 `TRANSLATION_RETRANSLATE_PAID_MIN_NEW_CHARS = 24` / `_PAID_MIN_INTERVAL_MS = 1200` 与 `resolveRetranslateThrottle(config)`：配置带 `apiKey` 就是付费档，无 Key（Chrome 内置、无 Key 的自定义本地端点）保持 8 / 400。判据用户拍板为「有没有 API Key」，不按地址猜本机还是局域网。
- 接入：`extension/lib/translation-scheduler.js` 的 `shouldHoldRetranslation` 每帧从 `getConfig()` 重算档位，`scheduleTranslationWake` 的补发上限跟着档位走（原来硬编码 400 ms，若不放宽，付费档的 held 行最多 400 ms 就会被唤醒，等于分档无效）。
- 单测：`tests/caption-utils.test.js` 新增档位判据用例（空 Key / 无 Key / 全空白归免费，有 Key 归付费，同一增长量在两档下的不同结论）；`tests/translation-scheduler.test.js` 新增付费档用例（源文增长 10 字符，400 ms 时不重译且 `wakeTimer` 已挂，1200 ms 时重译并定稿）。
- 验证：`pnpm run verify` 296 项（295 pass / 1 skip）、`pnpm run smoke` 11 项全过。真机未跑（需用户启动采集），列入 plan.md 第 2 节第 4 步。
- 文档：`paseo/20-bailian-free-tier.md`（`research.md` §7 拆出：免费额度规则、默认模型 `qwen-plus` 已无额度、6 个可填模型、`qwen-mt-*` 与仅思考模式的坑、每月重置的 `paraformer-realtime-v2`），`paseo/README.md` 加索引；`AGENTS.md` 首行版本号 0.5.10 → 0.5.11，两处限流常量说明改为按后端分档。`research.md` 其余部分继续留在仓库外（untracked）。
- 仓库状态修正：`master` 相对 `origin/master` 是 ahead 5 / behind 1（上游已用 `865f0d9` 合并 PR #2）。已核对本地 `1efaa8c` 与 `865f0d9` 的 PR #2 实现与测试等价，差异全部是本地独有的 0.5.11；push 前应 merge 而非 rebase。
- 待办：merge `origin/master` → 跨模型 `code review`（含本轮分档）→ push。

### 跨模型审阅（qwen3.7-plus，Code Review profile，只读 worktree `shengmu-review-0511` @ `256fc15`）

- 范围 `865f0d9..256fc15`（17 文件 +584/−277）：0 P0、0 P1、1 P2。
- P2 已修：`extension/content/content-overlay.js` 旧 worker 降级路径把 `composeLiveSourceParts` 返回的**对象**当条件（`Boolean(source && …)` 恒真），与 `caption-utils.js` 的 `latestSource.stable` 不一致；空字幕时会误亮等待小点。改判 `source.stable`。该文件不被单测 import，靠 `node --check` + smoke 兜底。
- 审阅者核过且我复核无异议的六项：`resolveRetranslateThrottle` 判据与 `getConfig()` 返回的 `apiKey` 一致且无循环导入；付费档 `wakeTimer` 不会丢（session 不活跃时不挂，恢复时由 `scheduleLines(0)` 重评）；改设置后档位下一帧生效（旧 timer 最多多等 800 ms）；`composeLiveSourceParts` 两份实现等价且 `setSourceText` 保持 `.caption-text` = 单串；PR #2 的 `fallbackSource` 机制完整且与本轮限流正交；文档常量/版本与代码一致。
- 审阅者误判一处，已澄清：它称「line 为空 + buffer 非空时 caption-utils 判 pending=false」——实际那种情况 `stable = buffer`，两侧同为 true；真实差异只在两者都空时。

### 真机验收（2026-11-05，dev 9223 + WLK large-v3-turbo + DeepL + 新档 24/1200）

环境：新起 dev Chrome（`pnpm services.mjs dev-browser --port 9223`）、WLK pid 28288 参数与 `scripts/local-service/config.mjs` 一致（`--buffer_trimming segment --buffer_trimming_sec 10`）、`translationProvider = deepl`（Key 已存）、`asrBackend = wlk`、`translationMode = api` → 走付费档。采集用 `.pr-test/auto-capture.mjs`（CDP `userGesture` 调 `getMediaStreamId` + `start-capture`）两次都成功，不必手点 popup。

| 指标 | `vkCu3V81N74-poe-05m15-07m15.wav`（120 s） | `Gq2r7x5qgmg-poe-24m00-26m00.wav`（120 s） |
|---|---|---|
| 行数 / 有译文 | 21 / 20 | **1 / 1** |
| 缺译 / 失败 / 截断被定稿 | 0 / 0 / 0 | 0 / 0 / 0 |
| `deliveredRatio` / `peak` | 0.99993 / 0.75 | 0.99919 / 0.238 |
| 历史行数 / 截断 / 缺译 | 20 / 0 / 0 | 未落盘（未停采） |
| `overlayStale` / `overlayPending` | 58/120 / 0 | 85/120 / 0 |

- 样本 A 结论：**新档 24/1200 在真实 DeepL 链路下没有制造缺译、截断或历史不一致**，缺译 0、`deliveredRatio ≥ 0.999` 过线。
- 样本 B 是 WLK 分段问题，不是本轮回归：整段只出一行（`len 3543`、`end 0:02:44.79`、`fragmentIds` 长度 1 → 未经过客户端合并），`translationPending` 全程 true，阶段译文 1293 字符。推断为连续讲话没有 ≥1 s 停顿，`--pause-segmentation-seconds 1` 不切，`--buffer_trimming segment 10` 也没生效；本轮改动只碰限流与浮层 `pending` 判据，与 ASR 分段无交集。
- 顺带暴露的既有缺陷：一行 3543 字符会顶满 `.caption-shell` 的 70vh 与历史 2 行截断。记 backlog（guillotine：WLK 侧强制按字符/时长切段，或客户端对超长行做 `FRAGMENT_MAX_CHARS` 级切分）。
- 采集后已 `stop-capture`（`active: false`）；探针与样本均在仓库外 `.pr-test/`，原始采样 `probe-0511-throttle.json`、`probe-0511-vkCu3.json`。

## 2026-11-04 · PR #2 · 修复在途请求期间源文被覆盖导致的译文截断

- 现象：句子还在生长时发出的请求，响应回来后被当成整句的最终译文，句尾没有中文，且写入历史与 SRT。
- 根因：`collectPending` 会改写在途条目的 `source`，而每次 ASR 更新都会调用它，于是 `applyLineTranslations` 拿新源文和新源文比较，判不出过期。该问题自调度器出现就有；它也让 0.5.8 的阶段译文在真实流程里几乎不会被判为过期。旧单测在改写源文后没有调用 `scheduleLines`，所以没有测出来。
- 修复：在途条目不再改写 `source` / `promptText`。另修一处丢唤醒：worker 在第 `MAX_FLUSH_ROUNDS` 轮结束时，阶段译文行已离开队列，`release` 看不到它，现在先 `collectPending` 再判断。
- 兜底译文单独记录所属源文（`fallbackSource`）：与当前行一致时直接定稿，不再多发请求；对应较短文本时只作阶段译文，不写入历史。
- 合并行的兜底译文必须覆盖全部片段：每个片段都有服务端译文时按序拼接，缺任一片段则不提供兜底。行为变化：之前 API 失败时会把首片段的译文当整句定稿；现在该行记为翻译失败，不再把半句写进历史和 SRT。
- 修复失败后按帧重试：带阶段译文的行遇到不可重试错误（如 Key 失效）后，下一帧 `reconcileLineTranslations` 会清掉失败标记并重新标为待译，调度器也只对无译文的行检查失败记录，于是每个 ASR 帧都发一次请求（合成复现：10 帧 10 次，修复后 0 次）。现在同一源文失败后不再重发，阶段译文留在屏上且不再显示“还在翻”；行继续生长或修改翻译设置后才重新尝试。
- 验证：`pnpm run verify` 293 项全过、`pnpm run smoke` 11 项全过；新增 8 项回归测试，修复前失败。
- 合成回放（200 句逐词生长、回显翻译器，非真实音频）：延迟 600 / 1000 / 1000 / 1500 ms、ASR 步长 700 / 700 / 400 / 900 ms 时，错误行由 82 / 95 / 143 / 120 降为 0；请求数由 521 / 433 / 326 / 434 升至 802 / 689 / 475 / 630（约 1.45~1.6 倍）。
- 本机合入：先以隔离 worktree（`.pr-test/pr2`）验证（`pnpm run verify` 293 项 292 pass / 1 skip、`pnpm run smoke` 11 项全过），再 merge 进 0.5.11 工作区；代码文件全部自动合并，仅本文件冲突手工解决。合并后 `pnpm run verify` 294 项（293 pass / 1 skip）、`pnpm run smoke` 11 项全过。

### 本机真机验证（dev 9223 + tabCapture + WLK large-v3-turbo + DeepL，`test-assets/quality-samples/vkCu3V81N74-poe-05m15-07m15.wav`，各 120 s）

| 指标 | 合并版（0.5.11 + PR #2） | 旧版（`c6f54f6`，无补丁，同一音频/后端） |
|---|---|---|
| 行数 / 有译文 | 24 / 23 | 16 / 15 |
| 截断仍被定稿（`translation` 有值 + `translatedSource !== source` + 非 pending） | 0 | 0 |
| 缺译 / 翻译失败 | 0 / 0 | 0 / 0 |
| 历史落盘一致性 | 23 行，截断 0、缺译 0 | 15 行，截断 0、缺译 0 |
| `deliveredRatio` / `peak` | 0.9994 / 0.93 | 0.9992 / 0.94 |

- 真机在 DeepL 快响应下测不出两版差异：旧版把在途条目的 `source` 改写成新源文，响应回来后 `translatedSource` 正好等于新源文，探针的判据被 bug 自身掩盖；只有「译文内容覆盖度」能区分，而那是人工/模型判读，不适合做自动化回归。
- 补丁必要性改由单测证明：把 PR 新增测试跑在 `c6f54f6` 的 `extension/lib` 上，8 项失败（`a merged row's fallback covers every fragment…`、`an ASR update during a request does not pass the old answer off as final`、`a batch split in flight still sends the text of the original request`、`a worker that runs out of rounds…`、`a fallback for the shorter text does not finish a row that grew`、`a permanent failure on a stage row…`、`a stage row that failed gets one new attempt…`、reducer 的 `fragments merge into one pending row…`），换回补丁后全绿。
- 采集自动化：扩展页 `Runtime.evaluate` 带 `userGesture: true` 可以调 `chrome.tabCapture.getMediaStreamId` + `start-capture`，不必每次手点 popup；但标签页导航、Chrome 重启都会让 activeTab 失效，必须用户再按一次 `Ctrl+Shift+Y`。
- 环境坑：Git Bash 会把 `node x.mjs /quality-samples/...` 的参数改写成 `C:/Program Files/Git/quality-samples/...`，页面里表现为 `MEDIA_ELEMENT_ERROR: Media load rejected by URL safety check`，传裸文件名、脚本里拼路径即可。
- 探针与临时资产（未入库，仓库外）：`C:/Users/moule/Documents/ChatGPT/.pr-test/` 下 `probe-pr2.mjs`（采 runtimeState 行 + 浮层 DOM + IndexedDB 历史）、`auto-capture.mjs`、`reload.mjs`、`static-server.mjs`（带 Range 的 8783 静态服务器）、`old/extension`（`c6f54f6` 快照）。dev Chrome 中途自行退出一次（CDP 9223 拒绝连接，原因未定位）。

### 限流成本核算（2026-11-05，只估算不动代码，等用户决策）

PR 的核心代价是重译请求变多。本轮把「请求数」拆开重算了一遍，结论：**请求数只是表象，DeepL 按源文字符计费，钱花在「每次重译都重发整句」上**。

- 机制：`extension/lib/caption-utils.js:589-590` 的 `TRANSLATION_RETRANSLATE_MIN_NEW_CHARS = 8` / `TRANSLATION_RETRANSLATE_MIN_INTERVAL_MS = 400` 是「或」关系（`shouldRetranslateLine`，`translation-scheduler.js:219-233` 消费）。WLK 的 ASR 帧间隔本来就在 0.5~1.5 s，400 ms 恒成立，实际门槛只剩 8 字符（≈1.5 个英文词），于是几乎每帧都发一次整句。涨的是原本被这个 bug 吞掉的开销，不是新功能开销。
- 回放方法：`.pr-test/cost-estimate.mjs`（仓库外）把真机采样的每秒行快照喂给真实 `shouldRetranslateLine`，只统计「有源文」的行。1 s 采样粒度，所以是请求数下限。

| 限流档位（字符 / ms） | 请求数 | 发送字符 | 字符/终态字符 | 相对当前省 |
|---|---|---|---|---|
| 8 / 400（当前） | 85 | 9 736 | **4.27×** | — |
| 16 / 800 | 85 | 9 736 | 4.27× | 0% |
| 24 / 1200 | 60 | 5 860 | **2.57×** | 40% |
| 32 / 1500 | 60 | 5 888 | 2.58× | 40% |

（合并版 120 s、24 行、终态 2 280 字符；旧版同口径 5.19×。16/800 一分钱没省——8 字符本来就约 1.5 个词，门槛提到 16 仍被 ASR 追加跨过；要动就得一次到 24~32。）

- 成本量级（按 2026 年第三方整理的 Growth 报价：$32.50/月含 1 M 字符、超出 $27.5/1 M；官方页与现有账号套餐需另行核对）：1 h/天 → 终态 1.5 M，当前发 6.4 M（≈$148）、放宽后 3.9 M（≈$80）；2 h/天 → 3.0 M，当前 12.8 M（≈$325）、放宽后 7.7 M（≈$182）。若用的是 Developer 计划 1 M 一次性额度，当前设置约 4.7 小时烧光，放宽到 24 字符约 7.9 小时。
- 这笔冗余买到的东西：0.5.8 的阶段译文（中文跟着英文往前进）。真机那轮 73/120 帧处于 `stale`（正在显示上一版阶段译文），即近 60% 时间屏上中文慢半拍但有内容；放宽后更新粒度从 ~1.5 个词变成 4~5 个词，最坏等 1.2 s。缺译、历史正确性、最终译文质量不受限流影响（实测 0 缺译、历史 23 行全一致）。
- 三个选项：A 不动（适合本地 9B / Chrome 内置为主，成本 0）；B 按后端分档——付费 API 用 24/1200、本地 `server` 模式与 Chrome 内置保持 8/400（`shouldRetranslateLine` 已接受 options，约 10 行改动 + 单测）；C 直接全局调到 24/1200（本地模型白省、跟手度下降）。分析倾向 B，但涉及产品取舍，**本轮不实现、不改常量**。
- 决策前需要用户回答：① 日常主要用哪个翻译后端（本地 Index-Translate-9B / DeepL）；② 每天大约看多久直播（决定账单是几十还是几百美元）。
- 顺带发现：`runtimeState.usage` 里已有 `billedCharacters`（DeepL 返回的计费字符），但 `stop-capture` 收尾会清空 session，探针没抓到实测值；下轮采集应把 `usage` 一并写进采样 JSON，用实测替代估算。

### 待办
- 限流是否放宽：**暂时不决定**，见上节；需要用户先回答后端偏好与观看时长。
- 本地合并（`1efaa8c`）尚未 push，提交前按 AGENTS 送跨模型 `code review`。
- 合并版 + 本地 9B（慢翻译 1~3 s）的一轮真机采样未做（用户叫停）。

## 2026-11-04 · 0.5.11 浮层广播风视觉改版 + 英文未定稿尾巴

设计依据：`research.md` §6（ReaLingo 对比调研的三条拍板方向），落地记录 `paseo/19-broadcast-visuals-0.5.11.md`。定位浮层第一受众为「看推流画面的直播间观众」。

### 已修改文件
- `extension/content/content-overlay.js`：
  - CSS：`.stage` 新增 `--caption-sans`（HarmonyOS Sans SC→MiSans→PingFang SC→Microsoft YaHei，700）/`--caption-latin`（Inter→Segoe UI，500）/`--caption-outline-strong`（8 向 1px 黑边+底影）/`--caption-outline-soft`（4 向）；译文 `#ffffff`、英文 `rgb(180 212 244 / .92)`、上一句 `rgb(203 213 225 / .88)`、`.pending` 冰蓝 68%、`.source-stash` 56%；底板改中性黑曜石 `180deg rgb(14 18 26) → rgb(8 11 16)`，去 `saturate(.8)`、去左侧 3px 金条与 `.caption-shell::after` 金线，`border-radius: 14px` 对称 + `padding: 14px 22px`；历史面板同语言（冰蓝英文 / `#f1f5f9` 中文 / 冷灰蓝 meta chip）；等待点由暗黄改冰蓝；`<720px` 内边距 `12px 16px`。
  - JS：内联 `composeLiveSourceParts` / `composeLiveSourceText`（`composeLiveSource` 语义保持 `stable + " " + stash`）；`latestCaption()` 输出 `sourceStable`/`sourceStash`，旧 worker 只发 `source` 时整行回退为已定稿；新增 `setSourceText(stable, stash)` 把 stash 包进 `.source .caption-text > span.source-stash`（重建条件同时看内容键与子节点，防模式来回切换后空槽不恢复）；`OVERLAY_VERSION` 10 → 11。
- `extension/lib/caption-utils.js`：新增 `composeLiveSourceParts`（返回 `{ stable, stash }`）与 `composeLiveSourceText`，`composeLiveSource` 改为两者组合；`selectDisplayCaption` 返回值新增 `sourceStable`/`sourceStash`。
- `tests/caption-utils.test.js`：新增 `composeLiveSourceParts` 四项切分用例（buffer 仅重复尾巴、尾部重叠后追加、纯 buffer、纯行）；三处 `selectDisplayCaption` 断言补新字段。
- `tests/transcript-reducer.test.js`：`displayCaption` deepEqual 补 `sourceStable`/`sourceStash`。
- `package.json` / `extension/manifest.json`：0.5.10 → 0.5.11。
- `AGENTS.md` §2：`OVERLAY_VERSION` 改 11 并补 10→11 说明；新增「视觉（0.5.11 广播风）」与「英文未定稿尾巴」两条红线（字体栈、文字色不乘 `--overlay-opacity`、禁 `-webkit-text-stroke`、禁恢复金条/金线/`saturate`、`.caption-text` 的 `textContent` 必须等于 `composeLiveSource` 单串）。
- `README.md`：版本 0.5.11；等待点改「小冰蓝点」；行为列表补「英文未定稿尾巴淡一档」与「浮层按直播画面来做」两条。
- `paseo/19-broadcast-visuals-0.5.11.md`（新增）与 `paseo/README.md` 索引。

### 已执行验证
- `pnpm run verify` 286 项（285 pass / 1 skip）、`pnpm run smoke` 11 项全过。
- 可视化预览（仓库外 `C:/Users/moule/Documents/ChatGPT/.style-preview/preview.mjs`：mock `chrome.*` + 注入真实 `content-overlay.js` + CDP 截图）：5 张图覆盖双语、stash、dual+等待点、纯白压测、5% 底板；量得 `shell` 851px、英文槽恒 28px、stash 取色 `rgba(180,212,244,0.56)`、译文 9 条 text-shadow。
- 真机采集（dev 9223 + 真实 tabCapture + `GHEBkhT1K7A-05m41-07m41.wav` + wlk ASR + DeepL，`OVERLAY_VERSION` 11 已重载）：50 s + 25 s 两轮采样；stash 出现 11/25，`.source` 高度恒 28px（无假折行）、无 A→B→A 回弹、`border-radius: 14px`、译文恒 `rgb(255,255,255)`、英文 `rgba(180,212,244,0.92)`。

### 未执行 / 待后续
- `subtitle/subtitle.html` 未跟进本次视觉（用户拍板暂不动，长文阅读页保留原样式）。
- 未走跨模型 `code review`（待视觉定稿、提交前统一送审）。
- Chrome 本机识别路径未复测（本轮真机跑的是 wlk + DeepL）。
- `.style-preview/preview.mjs`、`probe-live.mjs`、`evaluate.mjs` 是仓库外的一次性可视化/采样工具，未入库。

## 2026-11-04 · 固定测试音频入库（`test-assets/quality-samples`）

- 把 `.research/quality-samples` 中的 7 个 120 s / 16 kHz 单声道 WAV（每个 3.84 MB）、3 套 VTT 与 3 个 silence 标注复制到 `test-assets/quality-samples/`（共 28 MB），并附 `README.md` 写清来源、切片、探针用法，让没有 `.research/` 的机器也能跑同一套端到端探针。
- `.gitignore`：`/test-assets/` 改为 `/test-assets/*` + `!/test-assets/quality-samples/`，`tab_capture`/`tts_lcv` 等旧资产仍只留本地；199 MB 的完整 webm 不入库。
- `AGENTS.md` 实测验收条样本路径改为 `test-assets/quality-samples/*poe*.wav`。
- 验证：`git check-ignore` 确认 `quality-samples` 不被忽略、`test-assets/tab_capture/target.wav` 仍被忽略；入库文件总 28 MB。

## 2026-11-04 · 全量跨模型审阅（`origin/master..port/0.5.10`）

审阅人同上（`Code Review` profile / `qwen3.7-plus`），快照 `a1e6268`，只读。范围 `c8fdab4..a1e6268`（41 文件 +2506/−812）。

### 结论
- **0 P0 / 0 P1**，可合入发布；1 条 P2（`composeLiveSource` 在 `content-overlay.js` 与 `lib/caption-utils.js` 各一份，改一份必改另一份——现有注释已写 “Change both or neither”，维持现状）。
- plan 第 3 节四个阶段的清单逐条核对全为“已完成”，无漏项；三个 `_locales` 键集 419 条一致；已删名字（buffer 送翻、`scrollbackSnapshot`、`translationTranslatePartial` 行为）无悬空引用，残留仅注释中的旧脚本名。

### 合入前需告知用户的行为变化
1. 历史与 SRT 不再收阶段译文：只有 `translationPending === false` 的行落盘，停采时 `commitRuntimeLinesToHistory` 定格补写。
2. API 模式不再发 buffer 请求，半句中文由成长行的阶段译文提供（8 字符 / 400 ms 限流）。
3. DeepSeek 模型锁 `deepseek-flash`，旧存储的 `deepseek-chat` 自动归一，面板模型框置灰。
4. 回看面板改 tail-follow，不再冻结打开瞬间的行。
5. 浮层高度 160 ms 缓动、英文槽单行左侧渐隐、量宽多 12 px 余量。

### 验收状态
- `pnpm run verify` 285 项（284 pass / 1 skip）、`pnpm run smoke` 11 项全过。
- 实测：阶段 3 回看 tail-follow（节点重建 0、译文 A→B→A 0）、阶段 4 bilingual/dual 两种模式（wrap rebound 0、英文槽恒 28 px、`top changes = line changes`）均达标。
- 未做：`.research/layout-synthetic.py`、server 模式浮层复测、真实 DeepL Key 的端到端（单测只用 mock server）。

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
- 跨模型审阅（`bc75dd0..0cd4bc1`）：0 P0/P1；P2 已处理（`tests/version-sync.test.js` 新增 `OVERLAY_VERSION` 为数字且 ≥10 的断言，285 项全过）；`measureShellNaturalHeight` 因依赖真实 DOM 仍未抽纯函数，记作已知取舍。
- 全量跨模型审阅（`origin/master..port/0.5.10`）待统一做。

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
