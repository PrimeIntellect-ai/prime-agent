#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$SourcePath,
    [string]$SourceArchive,
    [string]$SourceSha256,
    [Alias('InstallDir')]
    [string]$InstallDirectory,
    [switch]$AddToPath,
    [switch]$SkipPrerequisites,
    [switch]$SkipKernelBootstrap
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:InstallerDirectory = $PSScriptRoot
$script:Owner = 'prime-agent-windows-source-v1'
$script:InstallerRoleVariables = @(
    'PRIME_AGENT_INTERNAL_DAEMON_WORKER',
    'PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN',
    'PRIME_AGENT_INTERNAL_DAEMON_WORKER_INSTANCE_ID',
    'PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID',
    'PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET',
    'PRIME_AGENT_INTERNAL_DAEMON_WORKER_RECOVERY_JOURNAL',
    'PRIME_AGENT_INTERNAL_DAEMON_WORKER_STARTUP_GATE_FD',
    'PRIME_AGENT_INTERNAL_DAEMON_CATALOG',
    'PRIME_AGENT_INTERNAL_OWNED_WORKER',
    'PRIME_AGENT_INTERNAL_OWNED_RECOVERY_DESCRIPTOR',
    'PRIME_AGENT_INTERNAL_OWNED_PROFILE',
    'PRIME_AGENT_INTERNAL_LEGACY_OWNED_WORKER_FRONTEND',
    'PRIME_AGENT_INTERNAL_ORPHAN_PROCESS_JOURNAL',
    'PRIME_AGENT_INTERNAL_SESSION_LEASES',
    'PRIME_AGENT_INTERNAL_SESSION_LEASE_OWNER_ID'
)

function Invoke-NativeChecked {
    param([string]$Command, [string[]]$Arguments)
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Command failed with exit code $LASTEXITCODE. The previous installation was kept."
    }
}

function Assert-NoReparsePoint {
    param([string]$Path)
    $item = Get-Item -LiteralPath $Path -Force
    while ($null -ne $item) {
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Refusing a symbolic link or junction: $($item.FullName)"
        }
        $item = $item.Parent
    }
}

function Assert-SourceTree {
    param([string]$Path)
    foreach ($name in @('package.json', 'package-lock.json', 'prime-agent.cmd', 'scripts/run-prime-agent.mjs', 'prime-agent-runtime/pyproject.toml')) {
        if (-not (Test-Path -LiteralPath (Join-Path $Path $name) -PathType Leaf)) {
            throw "Incomplete source tree: missing $name in $Path. Use the complete Windows source download."
        }
    }
    $package = Get-Content -LiteralPath (Join-Path $Path 'package.json') -Encoding UTF8 -Raw | ConvertFrom-Json
    if (-not $package.scripts.PSObject.Properties['build:windows']) {
        throw 'The source tree does not have the build:windows script.'
    }
}

function Copy-SourceTree {
    param([string]$Source, [string]$Destination)
    $excluded = @('.git', 'node_modules', 'dist', '.venv', 'venv', 'kernel-venv', 'binaries', 'release', 'coverage', '__pycache__')
    [IO.Directory]::CreateDirectory($Destination) | Out-Null
    foreach ($item in Get-ChildItem -LiteralPath $Source -Force) {
        if ($excluded -contains $item.Name -or $item.Name -eq '.prime' -or $item.Name -eq '.pi' -or $item.Name -like '.env*' -or $item.Name -eq 'auth.json') { continue }
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
        $target = Join-Path $Destination $item.Name
        if ($item.PSIsContainer) { Copy-SourceTree $item.FullName $target }
        else { [IO.File]::Copy($item.FullName, $target, $false) }
    }
}

function Expand-VerifiedSourceArchive {
    param([string]$Archive, [string]$Sha256, [string]$Destination)
    if ($Sha256 -notmatch '^[0-9a-fA-F]{64}$') { throw '-SourceArchive requires a known -SourceSha256 (64 hexadecimal characters).' }
    if ((Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash -ine $Sha256) { throw 'Source archive SHA-256 mismatch. Nothing was extracted.' }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Directory]::CreateDirectory($Destination) | Out-Null
    $base = [IO.Path]::GetFullPath($Destination).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    $zip = [IO.Compression.ZipFile]::OpenRead($Archive)
    try {
        # Validate the whole archive before writing any member. Reject Windows ADS,
        # links, duplicate names, and names with ambiguous Windows normalization.
        $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        foreach ($entry in $zip.Entries) {
            $name = $entry.FullName.Replace('\', '/')
            $parts = $name.TrimEnd('/').Split('/')
            if ([string]::IsNullOrWhiteSpace($name) -or $name.StartsWith('/') -or $name -match '[:\x00-\x1f]' -or
                @($parts | Where-Object { $_ -eq '.' -or $_ -eq '..' -or $_ -eq '' -or $_ -match '[. ]$' -or $_ -match '^(?i:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)' }).Count -gt 0) {
                throw "Unsafe archive entry: $name"
            }
            $unixType = ($entry.ExternalAttributes -shr 16) -band 0xF000
            if ($unixType -eq 0xA000 -or (($entry.ExternalAttributes -band 0x400) -ne 0)) { throw "Archive links are not allowed: $name" }
            $target = [IO.Path]::GetFullPath((Join-Path $Destination ($name.Replace('/', [IO.Path]::DirectorySeparatorChar))))
            if (-not $target.StartsWith($base, [StringComparison]::OrdinalIgnoreCase) -or -not $seen.Add($target)) { throw "Unsafe or duplicate archive entry: $name" }
        }
        foreach ($entry in $zip.Entries) {
            $name = $entry.FullName.Replace('\', '/').Replace('/', [IO.Path]::DirectorySeparatorChar)
            $target = Join-Path $Destination $name
            if ($entry.FullName.EndsWith('/') -or $entry.FullName.EndsWith('\')) { [IO.Directory]::CreateDirectory($target) | Out-Null }
            else {
                [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null
                [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $false)
            }
        }
    } finally { $zip.Dispose() }
    if (Test-Path -LiteralPath (Join-Path $Destination 'package.json')) { return $Destination }
    $children = @(Get-ChildItem -LiteralPath $Destination -Force)
    if ($children.Count -eq 1 -and $children[0].PSIsContainer) { return $children[0].FullName }
    throw 'The archive must contain a source tree, optionally inside one top-level directory.'
}

function Merge-PathEntries {
    param([string[]]$Values)
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $result = @()
    foreach ($value in $Values) {
        foreach ($entry in ($value -split ';')) {
            if ($entry -and $seen.Add($entry.TrimEnd('\'))) { $result += $entry }
        }
    }
    return ($result -join ';')
}

function Refresh-InstallerPath {
    # Keep caller-specific entries, including custom Node and uv installations.
    $env:PATH = Merge-PathEntries @($env:PATH, [Environment]::GetEnvironmentVariable('Path', 'Machine'), [Environment]::GetEnvironmentVariable('Path', 'User'))
}

function Find-Application {
    param([string]$Name)
    $command = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { return $command.Source }
    return $null
}

function Test-NodeVersion {
    param([string]$Version)
    if ($Version -notmatch '^v?(\d+)\.(\d+)\.(\d+)$') { return $false }
    return ([version]($Version.TrimStart('v')) -ge [version]'22.8.0')
}

function Find-NativeNode {
    $candidates = @((Find-Application 'node.exe'))
    if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles 'nodejs/node.exe') }
    foreach ($candidate in $candidates | Select-Object -Unique) {
        if (-not $candidate -or -not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
        $identity = @(& $candidate -p "process.platform + ' ' + process.arch + ' ' + process.versions.node" 2>$null)
        if ($LASTEXITCODE -ne 0 -or $identity.Count -ne 1) { continue }
        $parts = $identity[0] -split ' '
        if ($parts.Count -eq 3 -and $parts[0] -eq 'win32' -and $parts[1] -eq 'x64' -and (Test-NodeVersion $parts[2])) { return $candidate }
    }
    return $null
}

function Find-GitBash {
    $candidates = @()
    foreach ($base in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA)) {
        if ($base) { $candidates += (Join-Path $base 'Git/bin/bash.exe'); $candidates += (Join-Path $base 'Programs/Git/bin/bash.exe') }
    }
    $git = Find-Application 'git.exe'
    if ($git) { $candidates += (Join-Path (Split-Path (Split-Path $git -Parent) -Parent) 'bin/bash.exe') }
    foreach ($candidate in $candidates | Select-Object -Unique) {
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
        $identity = @(& $candidate --noprofile --norc -c 'uname -s' 2>$null)
        if ($LASTEXITCODE -eq 0 -and $identity.Count -eq 1 -and $identity[0] -match '^MINGW') { return [IO.Path]::GetFullPath($candidate) }
    }
    return $null
}

function Find-NativeUv {
    $candidate = Find-Application 'uv.exe'
    if (-not $candidate) { return $null }
    $identity = @(& $candidate --version 2>$null)
    if ($LASTEXITCODE -eq 0 -and $identity.Count -eq 1 -and $identity[0] -match '^uv \d+\.') { return $candidate }
    return $null
}

function Install-WinGetPrerequisite {
    param([string]$PackageId)
    $winget = Find-Application 'winget.exe'
    if (-not $winget) { throw "Missing prerequisite $PackageId. Install Microsoft App Installer (WinGet), or install Node.js >=22.8 x64, Git for Windows, and native uv, then retry. See https://learn.microsoft.com/windows/package-manager/winget/" }
    Write-Host "Installing $PackageId with WinGet. Windows may ask for administrator approval."
    Invoke-NativeChecked $winget @('install', '--id', $PackageId, '--exact', '--source', 'winget', '--accept-source-agreements', '--accept-package-agreements', '--disable-interactivity')
    Refresh-InstallerPath
}

function Get-Prerequisites {
    param([switch]$ValidateOnly)
    $node = Find-NativeNode
    if (-not $node -and -not $ValidateOnly) { Install-WinGetPrerequisite 'OpenJS.NodeJS.LTS'; $node = Find-NativeNode }
    if (-not $node) { throw 'Native Windows x64 Node.js >=22.8 is required. An older Node earlier on PATH can hide a new installation.' }
    $npm = Join-Path (Split-Path $node -Parent) 'npm.cmd'
    if (-not (Test-Path -LiteralPath $npm -PathType Leaf)) { throw "npm.cmd is missing beside $node. Install the complete Node.js distribution." }
    $bash = Find-GitBash
    if (-not $bash -and -not $ValidateOnly) { Install-WinGetPrerequisite 'Git.Git'; $bash = Find-GitBash }
    if (-not $bash) { throw 'Git for Windows with Git Bash is required. WSL bash is not supported by this installer.' }
    $uv = Find-NativeUv
    if (-not $uv -and -not $ValidateOnly) { Install-WinGetPrerequisite 'astral-sh.uv'; $uv = Find-NativeUv }
    if (-not $uv) { throw 'Native Windows uv.exe is required. Install uv, reopen PowerShell, then retry.' }
    return @{ Node = $node; Npm = $npm; Bash = $bash; Uv = $uv }
}

function ConvertTo-BatchLiteral {
    param([string]$Value)
    if ($Value -match '["\x00\r\n]') { throw 'Paths cannot contain quotes, NUL, or line breaks.' }
    return $Value.Replace('%', '%%')
}


function Get-InstallerDaemonPipe {
    param([string]$State, [string]$UserSid)
    if (-not $UserSid) { $UserSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value }
    $identity = $UserSid + "`0" + [IO.Path]::GetFullPath($State).TrimEnd('\').ToLowerInvariant()
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $digest = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($identity))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
    return '\\.\pipe\prime-agent-windows-' + $digest.Substring(0, 32)
}

function New-LauncherContent {
    param([string]$Release, [string]$State, [hashtable]$Tools)
    $pipe = Get-InstallerDaemonPipe $State
    $clearRoles = ($script:InstallerRoleVariables | ForEach-Object { 'set "' + $_ + '="' }) -join "`r`n"
    $node = ConvertTo-BatchLiteral $Tools.Node
    $entry = ConvertTo-BatchLiteral (Join-Path $Release 'packages/coding-agent/dist/bundle/cli.js')
    $statePath = ConvertTo-BatchLiteral $State
    $sessions = ConvertTo-BatchLiteral (Join-Path $State 'sessions')
    $registry = ConvertTo-BatchLiteral (Join-Path $State 'supervisor-owners')
    $venv = ConvertTo-BatchLiteral (Join-Path $Release 'kernel-venv')
    $prefix = ConvertTo-BatchLiteral (Merge-PathEntries @((Split-Path $Tools.Node -Parent), (Split-Path $Tools.Uv -Parent), (Split-Path $Tools.Bash -Parent)))
    return (@('@echo off', "rem $script:Owner", 'setlocal DisableDelayedExpansion', $clearRoles,
        'set "_PRIME_AGENT_OLD_CP="', 'for /f "tokens=2 delims=:" %%a in (''chcp'') do set "_PRIME_AGENT_OLD_CP=%%a"', 'chcp 65001 >nul',
        "set `"PATH=$prefix;%PATH%`"", "set `"PRIME_AGENT_CODING_AGENT_DIR=$statePath`"",
        "set `"PRIME_AGENT_SESSION_DIR=$sessions`"", "set `"PRIME_AGENT_WINDOWS_DAEMON_PIPE=$pipe`"", 'set "PRIME_AGENT_CODING_AGENT_SESSION_DIR="',
        "set `"PRIME_AGENT_KERNEL_VENV=$venv`"", "set `"PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR=$registry`"", 'set "PRIME_AGENT_KERNEL_PYTHON="',
        'set "PRIME_AGENT_LAUNCHER_PATH=%~f0"', 'set "PRIME_AGENT_INSTALL_UV=0"',
        "`"$node`" `"$entry`" %*", 'set "_PRIME_AGENT_EXIT=%errorlevel%"',
        'if defined _PRIME_AGENT_OLD_CP chcp %_PRIME_AGENT_OLD_CP% >nul', 'exit /b %_PRIME_AGENT_EXIT%', '') -join "`r`n")
}

function Assert-OwnedLauncher {
    param([string]$Launcher)
    if (Test-Path -LiteralPath $Launcher) {
        Assert-NoReparsePoint (Split-Path $Launcher -Parent)
        if (((Get-Item -LiteralPath $Launcher -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
            -not (Get-Content -LiteralPath $Launcher -Encoding UTF8 -Raw).Contains("rem $script:Owner`r`n")) {
            throw "Refusing to replace an unmanaged launcher: $Launcher"
        }
    }
}

function Publish-Launcher {
    param([string]$Launcher, [string]$Content)
    Assert-OwnedLauncher $Launcher
    Assert-OwnedLauncher "$Launcher.previous"
    $next = "$Launcher.$([guid]::NewGuid().ToString('N')).new"
    try {
        [IO.File]::WriteAllText($next, $Content, [Text.UTF8Encoding]::new($false))
        if (Test-Path -LiteralPath $Launcher) {
            # Windows File.Replace switches the launcher atomically and retains its predecessor.
            [IO.File]::Replace($next, $Launcher, "$Launcher.previous", $true)
        } else { [IO.File]::Move($next, $Launcher) }
    } finally { if (Test-Path -LiteralPath $next) { Remove-Item -LiteralPath $next -Force } }
}

function Add-InstallerUserPath {
    param([string]$Bin)
    $old = [Environment]::GetEnvironmentVariable('Path', 'User')
    $updated = Merge-PathEntries @($old, $Bin)
    if ($updated -cne $old) { [Environment]::SetEnvironmentVariable('Path', $updated, 'User') }
    $env:PATH = Merge-PathEntries @($env:PATH, $Bin)
}

function Install-PrimeAgentWindows {
    param([string]$SourcePath, [string]$SourceArchive, [string]$SourceSha256, [string]$InstallDirectory,
        [switch]$AddToPath, [switch]$SkipPrerequisites, [switch]$SkipKernelBootstrap)
    if ($env:OS -ne 'Windows_NT' -or -not [Environment]::Is64BitProcess -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') {
        throw 'Run this installer in 64-bit Windows PowerShell 5.1 or PowerShell 7 on Windows x64.'
    }
    if ($SourceArchive -and $SourcePath) { throw 'Choose -SourcePath or -SourceArchive, not both.' }
    if ($SourceSha256 -and -not $SourceArchive) { throw '-SourceSha256 requires -SourceArchive.' }
    if (-not $InstallDirectory) { $InstallDirectory = Join-Path $env:LOCALAPPDATA 'PrimeAgent/windows-source' }
    $root = [IO.Path]::GetFullPath($InstallDirectory)
    $release = $null
    $archiveTemp = $null
    $lock = $null
    $activated = $false
    $environmentNames = @('PATH', 'PRIME_AGENT_CODING_AGENT_DIR', 'PRIME_AGENT_SESSION_DIR', 'PRIME_AGENT_CODING_AGENT_SESSION_DIR', 'PRIME_AGENT_KERNEL_VENV', 'PRIME_AGENT_KERNEL_PYTHON', 'PRIME_AGENT_WINDOWS_DAEMON_PIPE', 'PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR', 'PRIME_AGENT_INSTALL_UV', 'PYTHONUTF8', 'HUSKY') + $script:InstallerRoleVariables
    $savedEnvironment = @{}
    foreach ($name in $environmentNames) { $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
    try {
        foreach ($name in $script:InstallerRoleVariables) { [Environment]::SetEnvironmentVariable($name, $null, 'Process') }
        if ($SourceArchive) {
            $archiveTemp = Join-Path ([IO.Path]::GetTempPath()) ('prime-agent-source-' + [guid]::NewGuid().ToString('N'))
            $SourcePath = Expand-VerifiedSourceArchive $SourceArchive $SourceSha256 $archiveTemp
        } elseif (-not $SourcePath) { $SourcePath = $script:InstallerDirectory }
        $source = [IO.Path]::GetFullPath($SourcePath)
        Assert-NoReparsePoint $source
        Assert-SourceTree $source
        if ($root.StartsWith($source.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -or $root -ieq $source) { throw 'The install directory must not be inside the source tree.' }
        if (Test-Path -LiteralPath $root) {
            Assert-NoReparsePoint $root
            $marker = Join-Path $root '.managed'
            if (-not (Test-Path -LiteralPath $marker -PathType Leaf) -or ((Get-Item -LiteralPath $marker -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or (Get-Content -LiteralPath $marker -Encoding UTF8 -Raw).Trim() -ne $script:Owner) { throw "Refusing to take ownership of existing directory: $root" }
        } else {
            # Check existing ancestors before creating a user-owned managed directory.
            $ancestor = Split-Path $root -Parent
            while (-not (Test-Path -LiteralPath $ancestor)) { $ancestor = Split-Path $ancestor -Parent }
            Assert-NoReparsePoint $ancestor
            [IO.Directory]::CreateDirectory($root) | Out-Null
            [IO.File]::WriteAllText((Join-Path $root '.managed'), $script:Owner)
        }
        $lockPath = Join-Path $root '.install-lock'
        try { $lock = [IO.File]::Open($lockPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None) }
        catch { throw "Installation is locked. If no installer is running, remove $lockPath and retry." }
        $bin = Join-Path $root 'bin'
        $versions = Join-Path $root 'versions'
        $state = Join-Path $root 'state'
        foreach ($directory in @($bin, $versions, $state)) {
            [IO.Directory]::CreateDirectory($directory) | Out-Null
            Assert-NoReparsePoint $directory
        }
        $launcher = Join-Path $bin 'prime-agent-windows.cmd'
        Assert-OwnedLauncher $launcher
        $tools = Get-Prerequisites -ValidateOnly:$SkipPrerequisites
        $env:PATH = Merge-PathEntries @((Split-Path $tools.Node -Parent), (Split-Path $tools.Uv -Parent), (Split-Path $tools.Bash -Parent), $env:PATH)
        $release = Join-Path $versions ([guid]::NewGuid().ToString('N'))
        Write-Host "Copying trusted source to $release"
        Copy-SourceTree $source $release
        Assert-SourceTree $release
        $settings = Join-Path $state 'settings.json'
        if (-not (Test-Path -LiteralPath $settings)) {
            [IO.File]::WriteAllText($settings, (@{ shellPath = $tools.Bash } | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
        } else {
            if (((Get-Item -LiteralPath $settings -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'The isolated settings file must not be a symbolic link.' }
            $existing = Get-Content -LiteralPath $settings -Encoding UTF8 -Raw | ConvertFrom-Json
            if (-not $existing.PSObject.Properties['shellPath'] -or -not (Test-Path -LiteralPath $existing.shellPath -PathType Leaf)) {
                throw "Set a valid Git Bash shellPath in $settings. Existing settings were not changed."
            }
        }
        $env:PRIME_AGENT_CODING_AGENT_DIR = $state
        $env:PRIME_AGENT_SESSION_DIR = Join-Path $state 'sessions'
        $env:PRIME_AGENT_WINDOWS_DAEMON_PIPE = Get-InstallerDaemonPipe $state
        $env:PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR = Join-Path $state 'supervisor-owners'
        $env:PRIME_AGENT_CODING_AGENT_SESSION_DIR = $null
        $env:PRIME_AGENT_KERNEL_VENV = Join-Path $release 'kernel-venv'
        $env:PRIME_AGENT_KERNEL_PYTHON = $null
        $env:PRIME_AGENT_INSTALL_UV = '0'
        $env:PYTHONUTF8 = '1'
        $env:HUSKY = '0'
        Push-Location $release
        try {
            Write-Host 'Installing locked npm dependencies and building Prime Agent.'
            Invoke-NativeChecked $tools.Npm @('ci', '--include=dev', '--include=optional', '--no-audit', '--no-fund')
            Invoke-NativeChecked $tools.Npm @('run', 'build:windows')
            $entry = Join-Path $release 'packages/coding-agent/dist/bundle/cli.js'
            Invoke-NativeChecked $tools.Node @($entry, '--version')
            Invoke-NativeChecked $tools.Node @($entry, '--help')
            if (-not $SkipKernelBootstrap) {
                Write-Host 'Preparing the isolated Python kernel. This requires internet access.'
                Invoke-NativeChecked $tools.Node @((Join-Path $release 'packages/coding-agent/dist/core/kernel/bootstrap-cli.js'))
            }
        } finally { Pop-Location }
        $metadata = @{ sourcePath = $source; sourceSha256 = $SourceSha256; installedAt = [DateTime]::UtcNow.ToString('o'); kernelPrepared = (-not $SkipKernelBootstrap) }
        [IO.File]::WriteAllText((Join-Path $release '.installation.json'), ($metadata | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
        $content = New-LauncherContent $release $state $tools
        Publish-Launcher $launcher $content
        $activated = $true
        if ($AddToPath) {
            try { Add-InstallerUserPath $bin }
            catch { Write-Warning "Installed, but could not update user PATH: $_" }
        }
        $quotedLauncher = $launcher.Replace("'", "''")
        Write-Host "Installed isolated Windows source build. Run: & '$quotedLauncher'"
        Write-Host "Settings and sessions: $state"
        Write-Host 'Updates: rerun this installer. Prior source builds and prime-agent-windows.cmd.previous are retained.'
        if ($SkipKernelBootstrap) { Write-Host 'Python kernel setup was deferred. First ipython use requires internet access.' }
        if ($AddToPath) { Write-Host 'Open a new terminal to use prime-agent-windows from PATH.' }
    } finally {
        foreach ($name in $environmentNames) { [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process') }
        if ($release -and -not $activated -and (Test-Path -LiteralPath $release)) { Remove-Item -LiteralPath $release -Recurse -Force }
        if ($archiveTemp -and (Test-Path -LiteralPath $archiveTemp)) { Remove-Item -LiteralPath $archiveTemp -Recurse -Force }
        if ($null -ne $lock) { $lock.Dispose(); Remove-Item -LiteralPath $lockPath -Force }
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    Install-PrimeAgentWindows @PSBoundParameters
}
