---
id: "research-chrome-extension-c9e4ff"
title: ".research 端到端探针硬编码 chrome-extension://<id>/subtitle.html，0.5.6 分层后该路径 404，探针静默测到空页面"
status: "active"
severity: "medium"
created: "2026-11-04T22:59:47+08:00"
last_seen: "2026-11-04T22:59:47+08:00"
hits: 0
verifications: 0
probe_kind: "shell"
probe_cmd: "cd \"$(git rev-parse --show-toplevel)\" && ! test -f extension/subtitle.html && grep -q 'chrome-extension://{EXT}/subtitle.html' .research/scrollback-live-probe.py"
probe_strength: "state"
signature_check: "matched"
tags:
  - "research"
  - "probe"
  - "cdp"
  - "paths"
signatures:
  - "chrome-error://chromewebdata"
  - "Cannot read properties of undefined \\(reading 'sendMessage'\\)"
  - "overlay never appeared"
  - "settings: \\{\\}"
---
## 现象
跑 .research/scrollback-live-probe.py（或 diag-e2e.py、reload-extension.py）时：
- `settings: {}`、`start: {}`（sendMessage 全部返回 undefined）
- 探针打开的 target URL 显示 chrome-extension://<id>/subtitle.html，但 location.href 是 chrome-error://chromewebdata/
- 页面里 typeof chrome.runtime === 'undefined'，evaluate 报 Cannot read properties of undefined (reading 'sendMessage')
- 后续 `overlay never appeared: {"host": false}`，看起来像浮层坏了，实际是扩展页根本没加载

## 根因
origin/master 0.5.6 把平铺目录改成 extension/subtitle/subtitle.html、extension/popup/popup.html；.research 下的探针脚本仍指向旧路径 chrome-extension://<id>/subtitle.html（HTTP 404 → Chrome 显示 chrome-error://chromewebdata）。扩展页面加载失败后 chrome.runtime 不存在，所有 sendMessage 静默返回 undefined，探针把 {} 当作正常设置继续跑。

## 绕法
1) 不要改 .research（项目规范冻结）：复制探针到仓库外，把 `chrome-extension://{EXT}/subtitle.html` 换成 `chrome-extension://{EXT}/subtitle/subtitle.html` 再跑；2) 重载扩展用 `node scripts/services.mjs dev-browser --port 9223`（会重新 loadUnpacked），不要依赖 .research/reload-extension.py；3) 判定探针是否有效：先看 `settings:` 是否含 provider/displayMode，出现 `{}` 一律当探针打空，再查 location.href 是否 chrome-error://。启动采集的可行路径（UIA 找不到工具栏图标时）：`chrome.action.openPopup()` 打开 popup → 点 `#primaryButton`，getMediaStreamId 就会带 activeTab 授权。
