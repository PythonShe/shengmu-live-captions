# 03 · 验证记录

验证时间：2026-10-27（paseo · pi / DeepSeek V4.1 Flash + Haiku 评审）
环境：Windows 11、Node 24.11.1、npm 11.21.0、Python 3.11.0、Chrome 156.0.8078.48
版本：0.4.0（未提交、未推送）

## 已执行

### 1. 单元 / 集成测试

```powershell
npm test
```

结果：**40/40 通过，0 失败**（约 0.7 秒），覆盖：

- 原有字幕时间码、epoch 合并、SRT、历史写入队列、PCM worklet、设置迁移/默认值/脱敏（16，含 0.3.x → server）
- 翻译客户端（`tests/translation-api.test.js`）：
  - DeepSeek 默认值、provider/key 隔离、缺 Key 校验
  - 请求 URL/请求体、`thinking:{type:"disabled"}`、Authorization
  - 400 thinking 拒绝后自动重试
  - JSON / 代码围栏 / 对象数组 / 编号行解析
  - 条数不足、截断 JSON、finish_reason=length 拒绝，避免错位
  - 401/402/429/400/5xx 错误映射
  - 超时（含 body 读取阶段）、空响应、自定义无 Key 端点
  - max_tokens 被拒后退回 max_completion_tokens；temperature 被拒后省略
  - 调用方 abort（停止收尾的中止路径）
  - 非回环 http:// 带 Key 被拒绝；DeepSeek 地址即使选自定义也关闭 thinking
- 后台消息与安全（`tests/service-worker.integration.test.js`）：
  - 默认 `api + deepseek + deepseek-chat`
  - `get-state` / `save-settings` 返回值不包含 `translationApiKeys`
  - content script 伪造 `translationMode/baseUrl/keys` 被丢弃
  - content script 调用 `test-translation-api` 被拒绝
  - 切换 provider 时不会沿用旧端点；手改端点会清空该服务商 Key
  - 扩展界面配置自定义端点后可真实调用本地 mock API，并带上已保存的 Key
- 显示层：永久失败的行标记 `translationFailed`，不再一直显示为“待译”

### 2. 语法检查

```powershell
Get-ChildItem -LiteralPath .\extension -Filter *.js |
    ForEach-Object { node --check $_.FullName }
```

等价 bash 循环覆盖 `extension/*.js`、`tests/*.js`、`paseo/*.mjs`：**全部通过**。

PowerShell：

```powershell
[System.Management.Automation.Language.Parser]::ParseFile(
  (Resolve-Path .\scripts\Start-Services.ps1), [ref]$null, [ref]$e)
```

结果：**Start-Services.ps1 语法 OK**。

### 3. Mock OpenAI 服务

```powershell
$env:PORT=8799
node paseo/mock-openai-server.mjs
curl http://127.0.0.1:8799/health
curl -X POST http://127.0.0.1:8799/v1/chat/completions ...
```

结果：

- `/health` → `{"status":"ok","mode":"mock-openai"}`
- `/v1/chat/completions` 返回 `["【模拟译文】Hello","【模拟译文】World"]` 和 usage
- 日志显示 `key=none thinking=false`（无 Key 的 custom 配置）

### 4. Service Worker 顶层加载 / 默认配置

用一个临时 Node 脚本模拟 Chrome API 后 `import extension/service-worker.js`：

- 模块成功加载，注册 `installed/startup/message/command/tabRemoved/tabUpdated`
- 首次 `initialize()` 写入默认值：`translationMode=api`、`provider=deepseek`、`model=deepseek-chat`

说明：该脚本只用于启动烟测，未写入仓库；仓库内的 `tests/service-worker.integration.test.js` 固化了消息层验证。

### 5. 真实端到端（0.5 发布会 2 分钟切片）

**音频**：`.research/quality-samples/vkCu3V81N74-15m00-17m00.wav`（120 秒）。`vkCu3V81N74` 的字幕中明确出现 `0.5.0`，是 0.5 发布会素材；切片从 15:00 到 17:00。

**链路**：

```powershell
.\scripts\Start-Services.ps1 -AsrOnly -Restart
.\scripts\Start-DevBrowser.ps1 -Url 'http://127.0.0.1:8899/target.html'
# 本地临时页循环播放 0.5 音频；扩展重载后设置 API/DeepSeek/Key
```

**API 连通性**：

- 真实 DeepSeek 请求成功，返回 `deepseek-flash`（请求模型为 `deepseek-chat`）
- 首包延迟 858 ms
- 测试译文：“大家好，欢迎来到今天的直播。”
- Key 只写入扩展存储，未打印、未写入证据文件

**120 秒采集结果**：

| 指标 | 结果 |
| --- | --- |
| 采样 | 13 次 / 120 秒 |
| inactive / disconnected | 0 / 0 |
| deliveredRatio 最小 / 中位 | 0.9970 / 0.999976 |
| 最终字幕条数 | 31 |
| 最终缺译 | **0** |
| 运行中最大瞬时缺译 | 1 |
| translationFailed | 0 |
| 服务端 fallback 行数 | 0（全部由 DeepSeek 翻译） |
| DeepSeek 请求数 | 99 |
| prompt / completion tokens | 23,700 / 929 |
| GPU 峰值 | 6,479 MiB（ASR-only，未加载 9B） |
| 行时长中位 / P95 / 最大 | 3.58 s / 7.42 s / 7.48 s |
| 8013 | 未监听（ASR-only 生效） |
| 8010 health | `{"status":"ok","backend":"faster-whisper","ready":true}` |

**截图与证据**：

- `paseo/evidence/v040-zero5-overlay.png`：页面浮层显示 `new mods` / `新词缀`
- `paseo/evidence/v040-zero5-history.png`：字幕窗口 31 条，音频采集完整度 100%
- `paseo/evidence/v040-zero5-summary.json`、`v040-zero5-lines.json`
- `paseo/evidence/v040-zero5-api-test.json`

**质量抽检**：

- `And there are even crafting meta runes.` → `甚至还有制作类的元符文。`
- `will unlock a set of time related mods to be crafted on your boots.` → `将解锁一组与时间相关的模组，可以在你的靴子上制作。`
- `Using regular metals alloyed with verisium.` → `使用常规金属与 verisium 熔合为合金。`（专有名词保留）

### 6. 独立评审

- Haiku 评审（`paseo/02-review.md`）发现 4 个必须修：M1 密钥文件、M2 停止在途译文、M3 Key/端点与明文 HTTP、M4 回归测试。
- 修复记录见 `paseo/02-review-fixes.md`：M2/M3 已修并加测试，M4 补了主要用例，M1 已加 `.gitignore` 但**吊销/移出 Key 需要用户操作**。
- 最终测试从评审时的 35 个增加到 40 个。

### 7. Git

```powershell
git status --porcelain=v1
```

- 未执行 `git add` / `commit` / `push`
- 保留了迁移前已有的 8 个修改和 3 个未跟踪文件
- 新增未跟踪：`extension/translation-api.js`、`tests/translation-api.test.js`、`tests/service-worker.integration.test.js`、`paseo/`

## 未执行 / 待验收

| 项 | 原因 | 建议步骤 |
| --- | --- | --- |
| 全量 0.5 发布会（约 80 分钟） | **不执行**：用户确认 token 成本偏高，2 分钟切片已够验证链路与质量 | 如以后要测长时稳定性，再单独安排 |
| 本地服务端模式回归 | 本次为了验证 API 使用 `-AsrOnly`，未加载 8013 9B | 不带 `-AsrOnly` 复跑原有 240 秒链路 |
| 长时稳定性 / 成本 | 2 分钟只能验证链路和基本质量 | 先 10 分钟，统计请求数/token/429/缺译 |
| M1 Key 轮换 | 代理不能代替用户在服务商后台操作 | 吊销/轮换 `feiyu.test` 中的 Key，并移出仓库 |

## 验收要点（端到端时）

1. 浮层中文正常，字幕窗口历史与浮层一致。
2. 停止后 `translationMissing = 0`；若 API 失败，状态应为 `incomplete` 而不是静默成功。
3. popup 显示本次请求次数/tokens；不应出现 Key。
4. `-AsrOnly` 时 8013 无监听；GPU 占用明显低于加载 9B。
5. Chrome 扩展的 content script 无法修改翻译端点/Key（集成测试已覆盖消息层，浏览器内建议再抽检一次）。
6. 缓冲半句翻译开启时，中文出现更早但请求数增加；关闭后只在整句定稿后翻译。

## 结论

- 代码层 + 真实 DeepSeek + Chrome 2 分钟端到端均已通过：31 条、缺译 0、无 fallback、捕获比中位 0.999976。
- 0.5 发布会链路验收通过；全量视频按用户要求不跑，长时稳定性和本地服务端回归留待需要时再做。
- M1 的 Key 轮换仍需用户完成；在此之前不要 `git add -A`。
