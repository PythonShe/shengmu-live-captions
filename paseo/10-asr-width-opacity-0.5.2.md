# 10 · ASR 参数、浮层宽度与透明度（0.5.2）

范围：0.5.1 实测反馈的四个问题——高语速漏词漏句、2~3 秒延迟、浮层横幅过长、缺透明度调节。
本文件是 0.5.2 的实现与验收记录；早期文档（`paseo/07-ui-fixes-0.4.3.md`、`paseo/09-overlay-injection-0.5.1.md`）与之冲突时以本文件为准。

## 1. ASR：把「丢音频」换成「不丢音频」

旧参数（0.5.1）：`--buffer_trimming_sec 4`、`--localagreement-beam-size 1`、`--asr-coalesce-min-s 0.5`，无 `--confidence-validation`。
后果：`LocalAgreement` 两轮解码一旦在句首分歧，未确认文本会一直卡在缓冲里；缓冲超过 4 秒即触发
`WARNING: No ASR output for x s. Resetting buffer to prevent freezing.`，把整段音频和文本直接丢掉（0.5.1 日志里可数到 10 次）。

新参数（`scripts/Start-Services.ps1`）：

| 参数 | 值 | 理由 |
|---|---|---|
| `--buffer_trimming` / `--buffer_trimming_sec` | `segment` / `10` | 上游默认 15 秒；4 秒会每 4 秒腰斩连读上下文，10 秒只裁不丢 |
| `--localagreement-beam-size` | `3` | 不再贪心解码，快速语音下两轮假设更容易一致，阻塞概率显著下降 |
| `--confidence-validation` | 开 | 概率 > 0.95 的词不等第二轮确认就提交，中文早约 0.5 秒 |
| `--asr-coalesce-min-s` | `0.5`（**保持**） | 曾试 0.3：解码次数翻倍，同一段音频 54% 的行碎成 “The.” / “现在。”，已回退 |

`--pause-segmentation-seconds 1.0`、`--retention-seconds 300`、`--backend faster-whisper`、`--model large-v3-turbo` 不变。

### 实测对比（同一段 120 秒固定样本）

样本：`.research/quality-samples/vkCu3V81N74-15m00-17m00.wav`；链路：Helium + 扩展 + 本地 WLK + 本地 Index-Translate-9B（`translationMode=server`）；
采样脚本 `.research/probe_caption_latency.py`，间隔 0.15 s。

| 配置 | 行数/120s | ≤3 词碎片占比 | 首英文 | 首中文 | 译文滞后 P50 | 译文滞后 P95 | 结束缺译 | buffer reset |
|---|---|---|---|---|---|---|---|---|
| 0.5.1 旧参数 | 31（0.5 发布会记录） | — | — | — | — | — | 0 | **10** |
| coalesce 0.3 + conf | 70 | **54%** | 0.78 s | 1.55 s | 0.47 s | 2.58 s | 1 | 0 |
| coalesce 0.5，无 conf | 22 | 0% | 0.94 s | 1.58 s | 1.79 s | 2.52 s | 0 | 0 |
| **coalesce 0.5 + conf（采用）** | **24** | **4%** | **0.80 s** | **1.55 s** | 1.25 s | 2.61 s | **0** | **0** |

结论：`Resetting buffer` 归零、缺译归零，译文滞后不再随句长线性恶化；coalesce 0.3 的“更跟手”是用碎片换来的，不采用。

## 2. 显示层：新英文不再等旧译文

`selectDisplayCaption`（`extension/caption-utils.js`）改为：

1. 原文槽永远显示**最新的英文**：未定稿 buffer 优先，否则最新已定稿行；
2. 译文槽显示**同一行**的译文；若还没到，就保留上一句译文并置 `pending: true`；
3. 首句还没有任何译文时译文槽为空（`pending` 空占位），失败行仍走 `failed`。

配套的浮层样式分两种状态，别混用：

- `.translation.pending`：空占位（小字号、浅色），旧行为不变；
- `.translation.stale`：上一句保留文本，**同字号只降透明**——用小字号会让框高每句跳一次。

效果：首句英文 0.94 s → 0.80 s 上屏；用户不再面对“英文已经说出 2 秒、屏幕上还是上一句中文”。

历史侧不受影响：`scrollbackEntries` 用 `lineId` 判断“当前行”，滚轮回看时当前行仍被排除。

## 3. 浮层宽度：贴合文本 + 单向缓动

- `.stage` 退化为定位锚点：`width: min(68vw, 860px)`（旧值 `min(82vw, 1180px)`，即那条横跨屏幕的黑条）、`align-items: center`。
- 真正绘制的是 `.caption-stack` 内的 `.caption-shell`（`width: 100%`），`.caption-stack` 的宽度由 JS 写死为像素值并 `transition: width 170ms`。
- 量宽方式：canvas `measureText`（字体/字距取 `getComputedStyle`），取三个槽位里最宽的一行；**不在 DOM 上量**，因为 `text-wrap: balance` 会让“当前宽度”反过来影响测量结果，形成振荡。
- 策略：目标宽度 = `clamp(240, 文本宽 + 内边距 + 边框, min(68vw, 860))`；**变宽立即应用**，**变窄延时 `SHELL_SHRINK_DELAY_MS = 420 ms`**，流式吐字时只涨不缩。
- `.history` 仍按 `.stage` 宽度铺开（回看面板需要横向空间），`.toolbar` 随 `.caption-stack` 走，不再飘在空背景右侧。
- `OVERLAY_VERSION` 由 `4` 升到 `5`：结构变了，旧注入实例必须重建而不是复用。

实测（`.research/v052-ui-check.py`，40 秒实时采集）：`.stage` 固定 860 px，`.caption-shell` 出现 240 / 293 / 312 / 324 / 363 / 366 / 398 / 443 / 511 / 558 / 585 / 723 / 760 / 778 / 783 / 844 / 848 / 860 px 共 18 档，短句 3 字宽 240 px，长句封顶 860 px。

## 4. 透明度：滑块 + 整层联动

底层其实早就有了（`settings.opacity`、`--overlay-opacity`、`TAB_ALLOWED_SETTING_KEYS`），0.5.1 缺的只是 UI 与视觉联动。

- popup 新增「不透明度」滑块（`5%~100%`，180 ms 防抖落库）；按拍板结果，**浮层工具栏不加**。
- `normalizeOpacity`：域 `0.05~1`，并且 `0` 不再被 `Number(x) || default` 吞成默认值。
- `--overlay-opacity` 同时驱动 `.caption-shell` 的渐变背景、边框（含 3px 金色左边框）、顶部装饰线（`::after`）、外阴影与 `backdrop-filter: blur(calc(11px * var(...)))`，所以拉到最低时剩下“只有文字”的状态，而不是一块固定毛玻璃。实测 `opacity=8%` 时左边框 alpha `0.08`、`blur(0.88px)`；`86%` 时 `0.86` / `blur(9.46px)`。
- `.history` 面板背景两端分别保底 `max(0.62, ...)` 与 `max(0.58, ...)`：回看时始终可读。

实测：滑块 8% → `backdrop-filter: blur(0.88px)`、左边框 `rgba(232,184,75,0.404)`；恢复 86% → `blur(9.46px)`。运行时改滑块，正在显示的字幕即时生效。

## 5. 双重翻译：API 模式下不再起本地翻译服务

popup 一键启动现在会带上 `translationMode` 与 `apiTranslationConfigured`：

| 条件 | 行为 |
|---|---|
| `api` 且已配置 Key | `server.mjs` 传 `-AsrOnly`：不启 8013、不传 WLK 翻译参数，显存与算力全给 ASR |
| `api` 但没配 Key | 本地翻译模型照常启动，作为 WLK 兜底译文（`fallbackTranslation`） |
| `server` | 与以前一致，启 8013 |

注意：`-AsrOnly` 下 WLK 不再产出兜底译文，API 失败时该行只会标 `translationFailed`。切换模式时若 8013 还在跑，`server.mjs` 会先停服务再以 `-Restart` 拉起，避免 `Start-Services.ps1` 直接报错。

修正一处早前报告的说法：WLK 的翻译在独立线程里跑（`asyncio.to_thread`），并发时机不阻塞 ASR 事件循环；省掉它的收益是**显存与 GPU 争用**，不是省掉一段 150~450 ms 的同步等待。

## 6. 验证与证据

- `npm test`：60 项通过（新增/改写 `selectDisplayCaption` 4 例、`normalizeOpacity` 1 例）。
- `node --check`：`extension/*.js`、`scripts/local-service/server.mjs`、`tests/*.js` 全通过；`Start-Services.ps1` PowerShell 解析 0 错误。
- 120 秒端到端 ×3 配置：见 §1 表格，`finalMissingTranslations = 0`、`Resetting buffer = 0`。
- UI 几何/透明度实时采样：`.research/v052-ui-check.py`、`.research/v052-ui-ui.json`。
- 截图：`paseo/evidence/v052-ui-overlay-default.png`、`paseo/evidence/v052-ui-overlay-opacity8.png`。
- 采样原始数据：`.research/v052-baseline-latency-*`、`.research/v052-noconf-latency-*`、`.research/v052-conf-c05-latency-*`。

## 7. 未做 / 已知限制

- 在线直播（Twitch/YouTube）不作为转写验收源，只用固定样本；线上表现仍需人眼确认。
- 短行合并（把 “The.” 与下一行合并后再翻译）没有实现：会重新引入中文延迟，需要单独设计。
- Helium 自带拦截器会挡 `chrome-extension://<id>/popup.html` 的**标签页**方式打开（`ERR_BLOCKED_BY_CLIENT`）；用工具栏图标或 `Ctrl+Shift+Y` 打开的真实弹窗不受影响。
- 打包版本号已同步 `package.json` 与 `extension/manifest.json` 为 0.5.2，未执行 `git push`。

## 8. 跨模型审阅与修复（GPT-6 Luna）

审阅结论：无 P0，1 个 P1，6 个 P2。P1 与 5 个 P2 已修并重测；剩 1 个 P2 记录待办。

| 级别 | 问题 | 处理 |
|---|---|---|
| P1 | `api` ↔ `server` 切模式时 `server.mjs` 不会重启 WLK：WLK 仍是 ASR-only，本地翻译起了却没人调用 | `startedWlkMode` 记录上次启动模式；WLK 在线且模式不符时按方向判定重启（要 ASR-only 一律重启；要翻译且 8013 未监听也重启），并在切换时给 popup 提示“请停止并重新开始字幕”。两个方向都实测过 |
| P2 | `apiTranslationConfigured` 缺字段被当成已配置 | 改为必须 `=== true` 才走 `-AsrOnly`，旧弹窗/缺字段回落本地翻译 |
| P2 | `runStopServices()` 失败被忽略，继续启动 | 停止失败直接返回 500 与具体原因，不再继续 |
| P2 | 拖动滑块时状态广播会把滑块复位 | 新增 `createSliderSaver`（timer + token），拖动/保存在途期间不覆写滑块（字号同样受益） |
| P2 | 延时收窄会把过期宽度应用回去 | 收窄回调里重新量宽；文本长回当前宽度时清掉待执行的收窄定时器 |
| P2 | 只有译文没有原文的行被回填进原文槽 | 原文槽不再回填译文，避免双语模式中文出现在英文行 |
| P2 | 透明度最低档仍留明显金色左边框/顶部装饰线 | 左边框 alpha 改用 `var(--overlay-opacity)`，`::after` 乘以同一变量；实测 8% 时为 `0.08` |
| P2（待办） | ASR-only 且 API 失败时，popup 仍显示“实时翻译中” | 采集状态与翻译健康度尚未分开显示，需要单独设计状态位，记入 backlog |

重测：`npm test` 61 项通过；`node --check` 全通过；模式切换双向实测（api → 8013 停、WLK 无 `translation-backend`；server → WLK 带 `openai-translation-model Index-Translate-9B`、8013 200）；120 秒固定样本复跑 24 行、首英文 0.907 s、首中文 1.547 s、缺译 0、`Resetting buffer` 0。

浏览器端复测改在 `scripts/Start-DevBrowser.ps1`（Chrome + `chrome-profile`）上做，以免打断 Helium 里的直播；`.caption-shell` 宽度仍为 240→860 px 多档，`.translation.stale` 在 39/100 采样中生效。
