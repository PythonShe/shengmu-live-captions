# 声幕 0.4.1 — 记录页闪烁 / 浮层历史回看 / 双行译文

日期：2026-10-28。验证环境：项目专用 Chrome（CDP 9223，扩展 `dfjobgemgohmbmnagcpcneledbacpmoj`）、WhisperLiveKit `faster-whisper large-v3-turbo`（8010）、Index-Translate-9B（8013）。

## 1. 改动

| 问题 | 方案 |
| --- | --- |
| 字幕记录页每来一条字幕就整表重建，全行重播入场动画、平滑滚动反复被打断 | 增量渲染：只追加新行、只更新文字变了的行；布局/查询/场次变化才整体重建；移除容器的 `scroll-behavior: smooth`；进场动画只给真正新增的一行 |
| 会话超过 250 条后窗口滑动会触发整表重建 | `planTranscriptDiff` 纯函数判定「追加 / 滑动丢最旧 / 重建」，滑动时只移除最旧的 DOM 行（有单测） |
| 「正在听」卡片反复隐藏/出现，把列表上下顶 | 直播期间常驻，空闲显示「等待下一句…」，`min-height` 固定 |
| 场次列表每次刷新都重建卡片 | 内容签名一致时跳过重建 |
| 浮层无法回看历史 | 指针在浮层/历史面板内滚轮上滚 → 展开最近 40 条；滚回最新一句自动收起；手势尾部 700ms 冷却，避免顺带滚走网页 |
| 回看时上句译文与最新历史行重复 | 历史展开时隐藏双行模式的上一句 |
| 原文过小 | 双语原文改为译文 60% 字号（`clamp(13px, 0.6em, 34px)`） |
| 缺少「双行译文」 | 新增 `displayMode: "dual"`：上一句译文（0.8 字号、弱化）+ 当前句；工具栏循环四模式；记录页/复制/SRT 按纯中文处理 |

版本号 0.4.1（`manifest.json`、`package.json`）。

## 2. 自动化 UI 验证（TARGET STREAM，`test-assets/tab_capture/target.wav` 循环 TTS）

脚本：`.research/ui-smoke-041b.py`、`.research/ui-smoke-041.py`。

### 记录页渲染稳定性（25 秒窗口，用户上翻离开底部）

```json
{"mutations": 5, "adds": 5, "removes": 0, "maxRemovedPerMutation": 0,
 "rows": 182, "firstRowStable": true, "lastRowPresent": true}
```

- 25 秒内新增 5 行 → 只有 5 次 append，**0 次移除、0 次整表替换**。
- 阅读位置仅因上方已存在行译文改写字数而移动 38px（内容变化，不是重建）。
- `#scrollLatest` 点击后恢复跟随（1.6 秒时仍在平滑滚动途中，属滚动动画时长，非回归）。

> 记录窗口是独立 popup 窗口，CDP `Input.dispatchMouseEvent` 对该 target 超时（主页面 target 正常），因此记录页用程序化 `scrollTop` 触发同一条 scroll 回调完成稳定性验证。

### 浮层滚轮回看（真实合成滚轮事件）

```json
open:  {"hidden": false, "rows": 17, "meta": "历史 17 条 · 向上查看更多",
        "prevVisible": false, "pageScrollY": 0}
close: {"hidden": true, "prevVisible": true, "pageScrollY": 0}
```

- 上滚 6 格 = 17 条历史；面板高 278px（上限 40vh/40 条），顶部溢出淡出。
- 展开/收起全过程网页 `scrollY` 保持 0：不再顺带滚动 YouTube 页面。
- 收起后双行模式的上一句自动恢复。

### 双行模式与原文比例

```json
{"prevVisible": true, "sourceEmpty": true, "modeButton": "双行",
 "sourceFontSize": "20.4px", "translationFontSize": "34px"}
```

20.4 / 34 = 0.6。

截图：

- `paseo/evidence/v041-monitor-reading.png`（记录页上翻阅读）
- `paseo/evidence/v041-monitor-dual.png`（双行模式记录页）
- `paseo/evidence/v041-monitor-final-bottom.png`（停止后收尾）
- `paseo/evidence/v041-overlay-dual.png`（浮层双行）
- `paseo/evidence/v041-overlay-history-final.png`（浮层历史回看）
- `paseo/evidence/v041-overlay-live.png`（滚回实时）

## 3. 240 秒采样（`monitor_extension_capture.py --duration 240 --interval 10 --stop-at-end`）

`v041-ui-smoke.summary.json` / `-samples.jsonl` / `-lines.json`：

| 指标 | 值 |
| --- | --- |
| 采样 | 25，inactive 0，disconnected 0，ad 0 |
| 采集完整度 | min 0.99899，median 0.99962 |
| 最终字幕 | 66 条，缺译 0 |
| 行时长 | median 3.12 s，P95 6.56 s，max 10.62 s，>30 s 0 |
| GPU 峰值 | 8316 MiB |

本次素材是确定性 TTS 循环（用于 UI 复现），不代表真实直播延迟；真实内容的 3 条 PoE 切片见下一节，全量真实内容指标见 v0.4.0 记录。

## 4. 三条 PoE 真实内容切片（0.4.1）

素材：`.research/quality-samples/*-full.webm`，用 `silencedetect` 选语音最密的 2 分钟，统一转 16 kHz 单声道 WAV（各 120.0 s）：

| 切片 | 文件 | 行数 | 缺译 | 采集完整度 min/med | 行时长 med/P95/max | 翻译观察延迟 med/P95/max |
| --- | --- | --- | --- | --- | --- | --- |
| NZGDC 主题演讲 24:00–26:00 | `Gq2r7x5qgmg-poe-24m00-26m00.wav` | 41 | 0 | 0.889 / 0.999 | 2.42 / 5.24 / 8.76 s | 1.52 / 3.53 / 7.12 s |
| Item Design 30:45–32:45 | `WIuIdulr-K0-poe-30m45-32m45.wav` | **1** | 0 | 0.899 / 0.998 | **120.06 s（单行）** | 0.52 s |
| PoE2 Reveal 05:15–07:15 | `vkCu3V81N74-poe-05m15-07m15.wav` | 24 | 0 | 0.899 / 0.999 | 3.04 / 7.82 / 10.20 s | 1.00 / 3.03 / 4.05 s |

原始数据与截图：`.research/poe-041/poe041-<video>-{summary.json,samples.jsonl,lines.json,overlay.png,subtitle.png}`。

译文抽样（正常切片）：

```text
[0:00:32.53] was scary for us because we wanted this to be a this to be a forever game.
          => 这对我们来说很可怕，因为我们希望这能是一款能长久玩下去的游戏。
[0:00:21.85] Unfortunately, on doing so, the corpses of the nearby undead are revived and infused with ...
          => 遗憾的是，这样一来，附近的亡灵尸体被复活了，并注入了一些潜在的力量。
[0:00:38.11] Farrow realizes that runesmithing is a dangerous business.
          => 法罗意识到，符文锻造是一项危险的业务。
```

三条切片均为 0 缺译、无断连、采集完整度中位 ≥ 0.998；主题演讲与 Reveal 两条的分句和译文正常。

## 5. 已知问题（留给下个版本，本版不修）

### A. 超长 ASR 句会把浮层铺满屏幕

复现：`poe041-WIuIdulr-K0`（Item Design 30:45–32:45）——整 2 分钟被切成 **1 句**（`lineDurationSeconds = 120.06`，source 2227 字符，译文 888 字符），浮层把整句渲染出来，字幕框高度超过视口，只剩浮层。

- 原因：连续讲话 + `--pause-segmentation-seconds 1` 没有停顿可切，localagreement 直到切片结束才落定；浮层正文没有高度上限。
- 证据：`paseo/evidence/v041-issue-longline-overlay.png`（浮层）、`v041-issue-longline-subtitle.png`（历史窗口）。
- 修复方向：浮层正文限高（建议译文最多 3 行 / 30vh、原文 2 行、上一句 2 行），用尾部对齐 + 顶部渐隐；历史行也限高；服务端可对 >30 s 的段落按标点/时长二次切分。
- 当前规避：暂停采集，或把浮层字号调小（治标）。

### B. 浮层历史回看不随新字幕/晚到译文刷新

复现：浮层上滚进入历史后，正在显示的行如果译文晚到（或原文被修订），面板里不会更新；新到达的字幕也不会进入面板。实时行本身仍正常刷新。

- 原因：历史面板进入回看时冻结快照（`scrollbackSnapshot`），刻意避免新内容顶动阅读位置；但同时也冻结了**已显示行**的译文更新。
- 修复方向：快照按行 id 保留，但每次 `caption-state` 把已显示条目的译文/原文就地合并（保持 `scrollTop` 锚点）；同时在面板角落显示“有 N 条新字幕”，滚回实时后再并入。

## 6. 已知遗留（非本版范围）

1. 记录页左侧场次列表在长标题下出现横向滚动条（旧布局问题，未在本次范围内改动）。
2. 直播源静音时 ASR 仍会产生极短碎片行（如 “7.8.”），属识别层输入问题，与本次 UI 改动无关。
