# install.ps1 — the Windows-native installer for Prime Agent (Rust build).
#
# THE ONE-LINER (the served copy carries the official domain + the stable
# channel rendered in by the release pipeline's publish step):
#
#   irm https://app.primeintellect.ai/prime-agent/install.ps1 | iex
#
# The Git Bash route is the same channel through install-rust.sh (the sh
# one-liner `curl -fsSL .../install.sh | sh` under Git Bash/MSYS2/Cygwin);
# this script is the PowerShell-native form. Both routes publish the SAME
# layout — $PREFIX\share\prime-agent\ (the payload) and $PREFIX\bin\
# (the launcher pair) — so either route can update the other's install.
#
# THE CHANNEL (install-rust.sh parity): the channel pointer (<base>/stable
# or <base>/beta) gives the version, the channel manifest (<base>/latest.json
# or <base>/beta.json) gives this platform's artifact row, and the versioned
# release prefix serves the tarball plus its SHA256SUMS; the checksum is
# verified before anything is published. NO GITHUB SURFACE anywhere in the
# user path.
#
# NO TYPESCRIPT TAKEOVER STEPS: the TypeScript product never shipped a
# Windows build, so there is no TS daemon, native install, or npm package
# to retire here — this installer publishes the Rust payload and stops
# this product's own daemon for the swap (a Windows process holds its
# binary open; the payload swap needs the daemon down first).
#
# Configuration (environment, install-rust.sh's own knobs):
#   PRIME_AGENT_DOWNLOAD_BASE_URL  the R2-backed download base
#   PRIME_AGENT_RELEASE_CHANNEL    stable | beta
#   PRIME_AGENT_VERSION            pin an exact version
#   PRIME_AGENT_RUST_PREFIX        install prefix (default: $HOME\.local)
#
# Prerequisites: Windows 10+ (tar.exe and Get-FileHash ship with the OS;
# the kernel's Python runtime bootstraps through uv on first session — the
# pre-warm below installs the venv when uv is available).

$ErrorActionPreference = 'Stop'

# The publish-rendered defaults: the release pipeline copies this file to
# <base>/install.ps1 with $DownloadBaseUrlDefault set to the R2 public base
# and $ReleaseChannelDefault set to the channel; the repo-file default IS
# the official domain, so the raw repo copy installs out of the box too.
$DownloadBaseUrlDefault = 'https://app.primeintellect.ai/prime-agent'
$ReleaseChannelDefault = 'stable'

function Fail($message) {
    # The download scratch (the tarball + the sums) rides every exit path:
    # Fail sweeps it before exiting (the bots' finding: accumulated release
    # tarballs in the temp folder).
    if (Get-Variable -Name download -Scope Script -ErrorAction SilentlyContinue) {
        Remove-Item -Recurse -Force $script:download -ErrorAction SilentlyContinue
    }
    Write-Error "install.ps1: $message"
    exit 1
}

# --- TLS floor (PowerShell 5.1 defaults can sit below TLS 1.2) ---------------
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch {
    Fail "could not enable TLS 1.2: $($_.Exception.Message)"
}

# --- the knobs ----------------------------------------------------------------
$baseUrl = if ($env:PRIME_AGENT_DOWNLOAD_BASE_URL) { $env:PRIME_AGENT_DOWNLOAD_BASE_URL } else { $DownloadBaseUrlDefault }
$channel = if ($env:PRIME_AGENT_RELEASE_CHANNEL) { $env:PRIME_AGENT_RELEASE_CHANNEL } else { $ReleaseChannelDefault }
$versionPin = $env:PRIME_AGENT_VERSION
$prefix = if ($env:PRIME_AGENT_RUST_PREFIX) { $env:PRIME_AGENT_RUST_PREFIX } else { Join-Path $HOME '.local' }

# THE HTTPS RULE: the channel is served over the R2-backed domain, and a
# plaintext download base would let a network attacker swap the payload
# the checksum then "verifies" into place. The one escape hatch is the
# explicitly-named knob for local-channel/e2e use (install-rust.sh carries
# the same rule + knob); it prints a loud warning when it is active.
$allowHttp = $env:PRIME_AGENT_ALLOW_HTTP -eq '1'
if ($baseUrl -notmatch '^https://') {
    if ($allowHttp) {
        Write-Warning "PRIME_AGENT_ALLOW_HTTP=1: the download base $baseUrl is NOT https - the download is plaintext; use this only for a local channel you control"
    } else {
        Fail "the download base URL must be an https URL: $baseUrl"
    }
}
$baseUrl = $baseUrl.TrimEnd('/')
if (@('stable', 'beta') -notcontains $channel) { Fail "unknown release channel: $channel (stable or beta)" }
# The prefix does not need to exist (a fresh Windows profile has no
# $HOME\.local; the share/bin creation below makes it), but it must name
# a directory path, not an existing FILE.
if (Test-Path $prefix -PathType Leaf) { Fail "the install prefix names an existing file: $prefix" }

# The channel files: the pointer names the version, the manifest the rows.
$manifestName = if ($channel -eq 'beta') { 'beta.json' } else { 'latest.json' }
$pointerName = $channel

# The platform this script serves: the channel manifest's win32-x64 row
# (the TS NATIVE_PLATFORMS spelling pa-core::update::install reads) — a
# fixed target, checked here so an ARM64 Windows machine fails loudly
# instead of downloading a payload it cannot start.
$platform = 'win32-x64'
# The OS architecture, not the process's: 32-bit PowerShell on x64 Windows
# (WOW64) reports PROCESSOR_ARCHITECTURE=x86 and the OS arm rides
# PROCESSOR_ARCHITEW6432 — the 64-bit OS must not be refused (Macroscope:
# the WOW64 shape).
$effectiveArchitecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
if ($effectiveArchitecture -ne 'AMD64') {
    Fail "this machine reports architecture '$effectiveArchitecture'; the Windows channel ships the x86_64 (win32-x64) build only"
}

# The channel naming contract gives the artifact row's file name: the row
# the channel manifest must carry for this platform (the reader's own rule,
# pa-core::update::release::parse_channel_manifest).
function ExpectedFileName($version, $platform) {
    return "prime-agent-$version-$platform.tar.gz"
}

# --- resolve the version (the channel pointer, or the pinned version) --------
# A PINNED version skips the channel manifest entirely (install-rust.sh
# parity): the manifest describes the channel's CURRENT release, and a
# historical pin must install from its own versioned prefix — the row is
# the channel naming contract, and the release prefix's SHA256SUMS verifies
# the artifact. An unpinned install reads the pointer + the manifest as a
# PAIR, retrying once on a version mismatch (the publish writes the
# manifest first and the pointer second: a read between the two writes sees
# the old pointer with the new manifest — a transient window, not a broken
# channel — install-rust.sh's consistency retry).
$manifest = $null
$manifestVersion = $null
$row = $null
if ($versionPin) {
    $version = $versionPin.TrimStart('v')
    Write-Host "installing prime-agent $version (pinned) from the $channel channel ($platform)"
} else {
    $attempt = 0
    while ($true) {
        $version = (Invoke-RestMethod -Uri "$baseUrl/$pointerName").ToString().Trim()
        if (-not $version) { Fail "could not resolve the latest $channel version from $baseUrl/$pointerName" }
        $manifest = Invoke-RestMethod -Uri "$baseUrl/$manifestName"
        $manifestVersion = ($manifest.version).ToString().TrimStart('v')
        if ($manifestVersion -eq $version) { break }
        $attempt += 1
        if ($attempt -gt 2) {
            Fail "the $channel manifest's version $manifestVersion does not match the channel pointer $version (re-read twice; the channel looks inconsistent)"
        }
        Write-Host "the $channel pointer and manifest disagree (a publish's consistency window); re-reading the pair..."
        Start-Sleep -Seconds 1
    }
    Write-Host "installing prime-agent $version from the $channel channel ($platform)"
}

# --- the channel manifest row (unpinned) / the naming contract (pinned) ------
$expectedFile = ExpectedFileName $version $platform
if (-not $versionPin) {
    foreach ($candidate in @($manifest.binaries_v2) + @($manifest.binaries)) {
        if ($candidate -and $candidate.platform -eq $platform) {
            if ($candidate.file -ne $expectedFile) {
                Fail "the manifest's $platform row names '$($candidate.file)' instead of the channel naming '$expectedFile'"
            }
            $row = $candidate
            break
        }
    }
    if (-not $row) { Fail "no artifact row for platform $platform in the $channel manifest" }
    if ($row.sha256 -notmatch '^[0-9a-f]{64}$') { Fail "the channel manifest's sha256 for $expectedFile is malformed" }
} else {
    Write-Host "pinned ${version}: installing from the versioned release prefix (the channel naming contract names the row)"
}

# --- the tarball + SHA256SUMS from the versioned release prefix ----------------
$releasePrefix = "releases/v$version"
$download = Join-Path ([IO.Path]::GetTempPath()) ("prime-agent-download-{0}" -f [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $download | Out-Null
# THE DOWNLOAD SWEEP: the scratch (the tarball + the sums) is removed when
# this script exits - success, a Fail, or a terminating error (install-
# rust.sh's `rm -rf "$dl"` discipline; the bots' finding: accumulated
# release tarballs in the temp folder). A script-scoped trap carries the
# cleanup through the non-local Fail exits.
trap {
    Remove-Item -Recurse -Force $download -ErrorAction SilentlyContinue
    break
}
$tarball = Join-Path $download $expectedFile
$sumsPath = Join-Path $download 'SHA256SUMS'
try {
    Invoke-WebRequest -Uri "$baseUrl/$releasePrefix/$expectedFile" -OutFile $tarball
    Invoke-WebRequest -Uri "$baseUrl/$releasePrefix/SHA256SUMS" -OutFile $sumsPath
} catch {
    Fail "could not download $expectedFile from $baseUrl/$releasePrefix/: $($_.Exception.Message)"
}

# --- verify the checksum (the release prefix's sums, cross-checked with the
# --- manifest's row: two independent reads of the same digest) ------------------
$sumsLine = Get-Content -LiteralPath $sumsPath | Where-Object { $_ -match "  $expectedFile$" } | Select-Object -First 1
if (-not $sumsLine) { Fail "SHA256SUMS in $releasePrefix has no line for $expectedFile" }
$sumsSha = ($sumsLine -split '\s+')[0]
if (-not $versionPin -and $sumsSha -ne $row.sha256) { Fail "checksum mismatch between the channel manifest and SHA256SUMS for ${expectedFile}: the channel is inconsistent" }
$actualSha = (Get-FileHash -LiteralPath $tarball -Algorithm SHA256).Hash.ToLower()
if ($actualSha -ne $sumsSha) { Fail "checksum mismatch for ${expectedFile}: the download is corrupt" }
Write-Host "checksum verified: $expectedFile ($version, the $channel channel)"

# --- extract to a staging dir inside the prefix (same volume: the final swap
# --- is a rename, not a copy) -----------------------------------------------------
$share = Join-Path $prefix 'share\prime-agent'
$bin = Join-Path $prefix 'bin'
New-Item -ItemType Directory -Path (Join-Path $prefix 'share') -Force | Out-Null
New-Item -ItemType Directory -Path $bin -Force | Out-Null
$stage = Join-Path (Join-Path $prefix 'share') ("prime-agent.stage-{0}" -f [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
& tar -xzf $tarball -C $stage
if ($LASTEXITCODE -ne 0) { Fail "could not extract $expectedFile (tar exited $LASTEXITCODE)" }
$payloadExe = Join-Path $stage 'prime-agent.exe'
if (-not (Test-Path $payloadExe -PathType Leaf)) { Fail "the tarball did not contain a prime-agent.exe payload" }

# The ownership marker (install-rust.sh's exact write shape — the update
# funnel's channel-stickiness read keys on it).
$channelLine = "install-rust.sh channel $channel"
$marker = "$channelLine`nversion $version"
Set-Content -LiteralPath (Join-Path $stage '.prime-agent-install') -Value $marker -NoNewline

# The launcher paths (the section below the publish writes both).
$launcher = Join-Path $bin 'prime-agent.cmd'
$shLauncher = Join-Path $bin 'prime-agent'

# --- the publication lock (one writer): a lock DIRECTORY is the atomic
# --- claim on Windows (mkdir wins exactly once); the holder's pid rides a
# --- file inside, and a stale lock is never auto-stolen. THE LOCK COMES
# --- FIRST: a failed lock claim must never have stopped a daemon (the
# --- bots' finding - the stop-for-nothing downtime).
$lockDir = Join-Path (Join-Path $prefix 'share') '.prime-agent-install.lock.d'
try {
    New-Item -ItemType Directory -Path $lockDir -ErrorAction Stop | Out-Null
} catch {
    $heldBy = ''
    $pidPath = Join-Path $lockDir 'pid'
    if (Test-Path $pidPath) { $heldBy = (Get-Content -LiteralPath $pidPath -ErrorAction SilentlyContinue) }
    Fail "another installer (pid $heldBy) or a stale publication lock owns $lockDir; if no installer is running, remove it and re-run"
}
Set-Content -LiteralPath (Join-Path $lockDir 'pid') -Value $PID

$published = $false
try {
    # THE DAEMON STOP, inside the lock's try (a terminating error in the
    # stop must still release the lock - the bots' finding: the stale lock
    # otherwise left behind). THE TRUSTED STOP: the previous payload's own
    # binary (the marked share tree's prime-agent.exe), never the launcher -
    # a launcher this installer has not verified is the unowned-execution
    # shape (an attacker-placed bin\prime-agent.cmd would otherwise run
    # with the installer's inherited environment); the share's ownership
    # marker gates the stop, and a fresh install (no marked payload yet)
    # has no daemon the stop could reach.
    $payloadStopExe = Join-Path $share 'prime-agent.exe'
    $shareMarker = Join-Path $share '.prime-agent-install'
    if ((Test-Path $shareMarker -PathType Leaf) -and (Test-Path $payloadStopExe -PathType Leaf)) {
        Write-Host 'stopping the running Rust daemon before the publish (a Windows process holds its binary open)'
        & $payloadStopExe shutdown *> $null
        if ($LASTEXITCODE -ne 0) {
            & $payloadStopExe shutdown --force *> $null
            if ($LASTEXITCODE -ne 0) {
                Write-Warning "no daemon answered the shutdown requests; if a daemon is running, stop it by hand (prime-agent shutdown --force) and re-run"
            }
        }
    }

    # The one-generation rollback: the previous payload (marker-checked —
    # an unowned directory is never claimed, and an unowned ROLLBACK name is
    # never deleted) moves aside, the fresh stage swaps in, and the next
    # install sweeps the rollback.
    $rollback = Join-Path (Join-Path $prefix 'share') 'prime-agent.old'
    if (Test-Path $share -PathType Container) {
        $markerPath = Join-Path $share '.prime-agent-install'
        if (-not (Test-Path $markerPath -PathType Leaf)) {
            Fail "refusing to take ownership of ${share}: it is not a marked prime-agent payload tree (.prime-agent-install); move it aside and re-run"
        }
        if (Test-Path $rollback) {
            $rollbackMarker = Join-Path $rollback '.prime-agent-install'
            if (-not (Test-Path $rollbackMarker -PathType Leaf)) {
                Fail "refusing to delete the unmarked rollback directory: $rollback (move it aside and re-run)"
            }
            Remove-Item -Recurse -Force $rollback
        }
        [IO.Directory]::Move($share, $rollback)
        Write-Host "rollback: $rollback (the previous payload, one generation)"
    }
    [IO.Directory]::Move($stage, $share)
    $published = $true
} finally {
    # A failed publish never leaves the machine without its previous payload:
    # the old tree returns to the live name before the lock releases (the sh
    # installer's restore-on-exit discipline).
    if (-not $published -and (Test-Path $rollback -PathType Container) -and -not (Test-Path $share)) {
        [IO.Directory]::Move($rollback, $share)
        Write-Warning "the publish failed; the previous payload was restored to $share"
    }
    Remove-Item -Recurse -Force $lockDir -ErrorAction SilentlyContinue
}

# --- the launcher pair: the cmd shim (cmd.exe + PowerShell) and the sh
# --- launcher (Git Bash) — the same payload, both shells, the same content
# --- install-rust.sh writes. The unowned-file discipline is the sh
# --- installer's own: a launcher this script did not write is preserved
# --- aside, never overwritten (an unrelated command is never destroyed)
# --- AND a failure after a preserve puts the user's file back (the sh
# --- installer's restore-on-exit contract; the bots' finding).
$preservedLaunchers = @()
function Preserve-UnownedLauncher($path) {
    if (-not (Test-Path $path -PathType Leaf)) { return }
    $firstLine = (Get-Content -LiteralPath $path -TotalCount 2) -join ' '
    if ($firstLine -match 'launcher written by install-rust\.sh') { return }
    $preserved = "$path.pre-takeover"
    while (Test-Path $preserved) { $preserved = "$preserved.$([Guid]::NewGuid().ToString('N').Substring(0,4))" }
    [IO.File]::Move($path, $preserved)
    $script:preservedLaunchers += ,@($preserved, $path)
    Write-Host "note: an unrelated $(Split-Path -Leaf $path) existed at $path; it was preserved at $preserved"
}
Preserve-UnownedLauncher $launcher
Preserve-UnownedLauncher $shLauncher

try {
    $cmdShim = @'
@echo off
rem prime-agent - launcher written by install-rust.sh.
if not defined PRIME_AGENT_CODING_AGENT_DIR set "PRIME_AGENT_CODING_AGENT_DIR=%USERPROFILE%\.prime\agent"
"%~dp0..\share\prime-agent\prime-agent.exe" %*
'@
    Set-Content -LiteralPath $launcher -Value $cmdShim

    $shBody = @'
#!/bin/sh
# prime-agent — launcher written by install-rust.sh.
export PRIME_AGENT_CODING_AGENT_DIR="${PRIME_AGENT_CODING_AGENT_DIR:-$HOME/.prime/agent}"
exec "$(dirname "$0")/../share/prime-agent/prime-agent.exe" "$@"
'@
    # LF endings + no BOM: the sh launcher must stay a POSIX file.
    [IO.File]::WriteAllText($shLauncher, $shBody.Replace("`r`n", "`n"))
} catch {
    # A failed launcher write never leaves the machine without its command:
    # every preserved file goes home before the failure surfaces. The
    # destination's PARTIAL file (Set-Content/WriteAllText can create or
    # truncate before throwing) is removed first - the bots' finding: the
    # broken new file otherwise blocks the restore.
    foreach ($pair in $script:preservedLaunchers) {
        if (Test-Path $pair[1]) { Remove-Item -Force $pair[1] -ErrorAction SilentlyContinue }
        [IO.File]::Move($pair[0], $pair[1])
    }
    throw
}

# --- the kernel pre-warm: uv + the Python venv (best-effort, install-rust.sh
# --- parity — an offline machine still installs; the first session retries
# --- the bootstrap online).
$uv = Get-Command uv -ErrorAction SilentlyContinue
if (-not $uv -and (Test-Path (Join-Path $HOME '.local\bin\uv.exe'))) { $uv = $true }
if ($uv) {
    Write-Host 'kernel pre-warm: provisioning the Python kernel runtime'
    & $launcher --prime-agent-bootstrap
    if ($LASTEXITCODE -ne 0) {
        Write-Warning 'the kernel pre-warm failed (the install stands; the first session will retry it online)'
    }
} else {
    Write-Host 'note: uv was not found; the first session bootstraps the kernel itself and needs the network once'
}

# --- the PATH note (warn, not fail — install-rust.sh parity) ---------------------
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$bin*") {
    Write-Host "note: $bin is not on your PATH; add it for the prime-agent command:"
    Write-Host "  [Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','User') + ';$bin', 'User')"
}

# --- verify: the launcher must answer --version -----------------------------------
try {
    $versionOut = (& $launcher --version) 2>$null | Select-Object -First 1
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "the installed launcher failed --version (exit code $LASTEXITCODE; the first run bootstraps the kernel venv — re-run it)"
    } else {
        Write-Host "installed: $versionOut"
    }
} catch {
    Write-Warning "the first --version run failed (the first run bootstraps the kernel venv — re-run it): $($_.Exception.Message)"
}
Write-Host "launcher:  $launcher"
Write-Host "payload:   $share"
Write-Host "source:    the $channel channel at $baseUrl (prime-agent $version)"
Write-Host 'next steps: the README''s Install section ships inside the payload:'
Write-Host "  $share\README.md"

Remove-Item -Recurse -Force $download -ErrorAction SilentlyContinue
