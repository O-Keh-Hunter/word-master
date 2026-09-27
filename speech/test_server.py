"""Contract tests require no models; real model evaluation is in evaluate.py."""
import asyncio
import io
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch
import wave

from fastapi.testclient import TestClient
import numpy as np
import server


class SpeechTests(unittest.TestCase):
    def setUp(self):
        self.engine = Mock()
        self.engine.recognize.return_value = "apple"
        self.engine.synthesize.return_value = (b"RIFF0000WAVEtest", False)
        self.factory = patch.object(server, "SpeechEngine", return_value=self.engine)
        self.factory.start()
        server.inference_lock = asyncio.Lock()
        self.client = TestClient(server.app).__enter__()

    def tearDown(self):
        self.client.__exit__(None, None, None)
        self.factory.stop()

    def test_pcm_and_health(self):
        self.assertTrue(self.client.get("/health").json()["ready"])
        self.assertEqual(self.client.post("/stt?lang=en_us", content=b"\x00\x01").json(), {"text": "apple"})
        self.engine.recognize.assert_called_once_with(b"\x00\x01", "en_us")

    def test_bad_audio_and_language(self):
        self.assertEqual(self.client.post("/stt", content=b"\x00").status_code, 400)
        self.assertEqual(self.client.post("/stt", content=bytes(server.MAX_PCM_BYTES + 2)).status_code, 413)
        self.assertEqual(self.client.post("/stt?lang=invalid", content=b"").status_code, 422)
        self.engine.recognize.assert_not_called()

    def test_wav_and_cache_header(self):
        response = self.client.post("/tts", json={"text": "你好", "lang": "zh_cn"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["content-type"], "audio/wav")
        self.assertEqual(response.headers["x-speech-cache"], "miss")

    def test_invalid_text(self):
        for text in ["", " ", "[]", "a" * 501]:
            self.assertIn(self.client.post("/tts", json={"text": text}).status_code, [400, 422])
        self.engine.synthesize.assert_not_called()


class CacheTests(unittest.TestCase):
    def test_audio_is_cached_and_evicted_with_a_size_limit(self):
        engine = server.SpeechEngine.__new__(server.SpeechEngine)
        engine.voices = {"en_us": 0, "zh_cn": 3}
        engine.tts = Mock()
        engine.tts.generate.return_value = SimpleNamespace(samples=np.zeros(100), sample_rate=24000)
        with tempfile.TemporaryDirectory() as directory, patch.object(server, "CACHE", Path(directory)), patch.object(server, "CACHE_BYTES", 300):
            data, hit = engine.synthesize("[apple]", "en_us")
            self.assertFalse(hit)
            with wave.open(io.BytesIO(data)) as wav:
                self.assertEqual(wav.getframerate(), 24000)
                self.assertEqual(wav.getnframes(), 100)
            self.assertTrue(engine.synthesize("apple", "en_us")[1])
            engine.tts.generate.assert_called_once_with("apple", sid=0, speed=1.0)
            engine.synthesize("pear", "en_us")
            self.assertEqual(len(list(Path(directory).glob("*.wav"))), 1)
            self.assertFalse(engine.synthesize("apple", "en_us")[1])

    def test_silence_does_not_produce_a_model_hallucination(self):
        engine = server.SpeechEngine.__new__(server.SpeechEngine)
        engine.recognizers = {"zh_cn": Mock(), "en_us": Mock()}
        self.assertEqual(engine.recognize(bytes(32000)), "")
        engine.recognizers["zh_cn"].create_stream.assert_not_called()

    def test_text_normalization_follows_answer_language(self):
        engine = server.SpeechEngine.__new__(server.SpeechEngine)
        engine.recognizers = {"zh_cn": Mock(), "en_us": Mock()}
        stream = engine.recognizers["en_us"].create_stream.return_value
        stream.result.text = "<|en|><|Speech|>eight"
        pcm = np.full(1600, 1000, dtype="<i2").tobytes()
        self.assertEqual(engine.recognize(pcm, "en_us"), "eight")
        engine.recognizers["en_us"].decode_stream.assert_called_once_with(stream)
        engine.recognizers["zh_cn"].decode_stream.assert_not_called()
        engine.recognizers["zh_cn"].create_stream.return_value.result.text = "八"
        engine.recognize(pcm, "zh_cn")
        engine.recognizers["zh_cn"].decode_stream.assert_called_once()


if __name__ == "__main__":
    unittest.main()
