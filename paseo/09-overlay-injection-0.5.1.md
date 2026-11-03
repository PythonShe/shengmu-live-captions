# 09-overlay-injection-0.5.1 · 浮层整体不出现（旧 worker + 新内容脚本）

问题来源：用户报告「新的 issue：浮层没有正确开启，开关也无效，实际后台字幕已经在跑了，字幕记录有，就是没浮层」。
修复版本：0.5.1（`package.json`、`extension/manifest.json`）。
验证环境：项目专用 Chrome（CDP 9223，未打包扩展 `dfjobgemgohmbmnagcpcneledbacpmoj`）、YouTube 页面、WhisperLiveKit 8010、llama.cpp 8013。
交叉审阅：Gemini 4 Argon（paseo 子代理，只读）：第一轮「暂不建议直接提交」，P1 3 项 + P2 2 项；全部修复后复核。

> 结论：已修复。降级路径、失败上报与恢复链路均有 CDP 实测证据，`npm test` 57 项全过。

## 1. 定位过程

用户先怀疑与沉浸式翻译冲突（日常 Chrome 装有 Immersive Translate + uBlock），关闭两个翻译功能后问题依旧。

| 已验证的排除项 | 证据 |
| --- | --- |
| 站点访问权限 | 读日常 Chrome `Secure Preferences`：`active_permissions` 含 `<all_urls>`、`scripting`，`withholding_permissions: false` |
| `executeScript` 注入能力 | dev browser 里注入成功，host 挂到 `<html>` |
| caption-state 广播链路 | 从扩展页 `tabs.sendMessage` 注入伪造字幕，浮层正常显示双语与探针文本 |
| 扩展 reload 后的孤儿实例 | 先注入并广播 probe-A → `chrome.runtime.reload()` → 再注入广播 probe-B，文本正常切换 |
| 位置存储越界 | `applyStoredPosition` 对 x/y 做 `[0,1]` clamp |

最终由用户贴出的页面 console 报错定型：

```
Uncaught TypeError: Cannot read properties of undefined (reading 'createHistoryLog')
```

## 2. 根因

`extension/service-worker.js` 的注入文件列表在 0.4.2 才变成两个文件：

```js
files: ["overlay-history.js", "content-overlay.js"]   // 0.4.2+
files: ["content-overlay.js"]                          // 0.4.0 / 0.4.1
```

用户日常 Chrome 里扩展没有整体 reload，**service worker 仍是旧代码**（单文件注入），而 `content-overlay.js` 每次都是从磁盘读取的新版本，开头就取 `globalThis.ShengmuOverlayHistory`（由 `overlay-history.js` 提供）→ `undefined` → 抛错 → 整个 IIFE 在 `buildOverlay()` 之前中断。

因此：后台采集/ASR/翻译/历史写入全部正常，浮层从未被创建，开关每次触发注入都崩在同一行，表现为「开关失灵」。

## 3. 修复

| 文件 | 改动 |
| --- | --- |
| `extension/content-overlay.js` | `ShengmuOverlayHistory` 缺失时使用降级 `HISTORY_API`（只失去滚轮回看）；`syncHistoryLog` 每次调用动态委托 `globalThis.ShengmuOverlayHistory`，补充注入后无需重建实例即可恢复历史与双行上一句 |
| `extension/service-worker.js` | `injectOverlay` 的 `executeScript`/`init` 失败不再吞掉，统一走 `reportOverlayFailure`；新增 `reportOverlayFailure`（幂等，`persistRuntimeState` + `broadcastToExtension({type:"status"})` + `broadcastCaptionState`）；`applyOverlaySetting` 不再手写 detail；`finalizeSession` 清空 `overlayError`；`refresh-overlay` 校验 `isExtensionPageSender` + `active`；`content-ready` 自愈清错 |
| `extension/caption-utils.js` | `EMPTY_RUNTIME_STATE.overlayError`；新增 `OVERLAY_UNAVAILABLE_DETAIL` 与 `applyOverlayFailure(state, error)` 幂等状态转换 |
| `extension/popup.html/.css/.js` | 浮层开关下新增提示条（失败原因 + 「重新注入」按钮），仅在 `overlayEnabled && active` 时显示 |
| `tests/` | `applyOverlayFailure` 单测；`refresh-overlay` 无会话失败、content script sender 被拒两个集成用例（57 项） |
| `AGENTS.md` / `README.md` | 记录该坑、同步模块行数表与版本记录 |

## 4. 验证

`npm test`：57 项全过。`node --check extension/*.js tests/*.js`：全过。

CDP 实测（`.research/diag-review-fixes.py`）：

| 步骤 | 期望 | 实际 |
| --- | --- | --- |
| 重置实例与历史 API，只注入 `content-overlay.js` | 浮层显示，双行上一句为空 | `stageHidden:false`、`translation:"降级第一行。"`、`previous:""` |
| 再注入两个文件（实例被 `OVERLAY_VERSION` 短路） | 不重建，但委托生效 | 注入成功，`hosts:1` |
| 再广播新一行 | 双行上一句恢复 | `previous:"恢复后的第二行。"` |
| popup 收到带 `overlayError` 且 `active:true` 的 status | 提示条显示 | 显示失败原因 + 提示重新加载 |
| 收到错误已清空的 status | 提示条消失 | `hidden:true` |
| 收到 `active:false` + 残留错误 | 提示条不显示 | `hidden:true` |

另外验证：无活跃会话时点「重新注入」返回「当前没有正在采集的标签页」。

## 5. 审阅与处理

| 编号 | 级别 | 结论 | 处理 |
| --- | --- | --- | --- |
| 1 | P1 | `reportOverlayFailure` 只广播给 content script，popup 收不到 `overlayError` 置位/清除 | 增加 `broadcastToExtension({type:"status"})`，文案与恢复逻辑收敛到 `applyOverlayFailure` |
| 2 | P1 | 停止会话后 `overlayError`/`tabId` 残留；`refresh-overlay` 未校验 `active` 与 sender | `finalizeSession` 清空、`refresh-overlay` 双重校验、popup 提示加 `active` 条件 |
| 3 | P1 | 降级实例因 `OVERLAY_VERSION` 短路，重载扩展后无法恢复滚轮回看/双行上一句 | `syncHistoryLog` 动态委托，CDP 实测恢复 |
| 4 | P2 | `content-ready` 未清 `overlayError` | 加自愈分支 |
| 5 | P2 | 缺测试、AGENTS.md 行数过期 | 新增 3 项测试、同步行数表与 README |

## 6. 用户操作

1. `chrome://extensions` → 声幕 → **重新加载**（关键，刷新页面无效）
2. 刷新 YouTube 标签页
3. 重新开始字幕

若再遇到同类现象，控制面板会在浮层开关下方直接给出失败原因与「重新注入」按钮。
