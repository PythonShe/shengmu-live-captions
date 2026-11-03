# 0.5.6 零配置：识别与翻译后端、Windows 助手、多语言界面与工程化

目标只有一条：终端用户装上扩展就能用，不需要运行任何脚本、不需要填 Key、不需要本地显卡。0.5.5 之前的最短路径是「装 Node 和 PowerShell 脚本 → 起 WhisperLiveKit 与本地 9B → 再开扩展」，对没有 NVIDIA 显卡的用户等于不可用。

本篇覆盖 0.5.6 的全部改动。顺序是先做工程化（拆后台、换 Node 运行时、补门禁），再做零配置主线（Chrome 内置识别与翻译、阿里云百炼、Windows 本机消息助手），最后做界面多语言。

## 1. 工程化

### 1.1 后台拆分

`background/service-worker.js` 原先一个文件承担设置、会话、调度、历史、视图与消息分发。拆成：

| 模块 | 职责 |
|---|---|
| `settings-store.js` | 设置缓存、迁移、Key 安全规则、会话 ASR 参数 |
| `runtime-store.js` | 运行态的唯一所有者与持久化 |
| `session-lifecycle.js` | 开始、停止、收尾、重启恢复 |
| `message-router.js` | `MESSAGE_ROUTES` 表：每种消息声明允许的发送方 |
| `history-sync.js` / `views.js` / `offscreen-client.js` | 历史写入、浮层与窗口、offscreen 文档 |
| `lib/translation-scheduler.js` / `lib/transcript-reducer.js` | 纯函数层，可单测 |

拆分中顺带修掉的真实缺陷：双击「开始」会留下孤儿会话；会话结束后再收到 stop 会二次收尾；收尾后迟到的转写会写进已封存的历史；Service Worker 重启后丢失停止原因；offscreen 文档未就绪时消息被丢弃；ASR 套接字积压时实时音频无限排队（改为超过 64 KiB 丢包并计数）。

### 1.2 Node 运行时替代 PowerShell

本地服务的启停、下载、控制服务全部改为 Node（`scripts/services.mjs`、`scripts/local-service/`），删除 `Start-Services.ps1` 等脚本；Windows、macOS、Linux 共用一份逻辑。控制服务只绑回环、校验 `Host` 与 `Origin`，`/start` 与 `/download` 并发返回 409。

Node 下限定为 24.22.2（Node 24 LTS 当前最新版，旧版本有已公开的安全漏洞），由 `package.json` 的 `engines` + pnpm `engineStrict`、`scripts/require-node.mjs`（服务与安装脚本第一行引入）和 CI 的 `check-latest` 三处共同保证。

### 1.3 门禁

`pnpm run verify` = 全部脚本 `node --check` + ESLint（按层限定全局变量）+ `tsc --checkJs`（只查 `lib/`）+ 单元测试；`pnpm run smoke` 用无头 Chrome 加载扩展，检查后台、offscreen、面板、字幕页、浮层注入和本机消息助手的扩展 ID 查找。CI 在 Ubuntu、Windows、macOS（x64 与 arm64）跑 verify，在三个系统跑 smoke。单元测试从 0.5.5 的 113 项增加到 258 项。

## 2. 翻译链路

### 2.1 提示词前缀缓存

DeepSeek 等服务按请求前缀命中缓存。0.5.5 把领域提示、partial 说明等按需拼进 system prompt，前缀随批次变化。0.5.6 让 system prompt 固定不变，可变内容全部放进 user 消息的 JSON 字段。

实测（2026-11-03，DeepSeek `deepseek-chat`，同一段 14 次请求的 PoE 脚本，按 旧、新、新、旧 顺序各跑一轮，每轮加随机前缀保证冷启动）：

| 指标 | 0.5.5 | 0.5.6 |
|---|---|---|
| 缓存命中率（冷） | 35.3%（2432/6887） | 61.9%（4736/7645） |
| 缓存命中率（热） | 37.5% | 65.8% |
| 未命中输入 token | 4455 | 2909（−35%） |
| p50 延迟 | 约 300 ms | 约 300 ms |
| 失败 | 0 | 0 |

### 2.2 失败处理

- 记住每个端点接受的请求形状（是否接受 `thinking`、`temperature`、`max_tokens` 字段名），被 400 拒绝后降级重试一次并缓存结论。
- 429 / 503 的 `Retry-After` 解析为 `retryAfterMs`，行队列与 buffer 翻译共用一个冷却，不再各自撞限流。
- 条数不符、JSON 截断这类「批次形状」错误把批次对半拆开重试；鉴权、余额、配置错误不重试。

### 2.3 增量广播

0.5.5 每次发布把整个字幕窗口广播给扩展页面与标签页。0.5.6 只发变化的行（`lib/caption-delta.js`），接收方按序号检测丢包后请求全量。稳态下单次发布从 97 KB 降到 4.6 KB（−95%）。

## 3. 零配置主线

### 3.1 识别后端

offscreen 文档按设置 `asrBackend` 选择后端，三者都适配成 WhisperLiveKit 的消息形状（`lib/asr-sessions.js` 的 `createLineAccumulator`），转写归并、调度与历史不感知后端：

| 后端 | 实现 | 术语 |
|---|---|---|
| `chrome`（新装默认） | `SpeechRecognition`，`processLocally`，`start(track)` 直接吃标签页音轨 | `phrases` 短语偏置（ASCII，最多 100 条） |
| `bailian` | 阿里云百炼 `fun-asr-realtime`，WebSocket 双工协议，`task-started` 之后才送音频 | `context` 上下文提示（400 字符） |
| `wlk` | 原 WhisperLiveKit 链路 | 不变 |

百炼的 Key 不进消息：后台用 `declarativeNetRequest` 会话规则（id 8101）给握手请求加 `Authorization` 头，规则限定 `initiatorDomains` 为本扩展、`tabIds: [-1]`、资源类型 websocket；会话结束或开始失败都会撤销规则。

Chrome 155 实测（offscreen 文档内）：

- 本机英语模型 `downloadable` → `install` 用时 19 秒；`start(MediaStreamTrack)` 可用，首个中间结果 0.8 秒。
- `install()` 与内置翻译一样需要用户手势（模型为 `downloadable` 时），offscreen 文档没有手势，所以由面板在点「开始」时同时发起语音与翻译两个模型的下载，offscreen 只等待下载完成。
- Microsoft Edge 156（Chromium 内核）没有 Google 的本机语音模型，`processLocally` 对任何语言都返回 `unavailable`，内置翻译则可用；面板分别提示缺的是哪一半。
- 短语偏置有效（Searing Exarch、Divine Orbs、Maven 识别正确）；没有标点，一段话说完才给长句。
- 端到端：英文样本 `speech.wav` 经标签页采集、本机识别，输出 8 行字幕。
- DNR 规则验证：offscreen 文档的握手带上了 `Authorization`，扩展标签页与普通网页发起的同一地址请求都不带。

### 3.2 Chrome 内置翻译

`Translator` 只存在于文档里，后台通过 offscreen 文档 RPC（`builtin-translate`）调用。模型状态为 `downloadable` 时创建必须有用户手势，所以由面板在点「开始」或「测试」时调用 `ensureBuiltinTranslator()` 下载（实测 21 秒），之后 offscreen 内创建 73 ms、每行约 4 ms，无需手势。

译文偏直译（farm → 耕种、drop → 下降），也不看上下文，所以面板在使用内置翻译时提示「填一个 DeepSeek Key」，一键切换。

术语不能直接预替换成中文：把「Searing Exarch」先换成「焚界者」再整句翻译，模型会把夹杂的中文当成噪声改写（实测出现过「火锅」）。改为先换成 24 个无意义拉丁占位词（Zorvex、Quellix……），翻译后按大小写不敏感匹配换回官译；任何一行丢了占位词就去掉术语重翻这一行。实测焚界者、神圣石、贤主三条全部正确还原，单行 18 ms。

### 3.3 通义千问

翻译提供方新增 `bailian`（OpenAI 兼容模式，默认 `qwen-plus`），与百炼识别共用一个 Key。端点由 `bailianRegion`（中国内地 / 国际）推导、不落库：落库的话切换地域会触发「改 baseUrl 清 Key」规则，把共用的 Key 清掉。

### 3.4 Windows 本机消息助手

扩展页面不能启动本地进程，原来必须先在终端执行 `pnpm services:serve`。0.5.6 在 Windows 上提供本机消息助手 `com.shengmu.live_captions`（`scripts/native-host/`）：

- 用户双击 `install-windows.cmd`。安装脚本从 Chrome 与 Edge 各渠道配置的 `Secure Preferences` / `Preferences` 里按扩展目录找到已加载的扩展 ID，把助手清单写进 `%LOCALAPPDATA%\Shengmu\native-host`，再同时登记到 `HKCU\Software\Google\Chrome\NativeMessagingHosts` 与 `HKCU\Software\Microsoft\Edge\NativeMessagingHosts`。未打包扩展的 ID 由目录决定，两个浏览器里相同，所以一份清单即可；`--uninstall` 两处都撤销。
- 没有用 manifest `key` 固定 ID：加了 `key` 会改变已安装用户的扩展 ID，旧的设置与历史随之失联。
- `nativeMessaging` 放在 `optional_permissions`，点「启动控制服务」时才申请。实测安装扩展时不出现任何新增权限警告。

### 3.5 新装默认值

新装默认识别 `chrome`、翻译 `chrome`，开箱即用；已有安装由 `migrateLegacySettings` 保持原来的 WLK 与 API 设置不变。面板按所选后端只显示相关区块（本地模型、连接、翻译模式只在 WLK 下出现）。

## 4. 界面多语言

使用 `chrome.i18n`：`_locales/zh_CN`（`default_locale`）、`en`、`zh_TW`，共 414 条文案。界面语言跟随 Chrome 的显示语言；翻译提示词、术语数据与译文目标语言（简体中文）不变。

- `lib/` 不能访问 `chrome.*`，所以只返回文案键与参数（`lib/i18n-message.js` 的 `msg(key, ...params)`，参数可以嵌套另一条文案，例如提供方名称），或抛出携带文案的错误；页面、后台、offscreen 与浮层各自渲染。运行态里的 `detail`、`translationError` 存渲染后的文本。
- 本地控制服务在原中文 `error` / `message` 旁增加 `errorCode` / `messageKey` 与参数，命令行与旧版扩展仍读中文文本。
- HTML 保留简体中文原文并加 `data-i18n*` 属性，默认语言首帧无需替换。
- zh_TW 由 OpenCC `s2twp` 转换后，按 Chrome 繁中界面用语修正（擴充功能、權限、即時、「」），品牌名保持「声幕」。
- `tests/i18n-catalog.test.js` 检查三份文案的键与 `$n` 参数一致、代码引用的键都存在、没有无人使用的键；测试里的 `chrome.i18n` 读真实 zh_CN 文案，原有中文断言保持有效。
- 实测：Chrome 以 `--lang=en-US` 启动时，面板、字幕页与扩展名称均为英文，`$1` 直接写在文案里可正常替换。

浮层 DOM 有变化，`OVERLAY_VERSION` 8 → 9。

## 5. 验证结果

- `pnpm run verify`：85 个脚本语法检查通过，ESLint 与类型检查通过，单元测试 258 项全部通过。
- `pnpm run smoke`：11 项检查全部通过。
- CI：9 个任务（三系统 verify，含 macOS x64 与 arm64，以及三系统 smoke）通过。

## 6. 未做 / 需在 Windows 上复核

开发机为 Apple Silicon Mac，没有 `.research/` 下的 WhisperLiveKit 与本地模型，以下几项未能实测：

- **固定样本验收**：`.research/quality-samples/*poe*.wav` 在 WLK + 本地 9B 下的缺译数、`deliveredRatio`、延迟（`paseo/03-verification.md` 口径）。
- **百炼**：协议与 DNR 规则已在本机验证，但没有用真实百炼 Key 跑过端到端识别与通义千问翻译。
- **Windows 本地服务**：Node 运行时拉起 WLK 与 llama-server 时是否闪控制台窗口；llama-server 参数与路径；0.5.5 遗留的无 PID 文件进程能否被识别；代理下模型下载断点续传。
- **Windows 本机消息助手**：双击 `install-windows.cmd` 能否找到扩展 ID 并登记；面板「启动控制服务」能否拉起 8014。CI 只覆盖了扩展 ID 查找（含 Edge 配置目录）与登记计划。
- **zh_TW**：macOS 上 `--lang` 不生效，繁中界面没有在浏览器里看过，只经过文案一致性测试。
