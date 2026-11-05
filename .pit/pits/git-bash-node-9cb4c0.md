---
id: "git-bash-node-9cb4c0"
title: "Git Bash 改写 node 脚本的 /path 参数，页面报 MEDIA_ELEMENT_ERROR: Media load rejected by URL safety check"
status: "active"
severity: "low"
created: "2026-11-05T10:20:43+08:00"
last_seen: "2026-11-05T10:20:43+08:00"
hits: 0
verifications: 0
probe_kind: "shell"
probe_cmd: "grep -q 'quality-samples' .pr-test/probe-pr2.mjs && grep -q 'src=/quality-samples/' .pr-test/probe-pr2.mjs && echo still-relevant"
probe_strength: "state"
reverify: "在 Git Bash 里执行 node -e 'console.log(process.argv[1])' /quality-samples/x.wav，看输出是否被改写为 C:/Program Files/Git/...；若是，说明该环境仍会转换路径。"
tags:
  - "git-bash"
  - "msys"
  - "cdp"
  - "audio"
  - "probe"
anchors:
  - ".pr-test/probe-pr2.mjs"
---
## 现象
node 探针里用 process.argv 拼出 audio.src = "/quality-samples/x.wav"，浏览器控制台/元素状态出现 MEDIA_ELEMENT_ERROR: Media load rejected by URL safety check，audio.error.code=4、readyState=0、networkState=3、duration=null，play() 抛 NotSupportedError: The element has no supported sources。目标标签页 URL 里能看到 src=C%3A%2FProgram%20Files%2FGit%2Fquality-samples%2F...

## 根因
MSYS2/Git Bash 会对以 / 开头的非选项参数做 Windows 路径转换，把 "/quality-samples/x.wav" 变成 "C:/Program Files/Git/quality-samples/x.wav"；脚本再把它 encodeURIComponent 进 URL，浏览器拿到跨 origin 的 file 风格路径，媒体加载被 URL safety check 拒绝。不是服务器缺 Range、不是音频文件格式问题。

## 绕法
脚本只接收裸文件名（"x.wav"），在脚本内自己拼 "/quality-samples/" + name；或在命令前加 MSYS_NO_PATHCONV=1 / MSYS2_ARG_CONV_EXCL="*"；完整 http:// 开头的 URL 参数不会被改写（可直接传整条 URL）。
