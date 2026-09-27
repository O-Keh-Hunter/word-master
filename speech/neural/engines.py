"""Model-specific adapters. Run Qwen and CosyVoice in separate Python environments."""
import hashlib
import os
from pathlib import Path

import numpy as np


def model_directory(required_file):
    directory = Path(os.environ["TTS_MODEL_DIR"]).resolve()
    if not (directory / required_file).is_file():
        raise RuntimeError(f"Missing {required_file} in {directory}; download the model before starting")
    return directory


def model_identity(directory):
    # Changing model files or an explicit cache revision invalidates previous audio.
    files = [(str(p.relative_to(directory)), p.stat().st_size, p.stat().st_mtime_ns)
             for p in sorted(directory.rglob('*')) if p.is_file() and '.cache' not in p.parts]
    return [str(directory), files, os.environ.get("TTS_CACHE_REVISION", "1")]


class QwenEngine:
    name = "qwen3"

    def __init__(self):
        import torch
        from qwen_tts import Qwen3TTSModel

        directory = model_directory("config.json")
        device = os.environ.get("QWEN_DEVICE", "auto")
        if device == "auto":
            device = "cuda:0" if torch.cuda.is_available() else "cpu"
        if device.startswith("cuda") and not torch.cuda.is_available():
            raise RuntimeError("Requested CUDA is unavailable; use QWEN_DEVICE=cpu or auto")
        self.model = Qwen3TTSModel.from_pretrained(
            str(directory), device_map=device,
            dtype=torch.bfloat16 if device.startswith("cuda") else torch.float32,
            attn_implementation="sdpa",
        )
        self.voices = {"zh_cn": os.environ.get("QWEN_ZH_SPEAKER", "Serena"),
                       "en_us": os.environ.get("QWEN_EN_SPEAKER", "Aiden")}
        supported = {name.lower() for name in (self.model.get_supported_speakers() or [])}
        if any(voice.lower() not in supported for voice in self.voices.values()):
            raise RuntimeError("Unsupported Qwen speaker; use a CustomVoice model and its supported speakers")
        self.identity = [self.name, model_identity(directory), self.voices, device]

    def generate(self, text, lang):
        wavs, sample_rate = self.model.generate_custom_voice(
            text=text, language="Chinese" if lang == "zh_cn" else "English",
            speaker=self.voices[lang], instruct="", non_streaming_mode=True,
        )
        return np.asarray(wavs[0]).reshape(-1), sample_rate


class CosyVoiceEngine:
    name = "cosyvoice3"

    def __init__(self):
        from cosyvoice.cli.cosyvoice import CosyVoice3

        directory = model_directory("cosyvoice3.yaml")
        self.prompts = {}
        for lang, suffix in [("zh_cn", "ZH"), ("en_us", "EN")]:
            audio = Path(os.environ[f"COSYVOICE_{suffix}_PROMPT_WAV"]).resolve()
            transcript_file = Path(os.environ[f"COSYVOICE_{suffix}_PROMPT_TEXT"]).resolve()
            if not audio.is_file() or not transcript_file.is_file():
                raise RuntimeError(f"Missing CosyVoice {suffix} reference WAV or transcript file")
            transcript = transcript_file.read_text(encoding="utf-8").strip()
            if not transcript or len(transcript) > 2000:
                raise RuntimeError(f"Invalid CosyVoice {suffix} reference transcript")
            self.prompts[lang] = (str(audio), transcript, hashlib.sha256(audio.read_bytes()).hexdigest())
        self.model = CosyVoice3(model_dir=str(directory), load_trt=False, load_vllm=False, fp16=False)
        self.identity = [self.name, model_identity(directory), self.prompts]

    def generate(self, text, lang):
        audio, transcript, _ = self.prompts[lang]
        chunks = []
        total = 0
        # CosyVoice 3 requires this delimiter in the reference transcript.
        prompt = 'You are a helpful assistant.<|endofprompt|>' + transcript
        for chunk in self.model.inference_zero_shot(text, prompt, audio, stream=False):
            samples = chunk['tts_speech'].detach().cpu().numpy().reshape(-1)
            total += samples.size
            if total > self.model.sample_rate * 300:
                raise RuntimeError("CosyVoice audio exceeds five minutes")
            chunks.append(samples)
        return np.concatenate(chunks) if chunks else np.empty(0), self.model.sample_rate


def create_engine():
    kind = os.environ.get("TTS_ENGINE", "qwen3")
    if kind == "qwen3":
        return QwenEngine()
    if kind == "cosyvoice3":
        return CosyVoiceEngine()
    raise RuntimeError("TTS_ENGINE must be qwen3 or cosyvoice3")
