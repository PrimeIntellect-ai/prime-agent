"""Load on-disk images into the model's context as multimodal attachments."""

from __future__ import annotations

import base64
import io
from pathlib import Path

# Keep in sync with ATTACHMENT_DISPLAY_MIME in src/core/kernel/index.ts.
_ATTACHMENT_DISPLAY_MIME = "application/vnd.prime-agent.attachment+json"

# Keep emitted attachments small enough that daemon clients can render and replay
# image-heavy sessions without compressing megabytes of base64 on every update.
_MAX_SOURCE_IMAGE_BYTES = 20_000_000
_MAX_SOURCE_IMAGE_PIXELS = 36_000_000
_MAX_ATTACHMENT_DATA_CHARS = 350_000
_MAX_ATTACHMENT_DIMENSION = 1200
_TRANSPARENCY_BACKGROUND = "#888888"
_JPEG_QUALITIES = (82, 72, 60, 48, 36)

# Matches IMAGE_MIME_TYPES in src/utils/mime.ts.
_IMAGE_SIGNATURES = (
    ("image/png", b"\x89PNG\r\n\x1a\n"),
    ("image/jpeg", b"\xff\xd8\xff"),
    ("image/gif", b"GIF87a"),
    ("image/gif", b"GIF89a"),
)


def _detect_image_mime(data: bytes) -> str | None:
    for mime, prefix in _IMAGE_SIGNATURES:
        if data.startswith(prefix):
            return mime
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def _image_dimensions(filepath: Path) -> tuple[int, int]:
    try:
        from PIL import Image
    except ImportError as error:
        raise RuntimeError(
            "attach_image needs Pillow to inspect this image before loading it into context."
        ) from error

    try:
        with Image.open(filepath) as image:
            return image.size
    except Exception as error:
        raise ValueError(
            f"{filepath} is not a readable supported image (PNG, JPEG, GIF, WebP)."
        ) from error


def _validate_decodable_image(filepath: Path) -> None:
    try:
        from PIL import Image

        with Image.open(filepath) as image:
            if getattr(image, "is_animated", False):
                image.seek(0)
            image.load()
    except Exception as error:
        raise ValueError(
            f"{filepath} is not a readable supported image (PNG, JPEG, GIF, WebP)."
        ) from error


def _validate_image(path: str) -> tuple[Path, str, int, tuple[int, int]]:
    filepath = Path(path).expanduser()
    if not filepath.is_file():
        raise FileNotFoundError(f"{path} is not an existing regular file")

    size = filepath.stat().st_size
    if size > _MAX_SOURCE_IMAGE_BYTES:
        raise ValueError(
            f"{path} is {size // 1_000_000}MB; images must be under "
            f"{_MAX_SOURCE_IMAGE_BYTES // 1_000_000}MB. Resize it first."
        )

    with filepath.open("rb") as f:
        head = f.read(16)
    mime = _detect_image_mime(head)
    if mime is None:
        raise ValueError(
            f"{path} is not a supported image (PNG, JPEG, GIF, WebP). "
            "Only images can be loaded into context; open other files in the kernel instead."
        )

    dimensions = _image_dimensions(filepath)
    pixel_count = dimensions[0] * dimensions[1]
    if pixel_count > _MAX_SOURCE_IMAGE_PIXELS:
        raise ValueError(
            f"{path} is {dimensions[0]}x{dimensions[1]} ({pixel_count // 1_000_000}MP); "
            f"images must be at most {_MAX_SOURCE_IMAGE_PIXELS // 1_000_000}MP. Resize it first."
        )
    _validate_decodable_image(filepath)

    return filepath, mime, size, dimensions


def _base64_chars(data: bytes) -> int:
    return ((len(data) + 2) // 3) * 4


def _load_image_for_attachment(data: bytes):
    from PIL import Image, ImageOps

    image = Image.open(io.BytesIO(data))
    is_animated = getattr(image, "is_animated", False)
    if is_animated:
        image.seek(0)
    image = ImageOps.exif_transpose(image)
    is_transparent = image.mode in {"RGBA", "LA"} or (image.mode == "P" and "transparency" in image.info)
    conversion_notes = []
    if is_animated:
        conversion_notes.append("animated image flattened to first frame")
    if is_transparent:
        conversion_notes.append(f"transparent pixels composited on {_TRANSPARENCY_BACKGROUND} background")
    conversion_note = "; ".join(conversion_notes) or None

    if is_transparent:
        rgba = image.convert("RGBA")
        background = Image.new("RGB", rgba.size, _TRANSPARENCY_BACKGROUND)
        background.paste(rgba, mask=rgba.split()[-1])
        return background, conversion_note
    return image.convert("RGB"), conversion_note


def _encode_jpeg(image, quality: int) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=quality, optimize=True, progressive=True)
    return buffer.getvalue()


def _resize_image(filepath: Path, mime_type: str, size: int, dimensions: tuple[int, int]) -> tuple[str, str, str | None]:
    data = filepath.read_bytes()
    encoded_chars = _base64_chars(data)

    if (
        size <= _MAX_ATTACHMENT_DATA_CHARS * 3 // 4
        and max(dimensions) <= _MAX_ATTACHMENT_DIMENSION
        and encoded_chars <= _MAX_ATTACHMENT_DATA_CHARS
    ):
        return base64.b64encode(data).decode("ascii"), mime_type, None

    try:
        from PIL import Image
    except ImportError as error:
        raise RuntimeError(
            "attach_image needs Pillow to resize this image before loading it into context."
        ) from error

    image, conversion_note = _load_image_for_attachment(data)
    original_width, original_height = image.size

    scale = min(1.0, _MAX_ATTACHMENT_DIMENSION / max(original_width, original_height))
    target_width = max(1, round(original_width * scale))
    target_height = max(1, round(original_height * scale))
    last_data: bytes | None = None
    last_width = target_width
    last_height = target_height

    while target_width >= 1 and target_height >= 1:
        resized = image.resize((target_width, target_height), Image.Resampling.LANCZOS)
        for quality in _JPEG_QUALITIES:
            candidate = _encode_jpeg(resized, quality)
            last_data = candidate
            last_width = target_width
            last_height = target_height
            if _base64_chars(candidate) <= _MAX_ATTACHMENT_DATA_CHARS:
                note = (
                    f"original {original_width}x{original_height}; attached "
                    f"{target_width}x{target_height} JPEG at quality {quality}"
                )
                if conversion_note:
                    note += f"; {conversion_note}"
                return base64.b64encode(candidate).decode("ascii"), "image/jpeg", note

        next_width = max(1, int(target_width * 0.75))
        next_height = max(1, int(target_height * 0.75))
        if next_width == target_width and next_height == target_height:
            break
        target_width, target_height = next_width, next_height

    raise ValueError(
        f"{filepath} could not be compressed below "
        f"{_MAX_ATTACHMENT_DATA_CHARS // 1000}KB base64 payload "
        f"(smallest was {_base64_chars(last_data or b'') // 1000}KB at {last_width}x{last_height})."
    )


def _emit_attachment(filepath: Path, mime_type: str, size: int, dimensions: tuple[int, int]) -> str | None:
    from rlm import emit

    data_b64, emitted_mime_type, resize_note = _resize_image(filepath, mime_type, size, dimensions)
    emit(
        {
            _ATTACHMENT_DISPLAY_MIME: {"mime_type": emitted_mime_type, "data": data_b64, "path": str(filepath)},
            "text/plain": f"Loaded image into context: {filepath}",
        }
    )
    return resize_note


async def run(*paths: str) -> str:
    """Load one or more on-disk images into the model's context as attachments.

    Use this when the model needs to actually SEE an image file — a screenshot,
    diagram, chart, photo, or scanned page. The image is sent to the model as a
    viewable attachment (the same way a pasted image is).

    Do NOT use this for programmatic image analysis (reading pixels, cropping,
    resizing, hashing, measuring colors). For that, open the file with PIL in
    the kernel instead.

    Args:
        *paths: One or more image paths. Relative, absolute, or `~`-prefixed.
            Supported formats: PNG, JPEG, GIF, WebP. Other types (PDF, audio,
            video) are not supported and raise an error.

    Returns:
        A short confirmation listing the images loaded into context.

    Raises:
        FileNotFoundError: If a path does not exist or is not a regular file.
        ValueError: If a file is not a supported image, is too large, or cannot
            be compressed enough for safe inline rendering and replay.
        RuntimeError: If the current model cannot accept images.
    """
    if not paths:
        raise ValueError("attach_image requires at least one image path")

    from rlm import host_request

    info = await host_request("model.info")
    if "image" not in info.get("input", []):
        model_id = info.get("id") or "the current model"
        raise RuntimeError(
            f"{model_id} does not support vision. "
            "Tell the user to switch to a vision-capable model to load images into context."
        )

    # Validate every path before emitting anything, so a later failure never
    # leaves a partial subset injected.
    validated = [_validate_image(path) for path in paths]
    resize_notes = []
    for filepath, mime, size, dimensions in validated:
        note = _emit_attachment(filepath, mime, size, dimensions)
        if note:
            resize_notes.append(f"{filepath}: {note}")

    message = f"Loaded {len(validated)} image(s) into context: {', '.join(paths)}"
    if resize_notes:
        message += "\nResized for efficient inline rendering/replay:\n- " + "\n- ".join(resize_notes)
    return message
