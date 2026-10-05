# install.ps1 — the Windows-native installer for Prime Agent (Rust build).
#
# THE ONE-LINER (the served copy carries the official domain + the stable
# channel rendered in by the release pipeline's publish step):
#
#   irm https://app.primeintellect.ai/prime-agent/install.ps1 | iex
#
# The repo copy's defaults are the same bucket-root base, so the raw form
# works out of the box too (the README's Windows command):
#
#   irm https://raw.githubusercontent.com/PrimeIntellect-ai/prime-agent/main/install.ps1 | iex
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
# THE WINDOWS CHANNEL FALLBACK: the stable releases predate Windows
# support, so the stable manifest carries no win32-x64 row until the first
# stable release ships one; a default-channel Windows install falls back
# to the beta channel with a printed notice, and a channel asked for by
# name refuses instead (the beta route spelled out).
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

# The whole body runs in a child scope: under `irm | iex` the script shares
# the caller's session, so the Stop preference and the installer's own
# variables must not stay behind in it, and a refusal must return to the
# prompt (Fail throws) instead of closing the user's PowerShell. The body
# stays unindented so the publish render's line-anchored sed still matches.
# Any failure reaches the catch at the bottom: run as a file it exits 1 (in
# PowerShell 7 and Windows PowerShell 5.1 alike, never relying on how an
# uncaught error or a trap's break maps to the exit code); under `irm | iex`
# ($PSCommandPath is empty) it rethrows to the caller instead, so the
# caller's session stays open.
try {
& {
$ErrorActionPreference = 'Stop'

# The publish-rendered defaults: the release pipeline copies this file to
# <base>/install.ps1 with $DownloadBaseUrlDefault set to the R2 public base
# and $ReleaseChannelDefault set to the channel; the repo-file default is
# the same bucket-root base install-rust.sh carries, so the raw repo copy
# installs out of the box too.
$DownloadBaseUrlDefault = 'https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev'
$ReleaseChannelDefault = 'stable'

# The installer-owned bookkeeping, initialized BEFORE any Fail can run
# (under `irm | iex` the script scope is the caller's session: ambient
# variables must never be read as this installer's state, so the names are
# unique to this script and all start cleared - the bots' finding).
$script:primeAgentInstallScratch = $null
$script:primeAgentInstallStage = $null
$script:primeAgentInstallLock = $null

# Fail only throws: the catch at the bottom sweeps the installer's own
# state on every failure path (a Fail and any other terminating error alike).
function Fail($message) {
    throw "install.ps1: $message"
}

# --- TLS floor (PowerShell 5.1 defaults can sit below TLS 1.2) ---------------
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch {
    Fail "could not enable TLS 1.2: $($_.Exception.Message)"
}

# --- the knobs ----------------------------------------------------------------
$baseUrl = if ($env:PRIME_AGENT_DOWNLOAD_BASE_URL) { $env:PRIME_AGENT_DOWNLOAD_BASE_URL } else { $DownloadBaseUrlDefault }
$channelRequested = $env:PRIME_AGENT_RELEASE_CHANNEL
$channel = if ($channelRequested) { $channelRequested } else { $ReleaseChannelDefault }
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

# The channel files: the pointer (<base>/stable or <base>/beta) names the
# version, the channel manifest (<base>/latest.json or <base>/beta.json)
# the rows; the version resolution below reads the pair per channel.

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
# channel — install-rust.sh's consistency retry). The pair reader is a
# function so the Windows channel fallback below re-resolves the beta
# channel through the same retry discipline.
function Read-ChannelPair($channelName) {
    $pairPointer = $channelName
    $pairManifestName = if ($channelName -eq 'beta') { 'beta.json' } else { 'latest.json' }
    $attempt = 0
    while ($true) {
        # The pointer is published bare ("1.2.3") but a `v`-prefixed
        # spelling is a valid historical form - normalize it (the manifest's
        # version is bare; the release prefix and the artifact names carry
        # no extra `v` - the bots' finding).
        $pairVersion = (Invoke-RestMethod -Uri "$baseUrl/$pairPointer").ToString().Trim().TrimStart('v')
        if (-not $pairVersion) { Fail "could not resolve the latest $channelName version from $baseUrl/$pairPointer" }
        $pairManifest = Invoke-RestMethod -Uri "$baseUrl/$pairManifestName"
        $pairManifestVersion = ($pairManifest.version).ToString().TrimStart('v')
        if ($pairManifestVersion -eq $pairVersion) { break }
        $attempt += 1
        if ($attempt -gt 2) {
            Fail "the $channelName manifest's version $pairManifestVersion does not match the channel pointer $pairVersion (re-read twice; the channel looks inconsistent)"
        }
        Write-Host "the $channelName pointer and manifest disagree (a publish's consistency window); re-reading the pair..."
        Start-Sleep -Seconds 1
    }
    return [pscustomobject]@{ Version = $pairVersion; Manifest = $pairManifest }
}

# The manifest's row for this platform: the channel naming contract gives
# the file name the row must carry (the reader's own rule,
# pa-core::update::release::parse_channel_manifest).
function Find-PlatformRow($rowManifest, $rowVersion) {
    $expected = ExpectedFileName $rowVersion $platform
    $found = $null
    foreach ($candidate in @($rowManifest.binaries_v2) + @($rowManifest.binaries)) {
        if ($candidate -and $candidate.platform -eq $platform) {
            if ($candidate.file -ne $expected) {
                Fail "the manifest's $platform row names '$($candidate.file)' instead of the channel naming '$expected'"
            }
            $found = $candidate
            break
        }
    }
    return $found
}

$manifest = $null
$row = $null
if ($versionPin) {
    $version = $versionPin.Trim().TrimStart('v')
    Write-Host "installing prime-agent $version (pinned) from the $channel channel ($platform)"
} else {
    $pair = Read-ChannelPair $channel
    $version = $pair.Version
    $manifest = $pair.Manifest
    $row = Find-PlatformRow $manifest $version
    # THE WINDOWS CHANNEL FALLBACK (the operator's real-machine report,
    # 2026-10-02): the plain one-liner threw "no artifact row for platform
    # win32-x64 in the stable manifest" - the stable releases predate
    # Windows support, and the win32-x64 build ships on the beta channel
    # only. A channel the user asked for BY NAME gets the honest refusal
    # (the beta route spelled out); the DEFAULT channel falls back to beta
    # with a printed notice, so the plain one-liner just works.
    if (-not $row) {
        if ($channelRequested -and $channelRequested -ne 'beta') {
            Fail ('the explicitly requested ' + $channelRequested + ' channel ships no ' + $platform + ' build yet; Windows builds ride the beta channel - re-run with the beta channel: ' + '$env:PRIME_AGENT_RELEASE_CHANNEL = ''beta''; irm https://raw.githubusercontent.com/PrimeIntellect-ai/prime-agent/main/install.ps1 | iex')
        } elseif ($channel -ne 'beta') {
            Write-Host "$channel does not ship Windows builds yet; installing from the beta channel"
            $channel = 'beta'
            $pair = Read-ChannelPair $channel
            $version = $pair.Version
            $manifest = $pair.Manifest
            $row = Find-PlatformRow $manifest $version
            if (-not $row) { Fail "no artifact row for platform $platform in the $channel manifest either (the Windows fallback found no beta build)" }
        } else {
            Fail "no artifact row for platform $platform in the $channel manifest"
        }
    }
    if ($row.sha256 -notmatch '^[0-9a-f]{64}$') { Fail "the channel manifest's sha256 for $(ExpectedFileName $version $platform) is malformed" }
    Write-Host "installing prime-agent $version from the $channel channel ($platform)"
}

# --- the channel manifest row (unpinned) / the naming contract (pinned) ------
$expectedFile = ExpectedFileName $version $platform
if ($versionPin) {
    Write-Host "pinned ${version}: installing from the versioned release prefix (the channel naming contract names the row)"
}

# --- the tarball + SHA256SUMS from the versioned release prefix ----------------
$releasePrefix = "releases/v$version"
$download = Join-Path ([IO.Path]::GetTempPath()) ("prime-agent-download-{0}" -f [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $download | Out-Null
$script:primeAgentInstallScratch = $download
# THE DOWNLOAD SWEEP: the scratch (the tarball + the sums) is removed when
# this script exits - success below, a Fail or a terminating error in the
# catch at the bottom (install-rust.sh's `rm -rf "$dl"` discipline; the
# bots' finding: accumulated release tarballs in the temp folder).
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
# The stage rides every exit path once created (the failure sweep at the bottom:
# a failed extraction/validation must not leave the extracted payload
# behind - the bots' finding).
$script:primeAgentInstallStage = $stage
& tar -xzf $tarball -C $stage
if ($LASTEXITCODE -ne 0) { Fail "could not extract $expectedFile (tar exited $LASTEXITCODE)" }
$payloadExe = Join-Path $stage 'prime-agent.exe'
if (-not (Test-Path $payloadExe -PathType Leaf)) { Fail "the tarball did not contain a prime-agent.exe payload" }

# The ownership marker (install-rust.sh's exact write shape — the update
# funnel's channel-stickiness read keys on it).
$channelLine = "install-rust.sh channel $channel"
$marker = "$channelLine`nversion $version"
# -Encoding Ascii keeps the marker byte-exact: Set-Content's default
# encoding follows $PSDefaultParameterValues['*:Encoding'] (UTF-16 or a
# BOM), and the update funnel's channel-stickiness read + the rollback's
# marker validation grep the raw ASCII line.
Set-Content -LiteralPath (Join-Path $stage '.prime-agent-install') -Value $marker -Encoding Ascii -NoNewline

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
try {
    Set-Content -LiteralPath (Join-Path $lockDir 'pid') -Value $PID
} catch {
    # A failed PID write releases the freshly claimed lock (the bots'
    # finding: the leaked lock otherwise blocks every later install).
    Remove-Item -Recurse -Force $lockDir -ErrorAction SilentlyContinue
    Fail "could not write the publication lock PID: $($_.Exception.Message)"
}
# The lock rides every exit path from here: Fail releases it, and the
# publish's finally releases + clears it.
$script:primeAgentInstallLock = $lockDir

$published = $false
$rollback = $null
$script:daemonStopped = $false

# THE PREFLIGHT: every ownership refusal that can happen runs BEFORE the
# daemon stop (a refused install must never have stopped a daemon - the
# bots' finding: the stop-then-refuse order was the avoidable downtime).
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
    }
}

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
        # THE SCRIPTED FORM: the CLI's bare `shutdown` prompts for
        # confirmation in an interactive terminal and REFUSES a
        # non-interactive one ("Shutdown requires confirmation in an
        # interactive terminal. Use prime-agent shutdown --force") - the
        # installer's context is the scripted one, so `--force` is the
        # documented non-interactive stop (the daemon's own forced
        # shutdown drains its workers with its internal budgets).
        & $payloadStopExe shutdown --force *> $null
        if ($LASTEXITCODE -eq 0) {
            $script:daemonStopped = $true
        } else {
            Write-Warning "no daemon answered the shutdown request; if a daemon is running, stop it by hand (prime-agent shutdown --force) and re-run"
        }
    }

    # The one-generation rollback (the ownership checks already ran in the
    # preflight): the previous payload moves aside, the fresh stage swaps
    # in, and the next install sweeps the rollback.
    if (Test-Path $share -PathType Container) {
        if (Test-Path $rollback) {
            Remove-Item -Recurse -Force $rollback
        }
        [IO.Directory]::Move($share, $rollback)
        Write-Host "rollback: $rollback (the previous payload, one generation)"
    }
    [IO.Directory]::Move($stage, $share)
    $script:primeAgentInstallStage = $null
    # The payload is live: no later launcher failure rolls it back (the new
    # tree is valid; the restored launchers point at ../share/prime-agent/
    # prime-agent.exe - the new payload - and keep working).
    $published = $true

    # --- the launcher pair: the cmd shim (cmd.exe + PowerShell) and the sh
    # --- launcher (Git Bash) - the same payload, both shells, the same
    # --- content install-rust.sh writes. THE LOCK STAYS HELD through the
    # --- launcher transaction (the bots' finding: a second installer must
    # --- not slip between the payload publish and the launcher write, or
    # --- its launcher would pair with this payload and a later failure of
    # --- EITHER installer would restore the other's .pre-takeover over
    # --- it). The unowned-file discipline is the sh installer's own: a
    # --- launcher this script did not write is preserved aside, never
    # --- overwritten (an unrelated command is never destroyed) AND a
    # --- failure after a preserve puts the user's file back. An
    # --- INSTALLER-OWNED launcher is snapshotted first (an I/O failure at
    # --- Set-Content can truncate a live, working launcher).
    # Script scope, the scope the helpers below append to: the reset must
    # hit the same arrays, or an earlier `irm | iex` run's entries in the
    # same session would be replayed by this run's recovery.
    $script:preservedLaunchers = @()
    $script:ownedLauncherBackups = @()
    function Backup-ExistingLauncher($path) {
        if (-not (Test-Path $path -PathType Leaf)) { return }
        $backup = "$path.install-backup"
        while (Test-Path $backup) { $backup = "$backup.$([Guid]::NewGuid().ToString('N').Substring(0,4))" }
        Copy-Item -LiteralPath $path -Destination $backup -Force
        $script:ownedLauncherBackups += ,@($backup, $path)
    }
    function Preserve-UnownedLauncher($path) {
        if (-not (Test-Path $path -PathType Leaf)) { return }
        $firstLine = (Get-Content -LiteralPath $path -TotalCount 2) -join ' '
        if ($firstLine -match 'launcher written by install-rust\.sh') {
            Backup-ExistingLauncher $path
            return
        }
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

        # The launchers are live: the owned-launcher snapshots (the failure
        # restore points) sweep away - nothing lingers after a success.
        foreach ($pair in $script:ownedLauncherBackups) {
            Remove-Item -Force $pair[0] -ErrorAction SilentlyContinue
        }
    } catch {
        # A failed launcher write never leaves the machine without its
        # command: every preserved file goes home, and every OWNED
        # launcher's pre-write snapshot is restored over its truncated
        # form, before the failure surfaces. The destination's PARTIAL
        # file (Set-Content/WriteAllText can create or truncate before
        # throwing) is removed first - the broken new file otherwise
        # blocks the restore.
        foreach ($pair in $script:preservedLaunchers) {
            if (Test-Path $pair[1]) { Remove-Item -Force $pair[1] -ErrorAction SilentlyContinue }
            [IO.File]::Move($pair[0], $pair[1])
        }
        foreach ($pair in $script:ownedLauncherBackups) {
            Copy-Item -LiteralPath $pair[0] -Destination $pair[1] -Force
            Remove-Item -Force $pair[0] -ErrorAction SilentlyContinue
        }
        throw
    }
} finally {
    # A failed publish never leaves the machine without its previous payload:
    # the old tree returns to the live name before the lock releases (the sh
    # installer's restore-on-exit discipline). $rollback is pre-initialized:
    # a terminating error before its assignment must not turn the finally's
    # own check into the leaked-lock failure.
    if (-not $published) {
        if ($rollback -and (Test-Path $rollback -PathType Container) -and -not (Test-Path $share)) {
            # The restore's own failure must not swallow the lock release
            # (an error thrown here would skip the Remove-Item below - the
            # stale-lock manual recovery class): the restore reports the
            # manual recovery instead of throwing.
            try {
                [IO.Directory]::Move($rollback, $share)
                Write-Warning "the publish failed; the previous payload was restored to $share"
            } catch {
                Write-Warning "the publish failed AND the previous payload could not be restored: it waits at $rollback - recover with: Move-Item '$rollback' '$share'"
            }
        }
        # A failed install sweeps its stage tree (the bots' finding: the
        # accumulated prime-agent.stage-* directories).
        if ($stage -and (Test-Path $stage -PathType Container)) {
            Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
        }
        # A daemon stopped for a FAILED install stays down (its sessions'
        # state is on disk; nothing here restarts it): name the recovery so
        # the user never guesses - the next invocation boots the old
        # payload's daemon again.
        if ($script:daemonStopped) {
            Write-Warning "the daemon stopped for this failed install stays down until the next prime-agent invocation boots it from the restored payload"
        }
    }
    Remove-Item -Recurse -Force $lockDir -ErrorAction SilentlyContinue
    $script:primeAgentInstallLock = $null
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

$script:primeAgentInstallScratch = $null
$script:preservedLaunchers = @()
$script:ownedLauncherBackups = @()
if ($download) { Remove-Item -Recurse -Force $download -ErrorAction SilentlyContinue }
}
} catch {
    # THE FAILURE SWEEP, the one cleanup path for every failure: exactly
    # what THIS script created - the download scratch, the stage tree, and
    # the publication lock it claimed (a refused install never leaks its
    # lock; the publish's finally has already released it when the failure
    # came from there). The names were cleared at the top, so an ambient
    # caller's variables never enter the cleanup.
    if ($script:primeAgentInstallScratch) {
        Remove-Item -Recurse -Force $script:primeAgentInstallScratch -ErrorAction SilentlyContinue
    }
    if ($script:primeAgentInstallStage) {
        Remove-Item -Recurse -Force $script:primeAgentInstallStage -ErrorAction SilentlyContinue
    }
    if ($script:primeAgentInstallLock) {
        Remove-Item -Recurse -Force $script:primeAgentInstallLock -ErrorAction SilentlyContinue
    }
    $script:primeAgentInstallScratch = $null
    $script:primeAgentInstallStage = $null
    $script:primeAgentInstallLock = $null
    if ($PSCommandPath) {
        $Host.UI.WriteErrorLine($_.Exception.Message)
        exit 1
    }
    throw
}
