---
name: attach-image
description: Load an on-disk image (PNG, JPEG, GIF, WebP) into the model's context as a viewable attachment so the model can directly SEE it — for screenshots, diagrams, charts, photos, or scanned pages. Use this when you need to perceive an image's visual contents. Requires a vision-capable model; errors clearly otherwise.
---

# Attach Image

Load on-disk images into the model's context as multimodal attachments. The
image is sent to the model the same way a pasted image is, so the model can
actually look at it.

## When to use this

- The user points at an image file and wants you to look at it.
- You need to read text, a chart, a diagram, or a layout from an image.
- A screenshot needs visual interpretation.

## When NOT to use this

For *programmatic* work on an image — measuring pixels, cropping, resizing,
computing a hash, comparing files byte-by-byte — open it in the kernel with a
library instead:

```python
from PIL import Image
img = Image.open("diagram.png")
print(img.size)
```

That path does not put the image in the model's context; it only lets you
compute over it. Use `attach_image` when you need to *see* the image.

## Usage

Call the prepared `attach_image` import directly in the Python kernel:

```python
print(await attach_image("diagram.png"))
print(await attach_image("a.png", "b.jpg"))
```

The skill automatically resizes and compresses large images before loading them
into context. Animated images that need compression are flattened to their first
frame. Transparent images that need compression are composited onto a neutral
gray background. Extremely large images are rejected by pixel count before full
processing. The original file is left untouched.

Supported formats: PNG, JPEG, GIF, WebP. The skill errors if a file is not a
supported image, or if the current model is not vision-capable.
