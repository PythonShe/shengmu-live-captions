# 固定测试音频（探针输入）

这些是端到端验收用的固定英文样本，入库是为了让没有本地 `.research/` 的机器（CI、另一台电脑）能跑同一套探针。

- 全部为 **16 kHz、单声道、120.0 秒** WAV，直接从对应直播的完整 webm 用 `silencedetect` 选出语音最密的 2 分钟切片。
- 文件名 = `<视频 ID>-<切片起点>-<切片终点>`，`-poe-` 表示该段以《流放之路》术语为主，是可用的术语库回归素材。
- `*.en.vtt` 为人工修正后的英文字幕，`*.en-orig.vtt` 为原始自动字幕，`*-silence.txt` 是 `ffmpeg silencedetect` 的输出（用于核对静音位置）。
- 完整 webm（199 MB）不入库，需要时从原视频重新切；切片参数见 `paseo/05-ui-fixes-0.4.1.md`。

## 用法

探针（`.research/*.py`，属冻结的旧线资产，不入库）默认从本地播放器 `127.0.0.1:8783/quality-samples/<文件名>` 取音频。把 `8783` 静态服务器的根目录指向本目录即可；探针里的 `SAMPLE` 常量不用改。

```sh
# 例：起一个只读静态服务器（在仓库根执行）
npx --yes http-server test-assets -p 8783 -s
# 浏览器打开（探针会自己找这个地址的标签页）
# http://127.0.0.1:8783/quality-samples/GHEBkhT1K7A-05m41-07m41.wav
```

样本优先级：`*-poe-*.wav` 用于术语与缺译验收，`GHEBkhT1K7A-05m41-07m41.wav` 用于浮层/回看探针（`rebound-probe.py`、`scrollback-live-probe.py`），其余为对照。

验收口径（缺译、`deliveredRatio`、延迟）见 `paseo/03-verification.md`；不要用在线的、含随机广告的 YouTube 直播做转写验收。
