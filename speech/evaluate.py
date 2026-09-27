"""Evaluate real recordings against reference answers, without downloading models.

Manifest: JSON array of {"file": "recordings/apple.wav", "expected": "apple",
"lang": "en_us", "category": "isolated-word"}. Paths are relative to manifest.
Input WAV must be PCM16 mono, 16 kHz (the same format as browser recordings).
"""
import argparse
import json
from pathlib import Path
import re
import time
import unicodedata
import urllib.request
import wave


def normalize(text):
    return "".join(c for c in text.lower() if not unicodedata.category(c).startswith("P")).strip()


def distance(reference, hypothesis):
    previous = list(range(len(hypothesis) + 1))
    for i, left in enumerate(reference, 1):
        current = [i]
        for j, right in enumerate(hypothesis, 1):
            current.append(min(current[-1] + 1, previous[j] + 1, previous[j - 1] + (left != right)))
        previous = current
    return previous[-1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--url", default="http://127.0.0.1:8001")
    parser.add_argument("--output", type=Path, default=Path("evaluation.json"))
    args = parser.parse_args()
    results = []
    for entry in json.loads(args.manifest.read_text()):
        with wave.open(str(args.manifest.parent / entry["file"]), "rb") as wav:
            if (wav.getnchannels(), wav.getsampwidth(), wav.getframerate()) != (1, 2, 16000):
                raise ValueError(f"Expected mono PCM16 16 kHz WAV: {entry['file']}")
            pcm = wav.readframes(wav.getnframes())
        request = urllib.request.Request(
            args.url.rstrip("/") + "/stt?lang=" + entry["lang"], data=pcm,
            headers={"Content-Type": "application/octet-stream"},
        )
        start = time.perf_counter()
        with urllib.request.urlopen(request, timeout=90) as response:
            actual = json.load(response)["text"]
        seconds = time.perf_counter() - start
        reference, hypothesis = normalize(entry["expected"]), normalize(actual)
        english = entry["lang"] == "en_us"
        left = reference.split() if english else list(re.sub(r"\s", "", reference))
        right = hypothesis.split() if english else list(re.sub(r"\s", "", hypothesis))
        results.append({
            **entry, "actual": actual, "seconds": round(seconds, 3), "exact": left == right,
            "metric": "WER" if english else "CER", "errors": distance(left, right), "reference_units": len(left),
        })
        print(json.dumps(results[-1], ensure_ascii=False), flush=True)
    report = {"results": results, "summary": {}}
    for category in sorted({item.get("category", "general") for item in results}):
        group = [item for item in results if item.get("category", "general") == category]
        report["summary"][category] = {
            "samples": len(group), "exact_rate": sum(item["exact"] for item in group) / len(group),
            "mean_seconds": sum(item["seconds"] for item in group) / len(group),
            "max_seconds": max(item["seconds"] for item in group),
        }
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(f"Report: {args.output}")


if __name__ == "__main__":
    main()
