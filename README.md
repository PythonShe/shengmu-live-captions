# 声幕 · 实时字幕翻译

Chrome MV3 扩展。采集当前标签页的英文音频，在本机实时转写成英文并翻译成中文，以浮层叠在视频画面上。

音频只在本机流转：`tabCapture → 扩展 → ws://127.0.0.1:8010`（本地 WhisperLiveKit）。**文本**去哪里取决于翻译引擎：选 DeepSeek / OpenAI 时字幕文本会发往对应云端 API，选本地模型时不出本机。

当前版本 0.5.5。

## 快速开始

需要 Windows + Chrome + NVIDIA GPU（本地模型推理），以及 Node.js（启动脚本用）。

```powershell
# 1. 起本地服务：ASR(8010) + 本地翻译(8013)；纯 API 用法加 -AsrOnly 省显存
.\scripts\Start-Services.ps1

# 2. 起开发浏览器并加载扩展
.\scripts\Start-DevBrowser.ps1 -Url 'https://www.youtube.com/'

# 3. 在目标页面按 Ctrl+Shift+Y 打开面板，点「开始实时翻译」
#    Ctrl+Shift+U 打开字幕与历史窗口
```

也可以用 `.\scripts\Start-LocalService.ps1` 起控制服务（`127.0.0.1:8014`），之后在面板里一键启停本地模型，不必手动敲命令。

模型档位可切换：`-TranslationModel 9b-q4km|2b-iq4xs`、`-AsrModel large-v3-turbo|medium`。

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

纯 API 用法推荐 `Start-Services.ps1 -AsrOnly`，显存全给 ASR。API Key 只存在本机 `chrome.storage`，不会下发给网页。

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

```powershell
npm test                     # node:test，113 项
.\scripts\Start-Services.ps1 # 本地 ASR + 翻译
```

改完扩展脚本建议过一遍语法检查：

```powershell
Get-ChildItem .\extension -Filter *.js -Recurse | ForEach-Object { node --check $_.FullName }
```

分层约定：`extension/` 按入口分目录（`background/`、`offscreen/`、`content/`、`popup/`、`subtitle/`），入口之间只通过 `chrome.runtime` / `chrome.storage.local` 通信；`lib/` 为纯函数模块，禁止引入 `chrome.*` 与 DOM；`storage/history-db.js` 封装 IndexedDB。设计与验收记录在 `paseo/`。

## 许可证

MIT，见 [LICENSE](LICENSE)。
