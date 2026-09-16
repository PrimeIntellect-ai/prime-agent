# Windows Support

Preme Agent supports native Windows development and runtime use. The tested path uses Windows 10/11, Node.js 22.8.0 or newer, npm, and Git for Windows.

In this fork, `preme-agent` is the primary CLI name. `prime-agent` and `pi` remain compatibility aliases.

## Requirements

- Node.js 22.8.0 or newer
- npm
- Git for Windows, which provides Git Bash
- Internet access on the first kernel bootstrap so `uv` can install Python and runtime packages

Preme Agent requires a bash-compatible shell on Windows. Checked locations, in order:

1. Custom path from `~/.supreme/agent/settings.json`
2. Git Bash (`C:\Program Files\Git\bin\bash.exe`)
3. `bash.exe` on PATH (Cygwin, MSYS2, or WSL)

For most users, [Git for Windows](https://git-scm.com/download/win) is sufficient.

## Source Checkout

From PowerShell:

```powershell
git clone https://github.com/JonusNattapong/preme-agent.git
cd preme-agent
npm ci
.\prime-agent.ps1
```

The PowerShell runner executes the source checkout directly and preserves the caller's working directory. It supports the same development flags as `prime-agent.sh`, including `--dist` and `--no-env`.

To expose the primary CLI aliases globally from the checkout:

```powershell
cd packages/coding-agent
npm link
supreme
```

`npm link` exposes `preme-agent`, `prime-agent`, and `pi`.

## Python Kernel Bootstrap

The Python kernel is bootstrapped automatically on first use. Windows virtual environments use:

```text
%USERPROFILE%\.supreme\agent\kernel-venv\Scripts\python.exe
```

The bootstrap uses `uv` and installs `prime-agent-runtime` plus the default Python packages into that environment. `PRIME_AGENT_KERNEL_PYTHON` is optional and should only be set when intentionally using an existing Python environment that already contains the required runtime packages.

Internal Git, PowerShell, Python, daemon, and worker subprocesses are launched without visible console windows so normal startup and shutdown do not flash extra terminal windows.

## Custom Shell Path

```json
{
  "shellPath": "C:\\cygwin64\\bin\\bash.exe"
}
```