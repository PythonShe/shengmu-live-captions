# 声幕 · 下一步计划（2026-11-05 第二轮）

基线：`pnpm run verify` 325 项（324 pass / 1 skip）、`pnpm run smoke` 11 项全过。
版本 0.5.12。

## 0. 仓库状态

`git rev-list --left-right --count origin/master...HEAD` = `0 0`：上一轮的 merge、跨模型审阅与 push 全部完成。本轮 0.5.12 已提交并 push（`3257f54` 功能 + `042c7b3` 审阅 P1 修复 + `3a08bab` pit 记录），工作区除未跟踪的 `research.md` 外干净。

## 1. 本轮已落地（0.5.12）

| 项 | 结论 | 证据 |
|---|---|---|
| 百炼模型面板显式选项 | 封闭下拉 4 项：`qwen3.7-flash` / `qwen-mt-flash` / `qwen-mt-plus` / `qwen-mt-lite`；存储里其它 id 归一回落 | 单测 + 真机 popup 渲染 |
| `qwen-mt-turbo` | **cn 地域 404 `model_not_found`**（5/5），已移出选项；intl 未验证 | `.pr-test/probe-qwen-mt-models.json` |
| 四个 MT 模型实测 | flash 325 ms / plus 442 ms / lite 321 ms（各 5 次中位，2 行批 + terms + domains） | `paseo/20` §6 |
| DeepL 术语库 | 免费 `:fx` Key **实测可用**；面板「同步到 DeepL」手动触发，680 条，翻译请求带 `glossary_id` | `paseo/22`、`.pr-test/probe-deepl-glossary-e2e.mjs` |

## 2. 下一轮待办（按建议顺序）

1. **百炼 ASR 模型可选（`fun-asr-realtime` / `paraformer-realtime-v2`）— 先查再动**。
   已核实：paraformer 的 `run-task` 里 `input` **固定为 `{}`**，拿不到 fun-asr 那种
   `input.context` 文本注入，现有英文术语热词（`buildAsrContextPrompt`）在它上面失效；
   热词只能走 `vocabulary_id`（需先建热词表）。待查：`paraformer-realtime-v2` 在
   阿里云控制台建热词表的成本与接口、`semantic_punctuation_enabled` /
   `max_sentence_silence` 对连续讲话断句的实际效果。决定点：接受丢热词，还是先做
   热词表 ID 输入框。
2. **DeepL 术语库增强（可选）**：词条变更后提示已就绪但需手动点同步；如果想省这一步，
   可在「开始采集」时检查指纹并在后台静默重建（需权衡：Free 只有 1 个坑位，删除窗口期
   会丢库）。
3. **Chrome 本机识别路径复测**（非 WLK）。
4. **server 模式（WLK 自带译文）浮层复测**。
5. **24/1200 付费档阶段译文跟手度体感确认**（最坏等 1.2 s）。

## 3. Backlog（不阻塞）

- [ ] 百炼 ASR 在 `fun-asr-realtime` 与 `paraformer-realtime-v2`（每月重置 10 h）之间可选
      （即上面第 2 节第 1 项，未开工）。
- [ ] `qwen-mt-turbo` 若换 intl 地域需复测（cn 已确认 404）。
- [ ] 单行 Ticker 滚动模式
- [ ] 原始协议帧环形缓冲查看器
- [ ] `subtitle.html` 跟进 0.5.11 广播风视觉（用户拍板暂不动）
- [ ] 端到端语音直译协议接入评估
- [ ] DeepL glossary 在「词条变更」时的自动重建（见第 2 节第 2 项）

## 4. 已完成的旧项（留存）

- [x] 重译限流按后端分档（24 字符 / 1200 ms 付费档）
- [x] 百炼默认模型 `qwen-plus` → `qwen3.7-flash`
- [x] `qwen-mt-*` 专用翻译协议
- [x] 用量面板（本地 90 天账本 + DeepL/DeepSeek 额度）
- [x] DeepL 术语库（0.5.12）
- [x] `qwen-mt-flash` 做成面板显式选项（0.5.12，连同类一起）
- [x] WLK 连续讲话不分段：API 模式客户端切句（`paseo/23`）；server 模式仍是一整行
