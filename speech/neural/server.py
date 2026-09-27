"""One model per process, shared WAV contract, bounded queue and disk cache."""
import asyncio
from contextlib import asynccontextmanager
import hashlib
import hmac
import io
import json
import logging
import os
from pathlib import Path
from typing import Literal
import uuid
import wave

from fastapi import FastAPI, HTTPException, Request, Response
import numpy as np
from pydantic import BaseModel, Field

from engines import create_engine


class CachedEngine:
    def __init__(self, engine):
        self.engine = engine
        self.directory = Path(os.environ.get("TTS_CACHE_DIR", "/cache"))
        self.limit = int(os.environ.get("TTS_CACHE_MB", "512")) * 1024 * 1024
        self.directory.mkdir(parents=True, exist_ok=True)

    def synthesize(self, text, lang):
        identity = json.dumps([self.engine.identity, text, lang], ensure_ascii=False, sort_keys=True)
        file = self.directory / (hashlib.sha256(identity.encode()).hexdigest() + '.wav')
        if self.limit > 0 and file.is_file():
            file.touch()
            return file.read_bytes(), True
        samples, rate = self.engine.generate(text, lang)
        samples = np.asarray(samples).reshape(-1)
        if not 8000 <= rate <= 96000 or not 0 < samples.size <= rate * 300 or not np.all(np.isfinite(samples)):
            raise RuntimeError("Model returned invalid or oversized audio")
        output = io.BytesIO()
        with wave.open(output, 'wb') as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(rate)
            wav.writeframes((np.clip(samples, -1, 1) * 32767).astype('<i2').tobytes())
        data = output.getvalue()
        if 0 < len(data) <= self.limit:
            files = sorted(self.directory.glob('*.wav'), key=lambda p: p.stat().st_mtime)
            size = sum(p.stat().st_size for p in files)
            for old in files:
                if size + len(data) <= self.limit:
                    break
                size -= old.stat().st_size
                old.unlink()
            temporary = file.with_suffix(f'.{uuid.uuid4()}.tmp')
            try:
                temporary.write_bytes(data)
                temporary.replace(file)
            finally:
                temporary.unlink(missing_ok=True)
        return data, False


@asynccontextmanager
async def lifespan(app):
    app.state.lock = asyncio.Lock()
    app.state.pending = 0
    app.state.engine = CachedEngine(await asyncio.to_thread(create_engine))
    yield
    del app.state.engine


app = FastAPI(lifespan=lifespan)


@app.middleware('http')
async def access_control(request: Request, call_next):
    if request.url.path != '/health':
        key = os.environ.get('TTS_API_KEY', '')
        if key and not hmac.compare_digest(request.headers.get('authorization', '').encode(), f'Bearer {key}'.encode()):
            return Response(status_code=401)
        # Bound the JSON body before Pydantic parses it, including chunked input.
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > 8192:
                return Response(status_code=413)
        # Starlette's middleware replays a cached body to the downstream parser.
        request._body = bytes(body)
    return await call_next(request)


@app.get('/health')
def health():
    return {'ready': hasattr(app.state, 'engine'), 'engine': os.environ.get('TTS_ENGINE', 'qwen3')}


class SynthesisRequest(BaseModel):
    text: str = Field(min_length=1, max_length=500)
    lang: Literal['zh_cn', 'en_us'] = 'en_us'


async def infer(operation, *args):
    if app.state.pending >= 4:
        raise HTTPException(503, 'Model busy; retry later')
    app.state.pending += 1
    try:
        async with app.state.lock:
            task = asyncio.create_task(asyncio.to_thread(operation, *args))
            try:
                return await asyncio.shield(task)
            except asyncio.CancelledError:
                # Native inference cannot be interrupted; retain lock until it ends.
                await task
                raise
    finally:
        app.state.pending -= 1


@app.post('/tts')
async def tts(body: SynthesisRequest):
    text = body.text.replace('[', '').replace(']', '').strip()
    if not text:
        raise HTTPException(400, 'Text is empty')
    try:
        audio, cached = await infer(app.state.engine.synthesize, text, body.lang)
        return Response(audio, media_type='audio/wav', headers={'X-Speech-Cache': 'hit' if cached else 'miss'})
    except HTTPException:
        raise
    except Exception:
        logging.exception('Neural synthesis failed')
        raise HTTPException(500, 'Neural synthesis failed; check worker logs')
