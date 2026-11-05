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

**已完成（0.5.11 后续提交）**：默认值已改为 `qwen3.7-flash`。

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

## 6. 实测：专用翻译模型 `qwen-mt-*`

上一节把 `qwen-mt` 归为「不推荐」，是因为当时只看额度。实测后结论反转：**它是同一份免费额度里最快的路径**。

| 请求 | 耗时 | token | 备注 |
|---|---|---|---|
| `qwen3.7-flash` + 9 条规则 prompt（2 行、1024 字符） | 1207 ms（5 次中位） | 550 | 当前 chat 链路 |
| `qwen3.7-flash` 压缩到 6 条规则（766 字符） | 1323 ms | 406 | **没变快**，省下的只是输入 token，已回滚 |
| `qwen-mt-flash`（`translation_options`，无 system） | **246~362 ms** | ~100 | 快 3~4 倍 |
| `qwen-mt-plus` | 519~559 ms | 108 | 质量档 |

关键对照：`qwen3.7-flash` 不传 `enable_thinking: false` 时单次要 **30~37 秒**（reasoning 近 1 万字符、输出 3000+ token），默认是开思考的；`qwen-mt-*` 没有思考开关，也就不存在踩这个坑的机会。

能承载的能力（实测）：

- **多段批处理**：段落按 `\n` 拼接，返回也是一行一段，行数与输入一致（不一致就走 `count_mismatch` 拆半重试）。
- **术语**：`translation_options.terms` 直接吃 `{source, target}`，实测 `Spirit → 精魂`、`Orb of Augmentation → 增幅石`、`Divination card → 命运卡` 全部命中；不需要把词表塞进 prompt。
- **领域**：`translation_options.domains` 接受自由文本（如 `Path of Exile game streaming`）。
- **代价**：禁止 `system` 消息，所以「删语气词、相邻片段衔接、半句不续写」这些靠 prompt 撑的规则都没有；也没有 `context`，跨行术语可能漂移（实测同一段里 `tome` 一会儿「典籍」一会儿「大部头书」，`Alder League` / `Alder Lake` 按 ASR 原样翻）。

落地：`lib/translation-api.js` 的 `resolveTranslationProtocol` 按模型名前缀切协议，用户在百炼的模型框里填 `qwen-mt-flash` 即可，Key 与地址不变。真机 120 s 首中文 p50 <1 s、`overlayStale` 7/120（DeepL 同口径 58/120）、缺译 0。

## 7. 待办（按性价比排）

1. 百炼 ASR 模型在 `fun-asr-realtime` 与 `paraformer-realtime-v2` 之间可选（设置项 + popup 下拉，未做）。
2. 把 `qwen-mt-flash` 做成面板里的显式选项（现在要手填模型名，新人不知道）；若同时保留 `qwen3.7-flash`，需要在 UI 上说明两者差别。
3. `qwen-mt-*` 补上下文：可试 `translation_options.tm_list` 或把前文当作不可译行，需先验证行对齐会不会被打乱。
4. 端到端语音直译（`qwen3.8-livetranslate`）：只在决定砍掉「ASR + 翻译两段式」时才启动，见 `research.md` §5.5。
