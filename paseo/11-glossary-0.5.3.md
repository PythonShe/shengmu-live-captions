# 0.5.3 · 术语库完整实现（内置 PoE 预设 + 双引擎注入 + ASR 热词 + Popup 面板）

> 0.5.4 把这里的空壳预设填成 313 条国服解包词库，词库口径与清单见 `paseo/12-poe-glossary-0.5.4.md`。

本次完成「术语库」全链路闭环：词条解析、匹配、提示词序列化、设置字段、内置《流放之路 (Path of Exile 1/2)》97 条预设库、API 翻译按批局部注入、本地服务 `-Glossary` 联动重启、Whisper ASR `?context=` 单会话热词注入，以及 Popup 术语库管理面板（含 TXT/CSV 导入导出）。

## 1. 数据模型

一条词条 = 一组同义源词 + 一个目标译名：

- `sources[]`：第一个是「主拼写」，其余是 ASR 同音误听或英美拼写变体（如 `Path of Exile` / `Path of Excel` / `PoE`）。
- `target`：中文译名。`source === target` 表示保留原文不译（如 `SSF`）。
- 词条不带分类、优先级、启用开关字段：同一领域一个预设包，冲突靠「后写覆盖主拼写相同者」解决，避免过早复杂化。

`chrome.storage.local` 顶层键冻结不变，术语设置全部收敛在 `settings` 内（`extension/caption-utils.js`）：

| 字段 | 默认 | 约束 |
| --- | --- | --- |
| `glossaryEnabled` | `true` | 只有显式 `false` 才关闭 |
| `glossaryPresetIds` | `[]` | 仅接受 `GLOSSARY_PRESETS` 里存在的 id，去重后保留 |
| `glossaryDomainHint` | `""` | 压空白后截 120 字符 |
| `customGlossary` | `""` | 截 32768 字符 |

术语字段**不在** `TAB_ALLOWED_SETTING_KEYS` 白名单里，网页侧脚本无法通过 `save-settings` 改词条（拦提示词注入）。

## 2. 解析规则

`parseGlossaryText(text)` 面向弹窗里手写的多行文本框，宽容优先、不抛错：

- 分隔符按「先出现者胜」挑选，顺序为 `->`、`=>`、`=`、`,`/`，`、制表符；左右两侧去空白。
- 源词侧用 `|`（含全角 `｜`）切别名，重复别名去除。
- 整行 `#` 或 `//` 开头视为注释；空行跳过；缺少任一侧的行静默丢弃。
- CSV 粘贴兼容：一行一条 `source,target`；目标侧若被双引号包裹会去引号并还原 `""`；粘贴进来的表头 `source,target` 自动识别并跳过。
- 主拼写相同（大小写不敏感）时后一行覆盖前一行，因此「先内置、后自定义」的合并天然让自定义优先。

`collectGlossaryEntries({ presetIds, customText })` 做预设与自定义的合并，返回扁平词条数组。

## 3. 匹配规则

`matchGlossaryTerms(texts, entries, maxMatches = 24)`：

- 大小写不敏感，`(?<![A-Za-z0-9_])…(?![A-Za-z0-9_])` 词边界，避免 `ES` 命中 `best` / `test`。
- 英文源词自动容忍复数与所有格：`sceptre` 命中 `sceptres`、`minion` 命中 `minion's`；辅音 + `y` 结尾改挂 `ies`（`Ascendancy` → `Ascendancies`）。
- 源词内空白按 `\s+` 匹配。
- **长词优先 + 区间遮挡**：把词条展平成「词条 × 拼写」对，按拼写长度降序匹配，命中的字符区间被占用。这样 `Orb` 与 `Orb of Augmentation` 并存时只注入后者；而且某个长词条的短别名（`PoE`）也不会抢走另一个更长词条（`PoE trading`）需要的区间——只按主拼写排序做不到这一点。
- 每条词条在一批文本里最多出现一次，结果上限 24 条。
- 返回 `{ source, target, matched }`：`source` 是主拼写，`matched` 是句子里真实出现的写法。翻译层要用 `matched` 做 key，模型才能看出自己被要求纠正的正是那个听错的词。
- 正则带缓存（上限 2000 条），逐句重编译不会成为热点。

## 4. 三个序列化器

- `buildAsrContextPrompt(entries, { maxChars = 360 })`：只取 ASCII 英文源词（含 `SSF` 这类缩写），中文目标与领域提示都不进去——faster-whisper 的 `initial_prompt` 只对英文解码有偏置作用。逐条试加，超预算就不加，不切断单个词。
- `serializeWlkGlossary(entries, { maxChars = 4000 })`：产出 `source -> target; …`。WLK 的 `--openai-translation-glossary` 用 `;`/换行切分、只认 `->` / `=>` / `=` / `:` 左侧、且没有 `|` 别名语法和复数折叠，所以这里**把每条别名展开成独立一对**。源词若含 `;`、`:`、`=`、`->` 或换行，WLK 根本无法表达（会被截断或切断条目），因此**直接跳过该别名并在文档里说明**，不静默改写成一个永远匹配不上的词；目标译文里的 `;`/换行则替换为空格。
- `exportGlossaryText(entries, "text" | "csv")`：`text` 保留可编辑的 `A | B -> 译名` 形式，`csv` 每个别名一行。两种格式都会给**会被读成行语法的源词**加引号（含 `|`、`｜`、逗号、`=`、`->`、制表符、引号，或以 `#`/`//` 开头），否则 `A=B` 这类词导出再导入会被拆成别的词条。解析器先遮住引号内区域再找分隔符与别名竖线，所以引号里的逗号和竖线不会被误切，两种格式都能原样往返。

## 5. 内置《流放之路 (Path of Exile 1/2)》预设词库与双层防错

`GLOSSARY_PRESETS.poe` 0.5.3 内置 97 条核心词条（0.5.4 起为 313 条，见 `paseo/12-poe-glossary-0.5.4.md`），`domainHint` 为 `Path of Exile (流放之路) 游戏直播`：

- **顶部优先排序**：前 30 条放置 `faster-whisper` 最易误听的核心专名（`Path of Exile`、`Wraeclast`、`Oriath`、`Ezomyte`、`Kalguuran`、`Faustus`、`runesmithing`、`sceptre`、`Spirit`、`Dominating Blow`、`Convoking Wand`、`Bone Ring`、`Orb of Augmentation` 等），确保始终装入 `MAX_ASR_CONTEXT_CHARS`（360 字符）预算；同时 `resolveEffectiveGlossary` 将用户自定义词条排在预设之前喂给 `buildAsrContextPrompt`，保证用户手写专名不会被大预设库挤出。
- **仅主拼写进 ASR**：`buildAsrContextPrompt` 只提取每条词条的 `sources[0]`（正确拼写），绝不把 `Path of Excel`、`Isamite` 等同音错词喂给 Whisper 解码器。
- **双引擎与 Popup 联动**：
  1. **API 模式（`translation-api.js`）**：`buildTranslationRequestBody` 按当前 `segments` 动态匹配词条；命中时在 `user` JSON 注入 `glossary` 映射，并在 `system` 提示词追加硬性术语约束与领域背景提示；未命中且无领域提示时请求体完全不变。
  2. **本地服务端模式（`server.mjs` + `Start-Services.ps1`）**：`POST /start` 接收清洗后的 `glossary` 字符串并传给 `-Glossary`；`server.mjs` 记录 `startedGlossarySignature`，当术语表变化时自动附带 `-Restart` 重载 WhisperLiveKit。
  3. **ASR 热词（`service-worker.js`）**：`buildSessionWsUrl` 将 `buildAsrContextPrompt` 生成的英文专名串写入 WebSocket URL 查询参数 `?context=...`，由 WLK `SessionASRProxy` 单会话生效；关闭术语库时自动移除 `context` 参数。
  4. **Popup 面板（`popup.html` / `popup.js`）**：新增「术语库」折叠区，含总开关、PoE 预设勾选、生效词条计数、领域背景提示、自定义多行编辑框（防抖落库 + 启动前强制同步）、TXT/CSV 导入（兼容沉浸式翻译三列 `source,target,tgt_lng` CSV）与导出。

## 6. 真实语料验证

用 `.research/poe-041/transcripts.md` 的 66 条英文行 + 内置 `GLOSSARY_PRESETS.poe`（0.5.3 时 97 条；0.5.4 的 313 条复测结果见 12 号文档）实跑：

- 10 行命中，共 17 次词条命中：`Path of Exile`、`Path of Excel`、`runesmithing`、`Isamite`、`dominating blow`、`convoking wand`、`bone rings`、`scepter`、`spirit`、`minion`、`minion builds`、`orb of augmentation` 等全部命中。
- 1000+ 字符的超长行（PoE2 长段口播）正常命中，未出现卡顿。
- `buildAsrContextPrompt` 输出 360 字符（上限 360，装入前 29 个核心专名），`serializeWlkGlossary` 输出 2375 字符（上限 4000，全部 97 条词条含别名完整装入）。

**已知未命中**：`sectors are thematically perfect`（实际语音是 `scepters`）不靠别名纠错——`sector` 是真实英文常用词，登记成别名会在其他语境误伤，交给「ASR `sceptre` 热词先验 + 翻译层领域提示模型纠偏」处理。

## 7. 验证命令与结果

```powershell
npm test                 # 0.5.3 时 90 项全通过（0.5.4 为 91 项）
Get-ChildItem extension,scripts/local-service,tests -Include *.js,*.mjs -Recurse | % { node --check $_.FullName }
```

## 9. 跨模型审阅（GPT-6 Luna，2026-10-31）

结论：无 P0；P1 两条、P2 三条，全部按报告修复并重测；复审又给出两个引号遮罩 P2，一并修掉（`npm test` 87 项通过）。第三条 P1 指出新增测试被 `.gitignore` 忽略、提交后不会随仓库交付 —— 该条成立（`tests/` 自 0.4.x 起被忽略），已按用户指令把 `/tests/` 移出 `.gitignore`，测试随 0.5.3 入库。`paseo/` 与 `AGENTS.md` 仍为本地文件。

| 级别 | 问题 | 处理 |
| --- | --- | --- |
| P1 | 导出不给 `=`、`->`、注释前缀加引号，`A=B -> 译文` 再导入会变成 `A` + `B -> 译文`；CSV 同样 | `LINE_UNSAFE` 统一判断，text/csv 两条导出路径都加引号，并补往返用例 |
| P1 | `serializeWlkGlossary` 把源词里的 `;`/换行替换成空格，生成一个永远匹配不上的词 | 改为**跳过** WLK 无法表达的源词（`;`、`；`、`:`、`=`、`->`、换行），补用例 |
| P2 | 排序只看主拼写长度，长词条的短别名会抢占更长词条的区间 | 展平成「词条 × 拼写」对按拼写长度排序，补 `PoE` / `PoE trading` 用例 |
| P2 | `normalizeEntries` 把 `sources` 数组拼回字符串再切，字面 `|` 被当别名分隔符 | 结构化数组逐项清理去重，不再重走别名语法，补字面竖线用例 |
| P2 | 32 KB `customGlossary` 随每次字幕状态广播发给浮层 content script | 新增 `settingsForCaptions`：发往标签页的对象剥离 `customGlossary`，扩展页面仍用 `settingsForBroadcast` 拿全量 |
| P2 | 引号遮罩遇到 emoji 或弯引号时读回错位 | `maskQuotedSpans` 改为按 UTF-16 索引遍历（避免代理对导致遮罩长度短于原串），且只把 ASCII `"` 当字段引号（弯引号退为普通字符），补 emoji + 弯引号往返用例 |
