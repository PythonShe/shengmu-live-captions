# 0.5.7 · DeepL API 作为第三方翻译引擎（与本地 9B 对照）

## 1. 起因

本地 `llama-server` + Index-Translate-9B 在真实直播里两次稳定复现两种失败：

1. 输出被 `max_tokens` 撑爆，`finish_reason: "length"`，整批译文作废；
2. 批次里有行没译出来，条数与输入对不上，重试 3 次后置 `translationFailed`，直接缺译。

这两种都属于「结构化输出不可靠」，与译文质量无关。要判断到底是模型能力问题还是链路问题，需要一个**不做生成、只做翻译**的对照引擎。DeepL 的 `/v2/translate` 返回数组与输入一一对应，没有 JSON 解析环节，正好可以把「截断/漏句」这一层变量消掉。

用户决定：直接集成进扩展（popup 服务商里可切换），而不是先写离线脚本。

## 2. 与现有 OpenAI 兼容路径的差别

| 维度 | OpenAI 兼容（DeepSeek/OpenAI/自定义） | DeepL |
|---|---|---|
| 端点 | `{baseUrl}/chat/completions` | `{baseUrl}/translate` |
| 认证 | `Authorization: Bearer <key>` | `Authorization: DeepL-Auth-Key <key>` |
| 模型 | 必填，随请求下发 | 无概念，服务端自选 |
| 提示词 | system prompt 控制语气、去口头禅、接上下文 | 完全不接收 |
| 术语表 | `glossary` 字段注入命中词条 | 需先建 DeepL glossary 并传 `glossary_id`，本次未做 |
| 上下文 | `context` 数组（英文原文 + 已有译文） | `context` 单字符串，只放英文原文，不计费 |
| 输出 | 需解析 JSON，可能截断、条数错位 | `translations[]` 与输入同序同数 |
| 用量 | `usage.prompt_tokens/completion_tokens` | `show_billed_characters` 返回计费字符数 |
| 配额错误 | 402 余额不足 | 456 字符额度用尽 |

结论写在代码注释里的一句话：DeepL 拿不到提示词和术语表，能做的只有「把英文准确翻成中文」这一件事；`polishTranslation` 与 `stripSpeechFillers` 仍由扩展侧承担。

## 3. 实现

- `extension/translation-api.js`
  - provider 表新增 `deepl`，并给三个既有 provider 补 `protocol: "openai"` 与 `requiresModel: true`；DeepL 为 `protocol: "deepl"`、`requiresModel: false`。
  - `normalizeTranslationSettings`：`requiresModel === false` 时把 `model` 强制归零，避免残留的 `deepseek-chat` 跟着配置走。
  - `resolveTranslationConfig`：新增 `deeplBaseUrl()`，Key 以 `:fx` 结尾且地址仍是预设 `https://api.deepl.com/v2` 时改走 `https://api-free.deepl.com/v2`；手改过的地址优先。`translationConfigIssue` 对 `requiresModel === false` 跳过模型校验。
  - 新增 `deeplTranslateUrl`、`buildDeepLRequestBody`、`parseDeepLResponse`；`translateTexts` 在 `protocol === "deepl"` 时分流到 `translateWithDeepL`。
  - 抽出 `postJson()`（超时、外部 abort、错误文案），`postChatCompletion` 变成它的薄包装，DeepL 与 OpenAI 两条路径共用同一套超时/取消语义。
  - `parseDeepLResponse` 对空数组、条数不符、全空译文分别报错；错误码沿用 `empty_response`/`count_mismatch`/`empty_translation`，上层重试逻辑无需改动。
  - `mapHttpError` 新增 456 → `quota`。
  - `ZH-HANS` 被 400 拒绝且错误信息提到 language/target_lang 时，回退 `ZH` 重发一次（老账号只认通用代码）。
- `extension/service-worker.js`：`translationUsage` 新增 `billedCharacters` 累计（含会话恢复路径与重置路径）；`shouldRetryTranslationError` 把 `quota` 归为不可重试。
- `extension/popup.html` / `popup.js`：服务商下拉新增 DeepL；`requiresModel === false` 时禁用模型输入并给占位文案；Key 提示追加「`:fx` 结尾的旧 Free Key 会自动改走 `api-free.deepl.com`」；用量行在有计费字符时显示「N 字符」而不是 0 tokens。
- `tests/translation-api.test.js`：+5 例（host 切换与 model 归零、请求体与 context、真实 HTTP 契约与计费字符、响应校验与 456、`ZH-HANS` 回退）。`tests/caption-utils.test.js`、`tests/service-worker.integration.test.js` 的 Key 配置断言同步加入 `deepl` 键。

## 4. 端点与 Key 的事实（2026-11 核实）

- DeepL 已停止销售 API Free / API Pro 计划，新账号走 Developer（一次性免费额度）与 Growth（订阅）。
- 但**端点仍按 Key 类型分**：`:fx` 结尾的旧 Free Key 只在 `api-free.deepl.com` 有效，付费 Key 走 `api.deepl.com`。两个 host 都存在（无 Key 时均返回 403）。
- 免费额度按字符一次性计，用完不重置；一轮字幕直播按英文千字符/分钟粗估，额度消耗要自己盯着 popup 的用量行。

## 5. 验证

- `npm test`：118 项全通过（0.5.5 的 113 项 + 本次 5 项）。
- `node --check`：`extension/*.js`、`scripts/local-service/server.mjs`、`tests/*.js` 全通过。
- mock 契约：本地 `node:http` 服务断言 `POST /v1/translate`、`Authorization: DeepL-Auth-Key test-key`、`text[]` 顺序、`target_lang`、`context` 只含英文原文、`billed_characters` 累加。
- 真实调用（用户 `:fx` Key，dev 浏览器 CDP，popup 配置）：
  - 端点自动落到 `https://api-free.deepl.com/v2`，`requiresModel: false`、`issue: ""`、`enabled: true`；
  - 单句测试（`Hello, and welcome to today's live stream.`）→ `大家好，欢迎收看今天的直播。`，1301 ms；
  - 4 条真实 PoE 批次（带 1 条英文 context）→ 4 条译文、一条不差、507 ms、计费 189 字符；`ZH-HANS` 未触发回退，说明该账号接受变体代码。
  - 专名对照：`Kalguuran runesmith` → “卡尔古兰符文匠”，与词库的「卡古兰」不同 —— 验证了 DeepL 拿不到术语表这一限制。

## 6. 对比实测：GHEBkhT1K7A 快语速样本（DeepL vs 本地 9B）

方法：`yt-dlp` 下载整段音频 → `ffmpeg` 切 120 s（05:41–07:41，快语速 PoE 讲解）→ 1× 实时喂 WLK（8010）拿 29 条 ASR 行 → 丢弃 1 条 68 s/269 词的收口行 → 28 条按扩展真实批大小（≤6 行/批）分别过 DeepL 与本地 9B（`llama-server` 8013，`Index-Translate-9B` Q4_K_M），两边都带同样的前文 context。明细表：`.research/deepl-vs-9b-gheb.md`。

| 指标 | DeepL | 本地 9B |
|---|---|---|
| 批次成功率 | 5/5 | 3/5 |
| 均延迟 | 701 ms | 1281 ms |
| 失败形态 | 无 | `parse_error`（JSON 不完整）1 批、`count_mismatch`（6→5）1 批 |
| 缺译行 | 0 | 12/28 |

- DeepL 每批都按输入顺序回满条数，没有解析环节，失败只可能出现在 HTTP 层。
- 9B 的两次失败都整批作废，与之前的 P1-b（长行/长批下输出膨胀、条数对不上）一致；本对比里 9B 未过 `stripSpeechFillers`，但 prompt 仍要求删语气词，因此 #1 的 “Um, you know” 不影响结论。
- 质量差异：DeepL 倾向把半句补成完整句（“体验，仿佛在进行一项全新的活动。”），9B 保留半句（“你在做一件新活动，”）；专名两边都靠猜（`Runes of Aldur` → 艾尔德 / 奥尔德），因为 DeepL 拿不到术语表。

## 7. 已知限制 / 未做

- 术语库对 DeepL 无效：DeepL 只接受 glossary id，需要在 `POST /v3/glossaries` 建表并缓存 id，且与 313 条 PoE 词库、自定义词条的增删要同步。当前仅在 popup 里静态说明，不做注入。
- 不做 `model_type: latency_optimized`：实时字幕其实该用它，但该参数在某些计划上的可用性未核实，先不引入未知 400。
- 无 system prompt ⇒ DeepL 不会删语气词、不会补主语、不会纠同音错词，只有 `polishTranslation` 这一道兜底。
- DeepL 逐条独立翻译，`context` 只影响歧义消解，不具备 9B 那种「前后片段译文衔接」能力；碎片行的中文仍可能读起来断。
- `context` 上限按 1000 字符截断（取最近的部分），官方未给明确上限，后续真实流量再校准。

## 8. 字幕译文回跳（已在 0.5.8 修复）

> 结论与实测见 `paseo/16-stage-translation-0.5.8.md`：根因不在 buffer，而在行文本生长时抹空译文、在途译文被丢弃、以及 buffer 双轨。下面保留当时的排查记录。

切到 DeepL 后，用户实测浮层出现「临时译文闪一下 → 切回上一句 → 再闪 → 整句一次性砸进来」的循环。三次改动都没通过实测，详细数据与失败原因记在 `PROGRESS.md` 的同日条目里。要点：

- WhisperLiveKit 的 `bufferSource` 是**滑动片段**（`greatest` → `league in` → `like we actually because we`），不是累积句，因此任何「buffer 是否属于同一句」的文本相似度判据都是错的前提。
- 以前每次 buffer 变化都会 abort 在途 buffer 请求，导致 `bufferTranslation` 长期为空；这一步已改成只在整句提交时 abort，方向正确但不足以消除回跳。
- 回跳在数据层就能观察到（`displayCaption.translation` 在 `bufferTranslation` 为空时回落到上一句），但尚未采集浮层 DOM 的实际文本，不能排除渲染层叠加。
- 与 provider 无关：DeepL 只是把延迟从 1.3 s 压到 0.5 s，让循环变得肉眼可见。
