import hashlib
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from download_models import fetch_archive


class DownloadTests(unittest.TestCase):
    def test_resumes_interrupted_download_and_verifies_integrity(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "model.partial"
            file.write_bytes(b"first")
            response = io.BytesIO(b"second")
            response.status = 206
            response.headers = {"Content-Range": "bytes 5-10/11"}
            with patch("urllib.request.urlopen", return_value=response) as download:
                fetch_archive("https://example.com/model", file, hashlib.sha256(b"firstsecond").hexdigest())
            self.assertEqual(file.read_bytes(), b"firstsecond")
            self.assertEqual(download.call_args.args[0].get_header("Range"), "bytes=5-")

    def test_restarts_when_server_does_not_support_range(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "model.partial"
            file.write_bytes(b"partial")
            response = io.BytesIO(b"complete")
            response.status = 200
            response.headers = {}
            with patch("urllib.request.urlopen", return_value=response):
                fetch_archive("https://example.com/model", file, hashlib.sha256(b"complete").hexdigest())
            self.assertEqual(file.read_bytes(), b"complete")

    def test_complete_archive_does_not_redownload(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "model.partial"
            file.write_bytes(b"complete")
            with patch("urllib.request.urlopen") as download:
                fetch_archive("https://example.com/model", file, hashlib.sha256(b"complete").hexdigest())
                download.assert_not_called()

    def test_checksum_failure_removes_the_corrupt_archive(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "model.partial"
            response = io.BytesIO(b"corrupt")
            response.status = 200
            response.headers = {}
            with patch("urllib.request.urlopen", return_value=response):
                with self.assertRaisesRegex(RuntimeError, "checksum"):
                    fetch_archive("https://example.com/model", file, hashlib.sha256(b"complete").hexdigest())
            self.assertFalse(file.exists())


if __name__ == "__main__":
    unittest.main()
