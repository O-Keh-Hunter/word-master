"""CPU-only, offline speech service. Start one worker; models stay in memory."""
import asyncio
from contextlib import asynccontextmanager
import hashlib
import io
import json
import logging
import os
from pathlib import Path
import re
import uuid
import wave

import numpy as np
from fastapi import FastAPI, HTTPException, Request, Response
from pydantic import BaseModel, Field
from typing import Literal

from download_models import ROOT, ASR_NAME, TTS_NAME, PROFILE

MAX_PCM_BYTES = 16000 * 2 * 30
CACHE = Path(os.environ.get("SPEECH_CACHE_DIR", Path(__file__).parent / "cache"))
CACHE_BYTES = int(os.environ.get("SPEECH_CACHE_MB", "256")) * 1024 * 1024


class SpeechEngine:
    def __init__(self):
        import sherpa_onnx

        threads = int(os.environ.get("SPEECH_THREADS", "2"))
        asr, tts = ROOT / ASR_NAME, ROOT / TTS_NAME
        asr_model = asr / ("model.onnx" if PROFILE == "quality" else "model.int8.onnx")
        tts_model = tts / ("model.onnx" if PROFILE == "quality" else "model.int8.onnx")
        # Some releases use kokoro.onnx instead of model.onnx.
        if not tts_model.exists():
            tts_model = tts / ("kokoro.onnx" if PROFILE == "quality" else "model.int8.onnx")
        for file in [asr_model, asr / "tokens.txt", tts_model, tts / "voices.bin", tts / "tokens.txt"]:
            if not file.is_file():
                raise RuntimeError(f"Missing {file}. Run python download_models.py first.")
        # Pin the tested runtime. Separate decoder configurations preserve
        # English spelling while allowing Chinese text normalization.
        self.recognizers = {
            lang: sherpa_onnx.OfflineRecognizer.from_sense_voice(
                model=str(asr_model), tokens=str(asr / "tokens.txt"), num_threads=threads,
                provider="cpu", language="auto", use_itn=lang == "zh_cn",
            )
            for lang in ("en_us", "zh_cn")
        }
        config = sherpa_onnx.OfflineTtsConfig(
            model=sherpa_onnx.OfflineTtsModelConfig(
                kokoro=sherpa_onnx.OfflineTtsKokoroModelConfig(
                    model=str(tts_model), voices=str(tts / "voices.bin"), tokens=str(tts / "tokens.txt"),
                    data_dir=str(tts / "espeak-ng-data"),
                    lexicon=f"{tts / 'lexicon-us-en.txt'},{tts / 'lexicon-zh.txt'}",
                ),
                num_threads=threads, provider="cpu",
            ),
            rule_fsts=",".join(str(tts / name) for name in ["phone-zh.fst", "date-zh.fst", "number-zh.fst"]),
            max_num_sentences=1,
        )
        if not config.validate():
            raise RuntimeError("Invalid Kokoro configuration; check the downloaded model files")
        self.tts = sherpa_onnx.OfflineTts(config)
        self.voices = {
            "en_us": int(os.environ.get("KOKORO_EN_SPEAKER", "0")),
            "zh_cn": int(os.environ.get("KOKORO_ZH_SPEAKER", "3")),
        }
        if any(sid < 0 or sid >= self.tts.num_speakers for sid in self.voices.values()):
            raise RuntimeError("Kokoro speaker index is out of range")
        CACHE.mkdir(parents=True, exist_ok=True)

    def recognize(self, pcm: bytes, lang: str = "zh_cn") -> str:
        if not pcm:
            return ""
        samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
        # Silence must not be submitted as a spoken answer.
        if np.max(np.abs(samples)) < 0.0001:
            return ""
        recognizer = self.recognizers[lang]
        stream = recognizer.create_stream()
        stream.accept_waveform(16000, samples)
        recognizer.decode_stream(stream)
        return re.sub(r"<\|[^|]+\|>", "", stream.result.text).strip()

    def synthesize(self, text: str, lang: str) -> tuple[bytes, bool]:
        text = text.replace("[", "").replace("]", "").strip()
        sid = self.voices[lang]
        identity = json.dumps([TTS_NAME, sid, 1.0, text], ensure_ascii=False)
        filename = CACHE / f"{hashlib.sha256(identity.encode()).hexdigest()}.wav"
        if filename.is_file():
            filename.touch()
            return filename.read_bytes(), True
        audio = self.tts.generate(text, sid=sid, speed=1.0)
        samples = np.asarray(audio.samples)
        if samples.size == 0 or not np.all(np.isfinite(samples)):
            raise RuntimeError("Kokoro returned empty or invalid audio")
        output = io.BytesIO()
        with wave.open(output, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(audio.sample_rate)
            wav.writeframes((np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes())
        data = output.getvalue()
        if CACHE_BYTES > 0 and len(data) <= CACHE_BYTES:
            files = sorted(CACHE.glob("*.wav"), key=lambda f: f.stat().st_mtime)
            size = sum(f.stat().st_size for f in files)
            for old in files:
                if size + len(data) <= CACHE_BYTES:
                    break
                size -= old.stat().st_size
                old.unlink()
            temporary = filename.with_suffix(f".{uuid.uuid4()}.tmp")
            try:
                temporary.write_bytes(data)
                temporary.replace(filename)
            finally:
                temporary.unlink(missing_ok=True)
        return data, False


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.engine = await asyncio.to_thread(SpeechEngine)
    yield
    del app.state.engine


app = FastAPI(lifespan=lifespan)
inference_lock = asyncio.Lock()
pending = 0


async def infer(operation, *args):
    global pending
    if pending >= 4:
        raise HTTPException(503, "Speech service busy; retry shortly")
    pending += 1
    try:
        async with inference_lock:
            # The native worker cannot be interrupted. Shield it so cancellation
            # cannot release the lock while native inference still runs.
            task = asyncio.create_task(asyncio.to_thread(operation, *args))
            try:
                return await asyncio.shield(task)
            except asyncio.CancelledError:
                await task
                raise
    finally:
        pending -= 1


@app.get("/health")
def health():
    return {"ready": hasattr(app.state, "engine"), "asr": "SenseVoice Small", "tts": "Kokoro-82M v1.1",
            "asr_model": ASR_NAME, "tts_model": TTS_NAME, "profile": PROFILE}


@app.post("/stt")
async def stt(request: Request, lang: Literal["zh_cn", "en_us"] = "zh_cn"):
    # Spoken language is auto-detected; UI language selects text normalization.
    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > MAX_PCM_BYTES:
            raise HTTPException(413, "Recording exceeds 30 seconds")
        body.extend(chunk)
    if len(body) % 2:
        raise HTTPException(400, "Expected PCM16 little-endian, mono, 16000 Hz")
    try:
        return {"text": await infer(app.state.engine.recognize, bytes(body), lang)}
    except HTTPException:
        raise
    except Exception:
        logging.exception("Local recognition failed")
        raise HTTPException(500, "Local recognition failed")


class SynthesisRequest(BaseModel):
    text: str = Field(min_length=1, max_length=500)
    lang: Literal["zh_cn", "en_us"] = "en_us"


@app.post("/tts")
async def tts(body: SynthesisRequest):
    if not body.text.replace("[", "").replace("]", "").strip():
        raise HTTPException(400, "Text is empty")
    try:
        audio, cached = await infer(app.state.engine.synthesize, body.text, body.lang)
        return Response(audio, media_type="audio/wav", headers={"X-Speech-Cache": "hit" if cached else "miss"})
    except HTTPException:
        raise
    except Exception:
        logging.exception("Local synthesis failed")
        raise HTTPException(500, "Local synthesis failed")
