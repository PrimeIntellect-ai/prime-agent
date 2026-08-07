# Windows Setup

Prime Agent requires a bash shell on Windows. Checked locations (in order):

1. Custom path from `~/.prime/agent/settings.json`
2. Git Bash (`C:\Program Files\Git\bin\bash.exe`)
3. `bash.exe` on PATH (Cygwin, MSYS2, WSL)

For most users, [Git for Windows](https://git-scm.com/download/win) is sufficient.

## Custom Shell Path

```json
{
  "shellPath": "C:\\cygwin64\\bin\\bash.exe"
}
```

## Act Cancellation

Native Windows reports `rlm.ACT_CANCELLATION_CAPABILITY` as `"cooperative-only"`. Cancelling `rlm.act()` stops provider work and cooperative awaited Python, but it does not promise to stop synchronous Python or blocking shell work before that work returns. WSL uses the POSIX managed-kernel path and reports `"posix-managed"`.

On every platform, detached, daemonized, remote, already-completed, and otherwise unmanaged effects remain outside the prompt-stop guarantee. Cancellation does not roll back completed effects. See [RLM](rlm.md#3-act-transfers-one-serial-task-into-the-root-world) for the complete contract.
