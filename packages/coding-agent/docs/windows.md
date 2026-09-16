# Windows setup

## Requirements

This source installer targets Windows 10/11 x64 with PowerShell 5.1 or newer. It builds the Node.js application and supplies PowerShell/CMD entry points. It does not produce a standalone `.exe` or change the macOS/Linux release installer.

The application needs:

- Native Windows Node.js 22.8 or newer, including npm.
- Git for Windows, including Git Bash. PowerShell and CMD are entry-point shells; the agent's Bash tool still uses Git Bash.
- Native Windows uv for the Python runtime.

The installer checks these programs and uses WinGet to install missing prerequisites. WinGet comes from Microsoft's App Installer. If WinGet is unavailable, install the prerequisites first. Git or Node installation can request elevation; the installer does not promise an administrator-free setup. Existing acceptable tools are reused.

## One-command source installation

From a trusted checkout or extracted source archive containing `install.ps1`, run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

`-ExecutionPolicy Bypass` applies only to this installer process. It does not change your machine-wide execution policy. Review the script before running it. If local scripts are already permitted, `& .\install.ps1` is sufficient.

The installer copies source into a new directory, installs locked npm dependencies, compiles the application, checks CLI startup, and prepares the Python runtime. This requires internet access and can take several minutes. It does not authenticate a provider or run a paid model request.

A source checkout/archive is required. There is no published Windows download-and-execute endpoint associated with this change. Do not substitute the inherited `@earendil-works/pi-coding-agent` npm package for the Prime Agent installer.

The installed command is **`prime-agent-windows.cmd`**, separate from `prime-agent`. Use the full launcher path printed by the installer. Add `-AddToPath` if you want the installer to add its command directory to your **user** PATH:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -AddToPath
```

Open a new terminal to use that PATH change. The installer does not modify the system PATH or replace another Prime Agent installation.

### Installation options

```powershell
# Install a trusted source checkout into a chosen directory.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -SourcePath C:\src\prime-agent -InstallDirectory C:\tools\prime-agent-windows

# Require already-installed prerequisites; do not invoke WinGet.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -SkipPrerequisites

# Install a source ZIP after verifying its expected SHA-256.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -SourceArchive C:\downloads\prime-agent-source.zip -SourceSha256 '<expected SHA-256>'
```

Obtain an archive's expected hash from its trusted distributor. A checksum does not establish who published the archive. Do not run untrusted source: npm lifecycle scripts and the application execute with your permissions.

Each successful installation uses a new build directory. The managed launcher is updated only after validation passes. A failed build leaves the previous launcher intact. Prior build directories are retained; do not remove one while its agent or Python processes are running.

### Configuration and updates

The installed command uses a separate daemon named pipe and isolates its configuration, sessions, and Python environment from the standard `~/.prime/agent` installation. It must not reuse a Linux virtual environment. Use `/login` to configure a provider for this installation, then `/model` to choose a model.

Update this source installation by rerunning the installer with the desired source. Do not use `prime-agent update` for this installation. This source installer is separate from the stable/beta release update mechanism.

## Build and run without installing

Install the prerequisites, then run from the repository root:

```powershell
npm.cmd ci
npm.cmd run build:windows
.\prime-agent.cmd --dist --version
.\prime-agent.cmd --dist
```

`prime-agent.ps1` is also available where script execution is permitted. The `.cmd` entry point avoids PowerShell execution-policy restrictions. Without `--dist`, either launcher uses the checkout's `tsx` dependency to run the TypeScript sources. Both preserve the caller's working directory:

```powershell
Set-Location C:\work\my-project
& 'C:\src\prime-agent\prime-agent.cmd' --dist
```

Unlike the installed isolated command, these repository launchers use the application's normal configuration defaults. Isolate manual source tests explicitly:

```powershell
$env:PRIME_AGENT_CODING_AGENT_DIR = "$env:USERPROFILE\.prime\agent-windows-test"
$env:PRIME_AGENT_SESSION_DIR = "$env:PRIME_AGENT_CODING_AGENT_DIR\sessions"
$env:PRIME_AGENT_KERNEL_VENV = "$env:PRIME_AGENT_CODING_AGENT_DIR\kernel-venv"
$daemonPipe = '\\.\pipe\prime-agent-windows-test-' + [guid]::NewGuid().ToString('N')
.\prime-agent.cmd --dist --daemon-socket $daemonPipe
```

Use the same `$daemonPipe` value for subsequent commands against that test daemon. Configuration environment variables alone do not select a different Windows daemon pipe.

## Git Bash and runtime limits

The Python runtime accepts Git Bash in its canonical Program Files locations or an explicit `shellPath` in the installation's `settings.json`. A different `bash.exe` on PATH alone is not sufficient for the kernel. For an intentional custom installation, configure its absolute executable path:

```json
{
  "shellPath": "D:\\Tools\\Git\\bin\\bash.exe"
}
```

Do not set `shellPath` to `powershell.exe`, `cmd.exe`, or WSL Bash. These are not native Git Bash substitutes for this runtime.

Windows PowerShell 5.1 can change empty arguments and embedded double quotes before Node receives them. Prefer PowerShell 7 for complex argument values. CMD applies its own variable/metacharacter expansion. The launchers cannot undo caller-shell parsing.

Windows interruption of synchronous Python cells has platform limits. Build and startup checks are not proof of every interactive terminal or process-control behavior. ARM64 and Windows Server are outside this installer's scope.

## Validation

The Windows source workflow runs installer safeguards in PowerShell 5.1/7, builds the Node.js application, checks source/compiled launchers, and runs focused Windows process and bootstrap regressions. The existing contributor trust gate also applies to this workflow.

Run the installer safeguards directly from the repository root:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-windows-installer.ps1
```

On Windows, run portable source checks:

```powershell
npx.cmd --no-install biome check --error-on-warnings .
npx.cmd --no-install tsgo --noEmit
npm.cmd run check:browser-smoke
```

The complete `npm run check`, including Unix installer checks, remains part of Linux validation. See [development](development.md) for focused test commands and contribution rules.
