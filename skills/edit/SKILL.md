---
name: edit
description: Replace an exact, unique string in an existing file. Use for targeted single-occurrence edits to files from the Python kernel instead of rewriting the whole file.
---

# Edit

Make a targeted edit to an existing file by replacing one exact, unique occurrence of a string. `old_str` must appear exactly once in the file.

Call directly from the kernel:

    await edit(path="pkg/file.py", old_str=old, new_str=new)

Use exact old/new strings. If the text contains triple double quotes, use triple single-quoted variables (`old = '''...'''`) or build `old`/`new` from inspected file slices. Returns a short confirmation; raises if `old_str` is missing or matches more than once (widen the snippet to make it unique). The file must have been read in this session, and it must not have changed on disk since that read; otherwise the edit is refused with a request to re-read.

Or from a shell cell:

    !edit --path pkg/file.py --old-str "..." --new-str "..."
