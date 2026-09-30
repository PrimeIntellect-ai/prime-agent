# test_windows_install.ps1 — the Windows install e2e (the windows-runtime-triage
# battery's install gates).
#
# WHAT IT PROVES: both Windows entry points install the REAL release artifact
# from a REAL channel shape —
#   1. assemble the win32-x64 tarball with the release pipeline's own
#      assemble_artifacts.py (the exact artifact the channel ships),
#   2. serve a local channel (the pointer, latest.json, the versioned
#      release prefix) over localhost,
#   3. install.ps1 (the PowerShell-native route) into a scratch prefix,
#   4. install-rust.sh under Git Bash (the sh route) into another prefix,
#   5. assert each route's launcher answers --version and the payload
#      layout carries the .exe binary + the runtime sidecar + skills.
#
# The kernel pre-warm rides its no-uv note path (the runner has no uv; the
# install must still succeed — the first session bootstraps online).
#
# Usage (from the repo root, on windows-latest):
#   pwsh -File scripts/release/test_windows_install.ps1

$ErrorActionPreference = 'Stop'

$repo = (Get-Location).Path
$scratch = Join-Path ([IO.Path]::GetTempPath()) ("prime-agent-install-e2e-{0}" -f [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $scratch | Out-Null

# The Python interpreter (the assembler + the local http server).
$py = if (Get-Command python3 -ErrorAction SilentlyContinue) { 'python3' } else { 'python' }

# 1. The release binary + the bundled catalog assets.
& cargo build --release --locked -p pa-cli
if ($LASTEXITCODE -ne 0) { throw 'cargo build --release -p pa-cli failed' }
$assets = Join-Path $scratch 'catalog-assets'
& $py scripts/release/bundle_catalog.py generate --fixture --out $assets
if ($LASTEXITCODE -ne 0) { throw 'the catalog fixture generation failed' }

# 2. The channel artifact + its checksums (the assembler names the archive
#    by the platform alias the channel contract requires).
$dist = Join-Path $scratch 'dist'
$binary = Join-Path $repo 'target\release\prime-agent.exe'
if (-not (Test-Path $binary)) { throw "the release binary is missing: $binary" }
$version = & $binary --version
if (-not $version) { throw 'the release binary did not answer --version' }
& $py scripts/release/assemble_artifacts.py --repo-root $repo --version $version --target x86_64-pc-windows-msvc --binary $binary --catalog-assets $assets --out-dir $dist
if ($LASTEXITCODE -ne 0) { throw 'assemble_artifacts.py failed for the msvc target' }
$artifact = "prime-agent-$version-win32-x64.tar.gz"
if (-not (Test-Path (Join-Path $dist $artifact))) { throw "the assembled artifact is missing: $artifact" }

# 3. The local channel: the stable pointer, the manifest with the win32-x64
#    row (the shape release.yml's emission publishes), the versioned prefix.
$channel = Join-Path $scratch 'channel'
$releaseDir = Join-Path $channel "releases\v$version"
New-Item -ItemType Directory -Path $releaseDir -Force | Out-Null
Copy-Item (Join-Path $dist $artifact) $releaseDir
Copy-Item (Join-Path $dist 'SHA256SUMS') $releaseDir
Set-Content -LiteralPath (Join-Path $channel 'stable') -Value $version -NoNewline
$manifestRow = "{`"platform`": `"win32-x64`", `"file`": `"$artifact`", `"sha256`": `"$( (Get-FileHash -LiteralPath (Join-Path $releaseDir $artifact) -Algorithm SHA256).Hash.ToLower() )`"}"
Set-Content -LiteralPath (Join-Path $channel 'latest.json') -Value "{`"version`": `"v$version`", `"binaries`": [$manifestRow], `"binaries_v2`": [$manifestRow]}"

# 4. Serve the channel on localhost (the installers read everything from
#    this one base URL).
$server = Start-Process -FilePath $py -ArgumentList '-m','http.server','8123','--directory',$channel -PassThru -WindowStyle Hidden
try {
    Start-Sleep -Seconds 2
    $base = 'http://localhost:8123'

    # 5. Route A: install.ps1 (the PowerShell-native entry point). The local
    #    channel rides the explicitly-named plaintext knob (the installers'
    #    https rule has exactly this escape hatch; a real channel is always
    #    https).
    $prefixA = Join-Path $scratch 'prefix-a'
    New-Item -ItemType Directory -Path $prefixA | Out-Null
    $env:PRIME_AGENT_DOWNLOAD_BASE_URL = $base
    $env:PRIME_AGENT_RELEASE_CHANNEL = 'stable'
    $env:PRIME_AGENT_RUST_PREFIX = $prefixA
    $env:PRIME_AGENT_ALLOW_HTTP = '1'
    & pwsh -File (Join-Path $repo 'install.ps1')
    if ($LASTEXITCODE -ne 0) { throw 'install.ps1 failed' }
    $cmdLauncher = Join-Path $prefixA 'bin\prime-agent.cmd'
    if (-not (Test-Path $cmdLauncher)) { throw "the cmd launcher is missing: $cmdLauncher" }
    $versionA = (& $cmdLauncher --version) | Select-Object -First 1
    if ($versionA -ne $version) { throw "the cmd launcher answered '$versionA' instead of '$version'" }
    foreach ($entry in @('share\prime-agent\prime-agent.exe', 'share\prime-agent\prime-agent-runtime\pyproject.toml', 'share\prime-agent\LICENSE', 'share\prime-agent\skills')) {
        if (-not (Test-Path (Join-Path $prefixA $entry))) { throw "the ps1 route's payload is missing $entry" }
    }

    # 6. Route B: install-rust.sh under Git Bash (the sh entry point).
    $prefixB = Join-Path $scratch 'prefix-b'
    New-Item -ItemType Directory -Path $prefixB | Out-Null
    $bash = 'C:\Program Files\Git\bin\bash.exe'
    if (-not (Test-Path $bash)) { throw "Git Bash is required for the sh route: $bash" }
    $env:PRIME_AGENT_DOWNLOAD_BASE_URL = $base
    $env:PRIME_AGENT_RELEASE_CHANNEL = 'stable'
    $env:PRIME_AGENT_RUST_PREFIX = $prefixB
    $env:PRIME_AGENT_ALLOW_HTTP = '1'
    & $bash (Join-Path $repo 'install-rust.sh')
    if ($LASTEXITCODE -ne 0) { throw 'install-rust.sh failed under Git Bash' }
    $shLauncher = Join-Path $prefixB 'bin\prime-agent'
    if (-not (Test-Path $shLauncher)) { throw "the sh launcher is missing: $shLauncher" }
    $cmdLauncherB = Join-Path $prefixB 'bin\prime-agent.cmd'
    if (-not (Test-Path $cmdLauncherB)) { throw "the sh route must also write the cmd twin: $cmdLauncherB" }
    # The MSYS form of the prefix (bash cannot parse the drive-letter spelling
    # inside its own quoting).
    $prefixBMsys = (& $bash -c ("cygpath -u '" + $prefixB + "'")).Trim()
    $versionB = (& $bash -c ('"' + $prefixBMsys + '/bin/prime-agent" --version') | Select-Object -First 1)
    if ($versionB -ne $version) { throw "the sh launcher answered '$versionB' instead of '$version'" }
    foreach ($entry in @('share\prime-agent\prime-agent.exe', 'share\prime-agent\prime-agent-runtime\pyproject.toml')) {
        if (-not (Test-Path (Join-Path $prefixB $entry))) { throw "the sh route's payload is missing $entry" }
    }

    Write-Host "WIN_INSTALL_E2E ps1=$versionA sh=${versionB}: both routes installed the ${version} win32-x64 payload and answered --version"
} finally {
    Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force $scratch -ErrorAction SilentlyContinue
}
