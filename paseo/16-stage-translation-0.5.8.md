# 声幕 0.5.8 — 字幕译文单调递进（阶段译文）与英文固定单行

## 1. 问题

0.5.7 实测（DeepL 模式，`GHEBkhT1K7A` 直播）出现两个现象：

1. **译文回跳闪烁**：每句开始先闪一下临时新译文，随即切回上一句已完成译文；有新进展就再闪一次、再切回；直到整句译完，一大段中文一次性砸进浮层。
2. **英文也在闪**：双语排版下原文槽在「整行英文」和「1~3 个词」之间来回跳。90 秒采样里出现 88 次文本切换。

## 2. 根因

| 编号 | 故障点 | 机制 |
|---|---|---|
| A | 行文本生长时抹空已有译文（`service-worker.js` 旧 `handleTranscriptUpdate`、`caption-utils.js` 的 `mergeCaptionFragments`） | WLK 每 0.5~1 秒向同一行追加几词，`previous.source === rawLine.source` 不成立即把 `translation` 清空，`selectDisplayCaption` 只能回退到上一句 |
| B | 在途译文被丢弃（`applyLineTranslations`） | 响应回来时 `line.source !== entry.source` 直接 `continue`，快语速下每次请求都作废，直到句子不再变长才落一次 |
| C | buffer 双轨（`selectDisplayCaption`） | `bufferSource` 非空时无条件屏蔽行译文、改用 `bufferTranslation`；而 WLK 的 buffer 是滑动片段，其译文与屏上句子无关 |
| D | 合并单元超 180 字符分裂 | 合并单元里的 WLK 行原地变长后重算合并条件失效，单元裂成两行，新尾行没有译文，浮层倒退回首行的旧短译文 |
| E | 英文槽取 `bufferSource \|\| latestLine.source` | 实测 buffer 与行尾**零重叠**，即 buffer 是行之后的新词；二选一导致英文槽整行跳变 |

A/B/C 是译文回跳的主因，D 是恶化项，E 是英文闪动的独立原因。

## 3. 设计

### 3.1 不变量：单句生长周期内译文单调前进

`上一句完成译文 → 当前句阶段译文 1 → 阶段译文 2 → 完整译文`。任何中间状态都不得把当前行已有阶段译文清零，也不得被空译文顶掉。

### 3.2 行字段

| 字段 | 含义 |
|---|---|
| `translation` | 当前上屏译文，可能是阶段译文 |
| `translatedSource` | 该译文对应的源文快照 |
| `translationPending` | `translatedSource !== source`，即译文落后于源文（有译文也算 pending） |
| `fragmentIds` | `mergeCaptionFragments` 记录的合并子行 id，供分裂承接使用 |

`translationPending` 的语义从「没有译文」改为「译文落后于源文」，这是全篇改动的基础。

### 3.3 `reconcileLineTranslations`（`caption-utils.js`）

每帧 ASR 更新时调用，纯函数：

- 按 id 从上一帧行接管 `translation` / `translatedSource` / `fallbackTranslation`，**源文变长也保留**；
- 计算 `translationPending = translatedSource !== source`；
- 分裂承接：上一帧某个合并单元的 `fragmentIds` 含本行 id、而本行自己没有前值时，继承该单元的阶段译文并置 pending，避免倒退回首行短译文；
- server 模式不接管，直接用 WLK 的译文。

### 3.4 `applyLineTranslations`

在途响应回来时源文已变长：不再丢弃，而是当作阶段译文上屏（`translationPending = true`、`translatedSource = entry.source`），下一轮再译最新源文。`translationPending` Map 里该行条目删除，好让 `collectPendingLineTranslations` 立刻重建。

### 3.5 重译限流

`TRANSLATION_RETRANSLATE_MIN_NEW_CHARS = 8`、`TRANSLATION_RETRANSLATE_MIN_INTERVAL_MS = 400`，用 `translationRetranslateGuards` 记录上次请求的源文与时间。增量不足且间隔不足时跳过，并 `scheduleTranslationWake` 补一次唤醒；不能在 `scheduleLineTranslations` 里静默丢掉，否则句尾可能永久停在阶段译文。

### 3.6 buffer 送翻整块删除

不只是 API 模式停用：`scheduleBufferTranslation` / `flushBufferTranslation` / `translationBufferAbort` / `TRANSLATION_BUFFER_*` 全部删除。API 模式下 `handleTranscriptUpdate` 把 `bufferTranslation` 恒置空，buffer 只进英文槽；server 模式的 buffer 译文来自 WLK 的 WS 消息，扩展侧本来就不送翻。

删整块而不是加条件，是因为跨模型审阅发现：`initialize()` 的 SW 回收恢复路径与 `applySettingsPatch()` 的设置变更路径都还无条件调 `scheduleBufferTranslation()`，API 模式下它们会真的发一次 buffer 请求并把滑动片段的译文写回 `bufferTranslation`（再由 `selectDisplayCaption` 当兜底显示），正好复现要修掉的闪烁。恢复路径现在只调 `scheduleLineTranslations(0)`。

`translationTranslatePartial` 设置项因此失去作用，popup 里的「半句预翻译」开关已删除（字段保留兼容，旧配置仍可迁移），`translationSettingsChanged` 也不再把这个键当触发条件。

### 3.7 历史与 SRT 只收最终译文

- `lineSignature` 包含 `translationPending`，阶段译文期间不入 `historyWriteQueue`，转为终态时补写一次；
- `finalizeSession` 在 flush 之前调 `commitRuntimeLinesToHistory()`，把屏上版本落盘，最后一句不会丢；
- server 模式无阶段译文，照旧每行即时落盘（缺译行也要落，否则缺译统计失真）。

### 3.8 英文槽

- `composeLiveSource(line, buffer)`：行文本 + buffer 尾部拼接，先做尾/首词重叠去重（实测零重叠，仍防 buffer 重写）。英文因此单调追加，只在换句时变化。
- `.source` 固定单行（`max-height: 1.38em`），交叉轴 `align-items: flex-end` 使溢出落在左侧并被裁切，`.source.overflowing` 用水平渐隐（`to right`）提示被裁。
- `markCaptionOverflow` 同时判断垂直与水平溢出（`rect.height - clientHeight` / `rect.width - clientWidth`）。
- `selectDisplayCaption` 的 `lineId` 恒取 `latestLine.id`，不再跟 `bufferSource` 绑定；否则双行模式会把当前句当「上一句」重复显示、scrollback 去重失效。
- `pending` 只表示「屏上中文落后于最新源文」：`latestLine.translationPending || 无行译文`。buffer 非空不算 pending（WLK buffer 几乎恒非空，否则角落小点常亮）。

## 4. 实测

dev 浏览器 9223，DeepL 模式，固定 wav 按 1× 经真实 tabCapture 采集，`.research/rebound-probe.py` 同时采浮层 DOM 与 `caption-state` 广播。

| 样本 | 时长 | 译文 A→B→A | 英文 A→B→A | 英文槽高度 | 空译文帧 |
|---|---|---|---|---|---|
| `GHEBkhT1K7A-05m41-07m41.wav` | 100 s / 90 s（修 P1 前/后） | 0 | 0 | 恒 28 px | 0 / 2 |
| `Gq2r7x5qgmg-poe-24m00-26m00.wav` | 90 s | 0 | 0 | 恒 28 px | 4 |

改动前同一段样本英文槽 88 次整行跳变（`bufferSource \|\| latestLine.source`）。

历史核对：42 行 / 0 缺译 / 0 行 `translatedSource !== source` / 0 行残留 pending。
跨模型审阅（`pi/magpie/opencode-go/qwen3.7-plus`，独立 worktree）：P1 一条（buffer 翻译恢复路径），已按上文删除整块修复并重测；P2 两条（限流与最终落盘缺单测、`translationTranslatePartial` 残留），前者已抽成 `shouldRetranslateLine` 并补测，后者已清掉 `translationSettingsChanged` 的键。

## 5. 已知取舍

- 英文槽左侧被裁的比例约 40~50%（尾部对齐是有意为之：最新的词必须可见）。
- shell 宽度仍按最宽槽位测，长英文行会让框偏宽（实测上限 722 px，未贴 860 上限）。
- 换句瞬间英文仍会变短（WLK 新行从短文本开始），这是 ASR 分段而非回跳。
- 阶段译文期间 `.translation.stale` 与小点较常出现（DeepL 实测 stale 54~69%、小点 21~36%），语义是「中文落后于最新英文」，不是「还在翻上一句」。
