"""Container checks intentionally use synthetic metadata, not codec fixtures."""

import base64
import importlib
import struct
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from attach_video.attach_video import _validate_video


def _box(kind, payload):
    return struct.pack(">I4s", len(payload) + 8, kind) + payload


def _mp4(handler=b"vide"):
    return _box(b"ftyp", b"isom" + bytes(4)) + _box(
        b"moov", _box(b"trak", _box(b"mdia", _box(b"hdlr", bytes(8) + handler)))
    )


def _element(kind, payload):
    assert len(payload) < 127
    return kind + bytes([0x80 | len(payload)]) + payload


def _webm(track_type=b"\x01", *, unknown_segment=False):
    header = _element(bytes.fromhex("1a45dfa3"), _element(bytes.fromhex("4282"), b"webm"))
    tracks = _element(bytes.fromhex("1654ae6b"), _element(b"\xae", _element(b"\x83", track_type)))
    segment = bytes.fromhex("18538067")
    if unknown_segment:
        return header + segment + b"\xff" + tracks
    return header + _element(segment, tracks)


class ContainerTests(unittest.TestCase):
    def validate(self, data):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "clip"
            path.write_bytes(data)
            return _validate_video(str(path))[1]

    def test_accepts_video_track_metadata(self):
        extended_mp4 = _mp4()[:16] + struct.pack(">I4sQ", 1, b"moov", len(_mp4()) - 8) + _mp4()[24:]
        zero_size_mp4 = _mp4()[:16] + bytes(4) + _mp4()[20:]
        streaming_webm = _webm(unknown_segment=True) + bytes.fromhex("1f43b675ff")
        cases = [(_mp4(), "video/mp4"), (extended_mp4, "video/mp4"),
                 (zero_size_mp4, "video/mp4"), (_webm(), "video/webm"),
                 (_webm(unknown_segment=True), "video/webm"), (streaming_webm, "video/webm")]
        for data, mime in cases:
            with self.subTest(mime=mime, data=data):
                self.assertEqual(self.validate(data), mime)

    def test_rejects_signature_only_files(self):
        cases = [(_box(b"ftyp", b"isom" + bytes(4)), "moov"),
                 (_element(bytes.fromhex("1a45dfa3"), _element(bytes.fromhex("4282"), b"webm")),
                  "Segment")]
        for data, reason in cases:
            with self.subTest(reason=reason):
                with self.assertRaisesRegex(ValueError, reason):
                    self.validate(data)

    def test_rejects_audio_only_containers(self):
        for data in [_mp4(b"soun"), _webm(b"\x02")]:
            with self.subTest(data=data):
                with self.assertRaisesRegex(ValueError, "video track"):
                    self.validate(data)

    def test_rejects_truncated_declared_payloads(self):
        for data in [_mp4()[:-1], _webm()[:-1], _mp4() + b"x",
                     _mp4() + struct.pack(">I4s", 1, b"free"), _webm() + b"\x81\x40"]:
            with self.subTest(data=data):
                with self.assertRaisesRegex(ValueError, "truncated"):
                    self.validate(data)

    def test_rejects_invalid_nested_lengths(self):
        cases = [_mp4() + struct.pack(">I4s", 4, b"free"),
                 _box(b"ftyp", b"isom" + bytes(4)) + _box(b"moov", b"\x00"),
                 _element(bytes.fromhex("1a45dfa3"), _element(bytes.fromhex("4282"), b"webm"))
                 + _element(bytes.fromhex("18538067"), b"\x16\x54\xae\x6b\x00")]
        for data in cases:
            with self.subTest(data=data):
                with self.assertRaisesRegex(ValueError, "truncated|invalid"):
                    self.validate(data)

    def test_requires_webm_doctype_not_a_substring(self):
        data = _element(bytes.fromhex("1a45dfa3"), _element(bytes.fromhex("4282"), b"matroska"))
        data += _element(bytes.fromhex("18538067"), _element(b"\xec", b"webm"))
        with self.assertRaisesRegex(ValueError, "DocType"):
            self.validate(data)


class AttachmentTests(unittest.IsolatedAsyncioTestCase):
    async def test_emits_validated_bytes_when_file_changes(self):
        skill = importlib.import_module("attach_video.attach_video")
        original = _mp4()
        validate = skill._validate_video
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "clip.mp4"
            path.write_bytes(original)

            def validate_then_replace(filename):
                validated = validate(filename)
                path.write_bytes(b"not a video")
                return validated

            with patch.object(skill, "_validate_video", side_effect=validate_then_replace), \
                    patch("rlm.host_request", new=AsyncMock(return_value={"input": ["video"]})), \
                    patch("rlm.emit") as emit:
                await skill.run(str(path))

            emit.assert_called_once()
            attachment = emit.call_args.args[0][skill._ATTACHMENT_DISPLAY_MIME]
            self.assertEqual(base64.b64decode(attachment["data"]), original)
            self.assertEqual(attachment["mime_type"], "video/mp4")


if __name__ == "__main__":
    unittest.main()
