# 0.5.5 字幕流：去灰化、语义单元、语气词与采集埋点

解决的问题来自实际使用反馈四条：译文槽频繁整行变灰、断句导致中文不连贯、语气词被直译、切页后采集失效。设计原则是先确认前三者是同一条流水线的时间结构问题，再统一改；第四条单列，先埋点后修。

## 1. 问题归因

原流水线：`ASR 碎片行 → 每行独立翻译 → 每行各自 pending → 屏幕跟着 pending 灰/亮`。

- `selectDisplayCaption` 在译文未到时把上一句放进译文槽并标 `pending`，浮层再对 `.translation.stale` 降透明到 0.58。
- 翻译单位是 ASR 行，上下文只取「最近 2 条已有译文的行」，而 WLK 的 `--asr-coalesce-min-s 0.5` 经常把一句切成 2~4 行。
- `SYSTEM_PROMPT` 第 2 条明确要求「保留语气」，且没有任何 filler 清洗层。

三者互相喂养：碎片行没有上下文 → 译文悬空 → 译文到达慢且与行切换不对齐 → 灰化成为常态。

## 2. 基线证据（固定样本，改动前）

样本 `.research/quality-samples/vkCu3V81N74-15m00-17m00.wav`，本地播放页 + tabCapture + WLK + 本地 9B，采样 100 秒：

| 指标 | 改动前 |
|---|---|
| `.translation.stale` 采样占比 | 65/100 秒（65%） |
| 译文文本变化率 | 0.42 次/秒 |
| 碎片行（≤4 词） | 10/30 行（33%） |
| 非句末结尾行 | 3/30（10%） |
| 英文 filler 残留 | um×3、kind of×2、honestly×1 |

典型的悬空译文（同一句被切成三行各自翻译）：

```
a real kalgurin runesmith.   -> 真正的卡尔古林符文锻造师。
that he has found.           -> 他找到了。              (宾语丢在上一行)
that Danig has been leading. -> 丹尼格一直在领导。      (领导什么？)
```

## 3. 改动

### 3.1 显示层：不再用降透明表达"还在翻"

- `.translation.stale` 全亮（`#fffdf4`），只保留 class 语义；dual 模式上一句从 0.62 提到 0.82。
- 新增 `.caption-shell[data-awaiting="1"]::before` 角落小点（5px、呼吸 2.4s、尊重 `prefers-reduced-motion`），由 `syncAwaitingDot` 控制：等待超过 `AWAITING_DOT_DELAY_MS = 700` 才出现，短等待不闪。
- `OVERLAY_VERSION` 5 → 6，强制重建旧实例。

### 3.2 语义单元：碎片合并成句后再翻译

新增 `extension/utterance.js`（零 `chrome.*`/DOM）：

- `needsCompletion(text)`：该行自身没说完——≤4 词或 ≤25 字符、逗号/分号收尾、以虚词收尾（`the`/`that`/`to`/`is`…）。
- `startsContinuation(text)`：该行是上一句的延续——从属连接词开头（and/but/or/that/which/with/because/if/when/while/than/then）或 `PARTICIPLE_CONNECTORS` 白名单现在分词（allowing/using/making…）且 ≤8 词。
- `isSpeechShard = startsContinuation || needsCompletion`。
- `planTranslationBatch`：把碎片与其完成行放进同一请求；尾部碎片最多等 `SPEECH_SHARD_HOLD_MS = 2000` 再单独发。

`extension/caption-utils.js` 新增 `mergeCaptionFragments`：行级合并，`FRAGMENT_GAP_SECONDS = 2.0`、`FRAGMENT_MAX_LINES = 4`、`FRAGMENT_MAX_CHARS = 180`；合并后沿用首行 id，`source` 拼接、`end` 取末行、译文清空待重译。

两条红线（都踩过）：

1. 判据不能用「以句号结尾」——WLK 给每个片段补标点，`and riddled with excitement.` 看着完整其实是半句。
2. 封口只能由「最后加入的行自身 `needsCompletion`」决定，不能用 `startsContinuation`，否则整段话被粘成一行且永远翻不出来。

合并只在 **API 模式**生效：server 模式的译文由 WLK 按自己的分段对齐，合并会把这些译文丢掉（实测 6/17 行缺译）。

### 3.3 上下文与提示词

`extension/translation-api.js`：

- `recentTranslationContext(lines, limit=4, excludeIds)`：窗口 2 → 4 行、`MAX_CONTEXT_CHARS` 240 → 480，且**允许未译行**（旧实现只收已译行，等于每批都像新对话）；调用方必须传当前批次 id 集合，避免同一句既在 `segments` 又在 `context`。
- prompt 新增规则 5（相邻片段同属一句，译文衔接、不重复上一片段）与规则 6（承接 context，补足省略主语）；规则 4 补「不要把片段翻成独立完整句」。`partial`/领域/术语规则编号顺延到 7/8/9。

### 3.4 语气词三道

新增 `extension/speech-cleanup.js`：

- `stripSpeechFillers`（送翻前，只改发送文本，历史英文保持原样）：删 um/uh/erm/hmm 等独立感叹词、逗号包围的插入语（you know / I mean / kind of / sort of / like / basically / literally / honestly / actually）、句首口头语（okay so / well / now）、`is kind of X` 结构、结巴重复（`I I` → `I`，保留 had/has/that 等合法重复）。
- prompt 规则 2：删除语气词、口头禅、结巴重复、自我打断，明确不输出「嗯、啊、那个、就是说」。
- `polishTranslation`（上屏/落盘前，两种模式共用）：去中文句首语气词（嗯/呃/啊/哦/噢/唉/欸/那个/就是说/然后呢）、合并重复标点、保留句中感叹；输入非空时绝不返回空串，否则会被当成翻译失败反复重试。

### 3.5 采集层埋点（第四条的前置）

`extension/offscreen.js`：

- `audioStats` 新增 `peak`（每窗口 abs max）与 `trackMuted`，`trackState` 保留。
- track 新增 `muted`/`unmuted` 事件上报与 `[capture-diag]` console。

这是唯一能区分「页面真的没声音」与「采集被切断」的信号：一次静音会话里 `deliveredRatio` 仍是 0.999、`peak` 为 0，而正常会话 `peak` 在 0.6~0.87。

## 4. 验证

### 4.1 单元测试

`npm test` 113 项通过（0.5.4 的 92 项 + 新增 21）：

- `tests/utterance.test.js`（9）：碎片判据、连接词/分词、封口、hold 释放、上限、批长。
- `tests/speech-cleanup.test.js`（6）：插入语、`kind of` 两义、结巴、空输入回退、中文语气词与标点。
- `tests/caption-utils.test.js`（+3）：碎片合句、限制与间隔、合并后译文失效。
- `tests/translation-api.test.js`（+3）：未译行进上下文、排除当前批、prompt 连续性规则。

### 4.2 端到端（本地 9B，API 模式，固定样本）

| 指标 | 0.5.4 基线 | 0.5.5 |
|---|---|---|
| 译文灰化（color 取值） | 0.58 灰 | 仅 `rgb(255,253,244)` |
| 碎片行 | 33% | 0~6% |
| 孤儿句 | 3 | 0 |
| 中文语气词 | 依赖模型 | 0 |
| 译文文本变化率 | 0.42/s | 0.19~0.34/s |

合并后的真实输出（同一段音频）：

```
0:00:49 | a real Khulgurran runesmith. and riddled with excitement, he wants to
        | learn how to merge modern Khulgurran techniques
     -> 一位真正的 Khulgurran 符文锻造师。他兴奋不已，想要学习如何将现代的
        Khulgurran 技术与自己发现的古老知识相结合。
```

同一批碎片在旧 prompt 下是三条各自独立的短句（见 `.research/p1p2-offline-check.mjs` 的对照输出）。

### 4.3 已知代价

- 本地 9B 下单次翻译 1~3 秒，合并单元又要求等封口，`data-awaiting` 出现率 80%（旧版灰化率 65%）。屏幕内容始终是完整中文（不再灰），但会慢一拍。云端 DeepSeek（0.2~0.5 秒）应显著更低，本次未用云端额度验证。
- `startsContinuation` 判据是词表，不是语法分析：同位语（`a real Kalgurin runesmith.`）无法向前合并，仍会单独成行。

## 5. 自动化验证工具（本次新增）

手动点扩展开始太费事，`.research/` 下补齐了一条无人值守链路：

- `reload-extension.py`：从扩展页调 `chrome.runtime.reload()`（worker 休眠时也能 reload）。
- `start-capture.py`：把播放页设前台 → 按 UIA 坐标点真实工具栏图标（授予 activeTab，CDP 无法伪造）→ 在 popup 上点开始 → 校验会话 active；前台抢不到时回退 `Ctrl+Shift+Y`；检测到会话锁定直接提示。
- `baseline-attach.py`：采样灰化/等待/碎片/孤儿句/filler，并自动恢复被按键暂停的播放器。
- `config-api-mode.py`：把 dev 扩展切到 API 模式指向本地 8013（验证 P1/P2 必需，会备份/恢复设置）。
- `p1p2-offline-check.mjs`：绕开 ASR 不稳定，把同一组碎片分别喂旧/新 prompt 做对照。
- `run-probe.sh`：一条命令跑完 reload → 启动 → 采样。

实测坑：`chrome.tabCapture.getMediaStreamId` 需要 activeTab，CDP 与脚本都无法授予；Windows 会话锁定时 `OpenInputDesktop()` 返回 0、`GetForegroundWindow()` 返回 0，任何合成输入都无效。

## 6. 未做

- 第四条的自愈（导航后重取 streamId + 热替换音频源）未实现：用户实测当前已复现不了该问题，按「先埋点、复现再修」处理。埋点（`peak`/`trackMuted`/`muted` 事件）已就位。
- 合并单元不重排历史顺序，也不做跨单元去重。
- 未用云端 DeepSeek 复测延迟与费用。
