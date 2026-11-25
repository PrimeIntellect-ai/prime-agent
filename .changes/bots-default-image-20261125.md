- Bots boot a prebuilt team image instead of the bare `python:3.12-bookworm`
  and pay no cold install. `bots::DEFAULT_BOT_IMAGE` now points at
  `prime/primeintellect/prime-agent-bot:latest`, which already carries the
  pinned Node.js, the GitHub CLI, uv, the kernel venv and a prime-agent
  release. `make bot-image` rebuilds and republishes it, and bakes the VM
  artifact so the first bot of a new tag never waits in `PENDING`.
- The bot install uploads a local tarball over the gateway multipart
  endpoint (`upload_file`) instead of piping it through the exec stream.
  The exec-stream transfer stays as the fallback, and the install removes
  the uploaded file.
