import asyncio
import io
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import wave

from fastapi.testclient import TestClient
import numpy as np
import server


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {'TTS_CACHE_DIR': self.directory.name, 'TTS_API_KEY': 'test-key', 'TTS_CACHE_MB': '1'})
        self.env.start()
        self.engine = SimpleNamespace(identity=['test-model'], generate=Mock(return_value=(np.zeros(100), 24000)))
        self.factory = patch.object(server, 'create_engine', return_value=self.engine)
        self.factory.start()
        self.client = TestClient(server.app).__enter__()
        self.headers = {'Authorization': 'Bearer test-key'}

    def tearDown(self):
        self.client.__exit__(None, None, None)
        self.factory.stop()
        self.env.stop()
        self.directory.cleanup()

    def test_auth_and_readiness(self):
        self.assertTrue(self.client.get('/health').json()['ready'])
        for headers in [{}, {'Authorization': 'Bearer wrong'}]:
            self.assertEqual(self.client.post('/tts', json={'text': 'apple'}, headers=headers).status_code, 401)
        self.engine.generate.assert_not_called()

    def test_valid_wav_and_cache_are_shared_by_normalized_text(self):
        def call(text):
            return self.client.post('/tts', json={'text': text, 'lang': 'en_us'}, headers=self.headers)
        first, second = call('[apple]'), call('apple')
        self.assertEqual(first.status_code, 200)
        self.assertEqual(first.headers['content-type'], 'audio/wav')
        self.assertEqual(first.headers['x-speech-cache'], 'miss')
        self.assertEqual(second.headers['x-speech-cache'], 'hit')
        self.assertEqual(first.content, second.content)
        with wave.open(io.BytesIO(first.content)) as wav:
            self.assertEqual((wav.getframerate(), wav.getnchannels(), wav.getsampwidth(), wav.getnframes()), (24000, 1, 2, 100))
        self.engine.generate.assert_called_once_with('apple', 'en_us')

    def test_validation_prevents_inference(self):
        for payload in [{'text': ''}, {'text': '[]'}, {'text': ' '}, {'text': 'a' * 501}, {'text': 'a', 'lang': 'fr'}]:
            self.assertIn(self.client.post('/tts', json=payload, headers=self.headers).status_code, [400, 422])
        self.assertEqual(self.client.post('/tts', content=b'a' * 8193, headers=self.headers).status_code, 413)
        self.engine.generate.assert_not_called()

    def test_busy_and_model_errors_are_clear(self):
        server.app.state.pending = 4
        response = self.client.post('/tts', json={'text': 'apple'}, headers=self.headers)
        self.assertEqual(response.status_code, 503)
        server.app.state.pending = 0
        self.engine.generate.side_effect = RuntimeError('private model path')
        response = self.client.post('/tts', json={'text': 'apple'}, headers=self.headers)
        self.assertEqual(response.status_code, 500)
        self.assertNotIn('private', response.text)
        self.assertEqual(server.app.state.pending, 0)


class CacheTests(unittest.TestCase):
    def test_voice_language_and_model_changes_invalidate_cache(self):
        engine = SimpleNamespace(identity=['model', 'voice1'], generate=Mock(return_value=(np.zeros(100), 24000)))
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {'TTS_CACHE_DIR': directory, 'TTS_CACHE_MB': '1'}):
            cache = server.CachedEngine(engine)
            self.assertFalse(cache.synthesize('apple', 'en_us')[1])
            self.assertTrue(cache.synthesize('apple', 'en_us')[1])
            self.assertFalse(cache.synthesize('apple', 'zh_cn')[1])
            engine.identity = ['model', 'voice2']
            self.assertFalse(cache.synthesize('apple', 'en_us')[1])
            engine.identity = ['new-model', 'voice2']
            self.assertFalse(cache.synthesize('apple', 'en_us')[1])
            cache.limit = 300
            cache.synthesize('pear', 'en_us')
            self.assertEqual(len(list(Path(directory).glob('*.wav'))), 1)

    def test_invalid_audio_is_not_cached(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {'TTS_CACHE_DIR': directory}):
            for samples, rate in [(np.empty(0), 24000), (np.array([np.nan]), 24000), (np.zeros(10), 0)]:
                engine = SimpleNamespace(identity=['model'], generate=Mock(return_value=(samples, rate)))
                with self.assertRaises(RuntimeError):
                    server.CachedEngine(engine).synthesize('apple', 'en_us')
            self.assertFalse(list(Path(directory).glob('*')))


class QueueTests(unittest.IsolatedAsyncioTestCase):
    async def test_inference_is_serialized(self):
        import threading
        server.app.state.lock = asyncio.Lock()
        server.app.state.pending = 0
        entered, release = threading.Event(), threading.Event()
        def slow():
            entered.set()
            release.wait(2)
            return 1
        first = asyncio.create_task(server.infer(slow))
        await asyncio.to_thread(entered.wait, 2)
        second_work = Mock(return_value=2)
        second = asyncio.create_task(server.infer(second_work))
        await asyncio.sleep(0)
        first.cancel()
        await asyncio.sleep(0)
        second_work.assert_not_called()
        release.set()
        with self.assertRaises(asyncio.CancelledError):
            await first
        self.assertEqual(await second, 2)
        self.assertEqual(server.app.state.pending, 0)


if __name__ == '__main__':
    unittest.main()
