# 06-review-fixes-0.4.2 · 0.4.1 评审问题修复记录

对应评审：外部模型对 `b761c10`（0.4.1）的代码审阅报告，P1×2、P2×3、P3×2。
修复版本：0.4.2（`package.json`、`extension/manifest.json`）。
验证环境：项目专用 Chrome 156（CDP 9223，未打包扩展 `dfjobgemgohmbmnagcpcneledbacpmoj`），未启动 ASR/翻译服务。
交叉审阅：GPT-6 Luna（paseo 子代理，只读），结论与处理见第 4 节。

> 结论：评审 P1 两项已修；P2 中 2.1/2.3 已修、2.2 复核后不成立；P3 常量与历史合并单测已补。交叉审阅的 1 个 P1、4 个 P2 已全部修复并回归。另修掉 3 个冒烟/复核中暴露的老问题。

## 1. 评审问题与处理

| 级别/编号 | 评审结论 | 处理 |
| --- | --- | --- |
| P1-1.1 浮层滚轮监听器泄漏 | `wheelBound` 只置 true 不重置，重建/重注入后旧监听器仍在 | `content-overlay.js` 增加 `bindWindowListeners()` / `teardown()`：窗口 `wheel`、`resize`、`fullscreenchange`、`chrome.runtime.onMessage`、`ResizeObserver`、idle timer 与 host 全部成对清理；`OVERLAY_VERSION` 升到 3，新实例注入时先调用旧实例的 `teardown()` |
| P1-1.2 `syncHistory` 每帧全量重建 | 每次 render 都 `new Map` + spread + sort + slice | 新增 `extension/overlay-history.js`：持久 `{entries, byId, limit}`，按行 id 原地更新晚到译文、按 order 插入新行、仅在超限时裁剪；`runtimeState.current.lines` 数组引用未变时直接跳过合并；日志满后跳过早于保留窗口的行。每次 render 不再产生新历史数组（单测断言数组/条目引用与日志稳定） |
| P2-2.1 `handleWheel` 高频 `getBoundingClientRect` | 每个滚轮事件 1-2 次布局读取 | 缓存 stage/历史面板 rect，由 `ResizeObserver` + 拖拽/挂载/定位/窗口 resize 失效；滚轮命中测试改用缓存盒 |
| P2-2.2 `lineViews` Map 可能积累 | 评审推测 append 路径残留旧条目 | **复核不成立**：append 路径按 `prevIds` 逐个 `view.article.remove()` + `lineViews.delete()`，两条路径结束后 `lineViews.size === renderedLineIds.length`；无匿名 id 的列表一律走重建。未改代码，仅保留结论 |
| P2-2.3 冻结快照不刷新晚到译文 | 回看时译文/新行都不更新 | 快照改为「冻结历史条目引用」：位置与行集合固定，新字幕不插入（阅读位置不跳动）；晚到译文仍写入同一对象，因此原地刷新；日志裁剪也删不掉已显示的行。`README` 已知问题改写为行为说明 |
| P3-3.1 魔法数字 | `3500` / `700` 写死 | 提取 `IDLE_FADE_MS`、`WHEEL_COOLDOWN_MS` |
| P3-3.2 单测覆盖 | 增量渲染 DOM 未测 | 新增 `tests/overlay-history.test.js`（8 例）；`syncTranscriptLines` 的 DOM 集成测试未做（需 jsdom/puppeteer，属评审建议非阻塞项） |

## 2. 冒烟/复核中额外发现并修复的老问题（0.4.1 既有）

1. **保存过拖拽位置的站点，浮层重新注入后可能跑到屏幕右下角/视口外。**
   - 根因：`loadPosition()` 在 stage 仍 `hidden` 时调用 `applyStoredPosition()`，`getBoundingClientRect()` 返回 0×0，`window.innerWidth - 0` 被当成可用宽度，`x=0.957` 被还原成 `998px`（真实可用宽度只有 187px）。
   - 修复：stage 隐藏或零尺寸时置 `positionPending`，在 `render()` 显示并写完正文后再应用；拖拽中不覆盖位置；resize/fullscreen/加载都先失效 rect 缓存。
   - 回归：冒烟第 1 项显式写入 `overlayPositions = {x:0.6, y:0.8}` 并断言落点等于按真实尺寸换算的坐标。
2. **历史为空时向上滚轮把空快照永久冻结**（0.4.1 把 `[]` 当成已冻结），之后即使有字幕也打不开。改为空结果不冻结、下次滚轮重新取。
3. **收起历史面板的尾动手势会滚动网页**：面板隐藏后其区域不再属于浮层，冷却期内落在原面板位置的滚轮会传给页面。现在冷却期内保留“刚收起的面板”命中盒，手势尾部照样吞掉；冷却结束后恢复正常。

## 3. 自动化验证

### 单元与语法

```text
npm test            -> 50/50 通过（新增 overlay-history 8 例）
node --check ext/*  -> 全部通过（新增 overlay-history.js）
```

### 浮层真实滚轮冒烟（12/12）

脚本：`.research/ui-smoke-042.py`（无服务，向内容脚本注入伪造 `caption-state`）。
结果：`.research/v042-smoke/results.json`。

| 检查 | 结果 |
| --- | --- |
| 注入后只有 1 个 host，显示最新行，且落点等于存储位置 | PASS |
| 向上滚 6 次 = 12 条历史，网页 `scrollY` 保持 0 | PASS |
| 晚到译文刷新冻结面板中的对应行 | PASS |
| 新字幕到达不改变面板行数与阅读位置 | PASS |
| 滚回最新一句自动收起，且不带动网页 | PASS |
| 冷却结束后滚轮恢复滚动网页（不误吞） | PASS |
| 版本替换后重新注入：仍 1 个 host，一格滚轮只前进 1 行 | PASS |
| 拖拽后滚轮命中区域跟随新位置 | PASS |
| 打开历史面板后拖动：面板新位置仍能接住滚轮 | PASS |
| 调整窗口大小后命中区域跟随重新居中的位置 | PASS |
| 历史日志始终封顶 60 条 | PASS |
| 回看期间再进 40 条新字幕：冻结的 40 行（含最旧一行）不消失 | PASS |

截图：

- `paseo/evidence/v042-overlay-history-open.png`（历史回看：12 条）
- `paseo/evidence/v042-overlay-history-closed.png`（滚回实时后）

### 环境备注

- Chrome 窗口被其他前台窗口完全遮挡时，`document.visibilityState` 变为 `hidden`，CDP `Input.dispatchMouseEvent` 不再应答（超时）。自动化冒烟需用 `--disable-features=CalculateNativeWinOcclusion` 启动专用调试 Chrome；本次仅在测试实例上手工加该参数，未改 `scripts/Start-DevBrowser.ps1`。
- `Emulation.setDeviceMetricsOverride` 在这台 1.75 缩放的机器上返回成功但不改变布局，缩放回归改用 `Browser.setWindowBounds` 真实调整窗口。

## 4. 交叉审阅（GPT-6 Luna）与处理

审阅基于当时的未提交工作树，运行了 `npm test` 与 `node --check`，只读、未改动文件。

| 审阅项 | 结论 | 处理 |
| --- | --- | --- |
| P1 0.4.1 旧实例没有 `teardown()`，其 `fullscreenchange` 仍能把已移除的 host 重新挂回页面 | 成立 | `retireStaleHosts()` 在构建和 `fullscreenchange` 时把非本实例的 host 置 `display:none` 后移除；旧实例即使重挂也是零尺寸、不可见、不会吞滚轮 |
| P2 worker 每次广播整窗 120 行，超过 60 条后旧行被反复插入再裁剪 | 成立 | 日志满后由 `syncHistory()` 与 `syncHistoryLog()` 双重跳过早于保留窗口的行；新增单测断言重复广播时 `entries`/首条目引用不变、返回 false |
| P2 快照只存 id，日志裁剪会让已显示行消失 | 成立 | 快照改存条目引用（见 1. P2-2.3）；冒烟新增“回看期间再进 40 条新行，40 行仍在” |
| P2 拖拽只清 stage rect，历史面板 rect 可能过期 | 成立 | 拖动过程与结束同时清 `historyRectCache`；冒烟新增“面板打开时拖动，新位置仍能接住滚轮” |
| P2 `refresh()` 直接赋值 `runtimeState`，绕过会话切换清理 | 成立 | 统一走 `setRuntimeState()`，与消息路径共用 `resetSessionHistory()` |
| P3 `overlay-history.js` 未注入时无降级 | 记录 | 唯一注入点按顺序成对注入两个文件；独立注入属不支持用法，见第 5 节 |
| 当前实例监听器配对、id 顺序/裁剪一致性、`positionPending` 交互、注入配对 | 通过 | 无需改动 |

## 5. 未完成 / 留待后续

- 评审建议的「3 台以上不同 Windows 配置」与「>2 小时长时直播内存观察」未执行（无多机条件，且本轮不启动真实服务）。
- `syncTranscriptLines` 的 DOM 级集成测试仍需引入 jsdom 或 Puppeteer；当前由 0.4.1 的 UI 冒烟与本次代码复核覆盖。
- 冻结快照有意不插入新行；若后续需要「有 N 条新字幕」提示，属于新功能。
- `content-overlay.js` 依赖先注入 `overlay-history.js`；单独注入浮层脚本会在初始化时报错，这是明确的不支持用法（`service-worker.injectOverlay` 是唯一入口）。
