# paseo · 设计与验收记录

这里放需求、设计、评审与验收记录，不放可运行代码。可运行的部分在 `extension/`、`scripts/`、`tests/`。

## 约定

- 文件名按 `NN-主题-版本.md` 编号；同一主题有多篇时，**编号靠后的覆盖靠前的**（例如 `09` 覆盖 `07` 的浮层约定）。
- 每篇记录三样东西：当次要解决的问题、做出取舍的理由、以及实测数据。没有数据的结论不算记录。
- `evidence/`（截图、日志、长样本）与仓库根的 `.research/` 不入库，避免仓库膨胀。
- 术语与领域概念以仓库根的 `GLOSSARY-ISSUES.md` 与 `extension/lib/glossary-poe.js` 为准。

## 文档索引

| 文件 | 内容 |
| --- | --- |
| `00-environment.md` | 迁移时的环境盘点、skill 安装、MCP 结论 |
| `01-translation-api-design.md` | 翻译 API 架构、数据流、错误处理、安全边界 |
| `02-review.md` `02-review-fixes.md` | 首轮独立评审结论与逐条修复状态 |
| `03-verification.md` | 测试与端到端验证口径（缺译、延迟、噪声判据） |
| `05-ui-fixes-0.4.1.md` | 浮层位置、拖动、全屏 |
| `06-review-fixes-0.4.2.md` | 第二轮评审修复 |
| `07-ui-fixes-0.4.3.md` | 字幕分页、降噪、历史回看 |
| `08-local-model-0.5.0.md` | 本地 Index-Translate 模型与一键启停 |
| `09-overlay-injection-0.5.1.md` | 浮层注入与判重、旧实例清理 |
| `10-asr-width-opacity-0.5.2.md` | ASR 参数、显示锁、宽度贴合、透明度滑块 |
| `11-glossary-0.5.3.md` | 术语库基建（解析、匹配、序列化） |
| `12-poe-glossary-0.5.4.md` | 《流放之路》313 条词库与数据判据 |
| `13-subtitle-flow-0.5.5.md` | 去灰化、碎片合句、语气词清理、采集埋点 |
| `14-zero-setup-0.5.6.md` | 零配置：Chrome 内置识别与翻译、阿里云百炼、Windows 本机消息助手、多语言界面、后台拆分与门禁 |
| `compare-codex-vs-paseo.md` | Codex 与 paseo 分工的评估（历史记录） |
| `mock-openai-server.mjs` | 无 Key 联调用的 OpenAI 兼容 mock |

## 常用命令

```sh
pnpm run verify                             # 语法 + ESLint + 类型检查 + 单元测试
pnpm run smoke                              # 无头 Chrome 冒烟
pnpm services:start [--asr-only]            # 本地 ASR + 翻译
node paseo/mock-openai-server.mjs           # mock 翻译 API（http://127.0.0.1:8787/v1）
```
