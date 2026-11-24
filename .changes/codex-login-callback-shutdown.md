A Codex login now returns only after its callback listener has closed. A retry straight after a cancel could otherwise find the port still held.
