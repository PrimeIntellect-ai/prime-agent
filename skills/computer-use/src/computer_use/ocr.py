"""Apple Vision text recognition over captured window screenshots.

get_text_regions runs VNRecognizeTextRequest over an already-captured window
PNG and returns the recognized text regions normalized to the image; the
capture itself stays with the App layer, so non-vision models read one window
without full-screen OCR being improvised from bash.
"""

from __future__ import annotations

import asyncio
from importlib import import_module
from typing import Any

from .errors import ComputerUseError

_MAX_REGIONS = 400
_ERROR_LIMIT = 200


async def _get_text_regions(
    path: str, *, frameworks: tuple[Any, ...] | None = None
) -> list[dict[str, str | float]]:
    """Recognize the text in the PNG at path and return its regions.

    Each region is {"text", "confidence", "x", "y", "width", "height"} with
    top-left-origin coordinates normalized to the image (0..1), sorted
    top-to-bottom then left-to-right, capped at 400 entries. frameworks
    optionally supplies the framework modules, including Vision; by default
    they are resolved from the macOS backend at call time. Raises
    ComputerUseError INVALID_ARGUMENT for a bad path and TRANSPORT_ERROR for
    any recognition failure, with the framework cause capped in the message.
    """
    if not isinstance(path, str) or not path:
        raise ComputerUseError(
            "INVALID_ARGUMENT",
            f"path must be a non-empty string, got {type(path).__name__}",
            {"path": type(path).__name__},
        )
    try:
        quartz, vision = _framework_pair(frameworks)
        observations = await asyncio.to_thread(_recognize, path, quartz, vision)
    except ComputerUseError:
        raise
    except Exception as error:
        raise ComputerUseError(
            "TRANSPORT_ERROR",
            f"vision text recognition failed: {str(error)[:_ERROR_LIMIT]}",
        ) from error
    regions = [_region(observation) for observation in observations]
    regions.sort(key=lambda region: (region["y"], region["x"]))
    return regions[:_MAX_REGIONS]


def _framework_pair(frameworks: tuple[Any, ...] | None) -> tuple[Any, Any]:
    """Resolve the Quartz and Vision modules for the recognition runner.

    frameworks, when given, is searched for both modules by module name so a
    longer backend tuple also works; None resolves Quartz from the macOS
    backend and imports Vision lazily.
    """
    if frameworks is None:
        from ._compat import _require_mac

        quartz = _require_mac().quartz
        try:
            vision = import_module("Vision")
        except ImportError as error:
            raise ComputerUseError(
                "TRANSPORT_ERROR",
                f"computer use backend unavailable: the Vision framework is not installed ({error})",
            ) from error
        return quartz, vision
    named = {getattr(module, "__name__", ""): module for module in frameworks}
    try:
        return named["Quartz"], named["Vision"]
    except KeyError as error:
        raise ComputerUseError(
            "TRANSPORT_ERROR",
            "the frameworks argument must include the Quartz and Vision modules",
            {"modules": ", ".join(sorted(name for name in named if name))},
        ) from error


def _recognize(path: str, quartz: Any, vision: Any) -> list[dict[str, Any]]:
    """Run one VNRecognizeTextRequest over the image at path.

    Returns the raw observations as {"text", "confidence", "bbox"} dicts with
    the Vision bounding box in image-normalized bottom-left coordinates.
    """
    url = quartz.NSURL.fileURLWithPath_(path)
    request = vision.VNRecognizeTextRequest.alloc().init()
    handler = vision.VNImageRequestHandler.alloc().initWithURL_options_(url, None)
    performed, error = handler.performRequests_error_([request], None)
    if not performed:
        raise RuntimeError(str(error) if error is not None else "the recognition request did not run")
    observations: list[dict[str, Any]] = []
    for observation in request.results() or []:
        candidates = observation.topCandidates_(1)
        if not candidates:
            continue
        candidate = candidates[0]
        box = observation.boundingBox()
        observations.append(
            {
                "text": str(candidate.string()),
                "confidence": float(candidate.confidence()),
                "bbox": (
                    float(box.origin.x),
                    float(box.origin.y),
                    float(box.size.width),
                    float(box.size.height),
                ),
            }
        )
    return observations


def _region(observation: dict[str, Any]) -> dict[str, str | float]:
    """Convert one raw observation into a top-left-origin normalized region."""
    x, bottom, width, height = observation["bbox"]
    return {
        "text": observation["text"],
        "confidence": observation["confidence"],
        "x": _unit(x),
        "y": _unit(1.0 - bottom - height),
        "width": _unit(width),
        "height": _unit(height),
    }


def _unit(value: float) -> float:
    """Clamp one coordinate into the documented 0..1 image range."""
    return max(0.0, min(1.0, float(value)))
