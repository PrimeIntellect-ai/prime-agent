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
# install.ps1 writes the User PATH (the PATH-parity flow) and installs uv
# when the machine has none (the astral route); the harness strips exactly
# its own scratch-prefixed PATH entries in the cleanup below. THE UV
# BINARIES ARE THE USER'S OWN STATE (the
# reviewers' finding): an unconditional cleanup delete destroyed a
# pre-existing ~/.local/bin install, so both binaries are snapshotted
# (byte backups) before the installer runs and restored in the cleanup
# below - the test deletes only the files it itself created. The snapshot
# runs INSIDE the try, so a snapshot failure still lands in the finally
# (the server stops, the scratch goes); a half-done snapshot neither
# restores a backup that does not exist nor deletes a file it never
# recorded (the $uvSnapshotDone guard below).
$uvBinDir = Join-Path $HOME '.local\bin'
$uvSnapshotDir = Join-Path $scratch 'uv-snapshot'
$uvBinaries = @('uv.exe', 'uvx.exe')
$uvBefore = @{}
$uvSnapshotDone = $false
# The kernel pre-warm's writes (the venv, uv's cache, uv's pythons) would
# land in the real user profile; the harness steers all three into its own
# scratch dir through the product's override knobs and restores the
# caller's values in the cleanup (the discipline install.ps1 itself runs).
$callerKernelVenv = $env:PRIME_AGENT_KERNEL_VENV
$callerUvCacheDir = $env:UV_CACHE_DIR
$callerUvPythonDir = $env:UV_PYTHON_INSTALL_DIR
try {
    foreach ($uvName in $uvBinaries) {
        $uvBefore[$uvName] = Test-Path (Join-Path $uvBinDir $uvName) -PathType Leaf
        if ($uvBefore[$uvName]) {
            New-Item -ItemType Directory -Path $uvSnapshotDir -Force | Out-Null
            Copy-Item -LiteralPath (Join-Path $uvBinDir $uvName) -Destination (Join-Path $uvSnapshotDir $uvName) -Force
        }
    }
    $uvSnapshotDone = $true
    $env:PRIME_AGENT_KERNEL_VENV = Join-Path $scratch 'kernel-venv'
    $env:UV_CACHE_DIR = Join-Path $scratch 'uv-cache'
    $env:UV_PYTHON_INSTALL_DIR = Join-Path $scratch 'uv-python'
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
    # The User PATH: strip ONLY the entries this test added - the ones
    # under its own scratch dir - from the CURRENT registry value, never
    # a stale snapshot restore (a whole-value overwrite would clobber any
    # external PATH change made while the test ran) and never through
    # [Environment]::SetEnvironmentVariable (it flattens a REG_EXPAND_SZ
    # Path to plain REG_SZ with this run's expansion frozen in). The raw
    # value rides out with its registry kind intact; a Path this test
    # created from nothing is deleted again; a Path it never touched is
    # not rewritten at all. A cleanup failure is recorded and the
    # remaining steps still run (the loud tail below reports it).
    $pathCleanFailed = $false
    $envKey = $null
    try {
        $envKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
        $rawUserPath = $envKey.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        $rawUserKind = [Microsoft.Win32.RegistryValueKind]::ExpandString
        if ($envKey.GetValueNames() -contains 'Path') {
            $rawUserKind = $envKey.GetValueKind('Path')
        }
        $allEntries = @($rawUserPath -split ';')
        $keptEntries = @($allEntries | Where-Object { -not $_.Trim().StartsWith($scratch, [System.StringComparison]::OrdinalIgnoreCase) })
        if ($keptEntries.Count -lt $allEntries.Count) {
            if ($keptEntries.Count -gt 0) {
                $envKey.SetValue('Path', ($keptEntries -join ';'), $rawUserKind)
            } else {
                $envKey.DeleteValue('Path', $false)
            }
        }
    } catch {
        $pathCleanFailed = $true
    } finally {
        if ($envKey) { $envKey.Close() }
    }
    # The uv binaries: a recorded pre-existing install is restored
    # byte-for-byte from its backup - a restore that FAILS (a locked
    # binary) is recorded and the remaining cleanup steps still run; a
    # file the snapshot recorded ABSENT is the test's own and leaves with
    # it; anything else - a snapshot that never completed, or a recorded
    # binary whose backup went missing - touches NOTHING: the delete below
    # runs only for files the snapshot itself recorded absent, so the
    # user's own uv can never be deleted. The loud tail below reports
    # every failure together, after the cleanup has finished (never
    # swallowed - a test that ends green with the user's uv replaced is a
    # silent restore failure).
    $uvRestoreFailed = @()
    foreach ($uvName in $uvBinaries) {
        $uvPath = Join-Path $uvBinDir $uvName
        if ($uvBefore[$uvName] -and (Test-Path (Join-Path $uvSnapshotDir $uvName))) {
            try {
                Copy-Item -LiteralPath (Join-Path $uvSnapshotDir $uvName) -Destination $uvPath -Force
            } catch {
                $uvRestoreFailed += $uvName
            }
        } elseif (-not $uvBefore[$uvName] -and $uvSnapshotDone) {
            Remove-Item -LiteralPath $uvPath -Force -ErrorAction SilentlyContinue
        } elseif ($uvBefore[$uvName] -and $uvSnapshotDone) {
            $uvRestoreFailed += $uvName
        }
    }
    $env:PRIME_AGENT_KERNEL_VENV = $callerKernelVenv
    $env:UV_CACHE_DIR = $callerUvCacheDir
    $env:UV_PYTHON_INSTALL_DIR = $callerUvPythonDir
    Remove-Item -Recurse -Force $scratch -ErrorAction SilentlyContinue
    if ($pathCleanFailed -or $uvRestoreFailed.Count -gt 0) {
        $cleanupFailures = @()
        if ($pathCleanFailed) {
            $cleanupFailures += 'could not clean the user PATH entries this test added'
        }
        if ($uvRestoreFailed.Count -gt 0) {
            $cleanupFailures += "could not restore the pre-existing uv binary ($($uvRestoreFailed -join ', ')): the restore failed or its byte backup went missing, so the file on disk may be the test's own; reinstall uv with: irm https://astral.sh/uv/install.ps1 | iex"
        }
        throw ($cleanupFailures -join '; ')
    }
}
