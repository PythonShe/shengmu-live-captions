# 08-local-model-0.5.0 · 控制面板一键启动本地模型

需求来源：用户在 0.4.3 之后指出控制面板缺少「一键启动本地模型 + 状态提示，没有本地模型时给下载链接和选择框」。
实现版本：0.5.0（`package.json`、`extension/manifest.json`）。
验证环境：项目专用 Chrome 156（CDP 9223，未打包扩展 `dfjobgemgohmbmnagcpcneledbacpmoj`）、WhisperLiveKit 8010、llama.cpp 8013、本地控制服务 8014、RTX 4070 SUPER。
交叉审阅：Qwen3.7 Plus（paseo 子代理，只读），结论「不能直接提交」，P0 1 项 + P1 2 项 + P2 3 项 + P3 4 项，全部处理。

> 结论：功能完成。控制面板可一键拉起 ASR + 本地翻译、切换 9B/2B 与 turbo/medium、缺失模型给下载页与代下进度；控制服务未启动时给出可复制命令。

## 1. 需求与决策

| 决策点 | 用户选择 |
| --- | --- |
| 启动范围 | ASR + 翻译全链路（不是只起翻译服务） |
| 启动机制 | 新增本地控制服务（HTTP），popup 按钮直连；扩展不能创建本地进程 |
| 选择框内容 | 翻译模型（9B Q4_K_M / 2B IQ4_XS）+ ASR 尺寸（large-v3-turbo / medium） |
| 模型缺失 | 给 Hugging Face 链接 + 控制服务代下并显示进度 |

## 2. 实现

新增：

- `scripts/local-service/server.mjs`：Node 原生 http，绑定 `127.0.0.1:8014`。
  - `GET /health`、`GET /status`（ASR/翻译在线状态、翻译模型别名、job、下载进度、日志尾部）、`GET /models`（档位、是否已下载、HF 链接）、`POST /start`、`POST /stop`、`POST /download`。
  - 只接受 `origin` 以 `chrome-extension://` 开头的请求；无 `origin` 时再看 `sec-fetch-site`，为 `cross-site` 的（跨站 `<img>`/`<link>` 探测）一律 403。
  - `/start` 先比对运行中的翻译模型别名，不一致时先调 `Stop-Services.ps1` 再拉起，避免「端口被旧模型占用」。
  - 下载用系统 `C:\Windows\System32\curl.exe`（继承 `HTTPS_PROXY`），先写 `.part` 再 rename；`HEAD` 取最后一段 `content-length` 作为总量；残留 `.part` 大于等于总量时先删，避免 416 死锁。
- `scripts/Start-LocalService.ps1` / `Stop-LocalService.ps1`：后台起停控制服务，写 `scripts/local-service/server.pid`（已 gitignore）与 `logs/local-service.*.log`。
- popup「本地模型」区块（`popup.html` / `popup.css` / `popup.js`）：状态徽标（全部在线/启动中/启动失败/控制服务未连接）、ASR 与翻译在线状态、两个下拉、缺失模型提示 + 下载页 + 代下进度条、一键启动/停止、控制服务离线时的可复制命令与「重新检测」、实际运行模型与所选不同时的切换提示。

改造：

- `scripts/Start-Services.ps1`：新增 `-TranslationModel`（`9b-q4km` / `2b-iq4xs`）、`-TranslationModelPath`、`-AsrModel`；预设映射写在这里作为单一事实来源；WLK 就绪等待 180 s → 600 s（首次使用未缓存 ASR 模型需下载）；启动 WLK 前设置 `HF_HUB_DISABLE_XET=1`。
- `extension/caption-utils.js`：新增 `LOCAL_TRANSLATION_MODELS` / `LOCAL_ASR_MODELS` 枚举与 `localTranslationModel` / `localAsrModel` 设置归一化。
- 版本号、`README.md`、`AGENTS.md`、`.gitignore`（`server.pid`）。

## 3. 验证

| 项 | 结果 |
| --- | --- |
| `npm test` | 54 项全过（新增本地模型设置校验：默认值、合法值、非法值回退、广播保留） |
| 控制服务接口 | `/health` `/status` `/models` `/start` `/stop` `/download` 全部实测通过 |
| CORS | 预检 204 + `allow-origin` 回显、`allow-methods: GET,POST`；`Origin: https://evil` 403；无 Origin + `sec-fetch-site: cross-site` 403 |
| 下载 2B GGUF | 1,234,377,216 字节，进度增长正常，`.part` → 正式文件，大小与 `content-length` 一致 |
| 启动 2B + turbo | 22 秒就绪（ASR 21 s、翻译 6 s）；`/status` 显示 `Index-Translate-2B` |
| 切到 9B | 自动停旧服务再拉起，19 秒就绪 |
| 2B 真实翻译 | “We are live from the Path of Exile reveal event.” → “我们正在参加《流放之路》发布活动直播。” |
| `/stop` | 两端口释放，`job=idle` |
| 启动中 `/stop`（P1 竞态） | 停止后 15 秒内状态稳定 `idle`，服务未复活 |
| ASR medium | 首次下载被 HF Xet 卡死（600 s 超时、缓存停 439 MB）；设 `HF_HUB_DISABLE_XET=1` 后 63 秒下完 1.5 GB，随后一键启动 21 秒就绪，真实转写 “Welcome back to the stream…” 通过 |
| 控制面板三态 | 在线/缺失/控制服务离线，经 CDP 检查 DOM 文本与按钮禁用状态，截图见 `evidence/v050-local-model-*.png` |

## 4. 审阅问题处理

| 级别 | 问题 | 处理 |
| --- | --- | --- |
| P0 | 三个新文件未入库 | 控制服务从被 gitignore 的 `.research/` 移到 `scripts/local-service/` |
| P1 | `/stop` 不终止进行中的启动脚本，job 状态被覆盖、可能漏杀新进程 | `handleStop` 先 `kill` launcher；`exit`/`error` 回调在 `stopping` 状态下不覆盖 job；实测回归通过 |
| P1 | `AGENTS.md` 路径写成 `.research/local-service/` | 已改为 `scripts/local-service/` |
| P2 | 无 Origin 调用仅靠回环绑定 | `sec-fetch-site: cross-site` 直接 403，并在 README 写明「本机进程可直接调用，不做额外鉴权」 |
| P2 | 下载中停止按钮可点但会被 409 拒绝 | 下载中禁用停止按钮 |
| P2 | `activeModels` 返回第一个已下载模型而非运行中的 | 改为按运行中别名反查 |
| P3 | 失败 `.part` 可能导致 416 | 下次下载前，若 `.part` 大于等于总量先删除；失败时保留 `.part` 以便续传 |
| P3 | CORS methods 过宽 | 收紧为 `GET,POST` |
| P3 | 控制服务退出不杀 launcher | `shutdown` 中 `kill` jobChild |
| P3 | HEAD 取 `Math.max(content-length)` | 改为取最后一段 |

## 5. 已知边界

- ASR 模型首次下载由 faster-whisper 自己完成，面板只有文字提示，没有进度条（翻译模型 GGUF 才有进度）。
- 控制服务需要手动启动（`scripts/Start-LocalService.ps1`）；不启动时 popup 显示可复制命令，`Start-Services.ps1` 仍可独立使用。
- 控制服务不做鉴权：本机任意进程可直接调用（回环绑定 + 扩展来源白名单只挡浏览器侧）。
