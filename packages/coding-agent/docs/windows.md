# Windows Setup

Prime Agent supports native Windows 10 and 11 on x64 and Arm64. WSL is not required.

## Requirements

- PowerShell 5.1 or newer for installation and updates
- [Git for Windows](https://git-scm.com/download/win), including Git Bash, for shell commands
- Windows Terminal is recommended

Prime Agent itself runs as a native Bun-compiled Windows executable. Git Bash is the command shell used by the `bash` tool; it does not run Prime Agent under WSL.

## Install

Open PowerShell and run:

```powershell
irm https://app.primeintellect.ai/prime-agent/install.ps1 | iex
```

The installer downloads the x64 or Arm64 ZIP archive, requires a matching SHA-256 entry, installs versioned files under `%LOCALAPPDATA%\PrimeAgent`, and adds `%LOCALAPPDATA%\PrimeAgent\bin` to your user `PATH`.

Open a new terminal after the first install, then run:

```powershell
prime-agent
```

To install the beta channel:

```powershell
irm https://app.primeintellect.ai/prime-agent/install-beta.ps1 | iex
```

## Update or select a version

```powershell
& ([scriptblock]::Create((irm https://app.primeintellect.ai/prime-agent/install.ps1))) -Update
& ([scriptblock]::Create((irm https://app.primeintellect.ai/prime-agent/install.ps1))) -Version 0.9.1
```

Downloads and extraction finish before the command shim changes. A failed download, checksum, extraction, or activation leaves the previous version active.

## Uninstall

```powershell
& ([scriptblock]::Create((irm https://app.primeintellect.ai/prime-agent/install.ps1))) -Uninstall
```

This removes `%LOCALAPPDATA%\PrimeAgent` and its entry from your user `PATH`. Open a new terminal to see the updated `PATH`.

## Git Bash discovery

Prime Agent checks shell locations in this order:

1. `shellPath` in `~/.prime/agent/settings.json`
2. `C:\Program Files\Git\bin\bash.exe`
3. `C:\Program Files (x86)\Git\bin\bash.exe`
4. `bash.exe` on `PATH`

A custom shell can be configured as follows:

```json
{
  "shellPath": "C:\\Program Files\\Git\\bin\\bash.exe"
}
```

Git Bash is the supported default. Cygwin and MSYS2 can be selected explicitly, but they are not part of the primary Windows validation path. WSL paths are not used by the native installer.

## Python kernel

The persistent CPython kernel is prepared automatically with `uv`. The Windows bootstrap uses PowerShell and a virtual environment at `~/.prime/agent/kernel-venv`, whose interpreter is under `Scripts\python.exe`.

On managed systems that block the uv installer, install uv separately or set `PRIME_AGENT_KERNEL_PYTHON` to a CPython environment that already contains `prime-agent-runtime`.

## Troubleshooting

### `prime-agent` is not recognized

Open a new terminal. Confirm that `%LOCALAPPDATA%\PrimeAgent\bin` appears in your user `PATH` and that `prime-agent.cmd` exists there.

### No bash shell found

Install Git for Windows with Git Bash. If it is installed in a custom directory, set `shellPath` in `~/.prime/agent/settings.json`.

### PowerShell blocks the installer

Run the command in a normal interactive PowerShell session. Organization policy can block downloaded scripts or remote content. In that case, download `install.ps1`, review it, and run it according to your organization's policy.

### A child process survives cancellation

Run `prime-agent shutdown --force`. Prime Agent uses Windows process-tree termination and CPython Job Objects, but a process moved into a separately managed Windows service or job can require manual termination.

### Terminal input or colors are incorrect

Use an updated Windows Terminal profile. See [Terminal Setup](terminal-setup.md) for the recommended key mappings.
