# 0.5.4 · 《流放之路》术语库定稿（313 条国服解包官译）

本次把 0.5.3 留下的空壳预设 `GLOSSARY_PRESETS.poe` 填成可用的词库：313 条词条、覆盖《流放之路 1》与《流放之路 2》，全部译名对齐国服（腾讯服）简体中文客户端解包串，并同时喂给三个下游——API 翻译提示词、本地 `llama-server` / WhisperLiveKit 兜底翻译、Whisper ASR 热词。

同时把 0.5.3 记录在册的链路（`translation-api.js` 注入、`service-worker.js` 传词与 WS `?context=`、`server.mjs` + `Start-Services.ps1` 的 `-Glossary`、popup 术语库面板）一并纳入 0.5.4 交付。

## 1. 与 0.5.3 的差别

| 项 | 0.5.3 | 0.5.4 |
| --- | --- | --- |
| 预设词条 | 97 条（混入台服/繁中译名） | 313 条（全部国服解包） |
| 词库位置 | `extension/glossary.js` 内联 | 独立 `extension/glossary-poe.js`（数据与逻辑分离，`glossary.js` 493 行） |
| 译名口径 | 无统一判据 | 逐条以 poe2db.tw/cn 优先、poedb.tw/cn 补充；同名冲突按 PoE 2 |
| 别名 | 少量 | 补齐正则无法推导的变形（`Quarterstaves`、`Foci`、`Staves`、`Ignited`、`Frozen`、`Chilled`、`Shocked`、`Electrocuted`） |
| ASR 热词 | 前 29 条命中预算 | 前 34 条专名占满 360 字符 |

被替换掉的台服旧译（示例，均为本次按国服解包修正）：

| 英文 | 0.5.3 旧值（台服） | 0.5.4 国服 |
| --- | --- | --- |
| `Kalguuran` | 卡尔葛 | 卡古兰人 |
| `The Maven` | 释界 | 贤主 |
| `The Searing Exarch` | 焚界者 | 焚界者（未变，仅补 `Searing Exarch` 别名） |
| `Trickster` | 诈欺师 | 欺诈师 |
| `Orb of Fusing` | 链接石 | 链结石 |
| `Scroll of Wisdom` | 智慧卷轴 | 知识卷轴 |
| `Herald of Ice` | 冰霜之捷 | 寒冰之捷 |
| `Ritual` | 祭坛 | 驱灵仪式 |
| `Delirium` | 谵妄 | 惊悸迷雾 |
| `Detonate Dead` | 尸爆术 | 爆灵术 |
| `Necropolis` | 亡城 | 魔影古园 |
| `Delve` | 地心探险 | 地心探索 |

## 2. 词条分布（共 313 条）

| 分类 | 条数 | 代表词条 |
| --- | --- | --- |
| 世界观、种族与首领 NPC | 35 | `Wraeclast` 瓦尔克拉斯、`Kalguuran` 卡古兰人、`Sekhemas` 丝克玛、`Xesht` 薛斯、`The Arbiter of Ash` 灰烬仲裁官 |
| 职业与升华（PoE 1 + 2） | 55 | `Sorceress` 魔巫、`Stormweaver` 风暴编织者、`Acolyte of Chayula` 夏乌拉追随者、`Gemling Legionnaire` 古灵使徒斗士、`Trickster` 欺诈师 |
| 通货与制作物品 | 55 | `Jeweller's Orb` 工匠石、`Hinekora's Lock` 辛格拉的发辫、`Perfect Jeweller's Orb` 完美工匠石、`Arcanist's Etcher` 奥术师的铭刻 |
| 核心战斗机制 | 37 | `Spirit` 精魂、`Runic Ward` 符文结界、`Deflect` 偏转、`Heavy Stun` 重度晕眩、`Charges` 能量球 |
| 装备、宝石、药剂基底 | 39 | `Quarterstaff` 节杖、`Focus` 法器、`Uncut Spirit Gem` 未切割的精魂宝石、`Meta Gem` 非凡宝石、`Waystone` 引路石 |
| 基石天赋 | 15 | `Chaos Inoculation` 异灵之体、`Giant's Blood` 巨人之血、`Zealot's Oath` 狂热者誓言、`Iron Reflexes` 霸体 |
| 技能宝石 | 38 | `Herald of Ice` 寒冰之捷、`Tempest Bell` 风雷钟、`Skeletal Frost Mage` 魔侍冰霜法师、`Galvanic Shards` 电光散射 |
| 终局与赛季机制 | 24 | `Trial of the Sekhemas` 丝克玛试炼、`The Burning Monolith` 燃石巨塔、`Necropolis` 魔影古园 |
| 顶流传奇物品 | 12 | `Mageblood` 法师之血、`Progenesis` 茁育助长、`Temporalis` 时空之肌、`Aegis Aurora` 幻芒圣盾 |
| 游戏模式 | 3 | `SSF`、`Hardcore` 专家模式、`Ruthless` 无情模式 |

分类只是维护视角，不是匹配字段：词条只有 `sources[]` 与 `target`，匹配靠词边界与长词遮挡。

## 3. 数据来源与判据

**唯一判据**：`https://poe2db.tw/cn/<Slug>` 与 `https://poedb.tw/cn/<Slug>` 条目页的 `<title>`（形如 `混沌石 - 流亡编年史, Path of Exile Wiki cn`）。这两个站点的 `/cn/` 与 `/us/` 共享同一解包 ID，因此 slug 可跨语言对齐，不必猜译名。

**冲突处理**：
1. 同一 slug 两站都有中文标题 → 取 PoE 2（`poe2db.tw`），符合本项目「当前以 PoE 2 直播为主」的口径。
2. 只有一站在售（PoE 1 独有内容，如 `Juggernaut`、`Orb of Fusing`）→ 取 `poedb.tw`。
3. 条目页标题未本地化（`Crossbows`、`Foci`、`Charms`、`Meta Gems`、`Omens`、`Tablets` 这类分类页）→ 取同站导航的中文链接文本。
4. 概念词没有独立条目页（`Endurance Charge`、`Fortify`）→ 用含该机制的技能/关键字页正文佐证：`Immortal Call` 正文出现「耐力球」、`Fortify` 关键字页标题即「护体」、`Charges` 页正文「能量球共有三种类型——耐力球、狂怒球和暴击球」。
5. 首页导航与条目页标题冲突时**以条目页为准**：`poedb.tw` 首页把 `Breach` 标成「深渊」，条目页是「裂隙」，后者正确。

**没有佐证的词一律不收**：`Kulemak`、`Runesmithing`、`Einhar`、`Niko`、`Jun` 等未取到中文标题的条目本轮跳过，不用记忆补写。

## 4. 三梯队与预算实测

框架有两处硬预算，词库顺序必须照顾它们：

| 预算 | 上限 | 实测 | 装进什么 |
| --- | --- | --- | --- |
| `buildAsrContextPrompt` | 360 字符 | 357 字符 / 35 条 | 只取 `sources[0]`，从 `Path of Exile` 到 `Warrior`：大陆、部族、首领与主要 NPC 专名 |
| `serializeWlkGlossary` | 4000 字符 | 4000 字符 / 200 对（恰好触顶） | 含别名展开后约前 150 条：世界观、职业升华、通货、核心机制 |
| `matchGlossaryTerms` | 无字符预算（每批 24 条） | — | 其余基石、技能、赛季、传奇 |

因此排在前面的不是「最重要的译名」，而是「Whisper 最容易听错的英文专名」。职业词（`Warrior`、`Monk` 等）排在最后，`Warrior` 恰好卡在第 35 位：它们不会被 ASR 听错，让位给 `Wraeclast`、`Kalguuran`、`Sekhemas`、`Xesht`。

## 5. 别名策略

`sources[1..]` 只承担两件事：

1. **同音误听**：`Path of Excel`（Path of Exile）、`Isamite`（Ezomyte）、`Jeweler's Orb`（Jeweller's Orb）。
2. **正则推不出的变形**：`buildGlossaryTermPattern` 只自动处理 `-s/-es/-ies/-'s`，所以显式补齐 `Quarterstaves`、`Staves`、`Foci`、`Ignited`、`Frozen`、`Chilled`、`Shocked`、`Electrocuted`。

别名绝不进入 ASR 热词：`buildAsrContextPrompt` 只读 `sources[0]`，把 `Path of Excel` 喂给 `initial_prompt` 会反向诱导 Whisper 听错。

## 6. 刻意剔除的词

纯日常基础英语单字一律不收：`Hit`、`Kill`、`Life`、`Mana`、`Return`、`Link`、`Chain`、`Spark`、`Arc`、`Grace`、`Pride`、`Wrath`、`Anger`、`Hatred`、`Split`、`Fork`、`Pierce`。

理由：这些词大模型本来就译不错，一旦入表，主播每句普通口语都会被强行注入游戏术语，还会吃光每批 24 条的命中配额。

保留的边界情况：`Chill`、`Shock`、`Freeze`、`Ignite`、`Impale`、`Fortify` 属于日常词但机制义极强、直播出现频率高，本轮保留；`Sin`、`Innocence`、`Charm` 中的前两个因日常义过强被剔除，`Charm` 保留（PoE 2 装备分类，语境明确）。

## 7. 已知分歧与遗留

| 项 | 现状 | 说明 |
| --- | --- | --- |
| `Ritual` | 取「驱灵仪式」 | `poedb.tw` 条目页为「驱灵仪式」，`poe2db.tw` 首页导航为「驱灵祭坛」；祭坛是物件、仪式是机制，取机制 |
| `The Searing Exarch` | 取「焚界者」 | 条目页标题「焚界者」，`poedb.tw` 首页导航标「灼督」；以条目页为准，与 `The Eater of Worlds`=「灭界者」成对 |
| `Focus` | 取「法器」（源词 `Focus | Foci`） | PoE 1 的 `Focus` 是「专注」技能，PoE 2 副手分类是 `Foci` 法器；按上面口径取 PoE 2 |
| `Headhunter` / `Mageblood` | 取「猎首」「法师之血」 | 条目页标题带基底（`猎首 皮革腰带`），已截掉基底部分 |
| `Spirit Gem` | 取「精神宝石」 | `poe2db.tw/cn/Spirit_Gems` 页头即「精神宝石 /53」，而 `Uncut Spirit Gem` 条目页是「未切割的精魂宝石」——解包自带不一致，词库照抄，不自行统一 |
| `Kalguur` | 不收独立词条 | 曾把 `Kalguur` 当作 `Kalguuran` 的同义拼写（卡古兰人），会把地名误改成人群称谓；现已移除该别名，只保留 `Settlers of Kalguur`＝君锋城下 |
| `Lineage Support` | 血脉辅助宝石 | 条目页标题是全称，不用短称「血脉辅助」 |
| 常见多义词 | 保留 | `Breach`、`Expedition`、`Harvest`、`Ritual`、`Legion`、`Rage`、`Crucible` 普通英语也用，但 PoE 直播里几乎总是赛季/机制名；`tests/glossary.test.js` 用一条「trades everyday polysemy」用例把误命中行为写死，避免以后误以为有领域门控 |
| WLK 覆盖 | 前 ~150 条 | 4000 字符装不下 313 条全展开；在线 API 与按句匹配不受此限，本地兜底模式下后半截靠 `matchGlossaryTerms` 走服务端注入 |
| 框架问题 | 未改框架 | `GLOSSARY-ISSUES.md` 记录 6 项；本次只做词表层面规避，框架逻辑一行未动 |

## 8. 验证命令与结果

```powershell
npm test                 # 92 项全通过（新增预设数据校验与多义取舍 2 项）
Get-ChildItem extension,scripts/local-service,tests -Include *.js,*.mjs -Recurse | % { node --check $_.FullName }
```

- 预设数据校验（`tests/glossary.test.js` 末尾）：条数 ≥300、主拼写与别名无重复、target 不含 `;`/换行、源词不含 WLK 无法表达的 `;`/`=`/`->`、10 条国服译名抽查、ASR 预算内必须出现 `Wraeclast`/`Ezomyte`/`Kalguuran`/`Kalandra`/`Xesht`/`Sekhemas` 且不得出现 `Path of Excel`/`Isamite`。
- 真实语料冒烟（`.research/poe-041/transcripts.md` 77 行英文）：11 行命中、15 次命中，覆盖 `Path of Exile`、`PoE2`、`dominating blow`、`convoking wand`、`bone rings`、`scepter`、`spirit`、`Isamite`、`orb of augmentation`。
- `buildAsrContextPrompt` 357 字符；`serializeWlkGlossary` 3989 字符 / 199 对。
## 9. 跨模型审阅（GPT-6 Luna，2026-10-31）

结论：有阻塞（1 个 P1），修完后可提交。P1 与 6 个 P2 的处理：

| 级别 | 问题 | 处理 |
| --- | --- | --- |
| P1 | 导入术语文件允许 512 KB，但序列化后直接 `.slice(0, 32 KB)`，超限会截断在词条中间且仍报「导入 N 条」 | 改为按整行（整条词条）截取，报告保留条数与丢弃条数，一行都放不下时直接报错不落库；原有词条优先 |
| P2 | `startedGlossarySignature` 为 `null`（控制服务重启、WLK 仍在线）且当前词表为空时不重启，旧词表继续生效 | 去掉 `null` 特判：WLK 在线且签名与期望不一致就 `-Restart`，含清空场景 |
| P2 | `Kalguur` 被当作 `Kalguuran` 同义拼写 | 移除别名，只留 `Kalguuran`；`Settlers of Kalguur` 有独立词条 |
| P2 | `Rage`/`Expedition`/`Breach` 等常见词无条件触发游戏译名 | 保留（直播语境优先），补「多义取舍」测试把行为写死，并在本文档记录 |
| P2 | `translation-api.js` 依赖 `glossary.js` 疑似违反「零扩展依赖协议层」 | 不改代码：`glossary.js` 自身零 `chrome.*`/DOM，属可复用领域纯函数；已把这条例外写进 `AGENTS.md` 分层表 |
| P2 | 测试只查主拼写重复、条数只断言 ≥300 | 改为遍历全部 `sources` 查重，并锁定 `313` 条发布契约 |
| P2 | `Spirit Gem`=「精神宝石」与 `Spirit`=「精魂」不一致（待确认） | 复核 `poe2db.tw/cn/Spirit_Gems` 页头确为「精神宝石」，属解包自身不一致，词库照抄并在 §7 记录 |
| 建议 | 未覆盖 `server.mjs` 重启判定、WS `context` 开关、导入超 32 KB | 导入超限逻辑已改；`server.mjs` 与 WS 参数仍靠 `node --check` + 人工核对，未补集成测试（列入后续） |

- 未做浏览器端实测：本次改动纯数据与文案，运行时链路由 0.5.4 链路改动承担，需在真实直播/Dev 浏览器复测一次术语生效情况。
