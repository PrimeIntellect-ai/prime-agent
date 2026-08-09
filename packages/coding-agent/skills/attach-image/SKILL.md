---
name: attach-image
description: Add on-disk PNG, JPEG, GIF, or WebP images to the model context for visual inspection. Use for screenshots, diagrams, charts, photos, and scanned pages when the model must see their contents. Requires a vision-capable model.
---

# Attach Image

Add an on-disk image to the model context as a multimodal attachment. The model
receives it like an image pasted into the conversation and can inspect its
visual contents.

## Use this skill when

- the user identifies an image file and asks what it shows;
- text, a chart, a diagram, a screenshot, or a page layout requires visual
  interpretation; or
- visual appearance, rather than file bytes alone, determines the answer.

## Use a Python image library instead when

The task is programmatic, such as measuring pixels, cropping, resizing,
computing a hash, or comparing files byte for byte:

```python
from PIL import Image

img = Image.open("diagram.png")
print(img.size)
```

A Python image library exposes pixels and metadata to Python. Use `attach_image`
to place the image in model context for visual inspection.

## Usage

Call the prepared `attach_image` import directly in the IPython kernel:

```python
print(await attach_image("diagram.png"))
print(await attach_image("a.png", "b.jpg"))
```

The skill resizes and compresses large images before attaching them. An animated
image that requires compression is flattened to its first frame. A transparent
image that requires compression is composited onto a neutral gray background.
An image above the pixel-count limit is rejected before full processing. The
original file is not modified.

Supported formats are PNG, JPEG, GIF, and WebP. The skill returns an error for
an unsupported file or a model without vision support.
