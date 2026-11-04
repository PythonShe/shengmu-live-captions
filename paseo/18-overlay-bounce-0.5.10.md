# 0.5.10 · 浮窗换行与高度抖动

## 要解决的问题

强制换行前后，浮窗在「单行 / 双行」之间反复切换，折行瞬间第 1 行文字大幅重排、右侧留大片空白。
`plan.md` 给出的实测基线：真实 60 s 样本（`GHEBkhT1K7A-05m41-07m41.wav`）里 `shellHeight` 在
117 / 164 / 211 px 之间跳变 16 次，译文文本本身 `A→B→A` 已是 0。

四条叠加根因（编号沿用 `plan.md`）：

| 编号 | 故障点 |
|---|---|
| R1 | 阶段译文从 1 行长到 2 行，换句又缩回 1 行，每句一次 `2 行 → 1 行 → 2 行` |
| R2 | `.caption-shell` 底部锚定，底部槽位换行时整个上边框被顶着上下跳约 47 px |
| R3 | `text-wrap: balance` 让折行时第 1 行后半截搬家，并每追加几字重新平分一次 |
| R4 | `.caption-stack` 宽度 170 ms 过渡 + Canvas 量宽零余量 → 文字先折 2 行、宽度到位再弹回 1 行 |

## 取舍（用户拍板）

- **行高预留被否决**：先按 `plan.md` 实现「同句单调不缩 + 跨句 2.8 s 延迟回落 + 未溢出时顶对齐」，
  实测每个短句阶段都会在中文下方留出一整行空白（`min-height` 保留了 2 行但只有 1 行字），
  用户明确否掉。改为**取消预留 + 给盒子高度加 160 ms 缓动**：`1↔2 行`依旧发生，但不再瞬跳。
- 上一句槽位（`.prev-translation`）与中文槽位同策略，不留「中文平滑、上一句还在跳」的半吊子状态。

## 实现

修 R3（无重排）：删掉 `.translation`、`.prev-translation` 的 `text-wrap: balance`。第 1 行填满到右侧内边距
再换行，追加文字只往第 2 行末尾长，右侧不再留白。

修 R4（无瞬态假换行）：
- `measureShellWidth` 在 `contentWidth + chromeWidth` 上加 `SHELL_WIDTH_SLACK_PX = 12`，吸收 Canvas
  `measureText` 与 DOM 实际排版的亚像素差（中英混排、标点挤压、粗体衬线字距）。
- `.caption-stack` 去掉常驻 `transition: width`；缩窄时才挂 `.shrinking` 类（170 ms ease-out），
  变宽分支直接写目标宽度，同一帧生效，杜绝「先折 2 行、170 ms 后弹回 1 行」。

修 R1/R2（高度不再瞬跳）：
- `.caption-shell` 高度始终显式（px），CSS `transition: height 160ms cubic-bezier(0.22, 1, 0.36, 1)`。自然高度由
  `measureShellNaturalHeight` 从**槽位内文本盒**求和（padding + 边框 + 各可见槽位文本高度按槽位
  `max-height` 截断 + 外边距 + 错误行），**不去写 `height: auto` 再读**——那会打断在途 transition，
  等于把缓动砍掉一半。
- 目标高度只在变化 ≥ 2 px 时写入（一行 36~47 px，1 px 级差异是测宽噪声），否则每次 render 都会
  重启动画。
- `.caption-shell.resizing`（`SHELL_HEIGHT_RESIZE_LOCK_MS = 200 ms` 内存在，比 CSS 的 160 ms 多 40 ms 余量）把 `.prev-translation`、`.translation` 改成 `flex: 0 0 auto`：
  盒子在动画中比内容矮时，可收缩的槽位会把文字顶走（实测译文 `top` 在一次动画里漂 47 px 并短暂
  挂上 `.overflowing` 渐隐），锁住槽位后只有外框上沿在动、文字位置不变。

## 实测（同一 60 s 样本、同一探针，8 Hz 采样）

探针 `.research/rebound-probe.py` 增记每 125 ms 的 `shellHeight` / 槽位高度 / 译文字数 / 槽位
`min-height`，并对「同一文本行数变化」（折行回弹）与「稳定 ≥250 ms 的高度序列 A→B→A」（高度往返）
分别计数。

| 指标（60 s / 40 s 同一时间窗） | 0.5.9 | 0.5.10 |
|---|---|---|
| 同一文本折行回弹（wrap rebound） | 2~3 次（宽度 617→678、627→726 等，正是 R4） | **0** |
| 文本 `A→B→A` 回跳 | 0 | 0 |
| 译文 `top` 变化次数 = 行数变化次数 | 是 | 是（14/14、13/13，动画期不再漂移） |
| 稳定高度序列 `A→B→A` | 0~2 | 5（`1↔2 行`仍在，只是 160 ms 缓动） |
| 空白行（预留 `min-height`） | 无 | 无 |
| `>3 行` 顶部渐隐 | 生效 | 生效（实测译文内容 4 行、槽位 3 行 + `.overflowing`） |

结论：折行瞬态回弹与第 1 行重排已消除；`1↔2 行`的高度变化仍在，但被 160 ms 缓动，且不留空白行。

## 红线

- 禁恢复 `text-wrap: balance`（会重新引入折行半行搬家与右侧留白）。
- 禁删 `.caption-shell.resizing` 的 `flex: 0 0 auto` 规则（删了动画期间文字会被顶走并闪渐隐）。
- 禁把量宽改回读 DOM（见 `AGENTS.md`），也别把 `SHELL_WIDTH_SLACK_PX` 调成 0。
- 禁把 `syncShellHeight` 改成「`height: auto` 量完再设值」，会打断在途 transition。

## 未做 / 观察

- 拖到页面下方的浮层是 top 锚定的（`stage.style.top` 已写死），盒子变高时向下长、还会被
  `keepStageInViewport` 顶回，观感比默认底部锚定差；本轮未动，记入 `plan.md`。
- 不是本轮引入但被本轮放大的现象：`prev-translation` 有时显示的是当前句的阶段译文前缀
  （`previousTranslation` 按整串不等来挑行），看起来像「上一句没动」。
