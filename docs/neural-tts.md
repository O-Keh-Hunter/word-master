# Qwen3-TTS 与 CosyVoice 3

项目支持 `TTS_PROVIDER=qwen3` 和 `TTS_PROVIDER=cosyvoice3`。现有朗读按钮、中文提示、录音识别接口不变，后端向指定模型服务发送文本并返回 WAV。当前讯飞配置无需修改，等模型服务通过试听后再切换。

两种模型分别使用独立 Python 环境、进程、端口和缓存；无需同时启动。推荐在 Linux NVIDIA GPU 电脑上运行，群晖 DS423+ 通过局域网调用。18 GB 内存并不意味着 NAS 的 CPU 能实时合成；本文没有承诺 NAS 延迟或显存下限。模型服务目前完成契约与模拟 SDK 测试，真实权重加载、CUDA 安装与朗读质量仍须在目标机器验收。

## 1. Qwen3-TTS 1.7B CustomVoice

默认使用中文 Serena、英文 Aiden，均为官方预设音色。可用 `QWEN_ZH_SPEAKER` / `QWEN_EN_SPEAKER` 改为对应模型支持的音色。不需要参考录音。

以下命令从本仓库根目录运行，需要 Python 3.10+、系统 `sox`、`libsndfile1`，以及与 PyTorch 匹配的 NVIDIA 驱动。先按 [PyTorch 官方安装选择器](https://pytorch.org/get-started/locally/)在新环境安装匹配的 `torch` 和 `torchaudio`，再安装其余依赖；不要复用现有 `speech/.venv`。

```bash
python3.11 -m venv speech/.venv-qwen
source speech/.venv-qwen/bin/activate
# 在此环境按 PyTorch 官方说明安装 torch 与 torchaudio
pip install -r speech/neural/requirements-qwen.txt
python -c "from huggingface_hub import snapshot_download; snapshot_download('Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice', local_dir='speech/models/qwen3-customvoice')"
export TTS_ENGINE=qwen3
export TTS_MODEL_DIR="$PWD/speech/models/qwen3-customvoice"
export TTS_CACHE_DIR="$PWD/speech/cache/qwen3"
export QWEN_DEVICE=cuda:0
export TTS_API_KEY='替换成你自行设置的服务密钥'
uvicorn server:app --app-dir speech/neural --host 0.0.0.0 --port 8002 --workers 1
```

使用 SDPA，不强制安装 FlashAttention。不设置 `QWEN_DEVICE` 时自动选择 CUDA（若可用）或 CPU；上面的示例显式选择了 CUDA，可改为 `cpu`。其他设备后端未验证。使用本地模型目录加载；模型首次下载需要联网。不要换成 Base 或 VoiceDesign 权重，它们的生成接口不同。

## 2. CosyVoice 3

使用 `FunAudioLLM/Fun-CosyVoice3-0.5B-2512` 和官方 `CosyVoice3.inference_zero_shot` 接口。中英文分别配置参考 WAV 及其逐字转录文本文件；建议使用相应语言、干净、单人、无背景音乐的短录音。参考声音影响最终口音与音色。服务启动时检查两组配置，缺失会明确失败。

在另一个终端、同一仓库根目录操作。官方依赖包含 CUDA 加速库、编译依赖；按[官方安装说明](https://github.com/FunAudioLLM/CosyVoice)准备 Linux、Python 3.10、系统音频库及匹配驱动。完整安装体积较大，当前接入不启用 TensorRT、vLLM 或半精度。

```bash
mkdir -p speech/vendor
git clone https://github.com/FunAudioLLM/CosyVoice.git speech/vendor/CosyVoice
git -C speech/vendor/CosyVoice checkout 074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc
git -C speech/vendor/CosyVoice submodule update --init --recursive
python3.10 -m venv speech/.venv-cosy
source speech/.venv-cosy/bin/activate
pip install -r speech/neural/requirements-cosyvoice.txt
python -c "from modelscope import snapshot_download; snapshot_download('FunAudioLLM/Fun-CosyVoice3-0.5B-2512', local_dir='speech/models/cosyvoice3')"
export PYTHONPATH="$PWD/speech/vendor/CosyVoice:$PWD/speech/vendor/CosyVoice/third_party/Matcha-TTS"
export TTS_ENGINE=cosyvoice3
export TTS_MODEL_DIR="$PWD/speech/models/cosyvoice3"
export TTS_CACHE_DIR="$PWD/speech/cache/cosyvoice3"
export COSYVOICE_ZH_PROMPT_WAV="$PWD/speech/models/references/zh.wav"
export COSYVOICE_ZH_PROMPT_TEXT="$PWD/speech/models/references/zh.txt"
export COSYVOICE_EN_PROMPT_WAV="$PWD/speech/models/references/en.wav"
export COSYVOICE_EN_PROMPT_TEXT="$PWD/speech/models/references/en.txt"
export TTS_API_KEY='替换成你自行设置的服务密钥'
uvicorn server:app --app-dir speech/neural --host 0.0.0.0 --port 8003 --workers 1
```

先自行准备上述四个参考文件。`.txt` 只写录音实际说出的文字，服务自动添加 CosyVoice 3 要求的提示前缀。单词很短时，参考句长短也可能影响效果，须单独试听单词与完整例句。

## 3. 不使用 CUDA：CPU 安装

两种模型均可选择 CPU，CUDA 不是必需条件。建议在 Linux x86_64 的独立环境中尝试；在群晖 Container Manager 中需自行准备含 Python 的 Linux 容器，以下不是可直接在 DSM shell 执行的安装命令。J4125 的推理速度及所用 PyTorch/ONNX 二进制与该 CPU 指令集的兼容性尚未实测；不要把内存够用等同于可以流畅朗读。

Qwen 环境中，将第 1 节 PyTorch 安装步骤替换为：

```bash
pip install torch==2.6.0 torchaudio==2.6.0 --index-url https://download.pytorch.org/whl/cpu
pip install -r speech/neural/requirements-qwen.txt
export QWEN_DEVICE=cpu
export OMP_NUM_THREADS=2
export MKL_NUM_THREADS=2
```

CosyVoice 环境中，将第 2 节依赖安装步骤替换为下述命令（源码、参考音频、模型下载及启动步骤相同）：

```bash
pip install torch==2.3.1 torchaudio==2.3.1 --index-url https://download.pytorch.org/whl/cpu
pip install -r speech/neural/requirements-cosyvoice-cpu.txt
export CUDA_VISIBLE_DEVICES=''
export OMP_NUM_THREADS=2
export MKL_NUM_THREADS=2
```

CPU 依赖去掉可选 DeepSpeed、TensorRT，并使用 CPU ONNX Runtime。服务不会启用这些可选加速接口。CPU 模式尚未用真实权重验收，首次运行仍可能需要排查上游依赖兼容性。低性能机器适合预先请求词库文本，将结果写入缓存；再次播放使用缓存，不必重新合成。超出交互超时的长文本应分成短句。

## 4. 验收并切换项目

模型加载完成后 `/health` 返回 `ready: true`，加载失败则进程退出。模型服务端口只应在可信局域网访问，跨不可信网络应使用 HTTPS。默认可不设 `TTS_API_KEY`；设置后 `/tts` 必须携带对应 Bearer 密钥。

```bash
curl http://127.0.0.1:8002/health
curl --fail-with-body http://127.0.0.1:8002/tts \
  -H "Authorization: Bearer $TTS_API_KEY" -H 'Content-Type: application/json' \
  -d '{"text":"Apple. Beautiful. I am looking for my phone. Do not give up.","lang":"en_us"}' \
  --output speech/samples/qwen3-en.wav
curl --fail-with-body http://127.0.0.1:8002/tts \
  -H "Authorization: Bearer $TTS_API_KEY" -H 'Content-Type: application/json' \
  -d '{"text":"苹果。美丽。我正在找我的手机。不要放弃。","lang":"zh_cn"}' \
  --output speech/samples/qwen3-zh.wav
```

先执行 `mkdir -p speech/samples`；CosyVoice 测试将端口换成 `8003`，输出文件名换成 `cosyvoice3-*.wav`。重复同一请求时 `X-Speech-Cache: hit` 表示直接读取缓存。检查逐字一致性、单词重音、句末是否完整、中文多音字和首次/缓存耗时，不要仅判断是否返回 200。

在 Node 本地开发的 `backend/.env` 或群晖 Compose 同目录 `.env` 设置：

```dotenv
TTS_PROVIDER=qwen3
QWEN3_TTS_URL=http://192.168.1.100:8002
QWEN3_TTS_API_KEY=与Qwen服务的TTS_API_KEY一致
COSYVOICE3_TTS_URL=http://192.168.1.100:8003
COSYVOICE3_TTS_API_KEY=与CosyVoice服务的TTS_API_KEY一致
NEURAL_TTS_TIMEOUT_SECONDS=180
```

IP 换成模型电脑地址。选 CosyVoice 时只需改为 `TTS_PROVIDER=cosyvoice3`。本机开发默认端口分别为 8002/8003；Docker 中的 `127.0.0.1` 是 app 容器自身，必须填写可访问的地址。更新源码并构建自己的应用镜像后重建 app 容器，例如 `docker compose --profile local-speech up -d --force-recreate app`。本机开发重启后端。

请求最长等待默认 180 秒，可配 1–600 秒；反向代理也需允许相应的请求时长。切换失败不会自动使用别的模型。两种服务最多容纳 4 个执行/排队请求，串行推理，必须使用单 worker。取消请求无法立刻停止底层推理，但不会让多个推理同时占用模型。

缓存默认上限 512 MB，可通过 `TTS_CACHE_MB` 调整；模型文件信息、语言、音色或参考音频/文本变化会生成新的缓存键。替换模型/参考文件后重启服务；需要强制清除旧效果时改变 `TTS_CACHE_REVISION`。权重、参考录音、音频缓存、依赖环境均被 Git 和 Docker 构建上下文排除。

## 测试

无需模型权重的契约、缓存及适配器测试：

```bash
pip install -r speech/neural/requirements-server.txt httpx==0.28.1
cd speech/neural
python -m unittest discover
```

这些测试不能替代真实模型音质和 GPU 性能验收。上游依据：[Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS)、[CosyVoice 3 示例](https://github.com/FunAudioLLM/CosyVoice/blob/074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc/example.py)。
