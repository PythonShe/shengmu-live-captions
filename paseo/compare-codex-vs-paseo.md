# Codex vs Paseo：这个项目继续用哪个

评估基于本次真实迁移：同一台 Windows 机器、同一个工作区、同一天完成「paseo 环境安装 + 翻译 API 需求 + 独立评审」。不是抽象对比。

## 一句话结论

**建议以 Paseo 为主开发环境，Codex 保留为第二意见/重型单线程实现的备用引擎。**
迁移成本已经付过了（全局 skill + `paseo/` 文档），现在切回 Codex 反而浪费这次准备。但 Codex 的 runbook 仍是这个项目的权威事实源，不要丢掉。

## Paseo 的优势（本次实际体验）

1. **多代理编排真的省时间。**
   - 一个子代理安装 skill、盘点环境、检查 MCP，产出 `00-environment.md`。
   - 另一个 Haiku 子代理独立评审，找出 4 个必须修问题（停止在途译文、Key 端点、明文 HTTP、测试缺口），其中 2 个是自审容易漏的异步/收尾问题。
   - Codex 里做同样的事需要手工开多个会话，且不容易并排比较。

2. **模型可换，按任务选。**
   - 实现用 DeepSeek V4.1 Flash；评审换 Haiku 5.5；需要时还能挂 Codex/GPT 作为 provider。
   - 这次 GPT/Codex 评审代理“爆了”，换成 Haiku 后立刻正常出报告——模型/代理隔离是实际可用的逃生通道。

3. **工作区、终端、MCP、skill 都在一个界面里。**
   - `~/.agents/skills/` 的 skill 对新 paseo 会话可见；`paseo/` 文档与代码同目录。
   - MCP 注入让子代理可以自己创建/查询/停止代理；不需要手写编排脚本。

4. **成本/用量可见。**
   - 代理状态里有 token/cost；这次 Haiku 评审约 $0.05，适合高频自审。

## Paseo 的摩擦（本次踩到的）

1. **Codex 的项目记忆不会自动搬过来。**
   - runbook 在 `.codex/memories/skills/...`，paseo 默认看不到。必须靠新装的全局 skill 路由过去。
   - 新会话若没加载 skill，会重新摸索。**以后开 paseo 会话先确认 `realtime-livestream-subtitles` 在 skill 列表里。**

2. **交互式提问在 paseo 代理终端里不可用。**
   - 这次 `AskUserQuestion` 直接报“requires an interactive terminal”，导致“插件内直连还是服务端切 DeepSeek”“/paseo 是副本还是文档区”只能按推荐默认值自行决定。
   - 需要用户拍板时，要在 Paseo 桌面端提问，或把问题留在最终汇报里；不要让代理在无交互环境里空转。

3. **MCP 不是全量在线。**
   - `mcp({})` 只看到 `paseo`；`mcp-adapter.json` 里的 chrome-devtools/exa/brave 等是懒连接。
   - 对本项目不是问题：CDP 9223 + `.research` 脚本比通用 chrome-devtools MCP 更贴合 tabCapture/扩展语义。**不要为了“装 MCP”而替换现有验证链路。**

4. **子代理质量/行为差异大。**
   - GPT/Codex 评审代理一开始做规划就卡住/爆掉；Haiku 能跑但会自己造临时 harness，花了约 10 分钟、116k context。
   - 经验：给子代理**明确的范围、只读边界、输出文件、时间盒**；需要深挖时再放权。

5. **行号/快照漂移。**
   - 评审时代码还在改，报告行号对应 22:58 快照。Paseo 多代理并发时，**评审前先冻结快照**（或让评审只读一次 commit/工作区快照）。

## Codex 的优势

1. **项目 runbook 和记忆是原生的。**
   - 这个项目的验收标准、已验证数字、坑、命令都在 Codex memory 里；不需要额外路由。
   - 对“继续做已有的实时字幕优化”这种强上下文任务，Codex 的启动成本更低。

2. **单代理、少变量。**
   - 不需要考虑 provider 注入、MCP 懒连接、子代理编排；一个人从头做到尾，状态更可控。
   - 对 Windows/PowerShell 的既有脚本和权限流程更熟。

3. **适合重型单线程实现。**
   - 大重构、长时间调试、需要连续几十步工具调用的任务，Codex 的单一上下文更稳。

## Codex 的劣势（本次实际体验）

1. **模型锁定、可用性波动。**
   - 这次 Codex/GPT 评审代理直接失败；没有 Haiku 这种低成本备选。

2. **并行评审/多视角不方便。**
   - 想让一个代理实现、另一个代理独立评审，需要手工开窗、复制上下文；Paseo 一条 `create_agent` 就完成。

3. **工作区/代理生命周期管理弱。**
   - Paseo 的 workspace、agent 状态、取消/归档、用量统计是产品化的；Codex 更偏单会话。

## 推荐分工

| 场景 | 推荐 |
| --- | --- |
| 日常需求、翻译 API/扩展功能、需要并行评审 | **Paseo + pi（DeepSeek/Haiku）** |
| 需要复用 Codex runbook 的深度优化（延迟、ASR、模型参数） | Paseo 里先读 runbook skill；如果任务很重，可让 Paseo 的 **codex provider** 跑单线程实现 |
| 高风险改动的第二意见 | Paseo 子代理（Haiku/DeepSeek），而不是同一个模型自审 |
| 需要用户中途拍板 | Paseo 桌面端提问；不要在 agent 终端里依赖 `AskUserQuestion` |
| 长时稳定性/真实直播验收 | 两者都行，优先用项目现有 CDP + 240s harness，不要新造轮子 |

## 具体下一步

1. **处理 `feiyu.test`**：到服务商后台吊销/轮换，移出仓库或删除；`.gitignore` 已挡住误提交。
2. ~~给 DeepSeek Key 做一次真实端到端~~：已完成 2 分钟 0.5 发布会切片验证（31 条、缺译 0、无 fallback）。全量视频按 token 成本不跑；长时稳定性按需再验。
3. **新 Paseo 会话**：确认全局 skill `realtime-livestream-subtitles` 已加载；先读 `paseo/01`/`02-review-fixes`/`03`。
4. **评审流程**：让评审代理只读、限定输出文件、限定时间；需要复现时给临时目录，不要让它改项目。
5. **不要**在迁移期清理 `.research`、改 Chrome profile、或把 Key 写进仓库。

## 最终判断

- **Paseo 更好**：如果目标是“继续开发 + 多代理评审 + 模型灵活”，它这次证明了自己，且迁移准备已经完成。
- **Codex 仍值得保留**：作为 runbook 权威源和重型单线程实现/第二意见；不必二选一。
- 最差的选择是“两边各维护一份上下文”。现在的事实源应统一为：**Codex runbook + 全局 paseo skill + `paseo/` 文档**；新会话从 skill 进，评审结果回写 `paseo/`。
