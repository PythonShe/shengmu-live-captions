# 01 · 翻译 API 接入设计（v0.4.0）

## 需求

给「声幕」Chrome 扩展增加翻译 API 接入能力，默认使用 DeepSeek；保留原有本地 WhisperLiveKit + Index-Translate-9B 链路。

验收口径：

1. 新安装默认 `API + DeepSeek`（`deepseek-chat`，`https://api.deepseek.com/v1`）。
2. 控制面板可选择 `API 翻译` 或 `本地服务端`；API 下可选 DeepSeek / OpenAI / 自定义 OpenAI 兼容端点。
3. 实时字幕在 API 模式下能拿到中文译文，写入浮层、字幕窗口和历史；失败可重试，最终仍无译文时计入“缺译”。
4. API Key 只保存在本机扩展存储，不广播给内容脚本，不进入日志、history、SRT。
5. 本地服务继续可用；0.3.x 升级用户不会被强制切换到缺 Key 的 API 模式。

## 关键决定

### 为什么在扩展侧翻译，而不是只改 WLK 启动参数

WhisperLiveKit 的 `--openai-translation-url` 是**服务启动参数**，WebSocket 会话不能覆盖。若只在 `Start-Services.ps1` 里把 URL 指向 DeepSeek：

- 用户在插件里看不到、也改不了 Key / 模型 / 端点；
- 换服务商必须重启服务；
- 与“插件支持多家翻译 API”的需求不符。

因此采用扩展侧实现，WLK 只负责 ASR。为省显存，`Start-Services.ps1` 新增 `-AsrOnly`：不启动 8013 的 9B 模型，也不给 WLK 传 `--target-language` / `--translation-backend`。

### 为什么保留“本地服务端”模式

- 0.3.x 用户已配置好本地链路，升级后不能直接坏掉；
- 离线 / 不想产生 API 费用时仍可用；
- 端到端回归时可以只改翻译层，隔离 ASR 变量。

`initialize()` 做一次性迁移：如果 `chrome.storage.local.settings` 已存在且没有 `translationMode` 字段，则置为 `server`。新安装没有旧 settings，保持默认 `api/deepseek`。

### 翻译流水线

```
tabCapture → offscreen PCM → WLK ASR
                              │  lines: [{id,start,end,text}]（-AsrOnly 时无 translation）
                              ▼
                 service-worker.handleTranscriptUpdate
                    │
                    ├─ 本地服务端模式：直接使用 WLK 的 translation / buffer_translation
                    │
                    └─ API 模式：
                         ├─ 丢弃服务端译文，保存为 fallbackTranslation
                         ├─ 行级队列（去重、按 id 合并、最多 6 条/批）
                         │    └─ POST {baseUrl}/chat/completions
                         ├─ buffer 半句预翻译（可关，450ms debounce，1.2s 最小间隔）
                         ├─ 成功：更新 runtimeState.current、history、浮层/窗口
                         └─ 失败：重试（1.2s/3s，最多 3 次）→ 服务端 fallback → 标记缺译
```

行级队列按 `line.id` 去重；同一条 ASR 行在定稿前可能多次变长，取最新 source。请求回来后校验 `line.source === entry.source`，source 已变化则丢弃旧译文，避免错位。

`buffer_translation` 只在文本变化时请求；响应回来时再次比对当前 buffer，防止旧译文覆盖新半句。

### 并发与生命周期

- 行翻译串行（`translationFlushPromise`），避免并发打爆 429。
- buffer 翻译在有待译行时让路；同一时刻最多一个 buffer 请求，新 buffer 到来会 abort 旧请求。
- `translationGeneration` 在开始/结束时自增，旧请求或旧回调不能写入新场次。
- 停止时 `settleTranslations(15s)`（大于默认 API 超时 12s）：取消 buffer、强制冲刷行队列、超时后用 fallback 收尾，再走原有 `flushPendingHistory` 和缺译统计。
- Service worker 被回收后，待译行可以从 `runtimeState.current.lines` 重建；已完成的译文通过 `knownLineSignatures` 与运行时行保留，不会退回空白。

### 安全

- `translationApiKeys` 是 `{deepseek, openai, custom}` 映射，按服务商分别保存。
- 所有对外广播（content script、subtitle 窗口、popup 的 get-state/get-settings、save-settings 返回值、overlay 初始化）统一走 `settingsForBroadcast()`：剥离 Key，只给 `translationApiKeyConfigured` 布尔值。
- Popup 的 Key 输入框永远不回填；留空表示“保持不变”，另有“清除 Key”。
- Key 不进 URL、不进日志、不进 history/SRT；`fetch` 只放在 `Authorization` 头里。
- 切换服务商时端点重置为预设；手动改端点会清空该服务商 Key，强制重新输入。
- 配置了 Key 时拒绝非回环 `http://`，避免明文传输；本机回环允许。
- Key 以明文存放在 `chrome.storage.local`，依赖 Windows 账户与 Chrome 配置目录的访问控制。
- `host_permissions` 原本已有 `<all_urls>`，没有为了外网 API 扩大权限。

### 错误处理

| 场景 | 行为 |
| --- | --- |
| API 模式但缺 Key / 缺模型 | 开始采集前直接报错，提示去“翻译引擎”配置或切本地服务端 |
| 401/403 | 不重试，显示“Key 无效或无权限”；若有服务端 fallback 则先顶上 |
| 402 | 不重试，显示“余额不足” |
| 429 / 5xx / 网络 / 超时 | 重试 2 次（1.2s、3s），仍失败则 fallback |
| 返回空内容 / 无法解析 | 重试，最终 fallback / 缺译 |
| 条数不足 / JSON 截断 / finish_reason=length | 报错并重试；截断停止重试，避免按错下标写入 |
| 某个槽位返回空译文 | 该行标记为失败并显示缺译，不再无限重发阻塞后续行 |
| DeepSeek 拒绝 `thinking` 参数 | 自动去掉 `thinking:{type:"disabled"}` 重试一次 |
| 模型只返回 `reasoning_content` | 报“只返回思考内容”，提示关思考或换模型 |

DeepSeek 默认可能开启思考模式，思考会吃掉 `max_tokens` 导致 `content` 为空，因此默认对 DeepSeek 发 `thinking: {type:"disabled"}`；对不认识的端点则靠 400 重试兜底。

### 显示与状态

- `runtimeState.translation = {mode, provider, model, enabled, usage, error}`，popup 显示本次请求次数和 token 数。
- 错误同时写入 `current.translationError`，浮层和字幕窗口沿用既有错误展示。
- API 模式下服务端若仍在翻译（未用 `-AsrOnly`），其译文只作为失败 fallback，不会闪现后又被 API 覆盖。

## 改动清单

新增：

- `extension/translation-api.js`：OpenAI 兼容客户端、provider 预设、请求构造、解析、错误映射、测试连接。
- `tests/translation-api.test.js`：翻译客户端用例（本地 mock HTTP server）。
- `tests/service-worker.integration.test.js`：后台消息、Key 脱敏、content script 权限、真实 mock 请求。
- `paseo/mock-openai-server.mjs`：无 Key 手工联调。

修改：

- `extension/caption-utils.js`：翻译设置默认值/校验、`settingsForBroadcast()`。
- `extension/service-worker.js`：迁移、API 流水线、停止收尾、探针、测试消息、广播脱敏。
- `extension/popup.html/css/js`：翻译引擎面板、Key 输入/清除、测试连接、用量。
- `extension/history-db.js`：session 记录翻译模式/服务商/模型。
- `scripts/Start-Services.ps1`：`-AsrOnly`。
- `README.md`、`manifest.json`、`package.json`：文档与版本 0.4.0。

## 非目标

- 不做语音级实时同传（仍是 ASR 定稿 + 文本翻译）。
- 不实现多语言目标（当前固定中文）。
- 不做云端 Key 托管、团队共享或计费统计。
- 不改 `.research` / WhisperLiveKit / 本地模型。

## 手工验收

无 Key：

```powershell
node paseo/mock-openai-server.mjs
# 扩展：翻译引擎 = API 翻译，服务商 = 自定义兼容 API
# API 地址 = http://127.0.0.1:8787/v1，模型 = mock-translate
# 点“测试翻译 API” → 应显示【模拟译文】...
```

ASR-only：

```powershell
.\scripts\Start-Services.ps1 -AsrOnly
# 8013 不应监听；8010 正常；扩展用 API 模式采集字幕
```

真实 DeepSeek：

1. 在 popup 填 DeepSeek Key，点“测试翻译 API”。
2. `-AsrOnly` 启动，打开一个英文直播/本地测试页，开始采集。
3. 检查浮层中文、字幕窗口历史、缺译数、请求次数/token。
