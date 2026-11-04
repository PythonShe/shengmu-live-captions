---
id: "dev-395f5a"
title: "改完扩展代码后 dev 浏览器仍跑旧模块图，端到端静默验证的是上一个构建"
status: "active"
severity: "high"
created: "2026-11-04T09:07:56+08:00"
last_seen: "2026-11-04T09:07:56+08:00"
hits: 0
verifications: 0
probe_kind: "shell"
probe_cmd: "node -e \"const run=async()=>{const l=await (await fetch('http://127.0.0.1:9223/json/list')).json();const sw=l.find(x=>x.type==='service_worker'&&(x.url||'').includes('chrome-extension://'));if(!sw){console.log('no-sw');process.exit(1);}const ws=new WebSocket(sw.webSocketDebuggerUrl);let id=null;ws.addEventListener('message',(e)=>{const m=JSON.parse(e.data);if(m.method==='Debugger.scriptParsed'&&(m.params.url||'').endsWith('/lib/caption-utils.js'))id=m.params.scriptId;if(m.id===2&&m.result&&m.result.scriptSource!==undefined){const fresh=m.result.scriptSource.includes('joinSources');console.log(fresh?'fresh':'stale');process.exit(fresh?1:0);}});ws.addEventListener('open',()=>{ws.send(JSON.stringify({id:1,method:'Debugger.enable'}));setTimeout(()=>{if(!id){console.log('no-script');process.exit(2);}ws.send(JSON.stringify({id:2,method:'Debugger.getScriptSource',params:{scriptId:id}}));},800);});};run();\""
probe_strength: "repro"
probe_expect: "stale"
signature_check: "matched"
reverify: "重启 dev-browser 后跑上面的 probe：输出 fresh 并 exit 1 说明缓存问题已不复现；若仍输 stale，说明清理步骤没做完（还有 Chrome 进程占用 profile，或删的是另一个 profile 目录）。"
tags:
  - "chrome"
  - "extension"
  - "cdp"
  - "e2e"
  - "cache"
signatures:
  - "hasJoinSources: false"
  - "\"open\": true"
  - "SOURCE_LEN 25408"
---
## 现象
磁盘上的 extension/lib/*.js 已改成新版，chrome.runtime.getURL() fetch 回来的也是新版，但运行时行为仍是旧逻辑：行对象带着源码里早已删除的字段（例如合并判据重写后仍出现 "open": true），单元测试全绿、smoke 全绿，端到端结论却和新代码无关。CDP 连 service worker 读已加载模块源码可见 SOURCE_LEN/hasJoinSources 与磁盘不一致（实测 25408 vs 27552 字节，hasJoinSources: false）。

## 根因
Chrome 在 profile 里缓存了扩展 service worker 的模块图/代码缓存：仅用 CDP Extensions.loadUnpacked 重新注册或重启浏览器，不保证 lib/*.js 重新解析。chrome-profile/Default/Service Worker 与 Code Cache 保留旧字节码，SW 按缓存加载，而 fetch(chrome.runtime.getURL(...)) 走磁盘，两条路径不一致，于是「读到的代码是新的、跑的代码是旧的」。

## 绕法
1) 关闭以 remote-debugging-port=9223 启动的 Chrome；2) 删除 <profile>/Default/Service Worker 与 <profile>/Default/Code Cache（纯缓存，可再生）；3) 重启 dev-browser；4) 用 CDP 核对：连 service_worker target → Debugger.enable → 收 Debugger.scriptParsed 中 caption-utils.js 的 scriptId → Debugger.getScriptSource，确认含 joinSources 且不再含 open:\s*needsCompletion。任何「改了扩展代码后的端到端」都必须先过这一步，否则结论作废。
