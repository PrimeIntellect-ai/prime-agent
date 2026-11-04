---
name: attach-video
description: Load an on-disk video clip (MP4, WebM) into the model's context as a viewable attachment so the model can directly WATCH it — for screen recordings, gameplay captures, or short camera clips. Use this when you need to perceive what happens over time in a video. Requires a model that declares video input (`"video"` in its model `input`) on an OpenAI-compatible chat-completions provider; errors clearly otherwise.
---

# Attach Video

Load short on-disk video clips into the model's context as multimodal
attachments. The clip is sent to the model as a `video_url` content part, so a
video-capable model can actually watch it.

## When to use this

- The user points at a video file and wants you to describe what happens in it.
- You need to follow motion, actions, or changes over time in a recording.
- A single frame is not enough (for one frame, extract it and use `attach_image`).

## When NOT to use this

For *programmatic* work on a video — reading metadata, cutting, re-encoding,
extracting frames — use a tool such as `ffmpeg` through `bash()` instead. That
path does not put the video in the model's context; it only lets you compute
over it. Use `attach_video` when you need to *see* the video.

## Usage

Call the prepared `attach_video` import directly in the Python kernel:

```python
print(await attach_video("clip.mp4"))
print(await attach_video("a.mp4", "b.webm"))
```

The file is attached as-is: it is not transcoded, trimmed, or resized, and the
original file is left untouched. Each file must be at most 7.5 MB (prime-agent's
limit for one attachment); trim or downscale longer recordings first (for example
`ffmpeg -i in.mp4 -t 10 -vf scale=640:-2 -an out.mp4`). The attachment is
replayed to the model on every later turn, so prefer short, low-resolution
clips.

Supported formats: MP4, WebM. The skill errors if a file is not a supported
video, is too large, or if the current model does not declare video input
(`"input": ["text", "image", "video"]` in `models.json`). Only
OpenAI-compatible chat-completions providers receive the video itself; other
providers, and models without declared video input, see a placeholder saying
the video was omitted.
