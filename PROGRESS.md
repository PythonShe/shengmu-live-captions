# 项目进度记录 (PROGRESS.md)

## 2026-11-03 · 0.5.5：去灰化、语义单元合并、语气词三道、采集埋点

设计/验收记录：`paseo/13-subtitle-flow-0.5.5.md`。起因是实际使用反馈四条（译文整行变灰、断句导致中文不连贯、语气词被直译、切页后采集失效），前三者判定为同一条流水线的时间结构问题，统一改；第四条先埋点，按「复现再修」搁置。

### 已修改文件
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\extension\utterance.js`（新增，148 行）：`needsCompletion`（≤4 词/≤25 字符/逗号或虚词收尾）、`startsContinuation`（从属连接词 + 分词白名单）、`isSpeechShard`、`planTranslationBatch`（碎片与其完成行同批、尾部碎片 hold 2 s）。
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\extension\speech-cleanup.js`（新增，168 行）：`stripSpeechFillers`（送翻前清洗，只改发送文本）与 `polishTranslation`（上屏/落盘前清洗，两种模式共用，非空输入不返回空串）。
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\extension\caption-utils.js`：新增 `mergeCaptionFragments`（行级合并，间隔 2.0 s / 4 行 / 180 字符，沿用首行 id），常量 `FRAGMENT_*`。
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\extension\translation-api.js`：`recentTranslationContext` 支持未译行、窗口 4 行 / 480 字符、可排除当前批次；prompt 新增规则 5（片段同属一句、译文衔接不重复）与规则 6（承接 context、补足主语），规则 2 改为删除语气词/口头禅/结巴/自我打断。
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\extension\service-worker.js`：API 模式下先 `mergeCaptionFragments` 再走后续链路；`collectPendingLineTranslations` 存 `promptText` 与 `queuedAt`；`flushLineTranslations` 用 `planTranslationBatch` 选批并排除当前批 id；译文过 `polishTranslation`；buffer 翻译不再被行队列饿死（积压 >2 才让位）。
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\extension\content-overlay.js`：`.translation.stale` 全亮、dual 上一句 0.82、新增 `data-awaiting` 角落小点（700 ms 延迟出现、2.4 s 呼吸、尊重 reduced-motion）、`syncAwaitingDot` 与 teardown 清理、`OVERLAY_VERSION` 5→6。
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\extension\offscreen.js`：`audioStats` 增 `peak`/`trackMuted`，track 增 `muted`/`unmuted` 上报与 `[capture-diag]` 日志。
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\tests\utterance.test.js`（新增 10 例）、`tests\speech-cleanup.test.js`（新增 6 例）、`tests\caption-utils.test.js`（+3）、`tests\translation-api.test.js`（+3）。
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\package.json` `extension\manifest.json`：0.5.4 → 0.5.5；`AGENTS.md`：版本、113 测试、新模块、灰化/合并/prompt/节流四条规范。
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\paseo\13-subtitle-flow-0.5.5.md`（新增）：基线、判据红线、两道踩坑、验收数据、自动化验证工具、未做项。

### 已执行验证
- `npm test`：113 项全通过；`extension/*.js` 全部 `node --check` 通过。
- 基线（改动前，固定样本 100 s）：`.translation.stale` 65%、碎片行 33%、孤儿句 3、译文变化 0.42/s。
- 0.5.5 端到端（API 模式 + 本地 9B + 同一 wav）：译文 color 只有 `rgb(255,253,244)`（灰化消失）、碎片行 0~6%、孤儿句 0、中文语气词 0、译文变化 0.19~0.34/s；合并后出现整句译文（`a real Khulgurran runesmith. and riddled with excitement…` → 一条完整中文）。
- 离线对照 `.research/p1p2-offline-check.mjs`：同一组碎片，旧 prompt 输出"他找到了。"式悬空句，新 prompt 输出承接上下文的完整译句。
- 采集埋点实测：静音会话 `peak 0` 而 `deliveredRatio 0.999`；正常会话 `peak 0.62~0.87`，证明 peak 是区分两者的必要指标。

### 未执行 / 待后续
- 第四条自愈（导航后重取 streamId、热替换音频源、一键续采）未实现：用户实测已无法复现，按要求搁置；埋点已就位。
- 本地 9B 下 `data-awaiting` 出现率 80%（旧版灰化 65%），屏幕不再变灰但会慢一拍；未用云端 DeepSeek 额度复测延迟。
- 同位语（`a real Kalgurin runesmith.`）无法向前合并，仍单独成行。
- `.research/` 下自动化工具（reload-extension / start-capture / baseline-attach / config-api-mode / run-probe）为本地文件，不入库。

### 跨模型审阅（qwen3.7-plus，`review=code review`）
- 结论：无 P0/P1，可提交。它自行修了 3 个 P2（`translation-api.js` 两语句挤一行、删掉未使用的 `joinBatchSources` 及其测试、纠正 PROGRESS 里的测试数）。审计其改动：删掉的导出无任何引用，格式修复无副作用，测试数已同步为 113。
- 它违反只读约束改了文件并 `git add` 了新文件；下次审阅需在 prompt 里加更硬的约束。

### 已提交并推送
- `05408db` `feat(0.5.5): de-grey stale translations, merge ASR fragments, strip fillers`（`master` → `origin/master`，GPG Good signature，15 文件 +924/−100）。
- 提交前发现 3 个文件的行尾被 Python 改写转成 CRLF（`git diff --stat` 整文件重写），已按 HEAD 版本对齐回 LF 并复核。
- 本机 `HTTP(S)_PROXY=127.0.0.1:7897` 无监听，push 需临时走实际端口 `7891`；已记 pit（`git-push-proxy-d37de8`）。


## 2026-10-31 · 0.5.4：术语库全链路 + 《流放之路》313 条国服词库定稿

设计/验收记录：`paseo/11-glossary-0.5.3.md`（链路）、`paseo/12-poe-glossary-0.5.4.md`（词库数据与判据）、`GLOSSARY-ISSUES.md`（框架问题复核）。两部分改动合并在 0.5.4 交付：链路由上一会话完成、词库由本会话定稿。

### 术语链路（上一会话，未提交）
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\extension\translation-api.js`：新增 `buildSystemPrompt`（部分译文提示、领域背景、术语硬约束三条按需追加）；`buildTranslationRequestBody` 用 `matchGlossaryTerms` 按当前 batch 命中后注入 `glossary` 映射，未命中且无领域提示时请求体与 0.5.3 一致；`translateTexts` 透传 `glossaryEntries` / `domainHint`。
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\extension\service-worker.js`：`translationConfig()` 附带 `glossaryEntries`、`domainHint`；新增 `buildSessionWsUrl` 把 `buildAsrContextPrompt` 结果写进 WS `?context=`（关闭术语库时删除该参数）；术语设置变更纳入 `translationSettingsChanged`。
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\scripts\local-service\server.mjs`：`POST /start` 接收 `glossary`，经 `sanitizeWlkGlossary`（去控制字符、压空白、截 4000）后传 `-Glossary`；新增 `startedGlossarySignature`，术语表变化或模式切换时补 `-Restart`；`/stop` 与异常路径清空签名。
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\extension\popup.html` `popup.js` `popup.css`：新增「术语库」折叠区（总开关、PoE 预设勾选、生效条数摘要、领域提示、自定义多行框、TXT/CSV 导入导出）；启动采集与「一键启动」前强制同步术语字段；本地服务端模式下提示需重载才能生效。
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\tests\translation-api.test.js` `tests\service-worker.integration.test.js`：+4 例覆盖提示词注入、按批命中、mock API 往返。

### 词库定稿（本会话）
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\extension\glossary-poe.js`（新增，345 行）：`POE_PRESET_ENTRIES` 313 条，覆盖世界观/种族/首领 35、职业与升华 55、通货与制作 55、核心机制 37、装备宝石药剂基底 39、基石天赋 15、技能宝石 38、终局赛季 24、顶流传奇 12、游戏模式 3。全部译名取自 `poe2db.tw/cn`（优先）与 `poedb.tw/cn` 条目页 `<title>`，分类页取同站导航，概念词用含该机制的技能/关键字页正文佐证。
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\extension\glossary.js`：删除内联的 97 条 `POE_PRESET_ENTRIES`，改为从 `glossary-poe.js` 引入（文件回落到 493 行，数据与逻辑分离）。其余逻辑未动。
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\extension\popup.html`：PoE 预设描述改为词库实际内容（节杖、引路石、符文结界、焚界者、异界图鉴、313 条）。
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\tests\glossary.test.js`：新增「shipped PoE preset matches the official Simplified Chinese client」1 例（条数 ≥300、主拼写与别名去重、target 无 `;`/换行、源词无 WLK 不可表达的 `;`/`=`/`->`、10 条国服译名抽查、ASR 预算内必须含 6 个高危专名且不得含同音错词）。
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\GLOSSARY-ISSUES.md`：追加「0.5.4 复核」表，逐条标注框架问题 1/2 已修或已规避、3/7 仍存在、4/5/6 已规避或定口径。
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\package.json` `extension\manifest.json`：0.5.3 → 0.5.4。
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\AGENTS.md` `README.md`：版本号、文档锚点、`npm test` 数量、分层表新增 `glossary-poe.js`、新增「词库数据红线」一条。
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\paseo\12-poe-glossary-0.5.4.md`（新增）：数据来源与判据、三梯队与预算实测、别名策略、剔除词、已知分歧、验证结果。

### 已执行验证
- `npm test`：92 项全通过（0.5.3 的 90 项 + 预设数据校验与多义取舍 2 项）。
- `node --check`：`extension/*.js`、`scripts/local-service/server.mjs`、`tests/*.js` 全通过。
- 词库规模与预算：313 条；`buildAsrContextPrompt` 357 字符（上限 360，装入前 35 条专名，`Wraeclast` 到 `Warrior`）；`serializeWlkGlossary` 4000 字符 / 200 对（上限 4000，恰好触顶，覆盖前约 150 条词条）。
- 真实语料冒烟（`.research/poe-041/transcripts.md` 77 行英文）：11 行命中、15 次命中，含 `Path of Exile`、`PoE2`、`dominating blow`、`convoking wand`、`bone rings`、`scepter`、`spirit`、`Isamite`、`orb of augmentation`。

### 未执行 / 待后续
- 未做浏览器实测：本次词库为纯数据改动，链路需在 Dev 浏览器或真实直播里复测一次（术语是否按预期出现在 API 请求与浮层译文）。
- 未拆 PoE 1 / PoE 2 预设包：同名不同译统一按 PoE 2 口径，若后续以一代直播为主需再评估。
- WLK 4000 字符只覆盖前约 150 条，后半截仅靠按句匹配生效；要彻底解决需取消启动参数静态全量传参（记在 `GLOSSARY-ISSUES.md` 第 3 条）。
- 未补集成测试：`server.mjs` 的术语签名重启判定与 WS `?context=` 的开关仍靠 `node --check` 与人工核对。

### 跨模型审阅（GPT-6 Luna，`review=code review`）
- 结论：有阻塞（1 个 P1），修完后可提交。完整分级表见 `paseo/12-poe-glossary-0.5.4.md` §9。
- P1（已修）：`popup.js` 导入术语文件允许 512 KB，却把序列化结果直接 `slice(0, 32 KB)`，超限会截断在词条中间且仍报「导入 N 条」。改为按整行截取，报告保留/丢弃条数，一条都放不下时直接报错不落库。
- P2（已修）：`server.mjs` 的 `startedGlossarySignature` 为 `null`（控制服务重启、WLK 仍在线）且当前词表为空时不重启，旧词表会继续生效 —— 去掉 `null` 特判，签名不符即 `-Restart`。
- P2（已修）：`Kalguur` 曾被当作 `Kalguuran` 的同义拼写（卡古兰人），会把地名误改成人群称谓，已移除别名。
- P2（已修）：测试只查主拼写重复、条数只断言 ≥300 —— 改为遍历全部 `sources` 查重并锁定 313 条。
- P2（记录不改）：`translation-api.js` 依赖 `glossary.js` 属可复用的领域纯函数（零 `chrome.*`/DOM），已在 `AGENTS.md` 分层表写明属例外。
- P2（记录不改）：`Spirit Gem`＝精神宝石、`Uncut Spirit Gem`＝未切割的精魂宝石 是解包自身不一致，词库照抄；`Breach`/`Expedition`/`Harvest`/`Ritual`/`Legion`/`Rage` 的日常词误命中用测试写死（直播语境优先）。
- 顺带修正：`Lineage Support` 改用条目页全称「血脉辅助宝石」。
- 已提交并推送：`ead7c47` `feat(0.5.4): ship the Path of Exile glossary and wire it into both engines`（GPG 签名验签 Good signature，16 文件 +1230/−101）、`d3f5e9b` 记录提交号、`e0580e9` pit 记录（`master` → `origin/master`）。`paseo/`、`AGENTS.md`、`.research/`、`test-assets/`、`chrome-profile/`、`logs/` 仍不入库。

## 2026-10-31 · 0.5.3：术语库基建（解析/匹配/序列化 + 设置字段，不含术语表内容）

设计/验收记录：`paseo/11-glossary-0.5.3.md`。范围由用户拍板：只做基建层，内置 PoE 预设留空壳，popup 面板 / 翻译注入 / ASR context / `-Glossary` 打通留到下一步。

### 已修改文件
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\extension\glossary.js`（新增，443 行）：零 `chrome.*`/DOM 纯函数。`GLOSSARY_PRESETS`（`poe` 空壳 + `domainHint`）、`parseGlossaryText`（`->`/`=>`/`=`/`,`/制表符分隔、`|` 别名、`#`/`//` 注释、引号遮罩（引号内逗号/竖线不切分）、CSV 表头跳过与引号还原、同主拼写后写覆盖）、`collectGlossaryEntries`（预设 + 自定义合并，自定义优先）、`matchGlossaryTerms`（词边界、英文复数/所有格折叠、长词优先 + 字符区间遮挡、每批 ≤24 条、正则缓存）、`buildGlossaryMap`、`buildGlossaryTermPattern`、`buildAsrContextPrompt`（仅 ASCII 英文源词，≤360 字符）、`serializeWlkGlossary`（别名展开成独立 `source -> target`，洗 `;；`，≤4000 字符）、`exportGlossaryText`（text/csv 双格式，均能原样读回）。
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\extension\caption-utils.js`：`DEFAULT_SETTINGS` 增 `glossaryEnabled`/`glossaryPresetIds`/`glossaryDomainHint`/`customGlossary`；`normalizeSettings` 增三条归一（未知/重复预设 id 丢弃、领域提示压空白截 120、自定义词条截 32 KB）；新增 `MAX_GLOSSARY_DOMAIN_HINT_CHARS`。术语字段不进 `TAB_ALLOWED_SETTING_KEYS`。
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\tests\glossary.test.js`（新增）：21 例，覆盖解析各格式、CSV 表头与引号、覆盖优先级、复数/所有格/`ies`、短词边界（`ES` 不碰 `best`/`test`）、长词遮挡（`Orb of Augmentation` 压 `Orb`）、`maxMatches`、空输入、`poe-041` 真实误听句（`Path of Excel`/`Isamite`/`dominating blow`）、ASR 提示词预算、WLK 序列化清洗与不可表达源词跳过、字面竖线、emoji 与弯引号、text/csv 往返。
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\tests\caption-utils.test.js`：+5 例（术语设置默认与非法预设 id、预算截断、`sanitizeSettingsPatch` 拦截术语字段、`settingsForBroadcast` 保留术语字段、`settingsForCaptions` 剥离 `customGlossary`）。
- `extension/service-worker.js`：`broadcastCaptionState` 与 `injectOverlay` 的 init 改用 `settingsForCaptions`，发往标签页的对象不再携带 32 KB 自定义词条（审阅 P2）。
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\package.json` `extension/manifest.json`：版本 0.5.2 → 0.5.3。
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\AGENTS.md`：首段版本与文档锚点、`npm test` 数量 57→80、分层表加 `glossary.js`、§4 增两条术语库红线。
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\paseo\11-glossary-0.5.3.md`（新增）：数据模型、解析/匹配规则、三个序列化器、空壳预设约定、真实语料验证、下一步。

### 已执行验证
- `npm test`：87 项全通过（本次 +26：`tests/glossary.test.js` 21 例 + `tests/caption-utils.test.js` 5 例）。
- `node --check`：`extension/glossary.js`、`extension/caption-utils.js`、`tests/glossary.test.js` 通过。
- 真实语料冒烟（`.research/poe-041/transcripts.md` 66 条英文行 + 对话里列出的 12 条 PoE 词条作 fixture）：10 行命中、11 次命中，含 `Path of Exile`×3 / `Path of Excel`×1 / `runesmithing`×3 / `Isamite`×2 等；1000+ 字符超长行命中 6 条不卡；`buildAsrContextPrompt` 196 字符、`serializeWlkGlossary` 316 字符，均未触顶。
- 已知不命中（设计内）：`sectors are thematically perfect`（实为 `scepters`）不靠别名纠错——`sector` 是真实英文常用词，登记别名会在其他语境误伤，留待「领域提示 + 模型纠偏」。

### 未执行 / 待后续决定
- 术语库下一步 4 项均未做（见 `paseo/11-glossary-0.5.3.md` §8）：`translation-api.js` 注入、`service-worker.js` 传词条与 WS `?context=`、`server.mjs` + `Start-Services.ps1` 的 `-Glossary` 打通与 `-Restart` 判定、popup 术语库面板。
- 预设词库内容（60~100 条）未写；360 字符 ASR 预算装不下全部专名时，需要一个「核心专名优先」的分级字段，待词条内容定稿后再选型（词条级 `core` 标记 vs 预设包级 `asrTerms[]` 短名单）。
- 跨模型审阅（GPT-6 Luna，`review=code review`）两轮完成：首轮无 P0、P1 两条 + P2 三条，全部已修；复审确认可提交，又指出两个引号遮罩边界 P2（emoji 代理对错位、弯引号误当字段引号），一并修掉并补往返用例。审阅第三条 P1（新增测试被 `.gitignore` 忽略、不会随仓库交付）成立，已把 `/tests/` 移出 `.gitignore`，测试随后续提交入库。详见 `paseo/11-glossary-0.5.3.md` §9。
- `.gitignore` 移除 `/tests/`：`tests/` 全部 7 个文件随之入库（此前自 0.4.x 起被忽略）；`paseo/`、`AGENTS.md`、`.research/`、`test-assets/` 仍为本地。
- 已提交并推送：`b30863c` `feat(0.5.3): add glossary infrastructure and track the test suite`（`master` → `origin/master`，GPG 签名验签 `G`）。`paseo/`、`AGENTS.md`、`.research/`、`test-assets/`、`chrome-profile/`、`logs/` 仍不入库。
- 未做浏览器实测：本次不含 UI 与运行时链路。`extension/glossary.js` 目前只被 `caption-utils.js` 引入两个常量（预设 id 列表、自定义词条长度上限），匹配与序列化函数尚无运行时调用者，扩展实际行为与 0.5.2 一致。

## 2026-10-31 · 0.5.2：ASR 参数、显示锁、浮层宽度、透明度滑块（Helium 实测）

设计/验收记录：`paseo/10-asr-width-opacity-0.5.2.md`。

### 已修改文件
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\scripts\Start-Services.ps1`：WLK 参数 `--buffer_trimming_sec 4→10`、`--localagreement-beam-size 1→3`、新增 `--confidence-validation`；`--asr-coalesce-min-s` 试过 0.3 后按实测回退 0.5（0.3 会让 54% 的行碎成 “The.” 级片段）。
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\scripts\local-service\server.mjs`：`/start` 接受 `translationMode` + `apiTranslationConfigured`；`api` 且已配 Key 时传 `-AsrOnly`（不启 8013），并在模式切换时先停旧服务 / 用 `-Restart` 避免 Start-Services 报错。
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\extension\caption-utils.js`：`selectDisplayCaption` 不再让新英文等旧译文（原文槽最新、译文槽保留上一句并置 `pending`）；新增 `normalizeOpacity`（域 `0.05~1`，`0` 不再被吞成默认值）。
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\extension\content-overlay.js`：新增 `.caption-stack` 承载工具栏与字幕框，`.stage` 退为定位锚点（`min(68vw, 860px)`）；canvas `measureText` 量宽 + 240~860 px 贴合、变宽立即/变窄延时 420 ms；`.translation.stale`（上一句，同字号降透明）与 `.translation.pending`（空占位）分流；`--overlay-opacity` 联动背景/边框/阴影/`backdrop-filter` 与历史面板。
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\extension\popup.html` `popup.js`：新增「不透明度」滑块（180 ms 防抖落库）；本地模型区按 API/本地模式调整文案与启停条件。
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\extension\manifest.json` `package.json`：版本 0.5.1 → 0.5.2。
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\README.md` `AGENTS.md` `paseo/10-asr-width-opacity-0.5.2.md`：文档与规范同步。
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\tests\caption-utils.test.js`：新增/改写 `selectDisplayCaption` 4 例与 `normalizeOpacity` 1 例。

### 已执行验证
- `npm test`：60 项全通过；`node --check` 覆盖 `extension/*.js`、`server.mjs`、`tests/*.js` 全通过；`Start-Services.ps1` PowerShell 解析 0 错误。
- 120 秒固定样本（`vkCu3V81N74-15m00-17m00.wav`）×3 配置，Helium + 扩展 + WLK + 本地 9B：采用配置 24 行、首英文 0.80 s、首中文 1.55 s、译文滞后 P50 1.25 s / P95 2.61 s、结束缺译 0、`Resetting buffer` 0。
- UI 实时采样（`.research/v052-ui-check.py`）：`.caption-shell` 出现 240→860 px 共 18 档随句长变化，`.stage` 固定 860 px；透明度滑块 8% → `blur(0.88px)`、86% → `blur(9.46px)`，`.translation.stale` 在 65/100 采样中生效且与上一句译文一致。

### 未执行 / 待后续决定
- 跨模型审阅（GPT-6 Luna）已完成：无 P0，1 个 P1、6 个 P2；P1 与 5 个 P2 已修并重测，剩 1 个 P2（ASR-only 下 API 失败时 popup 仍显示“实时翻译中”）记入 backlog。详见 `paseo/10-asr-width-opacity-0.5.2.md` §8。
- 最终浏览器复测在 `scripts/Start-DevBrowser.ps1`（Chrome + `chrome-profile`）上完成，未再打断 Helium 里的直播；Helium 侧由用户自行观察。
- 已提交并推送：`defe4fc` `feat(0.5.2): stop dropping ASR audio, hug the caption box, add opacity slider`（`master` → `origin/master`，GPG 签名）。`.research/`、`tests/`、`paseo/`、`AGENTS.md` 在 `.gitignore` 中，这些改动不进版本库。
- 在线直播（Twitch）只做了人眼链路，未作为转写验收源。
- 短行合并（把 “The.” 与下一行合并再翻译）未实现，需单独设计。
- Helium 自带拦截器会挡以标签页方式打开 `chrome-extension://<id>/popup.html`；该标签页若成为活动标签，点“开始”会报“此页面不支持标签页音频采集”。已记入 `.pit`（`tabcapture-97fd44`）。
- `Start-LocalService.ps1` 在本次会话两次出现“服务已起来但 PowerShell 包装进程不返回”（120 s 后才被中断），疑似脚本末尾健康轮询/句柄继承问题，与本次改动无关，未深查。

## 2026-10-31 · 重写项目级 `AGENTS.md`（参照 Sonelis Station `CLAUDE.md` 电报式极简风格）

### 已修改文件
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\AGENTS.md`：砍掉八股套话与顶层巨型四列表，压缩为 63 行（约 3.8 KB，体积缩减超 55%）电报式高密度规范，完整保留命令、代码规则、浮层/降噪阈值、分层表、三处模型同步、节流预算与安全红线。
- `C:\Users\moule\Documents\ChatGPT\实时字幕翻译\PROGRESS.md`：更新进度记录。

### 已执行验证
- `npm test`：57 项测试全部通过（耗时 ~718 ms）。
- `node --check`：全量检查 `extension/*.js`、`scripts/local-service/server.mjs`、`tests/*.test.js` 语法全部通过。
- Phase 4 12 条红线自检：12/12 全部 `PASS`（83 行 ≤ 120 行上限）。

### 未执行 / 待后续决定
- 本地 GPU 端到端启动命令（`.\scripts\Start-Services.ps1`、`.\scripts\Start-LocalService.ps1`、`.\scripts\Start-DevBrowser.ps1`）属于有状态硬件/浏览器服务命令，本次仅做静态脚本路径与参数核对，未拉起常驻进程。
- `package.json` 尚未串联一键 `check` 脚本（当前仅有 `"test": "node --test tests/*.test.js"`），按约定未擅自修改 `package.json`，已在交付报告中给出补齐建议。
