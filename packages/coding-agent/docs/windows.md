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

## Daemon Endpoint

The background daemon listens on a named pipe whose name is derived from your Windows account and agent directory (`\\.\pipe\prime-agent-daemon-<key>`), so accounts on a shared machine never share an endpoint. Because named pipes do not carry Unix-style ownership, the client and the daemon prove to each other that they can read `%USERPROFILE%\.prime\agent\daemon-endpoint-secret` before any session data is exchanged. That file inherits your profile's permissions; do not share it or widen its ACL. If the daemon reports `Daemon socket already in use`, another process owns the pipe: stop it, or pick another endpoint with `--daemon-socket`.
