# 07-ui-fixes-0.4.3 · 三个已知问题的修复记录

对应问题来源：`paseo/05-ui-fixes-0.4.1.md` §5-A（超长句铺满浮层）、§6-1（场次列表横向滚动条）、§6-2（静音碎片行）。
修复版本：0.4.3（`package.json`、`extension/manifest.json`）。
验证环境：项目专用 Chrome 156（CDP 9223，未打包扩展 `dfjobgemgohmbmnagcpcneledbacpmoj`）、WhisperLiveKit `-AsrOnly`（8010）、本地静态冒烟页 `127.0.0.1:8781`。
交叉审阅：GPT-6 Luna（paseo 子代理，只读）。

> 结论：三个问题已修。审阅共提 4 项（P1 纯数字被误杀、P1 孤立小数/时间码被误丢、P1 时间戳缺失被折算成 0 时长、P2 小视口大字号仍可能顶部裁切），全部修复并回归；纯符号行按用户确认继续丢弃。

## 1. 问题与处理

| 级别/编号 | 问题 | 处理 |
| --- | --- | --- |
| A 超长 ASR 句铺满屏幕 | 一条 120.06 秒、2227 字符的 ASR 句会被整段渲染，字幕框高度超过视口 | 浮层三个 slot 改为固定行数窗口：译文 3 行、原文 2 行、上一句 2 行；`display:flex; flex-direction:column; justify-content:flex-end` 让**最后几行**留在视野内，超出部分在顶部裁掉；`markCaptionOverflow()` 实测内层高度，超出时加 `.overflowing` 做 `mask-image` 顶部渐隐；浮层历史面板每行用 `-webkit-line-clamp` 限高（译文 2 行、原文 1 行 + 省略号）。`OVERLAY_VERSION` 3 → 4，旧实例通过 `teardown()` 退役 |
| A-附 | 拖动过的浮层按视口比例存位置，内容变高后会溢出视口底部 | 新增 `keepStageInViewport()`：`.dragged` 状态下每次渲染后把溢出的 `top/left` 拉回视口内 |
| B 场次列表横向滚动条 | 长标题/长 hostname 把 rail 卡片撑到 890px，列表 `scrollWidth` 894 > `clientWidth` 264 | `.session-list` 加 `grid-template-columns: minmax(0, 1fr)` + `overflow-x: hidden`；`.session-card`、`.session-card-head` 加 `min-width: 0`；`.session-card-head strong` 加 `flex: 1 1 auto`；`.session-card-foot` 与子项加 `min-width: 0` + 省略号。修复后 `scrollWidth == clientWidth == 264` |
| C 静音碎片行 | 静音时 ASR 产出「7.8.」这类无字母碎片，会显示、入库并送去翻译 | `caption-utils.js` 新增 `isNoiseTranscript(text, duration)` 与 `transcriptDuration(line)`，在 `normalizeCaptionLines()`（worker 唯一的行归一化入口）里丢弃该类行，并按同一规则清空纯符号 buffer |
| P1（审阅） | 初版规则「无字母 + ≤6 位纯数字」会丢掉 `42`、`1,024` 这类合法数字口播 | 第一轮收窄为「小数/时间码/纯符号」形态，普通整数保留 |
| P1（复核） | 孤立小数/时间码（`3.14`、`12:34`）仍可能被丢弃 | 按用户决定改为**行时长判定**：无字母的小数/时间码形态在该行 ≤ 1.5 秒时才丢弃，超过视为真实口播保留 |
| P1（复核二） | 时间戳缺失/倒置时 `parseTimecode` 返回 0，会把「未知时长」当成「很短」而误丢 | 新增 `transcriptDuration(line)`：只有 `end > start` 才算时长，否则返回 `null`；`isNoiseTranscript` 对 `null`/非有限/≤0 的时长一律**保留** |
| P1（复核三） | 只有单边时间戳（如 `{end: "0:00:01.00"}`）时仍会被算成 1 秒 | 新增 `TIMECODE_SHAPE` 校验：两端都必须是合法 `H:MM:SS.cc`（或数字秒）才算时长，单边缺失/乱码 → `null` → 保留；补 4 个用例 |
| P2（复核四） | `parseTimecode` 也接受数字秒，但校验只认字符串，数字型时间戳会被判为未知（噪声行少被过滤） | `timecodeSeconds()` 同时接受有限数字；已核对 WhisperLiveKit `timed_objects.py:6` 的 `format_time()` 始终输出 `H:MM:SS.cc` 字符串，故该分支只是防御 |
| P2（审阅） | 64px 字号 + 短窗口（约 400px 高）时，未拖动的浮层顶部会超出视口 | `.caption-shell` 加 `max-height: min(70vh, 680px)`；`.prev-translation`/`.source` 设 `flex: 0 3 auto`（先被压缩），`.translation` 设 `flex: 0 1 auto`，三者 `min-height: 0` |

## 2. 实现要点

- DOM：`.prev-translation` / `.source` / `.translation` 各加一层 `<span class="caption-text">`，slot 自身变成定高窗口，内层 span 保持自然高度（`flex: none`），这样 `justify-content: flex-end` 才能让溢出发生在顶部。
- 文本写入统一走 `setCaptionText(element, text)`：写内层 span + 按文本是否为空 toggle `.visible`（原来靠 `:empty` 隐藏，加了内层后失效）。`applyVisualSettings()` 不再直接 toggle `.source.visible`，显示模式仍由 render 里的 `displayMode === "bilingual"` 决定。
- 溢出判定 `markCaptionOverflow()`：`inner.getBoundingClientRect().height - element.clientHeight > 1`，每次 render 与窗口 resize 后各测一次；元素不可见时清掉 class，避免字号调小后残留渐隐。
- 噪声规则（`extension/caption-utils.js`）：

  ```js
  const DECIMAL_FRAGMENT = /^\d+(?:\.\d+)+\.*$/;      // 7.8. / 7.8
  const CLOCK_FRAGMENT = /^\d{1,2}:\d{2}(?:\.\d+)?$/;  // 00:12
  const SYMBOLS_ONLY = /^[\p{P}\p{S}]+$/u;             // ... / %$# / ♪（无条件丢）
  const NOISE_MAX_DURATION_SECONDS = 1.5;
  const TIMECODE_SHAPE = /^(?:\d+:)?\d{1,2}:\d{1,2}(?:\.\d+)?$/;
  // 含任意 Unicode 字母（含汉字、假名、韩文）一律保留；普通整数一律保留；
  // 小数/时间码形态只在行时长 ≤ 1.5 s 时丢弃；
  // 时长未知（单边缺失/乱码/倒置，transcriptDuration 返回 null）一律保留；
  // buffer 没有时长，因此只丢纯符号 buffer。
  ```

## 3. 验证

### 单元测试

```powershell
npm test
```

53 项全过。新增 3 项：`isNoiseTranscript` 形态与时长判定（`42`/`1,024`/`2024` 必须保留、6 秒的 `3.14` 必须保留、时长未知必须保留、`♪` 无条件丢弃）、`transcriptDuration`（缺失/相等/倒置/单边缺失/乱码 → `null`，数字秒 → 正常计算）、`normalizeCaptionLines` 丢弃 0.5 秒的 `7.8.` 但保留 6 秒的 `3.14`、无时间码与单边时间戳的 `7.8.`。

### CDP 冒烟（无服务，注入伪造 caption-state）

```powershell
.research/wlk-venv/Scripts/python.exe .research/ui-smoke-043.py
```

8 项全过：

1. 冒烟页可见 + 浮层只挂一次
2. 正常单行字幕 1 行、无渐隐、浮层高度 < 视口 20%
3. 超长句译文限 3 行、原文限 2 行
4. 超长句下字幕框高度 < 视口 45%，且整体在视口内
5. 裁剪槽位有顶部渐隐、文本未丢失（长度与注入一致）
6. 浮层历史行：译文 2 行（648 字的那条实测 57px）、原文单行省略
7. 短句回来后渐隐被清除
8. 520px 高窗口 + 64px 字号（dual 模式、全新实例、无存储位置）下整块浮层仍在视口内

截图：`paseo/evidence/v043-overlay-longline.png`、`v043-overlay-history-longline.png`、`v043-overlay-cramped-viewport.png`。

### 回归

```powershell
.research/wlk-venv/Scripts/python.exe .research/ui-smoke-042.py
```

0.4.2 的 12 项浮层冒烟全过（DOM 结构与 `.visible` 切换改动未破坏历史回看、冻结快照、滚轮命中、拖拽、缩放、日志裁剪）。脚本里的 `OVERLAY_VERSION` 断言已从 3 改为 4。

### 场次列表

`.research/v043-smoke/diag-sessions.py` 向 IndexedDB 写入一条超长标题场次并 reload 测量：修复前 `scrollWidth 894 / clientWidth 264`，修复后 `264 / 264`，卡片标题与 foot 正常省略。截图 `paseo/evidence/v043-session-rail.png`。

### 真实 ASR 素材

WhisperLiveKit（`-AsrOnly`）+ `.research/quality-samples/WIuIdulr-K0-poe-30m45-32m45.wav`（2 分钟，4 倍速投喂）。把该轮的 134 条唯一转写全部喂给 `isNoiseTranscript`：丢弃 0 条，真实英文行没有误杀。另外用纯静音与低电平粉噪声各 20 秒投喂，WLK 自身没有输出碎片行，因此「7.8.」的原始触发条件未能稳定复现（原始证据仍是 0.4.1 录制），本项修复以规则单测 + 真实素材零误杀为准。

## 4. 交叉审阅（GPT-6 Luna）

审阅基于未提交工作树，只读，自行跑了 `npm test` 与 `node --check`。

| 审阅项 | 结论 | 处理 |
| --- | --- | --- |
| P1 纯数字被误杀：`42`/`1,024` 等合法口播会被丢弃 | 成立 | 先收窄为形态匹配，再按用户决定改为行时长判定（≤1.5 s 才丢）；补测试用例 |
| 复核：孤立小数/时间码（`3.14`、`12:34`）可能被丢弃 | 成立（条件性 P1） | 改为行时长判定后，这类 6 秒长的行实测保留；只有 ≤1.5 s 的暂停碎片会被丢 |
| 复核：时间戳缺失/倒置被折算成 0 时长，会误丢 | 成立（P1） | 新增 `transcriptDuration()`，`end > start` 才算时长，否则视为未知并保留；补测试 |
| 复核：单边缺失时间戳仍被算成 1 秒 | 成立（P1） | 加 `TIMECODE_SHAPE` 双端校验；补 4 个单边/乱码用例 |
| 复核：数字型时间戳被判为未知 | P2，前提不成立（WLK 始终输出字符串），仍做了兼容 | `timecodeSeconds()` 接受有限数字 |
| 最终轮 | 无残留 P0/P1，`npm test` 53 项通过，可提交 | — |
| 复核：单独音乐符号被丢弃 | 产品取舍，用户确认继续丢弃 | `SYMBOLS_ONLY` 保持不变，始终丢弃纯符号行 |
| P2 64px 字号 + 约 400px 高窗口下未拖动浮层顶部裁切 | 成立（实测 520px 窗口 stage 高度 268px，已修复） | `.caption-shell` 加视口高度上限，旧槽位优先压缩；冒烟新增第 8 项 |
| 显示模式与 pending/failed 占位切换 | 通过 | 无需改动 |
| 静音碎片入口是否唯一 | 通过 | `normalizeCaptionLines` 是唯一入口，历史写入、翻译、SRT 都在其后 |
| 窄屏（≤820px）场次列表 | 通过 | 媒体查询里的 `overflow-x: auto` 与 `min-width: 210px` 仍生效 |
| 版本号同步 | 通过 | `package.json` 与 `manifest.json` 均为 0.4.3 |

## 5. 未完成 / 留待后续

- 「7.8.」碎片行的**真实复现**：纯静音与低电平噪声都无法让 WLK 输出该形态，需要用原始出问题的直播素材才能复现；当前以规则单测与真实素材零误杀作为验证手段。
- 记录页历史行（`subtitle.html` 的 `.line-translation`）未加行数上限。该页是可滚动阅读视图，长行不影响浮层可用性，若后续要折叠需新增「展开全文」交互。
- 「按标点二次切分超长 ASR 句」这一治本方案未做（会改动行 id 与晚到译文回填逻辑），本轮采用显示层限行。
- `syncTranscriptLines` 的 DOM 级集成测试仍缺 jsdom/Puppeteer（0.4.2 遗留）。
