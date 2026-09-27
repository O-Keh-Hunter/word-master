"""Download pinned CPU models. Run once; serving never downloads anything."""
import hashlib
import os
from pathlib import Path
import shutil
import tarfile
import tempfile
import urllib.request


def fetch_archive(url: str, archive: Path, digest: str):
    """Keep partial downloads across restarts on slow NAS connections."""
    def file_digest():
        checksum = hashlib.sha256()
        with archive.open("rb") as downloaded:
            while chunk := downloaded.read(1024 * 1024):
                checksum.update(chunk)
        return checksum.hexdigest()
    if archive.exists() and file_digest() == digest:
        return
    offset = archive.stat().st_size if archive.exists() else 0
    headers = {"Range": f"bytes={offset}-"} if offset else {}
    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request, timeout=60) as response:
        resumed = offset > 0 and response.status == 206
        if resumed and not (response.headers.get("Content-Range") or "").startswith(f"bytes {offset}-"):
            raise RuntimeError("Server returned an unexpected download range")
        with archive.open("ab" if resumed else "wb") as output:
            while chunk := response.read(1024 * 1024):
                output.write(chunk)
    if file_digest() != digest:
        archive.unlink()
        raise RuntimeError("Model checksum mismatch; download again")

ROOT = Path(os.environ.get("SPEECH_MODEL_DIR", Path(__file__).parent / "models"))
# FP32 is the quality baseline; int8 is an explicit deployment option to measure
# on the target NAS, not an assertion of equivalent recognition or voice quality.
PROFILE = os.environ.get("SPEECH_MODEL_PROFILE", "quality")
if PROFILE not in ("quality", "compact"):
    raise ValueError("SPEECH_MODEL_PROFILE must be quality or compact")
ASR_NAME = "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17" if PROFILE == "quality" else "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17"
TTS_NAME = "kokoro-multi-lang-v1_1" if PROFILE == "quality" else "kokoro-int8-multi-lang-v1_1"
ASSETS = [
    ("asr-models", ASR_NAME, "f6b2a72ebcb1ac7a764d4cfccd886e6bcb2a95c4657c2199d0ba95ed4b9ea71a" if PROFILE == "quality" else "7d1efa2138a65b0b488df37f8b89e3d91a60676e416f515b952358d83dfd347e"),
    ("tts-models", TTS_NAME, "a3f4c73d043860e3fd2e5b06f36795eb81de0fc8e8de6df703245edddd87dbad" if PROFILE == "quality" else "a1e94694776049035c4f2c6529f003aaece993c76aae9a78995831c3c4dcafc6"),
]


def download():
    ROOT.mkdir(parents=True, exist_ok=True)
    for release, name, digest in ASSETS:
        target = ROOT / name
        marker = target / ".download-sha256"
        if marker.is_file() and marker.read_text().strip() == digest:
            print(f"Already downloaded: {name}", flush=True)
            continue
        if target.exists():
            raise RuntimeError(f"Incomplete model directory: {target}. Move it aside and retry.")
        url = f"https://github.com/k2-fsa/sherpa-onnx/releases/download/{release}/{name}.tar.bz2"
        print(f"Downloading {name}...", flush=True)
        archive = ROOT / f"{name}.tar.bz2.partial"
        fetch_archive(url, archive, digest)
        with tempfile.TemporaryDirectory(dir=ROOT) as temporary:
            extracted = Path(temporary) / "extracted"
            with tarfile.open(archive, "r:bz2") as tar:
                for member in tar.getmembers():
                    parts = Path(member.name).parts
                    if not parts or parts[0] != name or ".." in parts or not (member.isfile() or member.isdir()):
                        raise RuntimeError(f"Unsafe archive member: {member.name}")
                tar.extractall(extracted, filter="data")
            shutil.move(str(extracted / name), target)
            marker.write_text(digest + "\n")
        archive.unlink()
        print(f"Ready: {target}", flush=True)


if __name__ == "__main__":
    download()
