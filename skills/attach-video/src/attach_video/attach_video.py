"""Load on-disk videos into the model's context as multimodal attachments."""

from __future__ import annotations

import base64
from collections.abc import Iterator
from pathlib import Path

# Keep in sync with ATTACHMENT_DISPLAY_MIME in crates/pa-core/src/kernel/shared.rs.
_ATTACHMENT_DISPLAY_MIME = "application/vnd.prime-agent.attachment+json"

# Keep in sync with MAX_ATTACHMENT_DATA_CHARS in crates/pa-core/src/kernel/shared.rs: the kernel drops a
# larger attachment. Videos are attached as-is (no transcoding), so the largest file is what fits in it.
_MAX_ATTACHMENT_DATA_CHARS = 10_000_000
_MAX_VIDEO_BYTES = _MAX_ATTACHMENT_DATA_CHARS // 4 * 3  # base64 turns 3 bytes into 4 chars

# ISO base media major brands of MP4 video files (still-image and audio brands
# such as heic, avif, or M4A are deliberately absent).
_MP4_BRANDS = frozenset(
    (b"isom", b"iso2", b"iso4", b"iso5", b"iso6", b"mp41", b"mp42", b"avc1", b"M4V ", b"dash", b"mmp4")
)
_EBML_MAGIC = b"\x1a\x45\xdf\xa3"

# Matches VIDEO_MIME_TYPES in crates/pa-core/src/tools/ipython.rs.
_SUPPORTED_FORMATS = "MP4, WebM"


def _detect_video_mime(head: bytes) -> str | None:
    if head[4:8] == b"ftyp" and head[8:12] in _MP4_BRANDS:
        return "video/mp4"
    if head.startswith(_EBML_MAGIC):
        return "video/webm"
    return None


def _mp4_boxes(data: memoryview) -> Iterator[tuple[memoryview, memoryview]]:
    offset = 0
    while offset < len(data):
        if len(data) - offset < 8:
            raise ValueError("truncated MP4 box header")
        size = int.from_bytes(data[offset:offset + 4], "big")
        kind = data[offset + 4:offset + 8]
        header = 8
        if size == 1:
            if len(data) - offset < 16:
                raise ValueError("truncated MP4 extended box header")
            size = int.from_bytes(data[offset + 8:offset + 16], "big")
            header = 16
        elif size == 0:
            size = len(data) - offset
        if size < header:
            raise ValueError("invalid MP4 box size")
        if size > len(data) - offset:
            raise ValueError("truncated MP4 box payload")
        yield kind, data[offset + header:offset + size]
        offset += size


def _validate_mp4(data: memoryview) -> None:
    has_moov = has_video = False
    for kind, payload in _mp4_boxes(data):
        if kind == b"ftyp" and (len(payload) < 8 or len(payload) % 4):
            raise ValueError("invalid MP4 ftyp box")
        if kind != b"moov":
            continue
        has_moov = True
        for kind, payload in _mp4_boxes(payload):
            if kind != b"trak":
                continue
            for kind, payload in _mp4_boxes(payload):
                if kind != b"mdia":
                    continue
                for kind, payload in _mp4_boxes(payload):
                    if kind == b"hdlr":
                        if len(payload) < 12:
                            raise ValueError("truncated MP4 track handler")
                        has_video |= payload[8:12] == b"vide"
    if not has_moov:
        raise ValueError("MP4 is missing its moov metadata box")
    if not has_video:
        raise ValueError("MP4 has no video track")


def _ebml_number(data: memoryview, offset: int, *, is_size: bool) -> tuple[int | None, int]:
    if offset >= len(data) or data[offset] == 0:
        raise ValueError("truncated or invalid WebM EBML header")
    width = 9 - data[offset].bit_length()
    if width > (8 if is_size else 4):
        raise ValueError("invalid WebM EBML integer width")
    if offset + width > len(data):
        raise ValueError("truncated WebM EBML integer")
    value = int.from_bytes(data[offset:offset + width], "big")
    if is_size:
        value &= (1 << (7 * width)) - 1
        if value == (1 << (7 * width)) - 1:
            value = None  # EBML's unknown-length marker.
    return value, offset + width


def _ebml_elements(data: memoryview) -> Iterator[tuple[int, memoryview]]:
    offset = 0
    while offset < len(data):
        kind, offset = _ebml_number(data, offset, is_size=False)
        size, offset = _ebml_number(data, offset, is_size=True)
        if size is None:
            # Streaming WebM commonly leaves Segment and Cluster lengths unknown.
            # Opaque Cluster data is not decoded; it occupies the remaining bytes.
            if kind not in (0x18538067, 0x1F43B675):
                raise ValueError("invalid unknown-length WebM metadata element")
            size = len(data) - offset
        if size > len(data) - offset:
            raise ValueError("truncated WebM element payload")
        yield kind, data[offset:offset + size]
        offset += size


def _validate_webm(data: memoryview) -> None:
    has_doctype = has_segment = has_video = False
    for kind, payload in _ebml_elements(data):
        if kind == 0x1A45DFA3:  # EBML header.
            for kind, payload in _ebml_elements(payload):
                if kind == 0x4282:  # DocType.
                    has_doctype |= payload == b"webm"
        elif kind == 0x18538067:  # Segment.
            has_segment = True
            for kind, payload in _ebml_elements(payload):
                if kind != 0x1654AE6B:  # Tracks.
                    continue
                for kind, payload in _ebml_elements(payload):
                    if kind != 0xAE:  # TrackEntry.
                        continue
                    for kind, payload in _ebml_elements(payload):
                        if kind == 0x83:  # TrackType (1 is video).
                            if not 1 <= len(payload) <= 8:
                                raise ValueError("invalid WebM TrackType")
                            has_video |= int.from_bytes(payload, "big") == 1
    if not has_doctype:
        raise ValueError("WebM requires an EBML DocType of webm")
    if not has_segment:
        raise ValueError("WebM is missing its Segment")
    if not has_video:
        raise ValueError("WebM has no video track")


def _validate_video(path: str) -> tuple[Path, str, bytes]:
    filepath = Path(path).expanduser()
    if not filepath.is_file():
        raise FileNotFoundError(f"{path} is not an existing regular file")

    size = filepath.stat().st_size
    if size > _MAX_VIDEO_BYTES:
        raise ValueError(
            f"{path} is {size / 1_000_000:.1f}MB; videos must be at most "
            f"{_MAX_VIDEO_BYTES / 1_000_000:.1f}MB, prime-agent's attachment limit. Trim or downscale it first "
            "(for example with ffmpeg -t and -vf scale)."
        )

    with filepath.open("rb") as f:
        data = f.read(_MAX_VIDEO_BYTES + 1)
    if len(data) > _MAX_VIDEO_BYTES:
        raise ValueError(f"{path} exceeds the attachment limit")
    mime = _detect_video_mime(data[:16])
    if mime is None:
        raise ValueError(
            f"{path} is not a supported video ({_SUPPORTED_FORMATS}). "
            "Only videos can be loaded into context with attach_video; use attach_image for images "
            "and open other files in the kernel instead."
        )
    try:
        if mime == "video/mp4":
            _validate_mp4(memoryview(data))
        else:
            _validate_webm(memoryview(data))
    except ValueError as error:
        raise ValueError(f"{path} is not a structurally valid video: {error}") from error
    return filepath, mime, data


def _emit_attachment(filepath: Path, mime_type: str, data: bytes) -> None:
    from rlm import emit

    data_b64 = base64.b64encode(data).decode("ascii")
    emit(
        {
            _ATTACHMENT_DISPLAY_MIME: {"mime_type": mime_type, "data": data_b64, "path": str(filepath)},
            "text/plain": f"Loaded video into context: {filepath}",
        }
    )


async def run(*paths: str) -> str:
    """Load one or more on-disk videos into the model's context as attachments.

    Use this when the model needs to actually WATCH a video file — a screen
    recording, gameplay capture, or short camera clip. The video is sent to the
    model as a viewable attachment (a `video_url` content part).

    Do NOT use this for programmatic video work (metadata, cutting, re-encoding,
    extracting frames). For that, run ffmpeg via `bash()` instead.

    Args:
        *paths: One or more video paths. Relative, absolute, or `~`-prefixed.
            Supported formats: MP4, WebM, at most 7.5 MB each. Files are attached
            as-is, without transcoding.

    Returns:
        A short confirmation listing the videos loaded into context.

    Raises:
        FileNotFoundError: If a path does not exist or is not a regular file.
        ValueError: If a file fails the container/track checks or is too large.
            Structural validation does not guarantee that frames can be decoded.
        RuntimeError: If the current model does not declare video input.
    """
    if not paths:
        raise ValueError("attach_video requires at least one video path")

    from rlm import host_request

    info = await host_request("model.info")
    if "video" not in info.get("input", []):
        model_id = info.get("id") or "the current model"
        raise RuntimeError(
            f"{model_id} does not support video input. "
            "Tell the user to switch to a model that declares video input to load videos into context."
        )

    # Validate every path before emitting anything, so a later failure never
    # leaves a partial subset injected.
    validated = [_validate_video(path) for path in paths]
    for filepath, mime, data in validated:
        _emit_attachment(filepath, mime, data)

    sizes = ", ".join(f"{filepath.name} {len(data) / 1_000_000:.1f}MB" for filepath, _mime, data in validated)
    return f"Loaded {len(validated)} video(s) into context: {', '.join(paths)} ({sizes})"
