# 0.5.11 · 浮层广播风视觉改版

## 为什么改

浮层的第一受众是**通过推流画面看直播的观众**（主播自己另开 `subtitle/subtitle.html` 看完整双语文稿）。按这个定位复盘 0.5.10 的浮层，有四个直接损害观看体验的点：

| 维度 | 0.5.10 现状 | 实际表现 |
|---|---|---|
| 字体 | 中文 `Noto Serif SC / Songti SC / SimSun`，英文 `Georgia / Times New Roman` | Windows 观众没有思源宋体，落到中易宋体：横画 1px，经 H.264 4:2:0 + 码率压缩后断笔、发虚 |
| 颜色层级 | 中文暖白 `#fffdf4`，英文同色 63% 半透明 | 只靠透明度分级，底板调淡或画面有高光时英文透底发灰发脏 |
| 描边 | 只有单向下方投影 | 文字上方与左右没有黑边，白字上半截融进亮色爆炸 / 冰霜地面 |
| 外框 | 暗绿茶色底 + `saturate(0.8)` + 左侧 3px 金条 + 右上渐变金线 + 不对称圆角 | 与直播游戏画面抢注意力，金条把余光从正文拉走 |

设计来源见 `research.md` §6（ReaLingo 对比调研得出的三条拍板方向）。

## 落地

**配色：冷暖分轨，用实色代替透明度。** 观众看的字自身不透明度都在 0.88 以上，靠色相与明度建立层级：

| 槽位 | 0.5.10 | 0.5.11 |
|---|---|---|
| 当前句中文 `.translation` | `#fffdf4` | `#ffffff` 700 |
| 当前句英文 `.source` | `rgba(255,253,244,.63)` | `rgb(180 212 244 / .92)` 冰川蓝 500 |
| 英文未定稿尾巴 `.source-stash` | 与已定稿无区分 | `rgb(180 212 244 / .56)` |
| 上一句中文 `.prev-translation` | `rgba(255,253,244,.82)` | `rgb(203 213 225 / .88)` 冷银灰 600 |
| 空占位 `.translation.pending` | 暖白 65% | `rgb(180 212 244 / .68)` |
| 回看面板 | 暗绿底 + 暖白字 | 黑曜石底 + 英文冰蓝 + 中文 `#f1f5f9`；meta chip 由金色改冷灰蓝 |
| 底板 `.caption-shell` | 暗绿渐变 + `saturate(.8)` | `180deg rgb(14 18 26) → rgb(8 11 16)`，去 `saturate` |

**字体：现代无衬线。** 两个变量落在 `.stage` 上，槽位统一引用：`--caption-sans`（中文，700 / `letter-spacing .015em`）、`--caption-latin`（英文，Inter 500）。`measureSlotWidth` 用 `getComputedStyle` 读字体族送 Canvas，变量已在计算值里展开，量宽代码无需改动。

**描边：闭合 `text-shadow`。** `--caption-outline-strong` 是 8 向 1px 黑边 + 弥散底影（译文），`--caption-outline-soft` 是 4 向 + 底影（英文、上一句、面板）。不用 `-webkit-text-stroke`：描边会向内侵蚀字白，字形发胖，8 向阴影只加黑护城河。底板拉到 5% 时白底仍能看清，这是本次改版最直接的收益。

**外框减法。** 去掉左侧金条、右上金线、`saturate(0.8)`；`border-radius: 14px` 对称，1px 白微光边（随 `--overlay-opacity` 缩放），内边距由 `18px 22px 16px` 收到 `14px 22px` 对称。等待小圆点由暗黄改冰蓝、右下移到 `14px/8px`。

**英文未定稿尾巴（stash）。** `composeLiveSourceParts` 把「已定稿行 + 识别中的尾巴」拆成 `{ stable, stash }`，`selectDisplayCaption` 输出 `sourceStable` / `sourceStash`，浮层用 `setSourceText` 把 stash 包进 `.source .caption-text > span.source-stash`。三条不变量：

1. `.caption-text` 的 `textContent` 仍等于 `composeLiveSource` 的单串（Canvas 量宽与 `markCaptionOverflow` 都读它），否则量窄触发假折行；
2. 拆分逻辑在 `lib/caption-utils.js` 与 `content-overlay.js` 各一份，必须同步（IIFE 无法 import）；
3. 模式来回切换后槽位可能被清空，`setSourceText` 的重建条件要同时看内容键与「有没有子节点」。

`OVERLAY_VERSION` 10 → 11（DOM 多了一层 stash span），`package.json` / `manifest.json` 同步 0.5.11。

## 验收

- `pnpm run verify` 286 项（285 pass / 1 skip）、`pnpm run smoke` 11 项全过。
- 新增单测：`composeLiveSourceParts` 四种切分（重复尾巴、尾部重叠后追加、纯 buffer、纯行）；`selectDisplayCaption` 三处断言补 `sourceStable` / `sourceStash`。
- 可视化预览（`C:/Users/moule/Documents/ChatGPT/.style-preview/preview.mjs`，仓库外工具）：mock `chrome.*` + 注入真实 `content-overlay.js` + CDP 截图，五张图覆盖双语、stash、dual+等待点、纯白压测、5% 底板；实测 `shell` 851px、英文槽恒 28px、`.source-stash` 取色 `rgba(180,212,244,0.56)`、译文 9 条 text-shadow。

## 已知取舍

- 本机未装 HarmonyOS Sans / MiSans，预览与多数 Windows 观众实际看到的是 Microsoft YaHei UI 700。
- `subtitle/subtitle.html` 是长文阅读页，仍保留原样式，未跟进本次视觉（用户拍板暂不动）。
- stash 依赖 worker 广播的 `sourceStable`/`sourceStash`；更老的 worker 只发 `source`，浮层会把整行当已定稿，退化为旧观感而不是报错。
