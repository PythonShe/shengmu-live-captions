# 声幕 · 下一步计划（2026-11-05 修订）

基线实测（不是引用旧记录）：`pnpm run verify` 296 项 295 pass / 1 skip / 0 fail；`pnpm run smoke` 11 项全过。

## 0. 仓库状态（与上一版计划的偏差）

| 项 | 上一版写的 | 实际 |
|---|---|---|
| 未推提交 | 4 个 | **5 个**（`c6f54f6` 0.5.11 视觉起，到 `d177538`） |
| 与远端关系 | 直接 push | **ahead 5 / behind 1**：上游已用 `865f0d9` 合并 PR #2 |

已核对 `git diff 1efaa8c 865f0d9`：差异全部是本地独有的 0.5.11（视觉、stash、文档、版本号），PR #2 的实现与测试两侧一致。所以 push 前 **merge `origin/master`，禁 rebase**（rebase 会让 5 个提交在 PR #2 上反复冲突重放）。

## 1. 已拍板（本轮做完的部分）

| 决策 | 结论 | 状态 |
|---|---|---|
| 重译限流 | B 按后端分档：配置带 `apiKey` → 24 字符 / 1200 ms；无 Key（Chrome 内置、无 Key 自定义端点）→ 8 / 400 | 已实现（`resolveRetranslateThrottle`）+ 2 项单测 |
| `research.md` | 只把 §7 百炼选型拆成 `paseo/20-bailian-free-tier.md` 入库，其余留在仓库外 | 已入库 + `paseo/README.md` 索引 |

依据：主力是付费 API 且挂后台常开，当前设置比终态多发 4.3 倍字符，放宽后约省 40%（见 PROGRESS.md 限流成本核算表）。

## 2. 剩余步骤（按顺序）

1. **merge `origin/master`**：`git fetch && git merge origin/master`，冲突应只出现在 `PROGRESS.md`（两侧都追加了 PR #2 记录），保留两侧内容。
2. **跨模型 code review**：范围 `merge-base(origin/master, HEAD)..HEAD`，覆盖 0.5.11 视觉改版、PR #2 回合并、限流分档、`paseo/20`。独立 workspace + worktree、`code review` profile、只读约束。P0/P1 必修并复测。
3. **push 到 `origin/master`**（禁未经指令 push，需我确认）。
4. **真机采一轮**（付费 API + 新 24/1200 档）：**已完成 2026-11-05**。样本 `vkCu3V81N74-poe-05m15-07m15.wav` 120 s：21 行 / 20 有译文、缺译 0、`deliveredRatio` 0.99993、历史 20 行一致，达标。另一段 `Gq2r7x5qgmg-poe-24m00-26m00.wav` 整段只出 1 行，定位为 WLK 分段问题（非本轮回归），已记入 backlog。

## 3. 未阻塞的验证缺项

| # | 缺项 | 优先级 |
|---|---|---|
| 1 | Chrome 本机识别路径复测（非 WLK） | 中 |
| 2 | server 模式（WLK 自带译文）浮层复测 | 中 |
| 3 | 24/1200 下阶段译文跟手度体感确认（最坏等 1.2 s） | 中，跟第 4 步同一轮做 |

## 4. Backlog（不阻塞本次发布）

- [ ] WLK 连续讲话不分段：`Gq2r7x5qgmg-poe-24m00-26m00.wav` 整段 2 分钟仅 1 行（3543 字符），顶满 70vh 与历史 2 行截断；需在 WLK 侧强制切段或客户端对超长行按 `FRAGMENT_MAX_CHARS` 再切

- [x] 百炼翻译默认模型 `qwen-plus` → `qwen3.7-flash`（已完成）
- [x] `qwen-mt-*` 专用翻译协议（已完成：0.2~0.36 s，真机首中文 p50 <1 s）
- [ ] 把 `qwen-mt-flash` 做成面板显式选项（现在需手填模型名）
- [ ] 百炼 ASR 在 `fun-asr-realtime` 与 `paraformer-realtime-v2`（每月重置 10 h）之间可选
- [ ] 单行 Ticker 滚动模式
- [ ] 原始协议帧环形缓冲查看器
- [ ] `subtitle.html` 跟进 0.5.11 广播风视觉（用户拍板暂不动）
- [ ] 端到端语音直译协议接入评估
