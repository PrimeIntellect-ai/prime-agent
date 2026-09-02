#!/usr/bin/env pwsh
<#
.SYNOPSIS
Install Prime Agent on Windows without WSL.
.DESCRIPTION
Downloads a checksummed Windows release archive, installs it under the current
user's LocalAppData directory, and adds the Prime Agent command directory to the
user PATH. Git Bash is required by Prime Agent's shell tool after installation.
.PARAMETER Version
Install a specific release version. A leading v is accepted.
.PARAMETER Channel
Resolve the current stable or beta release when Version is omitted.
.PARAMETER Update
Install and activate the requested release over the current command shim.
.PARAMETER Uninstall
Remove Prime Agent and its user PATH entry.
#>

[CmdletBinding()]
param(
    [string]$Version,
    [ValidateSet("stable", "beta")]
    [string]$Channel,
    [switch]$Update,
    [switch]$Uninstall
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$DownloadBaseUrl = if ($env:PRIME_AGENT_DOWNLOAD_BASE_URL) {
    $env:PRIME_AGENT_DOWNLOAD_BASE_URL.TrimEnd("/")
} else {
    "__PRIME_AGENT_DOWNLOAD_BASE_URL__"
}
$DefaultChannel = "__PRIME_AGENT_DEFAULT_RELEASE_CHANNEL__"
if ($DefaultChannel -eq "__PRIME_AGENT_DEFAULT_RELEASE_CHANNEL__") {
    $DefaultChannel = "stable"
}
if (-not $Channel) {
    $Channel = $DefaultChannel
}

$CommandName = if ($env:PRIME_AGENT_CMD) { $env:PRIME_AGENT_CMD } else { "prime-agent" }
if ($CommandName -notmatch "^[A-Za-z0-9._-]+$") {
    throw "Invalid PRIME_AGENT_CMD value: $CommandName"
}
if (-not $env:LOCALAPPDATA) {
    throw "LOCALAPPDATA is required for a per-user Prime Agent installation."
}

$InstallRoot = Join-Path $env:LOCALAPPDATA "PrimeAgent"
$VersionsDir = Join-Path $InstallRoot "versions"
$BinDir = Join-Path $InstallRoot "bin"
$CommandShim = Join-Path $BinDir "$CommandName.cmd"

function Write-Step([string]$Message) {
    Write-Host "prime-agent: $Message" -ForegroundColor Cyan
}

function Get-ReleasePlatform {
    $architecture = if ($env:PROCESSOR_ARCHITEW6432) {
        $env:PROCESSOR_ARCHITEW6432
    } else {
        $env:PROCESSOR_ARCHITECTURE
    }
    switch ($architecture.ToUpperInvariant()) {
        "AMD64" { return "windows-x64" }
        "ARM64" { return "windows-arm64" }
        default { throw "Unsupported Windows architecture: $architecture" }
    }
}

function Assert-ReleaseVersion([string]$Value) {
    $normalized = $Value.Trim().TrimStart("v")
    if ($normalized -notmatch "^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$") {
        throw "Invalid Prime Agent release version: $Value"
    }
    return $normalized
}

function Resolve-ReleaseVersion {
    if ($Version) {
        return Assert-ReleaseVersion $Version
    }
    if ($env:PRIME_AGENT_VERSION) {
        return Assert-ReleaseVersion $env:PRIME_AGENT_VERSION
    }
    $channelUrl = "$DownloadBaseUrl/$Channel"
    Write-Step "resolving the $Channel release"
    $response = Invoke-WebRequest -Uri $channelUrl -UseBasicParsing -TimeoutSec 30
    return Assert-ReleaseVersion $response.Content
}

function Add-UserPathEntry([string]$Entry) {
    $userPath = [Environment]::GetEnvironmentVariable("PATH", "User")
    $entries = @($userPath -split ";" | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    $present = $entries | Where-Object { [string]::Equals($_, $Entry, [System.StringComparison]::OrdinalIgnoreCase) }
    if (-not $present) {
        $newPath = (@($entries) + $Entry) -join ";"
        [Environment]::SetEnvironmentVariable("PATH", $newPath, "User")
    }
    if (-not (($env:PATH -split ";") | Where-Object { [string]::Equals($_, $Entry, [System.StringComparison]::OrdinalIgnoreCase) })) {
        $env:PATH = "$env:PATH;$Entry"
    }
}

function Remove-UserPathEntry([string]$Entry) {
    $userPath = [Environment]::GetEnvironmentVariable("PATH", "User")
    $entries = @($userPath -split ";" | ForEach-Object { $_.Trim() } | Where-Object {
        $_ -and -not [string]::Equals($_, $Entry, [System.StringComparison]::OrdinalIgnoreCase)
    })
    [Environment]::SetEnvironmentVariable("PATH", ($entries -join ";"), "User")
}

function Get-ExpectedChecksum([string]$ChecksumsPath, [string]$ArtifactName) {
    foreach ($line in Get-Content -LiteralPath $ChecksumsPath) {
        if ($line -match "^([0-9A-Fa-f]{64})\s+\*?(.+)$" -and $Matches[2].Trim() -eq $ArtifactName) {
            return $Matches[1].ToLowerInvariant()
        }
    }
    throw "SHA256SUMS does not contain $ArtifactName"
}

function Assert-ArchiveLayout([string]$Directory) {
    $required = @(
        "prime-agent.exe",
        "package.json",
        "README.md",
        "CHANGELOG.md",
        "install.sh",
        "install.ps1",
        "photon_rs_bg.wasm",
        "prime-agent-runtime",
        "skills",
        "theme",
        "assets",
        "export-html",
        "docs",
        "examples"
    )
    foreach ($name in $required) {
        if (-not (Test-Path -LiteralPath (Join-Path $Directory $name))) {
            throw "Release archive is missing required sidecar: $name"
        }
    }
}

function Set-ActiveVersion([string]$VersionDirectory) {
    New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
    $binaryPath = Join-Path $VersionDirectory "prime-agent.exe"
    $temporaryShim = Join-Path $BinDir "$CommandName.cmd.$([guid]::NewGuid().ToString("N")).tmp"
    $shim = "@echo off`r`n`"$binaryPath`" %*`r`n"
    $backupShim = "$CommandShim.backup"
    try {
        Set-Content -LiteralPath $temporaryShim -Value $shim -Encoding Ascii -NoNewline
        if (Test-Path -LiteralPath $CommandShim) {
            [System.IO.File]::Replace($temporaryShim, $CommandShim, $backupShim, $true)
            Remove-Item -LiteralPath $backupShim -Force -ErrorAction SilentlyContinue
        } else {
            Move-Item -LiteralPath $temporaryShim -Destination $CommandShim
        }
    } finally {
        Remove-Item -LiteralPath $temporaryShim -Force -ErrorAction SilentlyContinue
    }
    Add-UserPathEntry $BinDir
}

function Install-Release([string]$TargetVersion) {
    $platform = Get-ReleasePlatform
    $artifactName = "prime-agent-$TargetVersion-$platform.zip"
    $releaseUrl = "$DownloadBaseUrl/releases/v$TargetVersion"
    $versionDirectory = Join-Path $VersionsDir "v$TargetVersion"

    if ((Test-Path -LiteralPath (Join-Path $versionDirectory "prime-agent.exe")) -and
        (Test-Path -LiteralPath (Join-Path $versionDirectory "package.json"))) {
        Set-ActiveVersion $versionDirectory
        Write-Step "Prime Agent v$TargetVersion is active"
        return
    }

    $temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) "prime-agent-install-$([guid]::NewGuid().ToString("N"))"
    $archivePath = Join-Path $temporaryRoot $artifactName
    $checksumsPath = Join-Path $temporaryRoot "SHA256SUMS"
    $stagingDirectory = Join-Path $temporaryRoot "staging"

    New-Item -ItemType Directory -Path $temporaryRoot -Force | Out-Null
    try {
        Write-Step "downloading Prime Agent v$TargetVersion for $platform"
        Invoke-WebRequest -Uri "$releaseUrl/$artifactName" -OutFile $archivePath -UseBasicParsing -TimeoutSec 120
        Invoke-WebRequest -Uri "$releaseUrl/SHA256SUMS" -OutFile $checksumsPath -UseBasicParsing -TimeoutSec 30

        $expectedHash = Get-ExpectedChecksum $checksumsPath $artifactName
        $actualHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actualHash -ne $expectedHash) {
            throw "SHA-256 mismatch for ${artifactName}: expected $expectedHash, got $actualHash"
        }

        Expand-Archive -LiteralPath $archivePath -DestinationPath $stagingDirectory -Force
        Assert-ArchiveLayout $stagingDirectory

        New-Item -ItemType Directory -Path $VersionsDir -Force | Out-Null
        if (Test-Path -LiteralPath $versionDirectory) {
            Remove-Item -LiteralPath $versionDirectory -Recurse -Force
        }
        Move-Item -LiteralPath $stagingDirectory -Destination $versionDirectory
        Set-ActiveVersion $versionDirectory
        Write-Step "installed Prime Agent v$TargetVersion"
    } finally {
        Remove-Item -LiteralPath $temporaryRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Uninstall-PrimeAgent {
    Remove-UserPathEntry $BinDir
    Remove-Item -LiteralPath $InstallRoot -Recurse -Force -ErrorAction SilentlyContinue
    Write-Step "uninstalled Prime Agent"
}

if ($Uninstall) {
    Uninstall-PrimeAgent
    exit 0
}
if ($DownloadBaseUrl -eq "__PRIME_AGENT_DOWNLOAD_BASE_URL__") {
    throw "Installer download URL is not configured. Use the published installer or set PRIME_AGENT_DOWNLOAD_BASE_URL."
}

$targetVersion = Resolve-ReleaseVersion
Install-Release $targetVersion
if ($Update) {
    Write-Step "update complete"
}
Write-Host "Run '$CommandName' in a new terminal. Git Bash is required for shell commands." -ForegroundColor Green
