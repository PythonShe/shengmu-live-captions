---
id: "dpi-unaware-python-317843"
title: "DPI-unaware 的 python 用 UIA 坐标调 SetCursorPos，点击整体偏移落空"
status: "active"
severity: "medium"
created: "2026-11-04T05:08:21+08:00"
last_seen: "2026-11-04T05:08:21+08:00"
last_verified: "2026-11-04T05:08:21+08:00"
hits: 0
verifications: 1
probe_kind: "manual"
signature_check: "matched"
reverify: "跑 ./.research/wlk-venv/Scripts/python.exe -c \"import ctypes; print(ctypes.windll.user32.GetSystemMetrics(0))\"：未设 DPI 感知时打印 1463（坑仍在），设过则 2560。真实点击验证：.research/start-capture-utf8.py 应能打开 popup。"
tags:
  - "windows"
  - "uia"
  - "dpi"
  - "automation"
signatures:
  - "toolbar click missed"
  - "popup did not open \\(shortcut not handled\\?\\)"
---
## 现象
start-capture.py 按 UIA 给出的按钮坐标点击，输出：

toolbar click missed; falling back to the keyboard shortcut
popup did not open (shortcut not handled?)

GetSystemMetrics 报 1463x823，实际屏幕 2560x1440；截屏可见点击落到窗口外。

## 根因
PowerShell/UIA 进程按物理像素上报 BoundingRectangle，而 python 进程默认 DPI-unaware：SetCursorPos 传入的坐标被系统按显示器缩放因子（本机 1.66x）再放大，(1455,111) 实际落到约 (2410,184)。同一进程里 GetSystemMetrics 也返回虚拟化后的 1463x823，掩盖差异。

## 绕法
注入鼠标前声明 per-monitor DPI 感知：ctypes.windll.shcore.SetProcessDpiAwareness(2)，失败回落 user32.SetProcessDPIAware()；此后坐标按物理像素理解，与 UIA 返回值同坐标系。
