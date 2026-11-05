# 0.5.12 · DeepL 术语库

## 1. 为什么需要单独一条链路

其余翻译后端都能改请求里的提示词，术语通过规则 7~9 注入。DeepL 的 `/v2/translate`
只接受 `text` / `target_lang` / `context` / `glossary_id` 这类字段，没有 system 消息，
所以术语只能走 glossary。换句话说：**只要用 DeepL，术语一致性就只能靠 glossary，
prompt 注入对它完全无效。**

## 2. 能力核实（2026-11-05，用仓库里已存的 `:fx` Key 实测）

| 探测项 | 结果 |
|---|---|
| `POST /v2/glossaries` | `201`，`ready: true` |
| 带 `glossary_id` 翻译 `Spirit` 句 | `我找到了一只精魂和一颗增幅之球。`（命中） |
| 同一句不带 glossary | `我找到了一只灵体和一颗强化之球。`（未命中） |
| 创建第二个 glossary | `456` `Too many glossaries`（免费层限 1 个） |
| `POST /v3/glossaries` | `456` `Quota exceeded`（同样受 1 个限制） |
| `DELETE /v2/glossaries/{id}` | `204` |

结论：**免费层可以用 glossary**（与网络上传言的「API glossary 仅 Pro」不符），
但整个账号只能存在一个。

其他从官方文档核实的约束：

- 创建必须用 root 语言码：`source_lang: EN`、`target_lang: ZH`。写成 `ZH-HANS`
  会被拒；翻译请求里则可以用 `ZH-HANS`，DeepL 会自动匹配 `ZH` 词典。
- 单条 source/target 上限 1024 UTF-8 字节，整个 glossary 上限 10 MiB。
- 条目按**大小写敏感**匹配，`Spirit` 命中不代表 `spirit` 命中。
- 只做整词/短语替换，ASR 错拼（`Path of Excel`）必须在词条里单独列出才可能命中。
- 带 `glossary_id` 翻译时 `source_lang` 必填，否则 400。

## 3. 设计

### 3.1 分层

| 层 | 文件 | 职责 |
|---|---|---|
| 纯函数 | `extension/lib/deepl-glossary.js` | 词条 → pairs（展开 `sources[]`、追加小写变体、丢弃不可匹配项）、TSV、指纹 |
| I/O | `extension/background/deepl-glossary-service.js` | 读 `chrome.storage.local.deeplGlossary`、DELETE + POST、错误映射 |
| 接线 | `background/service-worker.js` | 把 `currentId()` 注入 scheduler 的 `getConfig()`，`test-translation-api` 也带同一 id |
| 路由 | `background/message-router.js` | `sync-deepl-glossary`、`get-deepl-glossary`，均 `extension-page` |
| 入口 | `popup` 术语库折叠区 | 「同步到 DeepL」按钮 + 状态行（未同步 / 词条已变 / 已同步 N 条） |

### 3.2 为什么是手动按钮

免费层只有一个 glossary 坑位，重建只能「先删后建」。如果挂在设置变更上自动执行，
用户每次改一个字母都会删一次账号里的术语库；如果那次创建失败，库就没了。因此：

- 面板显式点击才同步；
- 同步前先把 glossary 草稿存盘（`collectGlossaryPatchFromInputs`），保证用的是
  用户眼前这份词条；
- 指纹相同直接返回「已是最新」，不发任何请求；
- 失败只报错，不动已有库（删除发生在新库创建之前，属于已知取舍）。

### 3.3 词条形态

`buildDeepLGlossaryPairs` 对每条 `{ sources, target }`：

1. 展开所有别名拼写（`Path of Excel` 这种同音误听本身就是给 ASR 用的，值得进库）；
2. 每条再追加全小写变体（`Spirit` → 另有 `spirit`），因为 ASR 首字母大小写不稳定；
3. 丢弃含 tab/换行、非 ASCII 源词、超 1024 字节、空 target 的条目；
4. 同一拼写先到先得，顺序沿用 `resolveEffectiveGlossary`（自定义在预设前）。

实测 313 条预设 + 27 个别名 = 340 对，加小写变体后 680 条，TSV 约 16 KB。

### 3.4 翻译链路

- scheduler 的 `getConfig()` 多带一个 `deeplGlossaryId`（来自服务内存缓存），
  不在每批请求里查存储；
- `buildDeepLRequestBody` 见到 id 才加 `glossary_id` + `source_lang: EN`；
- `translateWithDeepL` 在 400 且响应提到 glossary 时去掉 id 重试一次——账号里的库被
  删掉不能把整行字幕变成缺译。

## 4. 实测（dev 9223，真实 Key）

1. 面板切到 DeepL，勾选术语库 + PoE 预设，点「同步到 DeepL」。
2. 状态行变为 `已同步 680 条术语到 DeepL`。
3. CDP 抓 service worker 网络：`POST /v2/glossaries` 带 680 行 TSV、
   `source_lang: EN`、`target_lang: ZH`；随后的 `POST /v2/translate` 带
   `glossary_id: bbeca0d7-…` 与 `source_lang: EN`。
4. `GET /v2/glossaries`：`shengmu-captions`，`entry_count: 680`，`ready: true`。
5. 面板「测试翻译 API」正常返回（457 ms），说明带 glossary 的请求被接受。

## 5. 已知限制

- **免费层 1 个 glossary**：同步会删掉同账号里已有的那个（不限于声幕创建的）。
  报错文案为 `glossary_quota`，消息里带服务端原话。
- **删除与创建之间**的短暂窗口里，在飞请求会带失效 id；由 400 重试兜底。
- **错拼覆盖有限**：glossary 是精确短语匹配，没列进词条的 ASR 错拼匹配不上，
  这与 prompt 注入的柔性纠错是两套东西。
- **词条变更不会自动生效**：面板会提示「词条已变化，重新同步后新术语才生效」。
- `qwen-mt-*` 等其它后端仍走原有 prompt / `translation_options.terms` 注入，
  不受本链路影响。
