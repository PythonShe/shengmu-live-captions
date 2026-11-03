# 02-review-fixes · 评审问题修复记录

对应评审：`paseo/02-review.md`（Haiku，快照 35/35）
修复后测试：**40/40 通过**，`node --check` 全部通过，`Start-Services.ps1` 语法通过。

> 结论：代码层必须项 M2/M3 已修，M4 已补主要回归；M1 的密钥吊销属于用户操作，未由代理执行。真实 DeepSeek + Chrome 端到端仍待验收。

## 必须修

| 项 | 状态 | 处理 |
| --- | --- | --- |
| M1 `feiyu.test` 疑似真实 Key | **部分完成，需用户操作** | 已把 `/feiyu.test`、`/.serena/` 加入 `.gitignore`，防止误提交；已更正 `00-environment.md` R3 的“占位符”错误描述。**未删除/移动文件，也未输出 Key**。请到服务商后台吊销/轮换该 Key，并把文件移出仓库或删除。 |
| M2 停止时在途译文丢失 | **已修** | 停止等待从 6s 提到 15s（大于默认 API 12s 超时）；请求体读取也纳入超时；`settleTranslations` 在截止后对在途行请求 `abort()` 并等待其结束，再汇总；`finalizeSession` 在汇总前递增 generation，禁止迟到写入。新增 abort 回归用例。 |
| M3 Key 可能发往意外端点/明文 HTTP | **已修** | 切换 provider 时重置为预设端点；手改端点会清空该 provider 的 Key，强制重新输入；配置了 Key 时拒绝非回环 `http://`（localhost/127.0.0.1/::1 除外）。新增对应单测与后台集成测试。 |
| M4 队列/停止路径缺测试 | **部分完成** | 新增：条数不足、截断 JSON、`finish_reason=length`、空槽位保序、body 读取超时、abort、max_tokens/temperature 降级、DeepSeek host、迁移、端点切换清 Key、content script 权限。队列重试/停止收尾仍主要靠代码评审与真实端到端，未做完整 IndexedDB 会话桩。 |

## 建议修

| 项 | 状态 | 处理 |
| --- | --- | --- |
| S1 SW 回收后不恢复队列 | 已修 | `initialize()` 在恢复 active 会话且 API 生效时调用 `scheduleLineTranslations(0)` + `scheduleBufferTranslation()`，从 `runtimeState.current.lines` 重建。 |
| S2 `-AsrOnly` 遇已运行 WLK 时状态不准 | 已修 | 已运行时直接抛错并提示 `-Restart`，不再输出假的 ASR-only 状态。 |
| S3 服务端模式配 `-AsrOnly` 整批缺译 | 已修 | `startSession` 在 server 模式下先探测 `127.0.0.1:8013/health`，失败则明确提示“只想跑 ASR 请切换为 API 模式”。 |
| S4 数字行回退错位 | 已修 | 数字行回退要求条数与期望完全一致；补充 `[1]` 编号格式；JSON 形态但解析失败不再回退为行解析。 |
| S5 自定义 provider 指向 DeepSeek 无法关思考 | 已修 | 按 baseUrl host 识别 `*.deepseek.com`，自动带 `thinking:{type:"disabled"}`；新增测试。 |
| S6 缺隐私告知 | 已修 | popup 增加“字幕和最近两条上下文会发送给所选服务商”；README 说明 Key 为明文本地存储。 |
| S7 工作区改动混杂 | 部分完成 | `.serena/`、`feiyu.test` 已忽略；未做 git 拆分（用户要求暂不提交/推送）。翻译 API 之外的改动是迁移前已存在的未提交工作，保持原样。 |
| S8 文档数字/事实过时 | 已修 | 00/01/03 更新为当前测试数；R3 更正；02 评审保留为历史快照并加修复状态横幅。 |

## 可选

| 项 | 状态 | 说明 |
| --- | --- | --- |
| O1 settle 绕过重试退避 | 保留 | 停止阶段优先尽快收尾，属有意行为；15s 上限已限制等待。 |
| O2 buffer 为任意待译行让路 | 保留 | 行译文优先，避免半句请求抢占 429/延迟；可在真实链路观察后再调。 |
| O3 `knownLineSignatures` 只增不减 | 保留 | 既有设计；2 小时场次约数千条，暂不构成问题。 |
| O4 PCM 尾部不足 100ms 不发送 | 不属本需求 | 原有行为，未动。 |
| O5 SRT 缺译回退英文 | 不属本需求 | 原有行为，未动。 |
| O6 部分只读消息未校验 sender | 保留 | `open-monitor`/`hide-overlay` 需要 content overlay 调用；其余风险低。 |
| O7 Key 明文存储 | 文档已补 | 已说明依赖本机账户/配置目录访问控制；未做加密（无有意义的本地密钥保护）。 |
| O8 Key 未失焦即关 popup | 部分缓解 | 开始采集/测试连接前会强制保存输入框中的 Key；单纯关闭 popup 仍可能丢输入。 |
| O9 中途切回 server 留下待译行 | 保留 | 停止时 `applyPendingFallbacks` 会处理有 fallback 的行；无 fallback 计入缺译。 |
| O10 max_tokens 兼容 | 已修并测试 | 见 M4。 |

## 最终判定

- 代码层 + 真实 DeepSeek + Chrome 2 分钟端到端已通过（31 条、缺译 0、无 fallback）。全量视频按用户要求不跑。
- 阻塞合入的唯一用户动作：**M1 的 Key 吊销/移出仓库**。
- 已覆盖：真实 DeepSeek 请求、tabCapture→WLK→API→浮层/历史的 2 分钟完整链路。未覆盖：长时稳定性、本地服务端回归、全量视频。
- 未执行：`git add` / `commit` / `push`。
