#!/usr/bin/env pwsh
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

if ($PSVersionTable.PSEdition -eq "Core" -and -not $IsWindows) {
    throw "Windows installer smoke test must run on Windows."
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$packageDir = Join-Path $repoRoot "packages\coding-agent"
$distDir = Join-Path $packageDir "dist"
$version = (Get-Content (Join-Path $packageDir "package.json") -Raw | ConvertFrom-Json).version
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) "prime-agent-windows-installer-$([guid]::NewGuid().ToString("N"))"
$serverRoot = Join-Path $testRoot "server"
$releaseDir = Join-Path $serverRoot "releases\v$version"
$stagingDir = Join-Path $testRoot "archive"
$localAppData = Join-Path $testRoot ("local app {0}{1} & % ! (test)" -f ([char]0x6D4B), ([char]0x8BD5))
$artifactName = "prime-agent-$version-windows-x64.zip"
$artifactPath = Join-Path $releaseDir $artifactName
$originalLocalAppData = $env:LOCALAPPDATA
$originalDownloadBaseUrl = $env:PRIME_AGENT_DOWNLOAD_BASE_URL
$originalVersion = $env:PRIME_AGENT_VERSION
$originalProcessorArchitecture = $env:PROCESSOR_ARCHITECTURE
$originalProcessorArchitectureW6432 = $env:PROCESSOR_ARCHITEW6432
$originalUserPath = [Environment]::GetEnvironmentVariable("PATH", "User")
$server = $null

try {
    New-Item -ItemType Directory -Path $releaseDir, $stagingDir, $localAppData -Force | Out-Null
    Copy-Item -Path (Join-Path $distDir "*") -Destination $stagingDir -Recurse -Force
    Move-Item -LiteralPath (Join-Path $stagingDir "pi.exe") -Destination (Join-Path $stagingDir "prime-agent.exe")
    Compress-Archive -Path (Join-Path $stagingDir "*") -DestinationPath $artifactPath -CompressionLevel Optimal
    $hash = (Get-FileHash -LiteralPath $artifactPath -Algorithm SHA256).Hash.ToLowerInvariant()
    Set-Content -LiteralPath (Join-Path $releaseDir "SHA256SUMS") -Value "$hash  $artifactName" -Encoding Ascii
    Set-Content -LiteralPath (Join-Path $serverRoot "stable") -Value $version -Encoding Ascii

    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
    $listener.Stop()

    $server = Start-Process -FilePath "python" -ArgumentList @(
        "-m", "http.server", "$port", "--bind", "127.0.0.1", "--directory", $serverRoot
    ) -PassThru -WindowStyle Hidden
    $baseUrl = "http://127.0.0.1:$port"
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    while ($true) {
        try {
            Invoke-WebRequest -Uri "$baseUrl/stable" -UseBasicParsing -TimeoutSec 1 | Out-Null
            break
        } catch {
            if ([DateTime]::UtcNow -ge $deadline) { throw "Local release server did not become ready." }
            Start-Sleep -Milliseconds 100
        }
    }

    $env:LOCALAPPDATA = $localAppData
    $installerSource = Get-Content -LiteralPath (Join-Path $repoRoot "install.ps1") -Raw
    foreach ($channel in @("stable", "beta")) {
        $rendered = $installerSource.Replace("__PRIME_AGENT_DOWNLOAD_BASE_URL__", $baseUrl).Replace("__PRIME_AGENT_DEFAULT_RELEASE_CHANNEL__", $channel)
        Set-Content -LiteralPath (Join-Path $testRoot "install-$channel.ps1") -Value $rendered -Encoding UTF8
    }
    $env:PRIME_AGENT_DOWNLOAD_BASE_URL = $null
    $env:PRIME_AGENT_VERSION = $null
    # Environment variables describe an emulated process, not the native OS.
    # Poison both values so this x64 runner proves the installer uses the Win32 native-machine API.
    $env:PROCESSOR_ARCHITECTURE = "ARM64"
    $env:PROCESSOR_ARCHITEW6432 = "ARM64"
    & (Join-Path $testRoot "install-stable.ps1")
    $env:PROCESSOR_ARCHITECTURE = $originalProcessorArchitecture
    $env:PROCESSOR_ARCHITEW6432 = $originalProcessorArchitectureW6432

    $shim = Join-Path $localAppData "PrimeAgent\bin\prime-agent.cmd"
    $binary = Join-Path $localAppData "PrimeAgent\versions\v$version\prime-agent.exe"
    if (-not (Test-Path -LiteralPath $shim)) { throw "Installer did not create prime-agent.cmd" }
    if (-not (Test-Path -LiteralPath $binary)) { throw "Installer did not create the versioned executable" }

    & $shim --version
    if ($LASTEXITCODE -ne 0) { throw "Installed prime-agent --version failed with $LASTEXITCODE" }
    & $shim --help | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Installed prime-agent --help failed with $LASTEXITCODE" }

    Remove-Item -LiteralPath (Join-Path $serverRoot "stable")
    Set-Content -LiteralPath (Join-Path $serverRoot "beta") -Value $version -Encoding Ascii
    & (Join-Path $testRoot "install-beta.ps1") -Update
    & (Join-Path $testRoot "install-beta.ps1") -Uninstall
    if (Test-Path -LiteralPath (Join-Path $localAppData "PrimeAgent")) {
        throw "Uninstall left the PrimeAgent install directory behind"
    }
    Write-Host "Windows installer end-to-end smoke passed."
} finally {
    if ($server -and -not $server.HasExited) {
        Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
    }
    [Environment]::SetEnvironmentVariable("PATH", $originalUserPath, "User")
    $env:LOCALAPPDATA = $originalLocalAppData
    $env:PRIME_AGENT_DOWNLOAD_BASE_URL = $originalDownloadBaseUrl
    $env:PRIME_AGENT_VERSION = $originalVersion
    $env:PROCESSOR_ARCHITECTURE = $originalProcessorArchitecture
    $env:PROCESSOR_ARCHITEW6432 = $originalProcessorArchitectureW6432
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}
