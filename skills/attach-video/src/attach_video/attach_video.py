"""Load on-disk videos into the model's context as multimodal attachments."""

from __future__ import annotations

import base64
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
    # The EBML header carries the Matroska DocType; WebM declares "webm".
    if head.startswith(_EBML_MAGIC) and b"webm" in head:
        return "video/webm"
    return None


def _validate_video(path: str) -> tuple[Path, str, int]:
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
        head = f.read(64)
    mime = _detect_video_mime(head)
    if mime is None:
        raise ValueError(
            f"{path} is not a supported video ({_SUPPORTED_FORMATS}). "
            "Only videos can be loaded into context with attach_video; use attach_image for images "
            "and open other files in the kernel instead."
        )
    return filepath, mime, size


def _emit_attachment(filepath: Path, mime_type: str) -> None:
    from rlm import emit

    data_b64 = base64.b64encode(filepath.read_bytes()).decode("ascii")
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
        ValueError: If a file is not a supported video or is too large.
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
    for filepath, mime, _size in validated:
        _emit_attachment(filepath, mime)

    sizes = ", ".join(f"{filepath.name} {size / 1_000_000:.1f}MB" for filepath, _mime, size in validated)
    return f"Loaded {len(validated)} video(s) into context: {', '.join(paths)} ({sizes})"
