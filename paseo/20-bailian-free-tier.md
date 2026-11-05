# 20 · 阿里云百炼免费额度选型（2026-11-05）

本文解决一件事：**在百炼免费计划里，哪些模型 ID 能直接填进声幕、哪些填了会报 400 或白烧钱**。原文是仓库外 `research.md` 的 §7（ReaLingo 调研的一部分），只把结论搬进仓库，不复述竞品分析。

计时前提：百炼价格与免费额度按官方文档（[模型调用价格](https://help.aliyun.com/zh/model-studio/model-pricing)、[新人免费额度规则](https://help.aliyun.com/zh/model-studio/new-free-quota)）核对于 2026-11-05。百炼改过一轮免费额度归属（见下），此表会过期，改动前请复核控制台。

## 1. 免费额度的三条规则

- 额度只在**中国内地（华北 2 · 北京）**地域发放，其它地域不参与。
- **按模型 ID 独立计算**：同代际的 plus / flash 各算一份，换个 ID 就重新有额度。
- 新用户 100 万 Token / 模型 / 90 天；`paraformer-realtime-v2` 是例外，按**每月重置**（见 §4）。
- 建议在控制台开「免费额度用完即停」，否则超额后静默按量扣费，声幕侧只能看到请求成功。

## 2. 必须先改的一处：默认模型 `qwen-plus` 已经没有免费额度

`TRANSLATION_PROVIDERS.bailian.model` 现在写的是 `qwen-plus`，而不带代际号的老别名 `qwen-plus` / `qwen-flash` / `qwen3.5-plus` / `qwen3.5-flash` / `qwen3.6-plus` / `qwen3.6-flash` 免费额度均为「无」。100 万 Token 已被挪到 `qwen3.7-*`、`qwen3.8-*` 与百炼托管的 `deepseek-v4.1-flash` 上。

后果分两种：开了「用完即停」→ 新用户第一次翻译直接报错；没开 → 按 0.8 元 / 2 元每百万 Token 扣费，用户不知道。

**待办（一行改动，未做）**：默认值改 `qwen3.7-flash`。

## 3. 翻译侧可填的 6 个免费模型

声幕的 API 翻译链路要求：`system` 指令 + 多句 `segments[]` JSON 输出 + 能关思考（`enable_thinking: false`）+ 上下文缓存。免费池里同时满足的只有下面这些，按推荐度排：

| 梯度 | 模型 ID | 免费额度 | 超额单价（输入 / 输出，每百万 Token） | 适用 |
|---|---|---|---|---|
| T0 首选 | `qwen3.7-flash` | 100 万 | 0.2 / 0.8 元 | 默认首选：首字延迟 ~300 ms，超额后比 `qwen-plus` 便宜 60~75% |
| T0 并列 | `qwen3.8-flash` | 100 万 | 0.8 / 2.7 元 | 最新代际，JSON 遵循与口语顺滑度好，延迟与上者同档 |
| T1 同源平替 | `deepseek-v4.1-flash`、`deepseek-v4.1-flash-1017`、`deepseek-v4-flash-0731` | 各 100 万（合计 300 万） | 忙时 2 / 8 元，闲时（22:00-08:00）1 / 4 元 | 声幕 prompt 本就按 DeepSeek 调优，三个 ID 共用同一个百炼 Key |
| T1 质量优先 | `qwen3.7-plus` | 100 万 | 1.6 / 6.4 元 | 长难句、剧情台词要求高时用 |
| T2 备选 | `qwen3.8-27b` | 100 万 | 3 / 12 元 | 额度耗尽后的替补 |

**零成本轮换**：这 6 个 ID 不需要改代码，在 popup「翻译服务商 → 阿里云百炼」的模型框里直接改即可，单账号合计约 600 万 Token。

## 4. 避坑清单

- **`qwen-mt-flash` / `qwen-mt-plus` / `qwen-mt-lite`（各 100 万）不能直接填。** 这系列**禁止 `system` 消息**，不支持 JSON 结构化输出，必须走专有字段 `translation_options: { source_lang, target_lang, terms, domains }`。市场上「免费 300 万」的说法对声幕不成立，除非像 0.5.7 接 DeepL 那样新增一条 `qwen-mt` 协议分支。收益评估：翻译单价本来就低，为省这笔额度写一条协议分支不划算。
- **`kimi-k3` / `MiniMax-M2.5` 虽然各 100 万，但「仅思考模式」**，关不掉思维链，单请求数秒，实时字幕用不了。
- `glm-5.3` 同类问题：延迟高，不适合逐行送翻。

## 5. ASR 侧：现有默认 vs 每月重置的那个

| 模型 | 声幕状态 | 免费额度 | 超额单价 | 说明 |
|---|---|---|---|---|
| `fun-asr-realtime` | 已内置（`BAILIAN_ASR_MODEL`） | 36,000 秒（10 h），90 天 | 0.00033 元/秒（≈¥1.19/h） | 400 字符 `context` 热词、语气词过滤、ITN、标点 |
| `paraformer-realtime-v2` | 未暴露切换项 | **每月 36,000 秒，自动重置** | 0.00024 元/秒（≈¥0.86/h） | 同一套 DashScope WS 协议；支持 `language_hints: ["en"]` 与词表 |
| `qwen3-asr-flash-realtime` | 未接入 | 36,000 秒，90 天 | 0.00033 元/秒 | 与默认同价同量 |
| `qwen3.8-livetranslate-flash-realtime` | 未接入（ReaLingo 用它） | 100 万 Token，90 天 | 音频输入 40 元/M、文本输出 100 元/M（≈¥0.02/分钟） | 端到端语音直译，一条 WS 同时出英文与中文，支持 1000 条热词 |

轻中度用户想长期零成本，`paraformer-realtime-v2` 的**每月重置**比默认那 10 小时一次性额度更实用；接入成本只是把 `BAILIAN_ASR_MODEL` 变成可选项，协议无需重写。

## 6. 待办（按性价比排）

1. 百炼翻译默认模型 `qwen-plus` → `qwen3.7-flash`（一行，零风险，未做）。
2. 百炼 ASR 模型在 `fun-asr-realtime` 与 `paraformer-realtime-v2` 之间可选（设置项 + popup 下拉，未做）。
3. `qwen-mt-*` 协议分支：不推荐，除非将来翻译量级大到额度成为瓶颈。
4. 端到端语音直译（`qwen3.8-livetranslate`）：只在决定砍掉「ASR + 翻译两段式」时才启动，见 `research.md` §5.5。
