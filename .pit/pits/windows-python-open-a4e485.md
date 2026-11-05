---
id: "windows-python-open-a4e485"
title: "Windows 上 Python open(p,'w') 把 \\n 写成 CRLF，让整个文件变成全量 diff"
status: "active"
severity: "medium"
created: "2026-11-05T22:08:49+08:00"
last_seen: "2026-11-05T22:08:49+08:00"
hits: 0
verifications: 0
probe_kind: "shell"
probe_cmd: "cd \"$(git rev-parse --show-toplevel)\" && for f in $(git status --porcelain | awk '{print $2}' | grep -E '\\.(js|md|json|html)$'); do if grep -qU $'\\r' \"$f\" 2>/dev/null; then echo \"CRLF: $f\"; fi; done; true"
probe_strength: "state"
probe_expect: "CRLF:"
tags:
  - "windows"
  - "python"
  - "git"
  - "line-endings"
anchors:
  - ".gitattributes @ f80a265ad02e0479291b641abf2ba24d67ea42e3352bd8b23b374327e61e507e"
  - "package.json @ 844d69d990d0c7c48cc16301e1906c865521e46e6d2a46f106b9de9418af7f4a"
---
## 现象
用 python 脚本改几行后，git diff --stat 显示该文件几百到几千行改动（实测 translation-api.js 3003 行变更、实际 57 行）。git show HEAD:file | python -c 检查显示原本是 LF（\r\n 计数 0）。

## 根因
Windows 上 Python 的 open(path,'w',encoding='utf-8') 默认 newline=None，写 str 时把 '\n' 翻译成 os.linesep（CRLF）。仓库文本是 LF（core.autocrlf=false、.gitattributes 只对 *.cmd 指定 eol=crlf），于是每一行都被视为修改。

## 绕法
写文件时显式 newline='\n'（open(p,'w',encoding='utf-8',newline='\n')），或写二进制后自己处理。已经写坏的：对 git status 里被改的文本文件跑 raw.replace(b'\r\n', b'\n') 还原，再用 git diff --stat 确认行数回到真实改动量；.cmd 文件必须保持 CRLF，别一起转。
