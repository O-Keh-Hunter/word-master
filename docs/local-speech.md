# 本地语音：SenseVoice Small + Kokoro-82M

语音识别和朗读默认使用独立 Python 服务，CPU 推理，无需讯飞密钥。模型下载和运行分离，下载完成后语音处理不访问云端。Node 后端仍提供原有 WebSocket 录音与 `/api/tts` 接口。

## DS423+ / 18 GB 部署选择

目标机器为群晖 DS423+（Celeron J4125），用户确认内存为 **18 GB**。默认方案以完整精度的官方通用 SenseVoice Small（2024-07-17） 和 Kokoro v1.1 中英模型为效果基线，单进程常驻，2 个 CPU 推理线程，推理任务顺序执行，最多接受 4 个进行中或等待中的请求。

18 GB 提供了较充足的内存空间，但不代表实时性能已经达标。J4125 的 CPU 是主要限制；**本项目没有在这台群晖实测延迟和儿童语音准确率**。完整精度也不等同于一定优于量化，需要同一批录音对比。Whisper large-v3-turbo 不作为这台低功耗 CPU 的默认模型。中英文解码器分别初始化，以保留经过验证的规范化配置，因此 ASR 占用高于只加载一个解码器。

- `quality`（默认）：完整精度，模型压缩包约 1.41 GB，解压和运行需要额外空间。
- `compact`（可选）：相同模型系列的 int8 版，压缩包约 310 MB；只在对比准确率、音质和延迟后决定是否切换。
- 两种方案都支持中文、英文及混合语音。SenseVoice 自动识别语言：英文答题关闭 ITN，保留口述词形（例如 `eight` 不应被转成 `8`）；中文答题启用文本规范化，改善本次中文样例的同音词识别。当前未使用标准答案作为识别提示，避免把错误答案强行改对。
- Kokoro 使用 v1.1 中英词典和数字规范化，默认英文音色 0（af_maple）、中文音色 3（zf_001）。可以用 `KOKORO_EN_SPEAKER` / `KOKORO_ZH_SPEAKER` 修改。

## 群晖 Container Manager / Docker Compose

此功能需要构建当前源码，远端原有 `latest` 镜像不包含这些修改。将整个仓库放到 NAS 的项目目录，用 SSH 或 Container Manager 支持的终端执行：

```bash
cp backend/.env.example .env
# 编辑 .env；使用 AI 账号登录时按 antigravity.md 配置管理密码和 OAuth 客户端
docker build -t word-master:local .
```

将 `docker-compose.yml` 中 app 的 `image` 改为 `word-master:local`，然后：

```bash
# 构建语音运行环境
docker compose --profile local-speech build speech
# 首次单独下载及校验模型，写入持久卷；下载失败可重新执行
docker compose --profile local-speech run --rm speech python download_models.py
# 启动应用和本地语音
docker compose --profile local-speech up -d
docker compose --profile local-speech logs -f speech
```

示例 `.env` 的 `LOCAL_SPEECH_URL` 留空：Compose 自动使用 `http://speech:8001`，本机开发自动使用 `http://127.0.0.1:8001`。如果自行设置了本机地址，Docker 部署时请恢复留空或改为 `http://speech:8001`。服务首次启动需要加载模型，待 speech 健康检查通过后使用语音。

模型保存在 `speech-models` 卷，合成音频在 `speech-cache` 卷，均不随容器重启丢失。语音服务没有公网映射端口。模型由 sherpa-onnx 官方仓库的模型 release 下载，下载脚本校验固定 SHA-256；部署时请同时查看模型的许可及使用条件。

如需测试量化版，在 Compose 同目录 `.env` 加 `SPEECH_MODEL_PROFILE=compact`，再次执行模型下载命令并重建 speech 容器。配置和下载必须使用同一个 profile。不会在识别失败时自动使用云服务。

## 本机开发

Python 3.11，Node.js 20+：

```bash
python3 -m venv speech/.venv
speech/.venv/bin/pip install -r speech/requirements.txt
speech/.venv/bin/python speech/download_models.py
cd speech
.venv/bin/uvicorn server:app --host 127.0.0.1 --port 8001 --workers 1
```

后端 `backend/.env`：

```env
STT_PROVIDER=local
TTS_PROVIDER=local
LOCAL_SPEECH_URL=http://127.0.0.1:8001
```

再启动原有前后端开发服务。浏览器麦克风仍要求 HTTPS 或 localhost。

## 运行行为

- 前端按住录音、松手发送 `done`。本地适配器缓存最多 30 秒的 16 kHz、单声道、16 位 PCM，松手后一次识别；等待期间显示「正在识别…」。取消或断线后丢弃结果。
- 识别等待最多 60 秒。这是超时上限，不是预期响应时间；体验是否合格需要 NAS 实测。
- `/api/tts` 本地模式返回 `audio/wav`，云端讯飞模式仍返回 `audio/mpeg`。两个格式都可由现有浏览器播放器播放。
- 朗读按文本、音色和模型版本缓存，默认总量 256 MB，超限清理最久未使用的音频。缓存仅包含合成音频；识别录音不落盘。
- 若 NAS 延迟过高，可在局域网内另一台更强的电脑运行 speech，设置 `LOCAL_SPEECH_URL=http://电脑IP:8001`。仅在可信内网开放端口，并限制访问来源。
- 仍可显式设置 `STT_PROVIDER=xunfei` 或 `tencent`；讯飞朗读用 `TTS_PROVIDER=xunfei`，并配置对应密钥。

## 效果验收

服务启动后可先做真实模型冒烟检查，生成可试听的中英文 WAV、验证缓存，并识别模型包附带的中英文录音：

```bash
speech/.venv/bin/python speech/check_models.py
# Docker / 群晖：样例写入 speech-cache 卷的 listening 子目录
docker compose --profile local-speech exec speech python check_models.py --output /cache/listening
```

这只确认模型链路和音频输出可用，不是准确率测评，也不能把开发电脑的耗时当作群晖的耗时。

不要用模型大小、成功返回文字或合成语音回读的结果代替真实准确率测试。建议用实际使用者的录音各测至少 20 条：孤立英文单词、短语/例句、中文答案、中英混说，并包含易混淆词和安静/家庭噪声环境。

将录音保存为 16 kHz、单声道 PCM16 WAV，准备 JSON 清单：

```json
[
  {"file":"recordings/apple.wav","expected":"apple","lang":"en_us","category":"英文单词"},
  {"file":"recordings/decision.wav","expected":"下定决心","lang":"zh_cn","category":"中文答案"}
]
```

```bash
python3 speech/evaluate.py samples.json --url http://127.0.0.1:8001 --output quality-results.json
```

报告包含实际识别结果、英文词错误数/中文字符错误数、规范化完全匹配率和每条处理时间；录音文件路径相对于清单。用同一批录音分别测试两种 profile，另试听中英朗读是否清晰、重音自然、孤立词发音准确。最终模型选择应以这些结果为准。语音识别不提供专业的发音评分。

本次开发机验证：官方英文、中文各一条样例在上述配置下均与参考文本匹配（忽略标点与大小写）；中英文 WAV 生成、缓存复用及 Node/WebSocket 链路通过。开发机进程常驻约 2.6 GB，英文样例识别约 0.8 秒、中文约 0.6–0.7 秒；这些是开发机结果，**不是 J4125 性能或儿童语音准确率**。初次生成试听音频约 6–7 秒，命中缓存约 0.01 秒。

模型接口测试（无需加载模型）：

```bash
speech/.venv/bin/pip install httpx==0.28.1
cd speech
.venv/bin/python -m unittest discover
```
