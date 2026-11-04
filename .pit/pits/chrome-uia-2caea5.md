---
id: "chrome-uia-2caea5"
title: "浮窗「声幕 - 字幕与历史」盖住 Chrome 工具栏，UIA 坐标点击被它吃掉"
status: "active"
severity: "medium"
created: "2026-11-04T05:08:21+08:00"
last_seen: "2026-11-04T05:08:21+08:00"
last_verified: "2026-11-04T05:08:21+08:00"
hits: 0
verifications: 1
probe_kind: "manual"
signature_check: "matched"
reverify: "跑 .research/start-capture-utf8.py：日志应先有 minimized overlay windows: N，随后 popup opened on click 1..3；若浮窗未最小化会停在 popup did not open。"
tags:
  - "automation"
  - "overlay"
  - "uia"
signatures:
  - "foreground ok: True"
---
## 现象
start-capture-utf8.py 确认前台后仍打不开 popup：

foreground ok: True
popup did not open

截屏发现屏幕右侧的「声幕 - 字幕与历史」浮窗正好压在工具栏按钮坐标上。

## 根因
扩展的字幕/历史浮窗是独立置顶窗口，位置与 Chrome 最大化窗口的工具栏右侧重叠。UIA 上报的是 Chrome 按钮的屏幕坐标，该坐标此刻属于浮窗，点击被浮窗接收，Chrome 收不到。

## 绕法
注入点击前 EnumWindows 找标题含「字幕与历史」的窗口并 ShowWindow(hwnd, 6/SW_MINIMIZE)，再点击；收尾别重新打开该浮窗。见 .research/start-capture-utf8.py 与 .research/aligned-sample.py 的 minimize_overlay_windows。
