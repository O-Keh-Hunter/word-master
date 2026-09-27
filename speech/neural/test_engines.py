import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import numpy as np
import engines


class EngineTests(unittest.TestCase):
    def test_qwen_loads_customvoice_and_selects_native_speakers(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, 'config.json').write_text('{}')
            model = Mock()
            model.get_supported_speakers.return_value = ['serena', 'aiden']
            model.generate_custom_voice.return_value = ([np.zeros(5)], 24000)
            factory = Mock(return_value=model)
            torch = SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: False), float32='float32', bfloat16='bfloat16')
            modules = {'torch': torch, 'qwen_tts': SimpleNamespace(Qwen3TTSModel=SimpleNamespace(from_pretrained=factory))}
            with patch.dict(sys.modules, modules), patch.dict(os.environ, {'TTS_MODEL_DIR': directory, 'QWEN_DEVICE': 'cpu', 'QWEN_ZH_SPEAKER': 'Serena', 'QWEN_EN_SPEAKER': 'Aiden'}):
                engine = engines.QwenEngine()
                self.assertEqual(factory.call_args.kwargs['dtype'], 'float32')
                for lang, speaker, language in [('en_us', 'Aiden', 'English'), ('zh_cn', 'Serena', 'Chinese')]:
                    engine.generate('test', lang)
                    model.generate_custom_voice.assert_called_with(text='test', language=language, speaker=speaker, instruct='', non_streaming_mode=True)
                with patch.dict(os.environ, {'QWEN_DEVICE': 'auto'}):
                    engines.QwenEngine()
                    self.assertEqual(factory.call_args.kwargs['device_map'], 'cpu')
                with patch.dict(os.environ, {'QWEN_DEVICE': 'cuda:0'}), self.assertRaisesRegex(RuntimeError, 'CUDA'):
                    engines.QwenEngine()
                model.get_supported_speakers.return_value = None
                with self.assertRaisesRegex(RuntimeError, 'CustomVoice'):
                    engines.QwenEngine()

    def test_cosyvoice_uses_each_languages_reference_with_v3_prefix(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'cosyvoice3.yaml').write_text('model')
            env = {'TTS_MODEL_DIR': directory}
            for suffix, transcript in [('ZH', '你好。'), ('EN', 'Hello.')]:
                (root / f'{suffix}.wav').write_bytes(b'reference')
                (root / f'{suffix}.txt').write_text(transcript)
                env[f'COSYVOICE_{suffix}_PROMPT_WAV'] = str(root / f'{suffix}.wav')
                env[f'COSYVOICE_{suffix}_PROMPT_TEXT'] = str(root / f'{suffix}.txt')
            tensor = Mock()
            tensor.detach.return_value.cpu.return_value.numpy.return_value = np.zeros((1, 5))
            model = Mock(sample_rate=24000)
            model.inference_zero_shot.side_effect = lambda *a, **kw: iter([{'tts_speech': tensor}, {'tts_speech': tensor}])
            factory = Mock(return_value=model)
            with patch.dict(sys.modules, {'cosyvoice.cli.cosyvoice': SimpleNamespace(CosyVoice3=factory)}), patch.dict(os.environ, env):
                engine = engines.CosyVoiceEngine()
                for lang, suffix, transcript in [('zh_cn', 'ZH', '你好。'), ('en_us', 'EN', 'Hello.')]:
                    samples, rate = engine.generate('test', lang)
                    self.assertEqual((samples.size, rate), (10, 24000))
                    model.inference_zero_shot.assert_called_with('test', 'You are a helpful assistant.<|endofprompt|>' + transcript, str((root / f'{suffix}.wav').resolve()), stream=False)
                old_identity = engine.identity
                (root / 'EN.wav').write_bytes(b'new reference')
                self.assertNotEqual(engines.CosyVoiceEngine().identity, old_identity)
                (root / 'EN.txt').unlink()
                with self.assertRaisesRegex(RuntimeError, 'Missing'):
                    engines.CosyVoiceEngine()

    def test_invalid_engine_and_missing_model_fail_early(self):
        with patch.dict(os.environ, {'TTS_ENGINE': 'typo'}), self.assertRaisesRegex(RuntimeError, 'TTS_ENGINE'):
            engines.create_engine()
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {'TTS_MODEL_DIR': directory}), self.assertRaisesRegex(RuntimeError, 'download'):
            engines.model_directory('config.json')


if __name__ == '__main__':
    unittest.main()
