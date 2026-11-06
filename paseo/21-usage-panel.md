# 21 · 用量面板（本地累计 + 账号额度）

## 1. 要解决什么

翻译花钱，但面板只有一个「本次 N 次请求」：`runtimeState.translation.usage` 在 `stop-capture` 收尾时被清空，关掉面板就看不见了。用户想知道的是「今天花了多少 / 这个月还剩多少额度」。

## 2. 各家能查到什么（核实于 2026-11-05）

| Provider | 远端接口 | 返回 | 结论 |
|---|---|---|---|
| DeepL | `GET {base}/usage` | `character_count`、`character_limit`（本计费周期） | 能查到精确的已用/上限 |
| DeepSeek | `GET /user/balance`（在 `/v1` 前缀之外） | `is_available`、`balance_infos[]{currency,total_balance,granted_balance,topped_up_balance}` | 能查到余额 |
| 阿里云百炼 | **无** | 只能看控制台「模型用量 / 免费额度」页，或用阿里云 CLI `bl usage free` / `bl usage stats`（要 AccessKey 登录态，不是百炼 API Key） | 查不到，只能本地统计 |
| OpenAI | `/v1/usage` 已废弃 | 现在需要 organization admin key 调 costs | 普通 Key 查不到 |
| Chrome 内置 / 本地 9B | — | 不计费 | 显示为本地统计 |

来源：[DeepL usage and limits](https://developers.deepl.com/docs/resources/usage-limits)、[DeepSeek Get User Balance](https://api-docs.deepseek.com/api/get-user-balance/)、[百炼用量与配额](https://www.alibabacloud.com/help/zh/model-studio/cli/usage-quota)、[百炼模型用量](https://docs.bailian.console.aliyun.com/zh/model-studio/model-usage-statistics)。

所以面板是**两层**：本地账本负责「我用了多少」，远端接口负责「账号还剩多少」，两者分开显示，查不到的那个说明原因（`console_only` / `admin_key_required` / `free` / `local_or_unknown`）。

## 3. 本地账本

`chrome.storage.local.usageLedger`：

- 按**本地日历日**分桶，桶内再按 `provider:model` 分（`qwen-mt-flash` 与 `qwen3.7-flash` 单价不同，不能合并）。
- 每天每桶记 `requests` / `promptTokens` / `completionTokens` / `billedCharacters`（DeepL 按字符计费，没有 token）。
- 保留 90 天，写入时顺手清理更早的日；`normalizeLedger` 对坏数据降级为空账本，不让存储里的脏值影响启动。
- 记账来源是浏览器侧的 `recordUsage(delta, config)` 回调（调度器每次请求成功后调用），**不是**会话内的 `usage`：后者会被停采清空，前者跨会话累积。

## 4. 刷新策略

- 本地写入节流 `USAGE_FLUSH_DELAY_MS = 2000 ms`：一次 ASR 会话里请求可能每几百毫秒一次，逐次写盘没有意义；节流窗口内合并成一个桶再写。
- 远端查询缓存 5 分钟，且**缓存要按 provider 区分**。第一版只按时间缓存，切到 DeepSeek 时把 DeepL 的「551,077 字符」原样显示了——这是实测时发现的真 bug，现在缓存的命中条件带 `remoteCache.value.provider === config.provider`，并有单测（去掉判据会红）。
- 面板每次 `render()` 调用 `refreshUsageLedger()`，10 秒内且 provider/model 未变则复用上次结果；换 provider 或换模型时立即强制刷新，否则用户切完语言看到的还是上一家的额度。

## 5. 实测（2026-11-05）

| 场景 | 结果 |
|---|---|
| DeepL（Free Key，`:fx`） | `GET api-free.deepl.com/v2/usage` → 551,077 / 1,000,000 字符（55%） |
| DeepSeek | `GET api.deepseek.com/user/balance` → `CNY 99.95`（granted 0、topped-up 99.95） |
| 百炼 | `console_only`，面板显示「百炼额度请到控制台查看」 |
| 本地累计 | 用 DeepSeek 跑 30 s：`today.requests = 2`、`promptTokens 1041`、`completionTokens 109`、桶名 `deepseek:deepseek-flash` |
| 面板文案 | 「今日 2 次 · 1,150 tokens · 本月 2 次 · 1,150 tokens · DeepSeek 余额 CNY 99.95（赠送 0.00）」，切换 provider 即时更新 |

## 6. 已知限制

1. 百炼没有用量 API，面板对百炼只能给本地统计——这是平台限制，不是没做。
2. OpenAI 需要管理员 Key，普通 Key 查不到额度；若将来要做，要单独在设置里填 admin key。
3. 远端数字是「缓存 5 分钟内」的值，正在大量翻译时可能略滞后于控制台。
4. 本地账本只记**本扩展发出的**请求；控制台里别的客户端用量看不到。
5. DeepL 的 `character_count` 是账号级、计费周期级，与本地账本的「今日/本月」口径不同（例如账本 1 号重置、DeepL 按订阅周期重置），两者并排显示，不做加减。
