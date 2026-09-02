#!/usr/bin/env pwsh
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

if (-not $IsWindows -and $PSVersionTable.PSEdition -eq "Core") {
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
$localAppData = Join-Path $testRoot "local-app-data"
$artifactName = "prime-agent-$version-windows-x64.zip"
$artifactPath = Join-Path $releaseDir $artifactName
$originalLocalAppData = $env:LOCALAPPDATA
$originalDownloadBaseUrl = $env:PRIME_AGENT_DOWNLOAD_BASE_URL
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
    $env:PRIME_AGENT_DOWNLOAD_BASE_URL = $baseUrl
    & (Join-Path $repoRoot "install.ps1") -Version $version

    $shim = Join-Path $localAppData "PrimeAgent\bin\prime-agent.cmd"
    $binary = Join-Path $localAppData "PrimeAgent\versions\v$version\prime-agent.exe"
    if (-not (Test-Path -LiteralPath $shim)) { throw "Installer did not create prime-agent.cmd" }
    if (-not (Test-Path -LiteralPath $binary)) { throw "Installer did not create the versioned executable" }

    & $shim --version
    if ($LASTEXITCODE -ne 0) { throw "Installed prime-agent --version failed with $LASTEXITCODE" }
    & $shim --help | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Installed prime-agent --help failed with $LASTEXITCODE" }

    & (Join-Path $repoRoot "install.ps1") -Version $version -Update
    & (Join-Path $repoRoot "install.ps1") -Uninstall
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
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}
