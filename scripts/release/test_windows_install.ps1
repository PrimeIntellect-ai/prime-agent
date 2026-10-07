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
# The kernel pre-warm installs uv when it is missing (the astral route; the
# runner has no uv but the network is up), then bootstraps the kernel venv —
# offline the step degrades to an honest note and the install still succeeds.
#
# Usage (from the repo root, on windows-latest):
#   pwsh -File scripts/release/test_windows_install.ps1

$ErrorActionPreference = 'Stop'

$repo = (Get-Location).Path
$scratch = Join-Path ([IO.Path]::GetTempPath()) ("prime-agent-install-e2e-{0}" -f [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $scratch | Out-Null

# The Python interpreter (the assembler + the local http server).
$py = if (Get-Command python3 -ErrorAction SilentlyContinue) { 'python3' } else { 'python' }

# THE PE IMPORT WALK: the release artifact's DLL imports, read straight
# from the PE headers (no dumpbin dependency on the runner).
function Get-PeImportDlls {
    param([string]$Path)
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    $peOffset = [BitConverter]::ToInt32($bytes, 0x3C)
    $signature = [Text.Encoding]::ASCII.GetString($bytes, $peOffset, 4)
    if ($signature -ne "PE`0`0") { throw "not a PE file: $Path" }
    $optionalHeaderOffset = $peOffset + 24
    $magic = [BitConverter]::ToUInt16($bytes, $optionalHeaderOffset)
    if ($magic -ne 0x20B) { throw "not a PE32+ file (magic 0x{0:X4}): $Path" -f $magic }
    # PE32+ optional header: the data directories start at +112; the import
    # table is directory 1.
    $importRva = [BitConverter]::ToUInt32($bytes, $optionalHeaderOffset + 112 + 8)
    if ($importRva -eq 0) { return @() }
    $numSections = [BitConverter]::ToUInt16($bytes, $peOffset + 6)
    $sizeOfOptionalHeader = [BitConverter]::ToUInt16($bytes, $peOffset + 20)
    $sectionTableOffset = $peOffset + 24 + $sizeOfOptionalHeader
    function ConvertTo-FileOffset([int]$Rva) {
        for ($i = 0; $i -lt $numSections; $i++) {
            $section = $sectionTableOffset + ($i * 40)
            $virtualAddress = [BitConverter]::ToUInt32($bytes, $section + 12)
            $virtualSize = [BitConverter]::ToUInt32($bytes, $section + 8)
            $rawPointer = [BitConverter]::ToUInt32($bytes, $section + 20)
            if ($Rva -ge $virtualAddress -and $Rva -lt ($virtualAddress + $virtualSize)) {
                return $Rva - $virtualAddress + $rawPointer
            }
        }
        throw "rva 0x{0:X} lies outside every section" -f $Rva
    }
    $dlls = @()
    $descriptor = ConvertTo-FileOffset $importRva
    while ($true) {
        $nameRva = [BitConverter]::ToUInt32($bytes, $descriptor + 12)
        if ($nameRva -eq 0) { break }
        $nameOffset = ConvertTo-FileOffset $nameRva
        $end = $nameOffset
        while ($bytes[$end] -ne 0) { $end++ }
        $dlls += [Text.Encoding]::ASCII.GetString($bytes, $nameOffset, $end - $nameOffset)
        $descriptor += 20
    }
    return $dlls
}

# 1. The release binary + the bundled catalog assets. THE SHIPPED LINK MODE
# (the reviewer's finding): the release workflow builds the Windows binary
# with the step-scoped crt-static RUSTFLAGS; this e2e must install the
# SAME link mode - a plain dynamic build would pass the launcher smoke on
# this runner image (which carries vcruntime140.dll) and mask the stock-box
# 0xC0000135 regression the shipped static link exists to fix. The import
# walk below proves the built binary really dropped the redist runtime DLL.
$env:RUSTFLAGS = '-C target-feature=+crt-static'
try {
    & cargo build --release --locked -p pa-cli --bin prime-agent
} finally {
    $env:RUSTFLAGS = $null
}
if ($LASTEXITCODE -ne 0) { throw 'cargo build --release -p pa-cli failed' }
$assets = Join-Path $scratch 'catalog-assets'
& $py scripts/release/bundle_catalog.py generate --fixture --out $assets
if ($LASTEXITCODE -ne 0) { throw 'the catalog fixture generation failed' }

# 2. The channel artifact + its checksums (the assembler names the archive
#    by the platform alias the channel contract requires).
$dist = Join-Path $scratch 'dist'
$binary = Join-Path $repo 'target\release\prime-agent.exe'
if (-not (Test-Path $binary)) { throw "the release binary is missing: $binary" }
# The stock-box regression guard: the shipped binary must not import the
# redist VC runtime (the runner has it, a stock machine does not).
$importedDlls = Get-PeImportDlls -Path $binary
$vcImports = @($importedDlls | Where-Object { $_ -match 'vcruntime' })
if ($vcImports.Count -gt 0) {
    throw "the release binary imports the redist VC runtime ($($vcImports -join ', ')); the crt-static build did not take"
}
Write-Host "link mode: no vcruntime import ($($importedDlls.Count) DLL imports)"
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
# install.ps1 writes the User PATH (the PATH-parity flow); the e2e strips
# exactly its own scratch-prefixed PATH entries in the cleanup below (a
# stale whole-value snapshot would linger or clobber). THE UV INSTALL IS
# ISOLATED (the reviewers' finding): ownership of a file in the shared
# ~/.local/bin is unprovable (a transcript line proves an attempt, not a
# landing; a concurrent external install races the attribution) - so the
# harness never lets the installers touch the shared dir: both routes
# honor PRIME_AGENT_UV_BIN_DIR and the harness points it at its scratch.
# The uv PRE-STATE still guards the parity gate below - install.ps1 skips
# its uv branch when the machine already answers uv, so the gate runs
# only against the fresh-runner contract.
$uvWasOnPath = [bool](Get-Command uv -CommandType Application -ErrorAction SilentlyContinue) -or (Test-Path (Join-Path $HOME '.local\bin\uv.exe'))
# The kernel pre-warm's writes (the venv, uv's cache, uv's pythons) and the
# uv install itself would land in the real user profile; the harness
# steers all of them into its own scratch dir through the product's
# override knobs and restores the caller's values in the cleanup (the
# discipline install.ps1 itself runs).
$callerKernelVenv = $env:PRIME_AGENT_KERNEL_VENV
$callerUvCacheDir = $env:UV_CACHE_DIR
$callerUvPythonDir = $env:UV_PYTHON_INSTALL_DIR
$callerUvBinDir = $env:PRIME_AGENT_UV_BIN_DIR
try {
    $env:PRIME_AGENT_KERNEL_VENV = Join-Path $scratch 'kernel-venv'
    $env:UV_CACHE_DIR = Join-Path $scratch 'uv-cache'
    $env:UV_PYTHON_INSTALL_DIR = Join-Path $scratch 'uv-python'
    $env:PRIME_AGENT_UV_BIN_DIR = Join-Path $scratch 'uv-bin'
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
    # The transcript is captured (the fallback harness's pattern): it is the
    # uv gate's evidence below - the branch's own verdict, not the network's.
    $ps1Lines = @(& pwsh -File (Join-Path $repo 'install.ps1') 2>&1 | ForEach-Object { "$_" })
    if ($LASTEXITCODE -ne 0) { $ps1Lines | Write-Host; throw 'install.ps1 failed' }
    $ps1Transcript = $ps1Lines -join [Environment]::NewLine
    $cmdLauncher = Join-Path $prefixA 'bin\prime-agent.cmd'
    if (-not (Test-Path $cmdLauncher)) { throw "the cmd launcher is missing: $cmdLauncher" }
    $versionA = (& $cmdLauncher --version) | Select-Object -First 1
    if ($versionA -ne $version) { throw "the cmd launcher answered '$versionA' instead of '$version'" }
    foreach ($entry in @('share\prime-agent\prime-agent.exe', 'share\prime-agent\prime-agent-runtime\pyproject.toml', 'share\prime-agent\LICENSE', 'share\prime-agent\skills')) {
        if (-not (Test-Path (Join-Path $prefixA $entry))) { throw "the ps1 route's payload is missing $entry" }
    }
    # The uv parity gate asserts the CONTRACT, never astral.sh availability
    # (the reviewer's finding): the branch is best-effort by design - offline
    # it degrades to the honest note and the install still succeeds - so
    # the gate demands either the landed binary (the online path) or the
    # honest degradation in the transcript. A branch that lands NEITHER is
    # broken; the network being down is not.
    $uvExePath = Join-Path (Join-Path $scratch 'uv-bin') 'uv.exe'
    $uvLanded = Test-Path $uvExePath
    $degradedHonestly = $ps1Transcript -match [regex]::Escape('could not install uv; the kernel pre-warm was skipped')
    if (-not $uvWasOnPath -and -not $uvLanded -and -not $degradedHonestly) {
        throw "install.ps1's uv branch landed no uv.exe and no honest degradation note (the branch is broken, not the network)"
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
    # The uv install needs no cleanup: it never left the scratch dir (the
    # PRIME_AGENT_UV_BIN_DIR knob above steered both installers), and the
    # user's ~/.local/bin was never touched at all.
    $env:PRIME_AGENT_KERNEL_VENV = $callerKernelVenv
    $env:UV_CACHE_DIR = $callerUvCacheDir
    $env:UV_PYTHON_INSTALL_DIR = $callerUvPythonDir
    $env:PRIME_AGENT_UV_BIN_DIR = $callerUvBinDir
    Remove-Item -Recurse -Force $scratch -ErrorAction SilentlyContinue
    if ($pathCleanFailed) {
        throw 'could not clean the user PATH entries this test added'
    }
}
