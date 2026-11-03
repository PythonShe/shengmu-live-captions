# 声幕 · 实时字幕翻译

Chrome MV3 扩展。采集当前标签页的英文音频，在本机实时转写成英文并翻译成中文，以浮层叠在视频画面上。

音频只在本机流转：`tabCapture → 扩展 → ws://127.0.0.1:8010`（本地 WhisperLiveKit）。**文本**去哪里取决于翻译引擎：选 DeepSeek / OpenAI 时字幕文本会发往对应云端 API，选本地模型时不出本机。

当前版本 0.5.5。

## 快速开始

需要 Chrome、Node.js 24 LTS（24.22.2 或更新，旧版本有已公开的安全漏洞；启动脚本用）和 pnpm；本地模型推理在 Windows 上用 NVIDIA GPU，在 Apple Silicon Mac 上用 Metal（见下文「macOS」）。

```sh
# 1. 起本地服务：ASR(8010) + 本地翻译(8013)；纯 API 用法加 --asr-only 省显存
pnpm services:start

# 2. 起开发浏览器并加载扩展
pnpm dev-browser --url https://www.youtube.com/

# 3. 在目标页面按 Ctrl+Shift+Y 打开面板，点「开始实时翻译」
#    Ctrl+Shift+U 打开字幕与历史窗口
```

也可以用 `pnpm services:serve` 在后台起控制服务（`127.0.0.1:8014`），之后在面板里一键启停本地模型，不必手动敲命令；`pnpm services:serve-stop` 关掉它。`pnpm services:status` 看各端口状态，`pnpm services:stop` 停掉本地模型。

模型档位可切换：`--translation-model 9b-q4km|2b-iq4xs`、`--asr-model large-v3-turbo|medium`。全部选项见 `pnpm services help`。

本地服务的目录约定（都在 `.research/` 下，不入库）：WhisperLiveKit 源码 `WhisperLiveKit/`、虚拟环境 `wlk-venv/`（Windows 为 `Scripts\*.exe`，macOS/Linux 为 `bin/`）、llama.cpp `llama.cpp-*/`、翻译模型 `models/`。进程 PID 记在 `.runtime/`，日志在 `logs/`。模型下载走 Node 的 fetch，设置了 `HTTPS_PROXY` 会自动走代理（`SHENGMU_DOWNLOAD_NO_PROXY=1` 关闭）；`HF_ENDPOINT` 可换 Hugging Face 镜像。

### macOS

ASR 默认走 whisper.cpp（Metal 加速）。WhisperLiveKit 没有 whisper.cpp 后端，所以由它的 `openai-api` 后端把音频转给本机的 `whisper-server`（`127.0.0.1:8011`，`--inference-path /v1/audio/transcriptions`），扩展仍然只连 8010，用法不变。这条路是实验性的：whisper-server 只按句段返回词级时间戳，识别节奏可能比 Windows 上的 faster-whisper 粗。

- `whisper-server` 需要自己编译 whisper.cpp（Homebrew 的 `whisper-cpp` 不带它），放在 `.research/whisper.cpp/build/bin/` 或 PATH 里。
- ggml 模型（`ggml-large-v3-turbo.bin` / `ggml-medium.bin`）首次启动时自动下载到 `.research/models/whisper.cpp/`。
- WhisperLiveKit 仍需本项目所用的那份分支（`--openai-translation-*` 等参数只在它里面有）。
- 想换回 MLX：`SHENGMU_ASR_BACKEND=mlx-whisper pnpm services:start`。

## 字幕怎么显示

浮层默认停靠在画面下方，可拖动、可隐藏，字号与背景透明度在面板里调。

| 模式 | 内容 |
|---|---|
| 双语 | 当前句英文 + 当前句中文 |
| 双行 | 上一句中文 + 当前句英文 + 当前句中文 |
| 中文 | 只有中文译文 |
| 英文 | 只有识别出的英文 |

面板与浮层工具栏里每点一次「双语」按钮就按这个顺序切换。

几句实测行为，看懂了就不会误以为出故障：

- 新的英文片段出现后，译文槽会继续显示**上一句中文**（不做变灰处理），右下角出现一个小金点表示「这句还在翻」。等待不足 0.7 秒不会显示金点。
- 被 ASR 切碎的半句会与后一句合并成一条字幕再翻译，所以偶尔会看到一行字幕比平常长、出现得稍晚。
- 滚轮上滑可回看最近字幕，回到最底部自动恢复实时。

## 翻译引擎

| 引擎 | 位置 | 说明 |
|---|---|---|
| DeepSeek API（默认） | 云端 | 面板填 Key，响应快，文本会发往 DeepSeek |
| OpenAI API | 云端 | 同上，模型可改 |
| 自定义 OpenAI 兼容 | 自定 | 可指向本地 `llama-server`（`http://127.0.0.1:8013/v1`）或任何兼容端点 |
| WhisperLiveKit 内置 | 本机 | 面板把翻译引擎切到「本地服务」，由 WLK 调用 8013 翻译，扩展不再改写译文 |

纯 API 用法推荐 `pnpm services:start --asr-only`，显存全给 ASR。API Key 只存在本机 `chrome.storage`，不会下发给网页。

## 术语库

内置 313 条《流放之路 1/2》国服解包官译（逐条对照 `poedb.tw/cn`、`poe2db.tw/cn`），另可导入自定义词条（TXT/CSV），支持同音误听别名。术语同时作用于三处：Whisper 识别热词、WhisperLiveKit 内部词表、API 翻译提示词。

不需要游戏术语时可在面板里关掉，或只保留「领域提示」一句话。

## 安装到日常 Chrome

`chrome://extensions` → 开启开发者模式 → 「加载已解压的扩展程序」→ 选 `extension` 目录。改代码后在扩展页面点「重新加载」。

## 常见问题

- **没有字幕**：先确认 8010 在线（面板「检查本地服务」），再看面板的状态与音频电平；本地模型首次加载要几十秒。
- **字幕慢一拍**：本地 9B 单次翻译 1~3 秒，长句合并后更明显；换 DeepSeek API 会快很多。链路总延迟通常 1~3 秒。
- **浮层不见了**：可能被隐藏或页面全屏；面板里可重新注入，历史窗口始终可见。
- **切换页面后没声音**：会话绑定在开始采集时那个标签页，页面内跳转偶尔会让浏览器停掉音频流；先停止再开始一次即可。这是已知问题，诊断埋点（音频峰值、track 静音事件）已就位。
- **抓到广告/其他声音**：标签页整体音频都会被采集，无法按内容过滤。
- **DRM 内容**：Netflix 等受保护内容可能拿不到音频。

## 开发

```sh
pnpm install                 # 只装开发工具（ESLint、TypeScript），扩展本身不依赖 node_modules
pnpm run verify              # 语法检查 + ESLint + 类型检查（lib/）+ 单元测试，提交前必过
pnpm run smoke               # 无头 Chrome 加载扩展，检查后台、offscreen、面板、字幕页与浮层注入
pnpm services:start          # 本地 ASR + 翻译（scripts/services.mjs）
```

包管理器为 pnpm（版本由 `package.json` 的 `packageManager` 锁定，`corepack enable` 后自动使用）。`verify` 中各项也可单独运行：`pnpm run check`（全部脚本 `node --check`）、`pnpm run lint`、`pnpm run typecheck`、`pnpm test`。CI（`.github/workflows/ci.yml`）在每次 push 与 PR 上于 Ubuntu、Windows、macOS（x64 与 arm64）跑 `verify`，在 Ubuntu、Windows、macOS 跑 `smoke`。本地服务的启停逻辑在 `scripts/local-service/`（`service-manager.mjs`，控制服务 `server.mjs` 与命令行共用），测试用桩进程代替真实模型，任何系统上都能跑。

分层约定：`extension/` 按入口分目录（`background/`、`offscreen/`、`content/`、`popup/`、`subtitle/`），入口之间只通过 `chrome.runtime` / `chrome.storage.local` 通信；`lib/` 为纯函数模块，禁止引入 `chrome.*` 与 DOM；`storage/history-db.js` 封装 IndexedDB。设计与验收记录在 `paseo/`。

## 许可证

MIT，见 [LICENSE](LICENSE)。
