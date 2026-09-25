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

## Daemon Pipe Names

On Windows the default daemon socket is a per-user named pipe: `\\.\pipe\prime-agent-daemon-` plus the first 12 hex characters of a hash of the Windows domain and username. Two accounts on the same machine do not share a pipe.

After upgrading from a build that used the shared `\\.\pipe\prime-agent-daemon` path, stop the old daemon once so clients attach to the new pipe. The wire protocol is unchanged.
