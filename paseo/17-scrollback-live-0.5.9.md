# 0.5.9 · 滚轮回看窗口改为实时跟随

## 1. 要解决的问题

浮层上滑打开的「历史 N 条」窗口从 0.4.1 起就是**打开瞬间冻结**的：`scrollbackSnapshot`
把当时的行 id 列表锁住，之后新到达的字幕不会进入面板，只有已显示行的晚到译文会原地刷新
（`paseo/05-ui-fixes-0.4.1.md` §5-B 记的就是这件事）。用户的实际用法是看中文追英文，
窗口不跟着走等于必须反复关掉再重开。

## 2. 取舍

面板底部钉在字幕框上方（`.history { bottom: calc(100% + 8px) }`），行按「老→新」从上往下排，
可视高度上限 40vh。因此「锁住正在读的那几行 + 新行照常进来」在这个布局里做不到：新行只能挤在
可视区外，效果仍然等于冻结。二选一由用户拍板，选**窗口跟着最新行走（tail-follow）**：

- 窗口内容 = 回看日志里最新的 `scrollBack` 行（`scrollBack` 仍由滚轮步进，上限 `MAX_SCROLLBACK = 40`）。
- 新句从底部进来，最老的一行从顶部滑出去。
- 面板仍排除「正在生长的实时行」，那一行由下方字幕框负责，避免同句两处不同步。

## 3. 实现

| 位置 | 改动 |
|---|---|
| `extension/content-overlay.js` | 删除 `scrollbackSnapshot` / `renderedScrollbackKey`，改为 `scrollbackRows`（行对象数组，与渲染出的 `.history-line` 一一对应）；`scrollbackView` 取消，`renderScrollback` 每帧从 `scrollbackEntries()` 取最新窗口 |
| 同上 | 行节点按行 id 复用：`createHistoryRow` 建一次、`patchHistoryRow` 只改真正变化的 `textContent`；只有 id 变了才增删节点。禁回 `replaceChildren` 整表重建 |
| 同上 | `scrollTop` / `.overflowing` 只在「行集合或文本真的变了」时重算，空闲广播不产生布局读 |
| 同上 | `historyRowText` 统一槽位取值：双语模式下未译行不再把英文同时印在原文槽和译文槽 |
| 同上 | 行元素带 `data-line-id`，供 CDP 探针区分「同行晚到译文」与「新行」 |
| 同上 | `OVERLAY_VERSION` 6 → 7：行为变了，旧注入实例必须重建而不是复用 |
| `extension/overlay-history.js` | 新增纯函数 `planHistoryRows(previousIds, nextIds)`：给出目标顺序、要新建的行 id、要丢弃的行 id，DOM 侧只按它增删 |
| `tests/overlay-history.test.js` | +3 例：滑动窗口（1 进 1 出）、滚轮上滑/下滑、无变化与清空、乱序时隔离中间段 |

## 4. 判据红线

1. 回看窗口必须实时跟随最新行；禁以「锁住阅读位置」为名恢复快照冻结。
2. 面板每帧不得整表重建：行节点按 id 复用，文本按值比较后才写。
3. 窗口行数恒等于 `scrollBack`（上限 40），不因新行到达而自行增长。
4. 滚到底（`scrollBack` 归 0）必须关闭面板并清空行节点，`wheelCooldownUntil` 要吃掉同一手势的尾巴，
   否则会把 YouTube 页面滚走。

## 5. 实测（dev 浏览器 9223 + 固定样本 + 真实 tabCapture，DeepL 后端）

探针：`.research/scrollback-live-probe.py`（真实 CDP 滚轮事件开面板，8 Hz 采 Shadow DOM）。
指标口径：`node re-creations` = 同一 `data-line-id` 在采样期出现的不同节点标记数；
`A→B→A flips` = 同一行译文压缩后回退到两步前的次数。

| 轮次 | 采样 | 面板行数 | 打开后新进来的行 | 节点重建 | 译文 A→B→A | 面板高度 |
|---|---|---|---|---|---|---|
| 0.5.8 前（对照组，冻结快照） | 60 s | 9 恒定 | 0 | 0（不刷新） | — | 恒定 |
| 0.5.9 第 1 轮 | 60 s | 9 恒定 | 16 | 0 | 0 | 恒定 287 px |
| 0.5.9 第 2 轮 | 45 s | 5 恒定 | 14 | 0 | 1（见下） | 恒定 287 px |
| 0.5.9 第 2 轮·深滚 | 20 s | 20 恒定 | 8 | 0 | — | 恒定 287 px |
| 0.5.9 收尾轮（0.5.9 构建） | 25 s | 6→16 | 10+ | 0 | 0 | 恒定 287 px |

- 深滚阶段（30 次滚轮上滑）行数停在 20 = 当时可用行数，未超 `MAX_SCROLLBACK`；再往下滑回最新行，
  面板 `hidden: true`、行数归 0。
- 第 2 轮那 1 次 A→B→A 是一行**译文内容**的回退（`…都能找到一块废墟石…` → 带后半句的阶段译文
  → 又回到短句），来自 service worker 的解码顺序，不是面板重建：该行节点标记始终同一个、
  面板高度全程未变。属 0.5.8 阶段译文机制的已知表现，不在本次范围。
- 同一构建上跑 `.research/rebound-probe.py 60` 复验字幕本体：译文与英文槽 A→B→A 均为 0、
  英文槽高度恒 28 px、60 帧全可见，说明回看窗口的改动没有反向污染实时槽。

## 6. 未做

- 未在 server 模式（WLK 自带译文）下复测面板的实时性；译文本就随 `lines` 更新，预期一致。
- 未测 40 行满窗 + 超大字号下的滚动锚点手感，只在 20 行状态做了深滚。
- 未做「有 N 条新字幕」提示：tail-follow 下新行就在窗口里，不再需要计数提醒。
