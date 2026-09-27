"""Exercise the running models and save listening samples; not an accuracy benchmark."""
import argparse
import json
from pathlib import Path
import time
import urllib.request
import wave

from download_models import ROOT, ASR_NAME
from evaluate import distance, normalize


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:8001")
    parser.add_argument("--output", type=Path, default=Path(__file__).parent / "samples")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    report = {"note": "Smoke test on this host, not NAS latency or children's accuracy", "checks": []}

    def call(endpoint, data=None, content_type="application/json"):
        request = urllib.request.Request(args.url.rstrip("/") + endpoint, data=data, headers={"Content-Type": content_type})
        start = time.perf_counter()
        with urllib.request.urlopen(request, timeout=90) as response:
            result, headers = response.read(), dict(response.headers)
        return result, {key.lower(): value for key, value in headers.items()}, round(time.perf_counter() - start, 3)

    body, _, _ = call("/health")
    report["health"] = json.loads(body)
    if not report["health"].get("ready"):
        raise RuntimeError("Models are not ready")
    for lang, text in [
        ("en_us", "Apple. Beautiful. I am looking for my phone. Don't give up."),
        ("zh_cn", "苹果。美丽。下定决心。我正在找我的手机。不要放弃。"),
    ]:
        data = json.dumps({"text": text, "lang": lang}, ensure_ascii=False).encode()
        audio, headers, seconds = call("/tts", data)
        if audio[:4] != b"RIFF" or audio[8:12] != b"WAVE":
            raise RuntimeError("Invalid WAV output")
        output = args.output / f"kokoro-{lang}.wav"
        output.write_bytes(audio)
        with wave.open(str(output)) as wav:
            duration = wav.getnframes() / wav.getframerate()
        cached, cache_headers, cache_seconds = call("/tts", data)
        if cache_headers.get("x-speech-cache") != "hit" or cached != audio:
            raise RuntimeError("Audio cache is not working")
        report["checks"].append({"type": "tts", "lang": lang, "text": text, "seconds": seconds,
                                 "cache_seconds": cache_seconds, "cache_on_first_call": headers.get("x-speech-cache"),
                                 "audio_seconds": round(duration, 3), "file": str(output)})
        sample = ROOT / ASR_NAME / "test_wavs" / ("en.wav" if lang == "en_us" else "zh.wav")
        with wave.open(str(sample)) as wav:
            if (wav.getnchannels(), wav.getsampwidth(), wav.getframerate()) != (1, 2, 16000):
                raise RuntimeError(f"Unexpected sample format: {sample}")
            pcm = wav.readframes(wav.getnframes())
        result, _, seconds = call(f"/stt?lang={lang}", pcm, "application/octet-stream")
        transcript = json.loads(result)["text"]
        if not transcript:
            raise RuntimeError("Reference speech returned no text")
        reference = "the tribal chieftain called for the boy and presented him with fifty pieces of gold" if lang == "en_us" else "开放时间早上9点至下午5点"
        expected = normalize(reference).split() if lang == "en_us" else list(normalize(reference))
        actual = normalize(transcript).split() if lang == "en_us" else list(normalize(transcript))
        report["checks"].append({"type": "asr", "lang": lang, "seconds": seconds, "transcript": transcript,
                                 "reference": reference, "errors": distance(expected, actual),
                                 "reference_units": len(expected), "metric": "WER" if lang == "en_us" else "CER",
                                 "source": str(sample)})
        print(json.dumps(report["checks"][-2:], ensure_ascii=False), flush=True)
    (args.output / "checks.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(f"Saved results to {args.output}")


if __name__ == "__main__":
    main()
