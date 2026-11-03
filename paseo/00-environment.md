# 00 · 环境盘点与 paseo 迁移准备

盘点时间：2026-10-27（只读）
迁移方向：Codex → paseo / pi

> 本次操作边界：未修改项目内任何已有文件，未执行 `git add/commit/push`，
> 未启动/停止 WhisperLiveKit、llama.cpp、Chrome 或任何服务，未写入 `.research`。
> 新增内容仅为：全局 skill（`C:\Users\moule\.agents\skills\realtime-livestream-subtitles\SKILL.md`）
> 与本报告目录 `paseo\`。

> **后续状态**：本报告是 22:15–22:18 的迁移快照。之后实现代理按需求修改了 `extension/`，
> 测试从 11 个增加到 40 个；最新结果见 `paseo/03-verification.md`。

---

## 1. 已安装的 skill

| 项目 | 值 |
| --- | --- |
| 路径 | `C:\Users\moule\.agents\skills\realtime-livestream-subtitles\SKILL.md` |
| name | `realtime-livestream-subtitles` |
| 大小 | 6654 字节 / 137 行 |
| 编码 | UTF-8，无 BOM，严格解码通过（已验证） |
| 自动加载 | 已验证：当前 paseo/pi 会话的可用 skill 列表包含了 `C:\Users\moule\.agents\skills\` 下的 skill（同目录的 `project-context-router`、`paseo`、`ffmpeg-skill` 均在列），因此该目录对 pi/paseo 可见并可按 description 自动匹配 |

skill 正文的定位是**路由 + 验证速查**，不是 codex runbook 的副本，包含：

1. 项目工作区定位（extension / scripts / tests / .research / chrome-profile / paseo 各自路径，含 `.research` 不可恢复警告、git-bash 与 PowerShell 差异）；
2. 先读的权威 runbook 绝对路径 `C:\Users\moule\.codex\memories\skills\realtime-livestream-subtitles\SKILL.md`，并给出阅读顺序（runbook → `.research\live-caption-extension-test-report-v4.md` → `README.md` → `extension\`）；
3. 关键已验证事实摘要（技术栈与端口、默认 ASR 参数、延迟数值、扩展架构与防节流、tabCapture 固有限制、CDP 9223 与扩展 id、已知未解决问题）；
4. paseo 下的验证命令（`npm test`、`node --check` 循环、环境存在性检查、health curl、240s 冒烟 harness、指标取 JSONL 而非 stdout）；
5. **服务与 Chrome 测试前先征得用户同意**的明确边界（含启动/停止服务、启动/关闭 Chrome、CDP 自动化、占 GPU 的实时采集、触发 UAC；只读操作免批准；删除 `.research` 必须批准）；
6. 范围红线（只用 Chrome、不碰 Helium、不改 `.research\chrome-tabcapture-test`）。

> 说明：`C:\Users\moule\.pi\agent\skills\` 下另有 `ask-sonner`、`ask-matt`、`reddit-automation`，本次未改动。Codex 原 runbook 仍保留在原位，不做迁移覆盖。

---

## 2. 环境版本

| 组件 | 版本 / 状态 |
| --- | --- |
| Node | v24.11.1 |
| npm | 11.21.0 |
| Python（系统 PATH） | 3.11.0（`C:\Users\moule\AppData\Local\Programs\Python\Python311\python.exe`） |
| git | 2.56.0.windows.2 |
| Chrome | **156.0.8078.48**（`C:\Program Files\Google\Chrome\Application\chrome.exe`；无 x86 与 LocalAppData 副本） |
| `.research\wlk-venv` | 存在，Python 3.11.0，占用约 3.7 GB |
| whisperlivekit | 0.2.26，editable 安装，指向 `.research\WhisperLiveKit`（依赖 torch、faster-whisper、uvicorn 等） |
| `.research\WhisperLiveKit` | 存在 |
| `.research\llama.cpp-b11808` | 存在 |
| `.research\models\index-translate-9b` | 存在，`Index-Translate-9B.Q4_K_M.gguf` 5.78 GB |

结论：runbook 记录的运行环境（Python 3.11、Win + PowerShell、本地大模型链路）在当前机器上完整可用。Chrome 已从 runbook 记录的 155 升到 **156**，`--enable-unsafe-extension-debugging` 仍是自动加载未打包扩展的必需参数，且 `scripts\Start-DevBrowser.ps1` 已经带上该参数与 `--remote-debugging-port=9223`，无需改动。

---

## 3. 测试结果（只读执行）

### `npm test`（`node --test tests/*.test.js`）

```
ℹ tests 11   ℹ pass 11   ℹ fail 0   ℹ cancelled 0   ℹ skipped 0
ℹ duration_ms 100.87
```

11/11 全部通过。覆盖：

- `shiftTimecode` 重连本地时间 → 场次时间换算
- `normalizeCaptionLines` ID 稳定性、时间平移、缺译标记
- `selectDisplayCaption` 待译期间保留上一条已译字幕、首条待译不显示空行
- `mergeCaptionLines` 跨 epoch 场次顺序合并
- `buildSrt` 重连后时间轴连续
- `HistoryWriteQueue` 失败批次回滚重试、写入期间新增行不丢失、旧写入不覆盖新行
- `pcm worklet` 100 ms 批处理不乱序

### `node --check extension/*.js`

首次执行（约 22:15，9 个文件）9/9 通过；22:18 复检（此时目录已变为 10 个文件，见 R8）**10/10 通过**：

```
caption-utils.js  content-overlay.js  history-db.js  history-write-queue.js
offscreen.js      pcm-worklet.js      popup.js       service-worker.js  subtitle.js
translation-api.js   （22:17 新出现，见 R8）
```

结论：**单元测试与语法检查全部通过**。注意这只证明纯逻辑与语法，不覆盖端到端链路（采集比、浮层渲染、窗口历史）。

---

## 4. MCP 结论

### 4.1 `C:\Users\moule\.pi\agent\mcp-adapter.json` 已配置的 server（未修改）

| server | 传输方式 |
| --- | --- |
| microsoft-learn | streamable-http `https://learn.microsoft.com/api/mcp` |
| huggingface | streamable-http `https://huggingface.co/mcp` |
| brave-search | npx `@brave/brave-search-mcp-server`（带 API key） |
| exa | streamable-http `https://mcp.exa.ai/mcp` |
| deepwiki | streamable-http `https://mcp.deepwiki.com/mcp` |
| **chrome-devtools** | npx `chrome-devtools-mcp@latest` |
| context7 | streamable-http `https://mcp.context7.com/mcp` |

当前 pi 会话实际只注册了 `paseo`（62 个工具），上述 7 个 server 尚未在会话中注册（`mcp({})` 显示 `0/1 servers`）。需要时可 `mcp({ connect: "chrome-devtools" })` 懒连接。

### 4.2 chrome-devtools MCP 是否需要额外安装

**不需要额外安装。** `chrome-devtools-mcp@latest` 已在 npx 缓存中解析完成（packageVersion `1.12.0`，`C:\Users\moule\AppData\Local\npm-cache\_npx\15c61037b1978c83`），配置也已在 `mcp-adapter.json` 里，属于即插即用。

### 4.3 项目现有 CDP 脚本是否已覆盖浏览器自动化需求

**已覆盖，且比通用 MCP 更贴合本项目。**

| 脚本 | 覆盖能力 |
| --- | --- |
| `scripts\Start-DevBrowser.ps1` | 启动专用 Chrome（`--remote-debugging-port=9223`、`--enable-unsafe-extension-debugging`、独立 `chrome-profile`），幂等检测端口、复用已开实例、自动调用加载扩展 |
| `scripts\Load-DevExtension.ps1` / `load-extension.mjs` | 通过 CDP `Extensions.loadUnpacked` 加载未打包扩展 |
| `.research\control_tab_capture.py` | `start` / `stop` 子命令，`/json/list` 发现 target、`Runtime.evaluate` 驱动 popup 起停采集（`--page-target-id`、`--ws-url`） |
| `.research\monitor_extension_capture.py` | 定时采样运行时指标 + 结束时 finalize（`--tag/--duration/--interval/--stop-at-end/--finalize-wait`），产出 JSONL 事件流 |
| `.research\cdp_call.py` / `cdp_eval.py` | 通用 CDP 调用与 JS 求值 |
| `.research\probe_caption_latency.py`、`full_length_eval.py` | 含 `Page.captureScreenshot` 的延迟探针与全长度评测 |

通用 chrome-devtools MCP 能补的只有「通用页面导航/点击/截图/network 面板」这类交互式调试，而本项目的关键路径（扩展加载、popup 驱动采集、运行时指标采样、截图比对）都已有脚本化实现，并且这些脚本承载了项目特定的语义（capture ratio、deliveredRatio、epoch 合并）。

### 4.4 结论

**不需要新增 MCP。**

- 浏览器自动化 → 现有 CDP 脚本 + 已配置的 chrome-devtools MCP 懒连接即可，无需新装。
- 搜索类（brave/exa）若在 paseo 会话不可用，属于「会话未注册」问题，按 runbook 的既定策略直接切 `curl.exe` / `Invoke-WebRequest`，不必新增 server。

---

## 5. 缺失项与风险

| # | 项 | 说明 | 建议 |
| --- | --- | --- | --- |
| R1 | `.research` 完全未纳入版本控制 | `.gitignore` 忽略 `.research/`，其中有 3.7 GB venv、5.78 GB 模型、全部 metrics 与历史报告；一旦误删不可恢复 | 任何清理/删除操作前必须征得同意；建议用户自行做一次外置备份 |
| R2 | 工作区存在未提交改动 | `git status` 显示 8 个已修改（caption-utils、content-overlay、offscreen、pcm-worklet、service-worker、Start-Services.ps1、target.html、caption-utils.test.js）+ 3 个未跟踪（`.serena/`、`feiyu.test`、`tests/pcm-worklet.test.js`） | 迁移前后保持原状；是否提交由用户决定，本次未执行任何 git 写操作 |
| R3 | `feiyu.test` 疑似真实 API Key | 根目录未跟踪文件；独立评审确认其内容形如服务商真实 Key，不是占位符（本报告不记录具体值） | 已加入 `.gitignore` 防止误提交；请用户在服务商后台忘记/吊销该 Key，并把文件移出仓库或删除 |
| R4 | pi 会话未注册 `mcp-adapter.json` 里的 7 个 server | 仅 `paseo` 在线；`pi-mcp-adapter` 已在 settings `packages` 中，可能是会话级懒加载 | 需要时 `mcp({ connect: ... })`；若长期不出现，再排查 adapter 加载（属配置问题，不影响本项目主链路） |
| R5 | Chrome 156 ≠ runbook 记录 155 | 自动化加载扩展仍依赖 `--enable-unsafe-extension-debugging` | 脚本已覆盖；后续若扩展加载失败，先查该 flag 与 profile 是否被日常 Chrome 占用 |
| R6 | 端到端链路本轮未验证 | 按约束未启动服务、未开 Chrome，故采集比、浮层、历史窗口、延迟均沿用历史报告数据（v0.3.2 / v4 报告） | 需要验收时，用户批准后再跑 240 s 冒烟，不要直接上 30 分钟稳定性 |
| R7 | 已知未闭环问题 | 偶发无标点 ~40 s ASR 长句、偶发最后一条缺译、history DB / 运行时视图 / 服务端快照三者可能不一致 | 验收清单里要同时比对三处与截图，不能只看 metrics 文件 |
| R8 | **实现代理修改 `extension/`（已确认不是并发冲突）** | 盘点期间（22:17–22:18）出现的 `extension\translation-api.js`、`caption-utils.js`、`service-worker.js` 变更是本任务的实现代理 | 最新快照与验证见 `paseo/03-verification.md`；迁移期仍不要执行 `git add` 或批量格式化 |

---

## 6. 下一步建议

1. **先做一次「零副作用」健康确认**：用户批准后，`scripts\Start-Services.ps1` → `curl 127.0.0.1:8013/health` 与 `:8010/health`，确认 Index-Translate-9B 与 WhisperLiveKit 都能起（首次加载模型明显更慢）。
2. **再跑 240 s 冒烟**：`Start-DevBrowser.ps1` → `Load-DevExtension.ps1` → `control_tab_capture.py start` → `monitor_extension_capture.py --duration 240 --stop-at-end`，指标从 JSONL 取，同时截图检查浮层与「声幕 - 字幕与历史」窗口。
3. **优先处理 R7 的两个边界问题**：给 ASR 长句加最大时长/最大字符切分或停顿 flush；确认 `ready_to_stop` 之后最后一批 `finish_batch()` 译文的落库顺序。修完再谈 30 分钟稳定性。
4. **迁移期的分工建议**：Codex runbook 继续作为唯一权威事实源，paseo 侧只通过新建的全局 skill 路由进入；每次验证结果落一份到 `paseo\`，不要回写 `.research`。
5. **不要**在迁移期做：提交/推送、清理 `.research`、升级 Chrome 或 Node、替换模型或路径、改动 `mcp-adapter.json`。
