# test_windows_channel_fallback.ps1 — the install.ps1 Windows channel-fallback
# regression test (the windows battery's third install gate).
#
# WHAT IT PROVES (the operator's real-machine report, 2026-10-02: the plain
# one-liner threw "no artifact row for platform win32-x64 in the stable
# manifest"):
#   1. a default-channel install against a stable channel that carries no
#      win32-x64 row falls back to beta, prints the notice, and publishes
#      the beta payload (the .prime-agent-install marker names beta);
#   2. an explicitly requested channel without a win32-x64 row refuses with
#      the beta one-liner spelled out — the fallback never overrides a
#      channel the user asked for by name.
#
# The payload is a stub tarball (a placeholder prime-agent.exe): this test
# exercises the channel resolution and the fallback, not the binary — the
# real-binary proof is the install e2e beside it (test_windows_install.ps1),
# and the real-channel proof is the raw one-liner check in the same battery.
#
# Usage (from the repo root, on windows-latest):
#   pwsh -NoProfile -File scripts/release/test_windows_channel_fallback.ps1

$ErrorActionPreference = 'Stop'

$repo = (Get-Location).Path
$scratch = Join-Path ([IO.Path]::GetTempPath()) ("prime-agent-channel-fallback-{0}" -f [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $scratch | Out-Null

# The Python interpreter for the local http server (the install e2e's pattern).
$py = if (Get-Command python3 -ErrorAction SilentlyContinue) { 'python3' } else { 'python' }

$stableVersion = '9.9.9'
$betaVersion = '9.9.9-beta.1'
$platform = 'win32-x64'

# The stub artifact the beta release prefix serves: a tarball whose payload
# is a placeholder exe (the install only checks the payload exists).
$payload = Join-Path $scratch 'payload'
New-Item -ItemType Directory -Path $payload | Out-Null
Set-Content -LiteralPath (Join-Path $payload 'prime-agent.exe') -Value 'stub payload for the channel-fallback regression test'
$artifactFile = "prime-agent-$betaVersion-$platform.tar.gz"
$artifact = Join-Path $scratch $artifactFile
& tar -czf $artifact -C $payload prime-agent.exe
if ($LASTEXITCODE -ne 0) { throw 'the stub artifact build failed (tar)' }
$artifactSha = (Get-FileHash -LiteralPath $artifact -Algorithm SHA256).Hash.ToLower()

# The local channel: the stable pointer + manifest WITHOUT a win32-x64 row
# (the real stable channel's shape while Windows rides the beta channel
# only), the beta pointer + manifest WITH the row, the versioned release
# prefix with the artifact + its sums.
$channel = Join-Path $scratch 'channel'
$releaseDir = Join-Path $channel "releases\v$betaVersion"
New-Item -ItemType Directory -Path $releaseDir -Force | Out-Null
Move-Item -LiteralPath $artifact -Destination $releaseDir
Set-Content -LiteralPath (Join-Path $releaseDir 'SHA256SUMS') -Value "$artifactSha  $artifactFile"
Set-Content -LiteralPath (Join-Path $channel 'stable') -Value $stableVersion -NoNewline
Set-Content -LiteralPath (Join-Path $channel 'latest.json') -Value ('{"version": "v' + $stableVersion + '", "binaries": [], "binaries_v2": []}')
Set-Content -LiteralPath (Join-Path $channel 'beta') -Value $betaVersion -NoNewline
$betaRow = '{"platform": "' + $platform + '", "file": "' + $artifactFile + '", "sha256": "' + $artifactSha + '"}'
Set-Content -LiteralPath (Join-Path $channel 'beta.json') -Value ('{"version": "v' + $betaVersion + '", "binaries": [' + $betaRow + '], "binaries_v2": [' + $betaRow + ']}')

# One install run under a given channel knob, with the transcript captured.
# It dials the channel server's $baseUrl, which the try block below learns
# from the server itself.
function Invoke-Installer {
    param([string]$ChannelKnob, [string]$Prefix)
    Remove-Item -Path 'Env:PRIME_AGENT_DOWNLOAD_BASE_URL', 'Env:PRIME_AGENT_RELEASE_CHANNEL', 'Env:PRIME_AGENT_RUST_PREFIX', 'Env:PRIME_AGENT_ALLOW_HTTP', 'Env:PRIME_AGENT_VERSION' -ErrorAction SilentlyContinue
    $env:PRIME_AGENT_DOWNLOAD_BASE_URL = $baseUrl
    $env:PRIME_AGENT_ALLOW_HTTP = '1'
    $env:PRIME_AGENT_RUST_PREFIX = $Prefix
    if ($ChannelKnob) { $env:PRIME_AGENT_RELEASE_CHANNEL = $ChannelKnob }
    $lines = @(& pwsh -NoProfile -File (Join-Path $repo 'install.ps1') 2>&1 | ForEach-Object { "$_" })
    return [pscustomobject]@{ Lines = $lines; Exit = $LASTEXITCODE }
}

# The server picks and holds its own port (http.server on port 0: the OS
# hands the port out atomically, so no other process can claim it) and
# announces it on stdout; -u flushes the announcement immediately, and the
# test reads it back from the log.
$serverLog = Join-Path $scratch 'channel-server.log'
$server = Start-Process -FilePath $py -ArgumentList '-u','-m','http.server','0','--bind','127.0.0.1','--directory',$channel -PassThru -WindowStyle Hidden -RedirectStandardOutput $serverLog
try {
    # The port the server itself announced, then readiness is it answering
    # a request for this test's own channel (beta.json): bounded deadlines,
    # and a dead child fails fast instead of hanging the installer.
    $deadline = (Get-Date).AddSeconds(30)
    $port = $null
    while ($null -eq $port) {
        if ($server.HasExited) { throw "the local channel server exited early" }
        if ((Get-Date) -gt $deadline) { throw "the local channel server did not announce its port within 30s" }
        $announced = Select-String -LiteralPath $serverLog -Pattern 'port (\d+)' -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($announced) { $port = [int]$announced.Matches[0].Groups[1].Value }
        if ($null -eq $port) { Start-Sleep -Milliseconds 100 }
    }
    $baseUrl = "http://127.0.0.1:$port"
    $ready = $false
    while (-not $ready) {
        if ($server.HasExited) { throw "the local channel server exited early (port $port)" }
        if ((Get-Date) -gt $deadline) { throw "the local channel server did not answer on $baseUrl within 30s" }
        try {
            $probe = Invoke-WebRequest -Uri "$baseUrl/beta.json" -TimeoutSec 2
            if ($probe.StatusCode -eq 200) { $ready = $true }
        } catch {
            Start-Sleep -Milliseconds 100
        }
    }

    # Case 1: the default channel falls back to beta and installs.
    $prefixA = Join-Path $scratch 'prefix-a'
    New-Item -ItemType Directory -Path $prefixA | Out-Null
    $runA = Invoke-Installer -Channel $null -Prefix $prefixA
    if ($runA.Exit -ne 0) {
        $runA.Lines | Write-Host
        throw "the default-channel install failed (exit $($runA.Exit))"
    }
    $transcriptA = $runA.Lines -join [Environment]::NewLine
    if ($transcriptA -notmatch [regex]::Escape("stable does not ship Windows builds yet; installing from the beta channel")) {
        throw 'the fallback notice is missing from the default-channel transcript'
    }
    if ($transcriptA -notmatch [regex]::Escape("installing prime-agent $betaVersion from the beta channel ($platform)")) {
        throw 'the default-channel install did not resolve the beta channel'
    }
    $markerPath = Join-Path $prefixA 'share\prime-agent\.prime-agent-install'
    if (-not (Test-Path $markerPath -PathType Leaf)) { throw "the install marker is missing: $markerPath" }
    $marker = Get-Content -LiteralPath $markerPath -Raw
    if ($marker -ne "install-rust.sh channel beta`nversion $betaVersion") { throw "the install marker says '$marker' instead of the beta channel" }
    if (-not (Test-Path (Join-Path $prefixA 'share\prime-agent\prime-agent.exe') -PathType Leaf)) { throw 'the beta payload is missing from the default-channel install' }

    # Case 2: an explicitly requested channel refuses with the beta route.
    $prefixB = Join-Path $scratch 'prefix-b'
    New-Item -ItemType Directory -Path $prefixB | Out-Null
    $runB = Invoke-Installer -Channel 'stable' -Prefix $prefixB
    if ($runB.Exit -eq 0) {
        $runB.Lines | Write-Host
        throw 'the explicitly requested stable channel must refuse (no win32-x64 row)'
    }
    $transcriptB = $runB.Lines -join [Environment]::NewLine
    if ($transcriptB -notmatch [regex]::Escape('the explicitly requested stable channel ships no win32-x64 build yet')) {
        throw 'the explicit-channel refusal is missing its headline'
    }
    if ($transcriptB -notmatch [regex]::Escape('$env:PRIME_AGENT_RELEASE_CHANNEL = ''beta''; irm https://raw.githubusercontent.com/PrimeIntellect-ai/prime-agent/main/install.ps1 | iex')) {
        throw 'the explicit-channel refusal does not spell out the beta one-liner'
    }

    Write-Host "WIN_CHANNEL_FALLBACK default->beta=$betaVersion notice+marker verified; explicit-stable refused with the beta route"
} finally {
    Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force $scratch -ErrorAction SilentlyContinue
}
