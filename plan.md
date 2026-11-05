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
4. **真机采一轮**（付费 API + 新 24/1200 档）：捐 `test-assets/quality-samples/*poe*.wav`，须满足缺译 0、`deliveredRatio ≥ 0.999`、本地延迟 1~3 s；同时把 `runtimeState.usage.billedCharacters` 写进采样 JSON，用实测替代估算。

## 3. 未阻塞的验证缺项

| # | 缺项 | 优先级 |
|---|---|---|
| 1 | Chrome 本机识别路径复测（非 WLK） | 中 |
| 2 | server 模式（WLK 自带译文）浮层复测 | 中 |
| 3 | 24/1200 下阶段译文跟手度体感确认（最坏等 1.2 s） | 中，跟第 4 步同一轮做 |

## 4. Backlog（不阻塞本次发布）

- [ ] 百炼翻译默认模型 `qwen-plus` → `qwen3.7-flash`（`paseo/20` §2，一行改动，新用户命中免费额度）
- [ ] 百炼 ASR 在 `fun-asr-realtime` 与 `paraformer-realtime-v2`（每月重置 10 h）之间可选
- [ ] 单行 Ticker 滚动模式
- [ ] 原始协议帧环形缓冲查看器
- [ ] `subtitle.html` 跟进 0.5.11 广播风视觉（用户拍板暂不动）
- [ ] 端到端语音直译协议接入评估
