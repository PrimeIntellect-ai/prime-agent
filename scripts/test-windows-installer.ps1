#Requires -Version 5.1
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path $PSScriptRoot -Parent) 'install.ps1')

$script:Passed = 0
function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw "FAIL: $Message" }
    $script:Passed++
}
function Assert-Throws {
    param([scriptblock]$Action, [string]$Pattern)
    $caught = $null
    try { & $Action } catch { $caught = $_ }
    Assert-True ($null -ne $caught) "Expected error matching $Pattern"
    if ($caught) { Assert-True ($caught.ToString() -match $Pattern) "Unexpected error: $caught" }
}
function Write-FixtureFile {
    param([string]$Path, [string]$Content)
    [IO.Directory]::CreateDirectory((Split-Path $Path -Parent)) | Out-Null
    [IO.File]::WriteAllText($Path, $Content, [Text.UTF8Encoding]::new($false))
}
function New-TestZip {
    param([string]$Path, [string[]]$Names, [switch]$Link)
    $zip = [IO.Compression.ZipFile]::Open($Path, [IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($name in $Names) {
            $entry = $zip.CreateEntry($name)
            if ($Link) { $entry.ExternalAttributes = -1577123840 }
            $writer = [IO.StreamWriter]::new($entry.Open())
            try { $writer.Write('fixture') } finally { $writer.Dispose() }
        }
    } finally { $zip.Dispose() }
}

$temp = Join-Path ([IO.Path]::GetTempPath()) ('prime-installer-tests-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($temp) | Out-Null
Push-Location $temp
try {
    Assert-True (Test-NodeVersion 'v22.8.0') 'Node minimum accepted'
    Assert-True (Test-NodeVersion '24.1.0') 'Newer Node accepted'
    Assert-True (-not (Test-NodeVersion '22.7.9')) 'Old Node rejected'
    Assert-True (-not (Test-NodeVersion '20.99.0')) 'Old major rejected'
    Assert-True (-not (Test-NodeVersion 'v22.8.0-evil')) 'Malformed version rejected'
    Assert-True ((Merge-PathEntries @('C:\one;C:\two', 'c:\ONE;C:\three')) -ceq 'C:\one;C:\two;C:\three') 'PATH deduplication preserves order'
    Assert-True ((ConvertTo-BatchLiteral 'C:\a %thing% & space') -ceq 'C:\a %%thing%% & space') 'Batch percent escaped'
    Assert-Throws { ConvertTo-BatchLiteral "C:\bad`"path" } 'Paths cannot contain'
    if ($env:OS -eq 'Windows_NT') {
        Assert-Throws { Invoke-NativeChecked $env:ComSpec @('/d', '/c', 'exit 7') } 'exit code 7'
    }

    $source = Join-Path $temp ('source space & ' + [char]0x00e9)
    foreach ($name in @('prime-agent.cmd', 'package-lock.json', 'scripts/run-prime-agent.mjs', 'prime-agent-runtime/pyproject.toml')) {
        Write-FixtureFile (Join-Path $source $name) 'fixture'
    }
    Write-FixtureFile (Join-Path $source 'package.json') '{"scripts":{"build:windows":"fixture"}}'
    foreach ($name in @('.git/secret', 'node_modules/dependency', 'packages/a/dist/stale', '.venv/python', '.env', '.env.local', '.prime/auth.json', '.pi/settings.json', 'auth.json')) {
        Write-FixtureFile (Join-Path $source $name) 'must not copy'
    }
    Assert-SourceTree $source
    $copy = Join-Path $temp 'copied'
    Copy-SourceTree $source $copy
    Assert-True (Test-Path -LiteralPath (Join-Path $copy 'scripts/run-prime-agent.mjs')) 'Source files copied'
    foreach ($name in @('.git', 'node_modules', 'packages/a/dist', '.venv', '.env', '.env.local', '.prime', '.pi', 'auth.json')) {
        Assert-True (-not (Test-Path -LiteralPath (Join-Path $copy $name))) "Excluded $name"
    }
    Assert-Throws { Assert-SourceTree $temp } 'Incomplete source tree'

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = Join-Path $temp 'source.zip'
    [IO.Compression.ZipFile]::CreateFromDirectory($copy, $archive)
    $sha = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash
    Assert-Throws { Expand-VerifiedSourceArchive $archive ('0' * 64) (Join-Path $temp 'bad-hash') } 'SHA-256 mismatch'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $temp 'bad-hash'))) 'No extraction before hash validation'
    Assert-Throws { Expand-VerifiedSourceArchive $archive '' (Join-Path $temp 'no-hash') } 'known -SourceSha256'
    $expanded = Expand-VerifiedSourceArchive $archive $sha (Join-Path $temp 'expanded')
    Assert-SourceTree $expanded
    foreach ($name in @('../escape', 'folder/../../escape', '/absolute', 'C:/drive', 'name:stream', 'folder./x', 'NUL.txt')) {
        $badZip = Join-Path $temp ([guid]::NewGuid().ToString('N') + '.zip')
        New-TestZip $badZip @($name)
        $badHash = (Get-FileHash -LiteralPath $badZip -Algorithm SHA256).Hash
        Assert-Throws { Expand-VerifiedSourceArchive $badZip $badHash (Join-Path $temp ([guid]::NewGuid().ToString('N'))) } 'Unsafe archive entry'
    }
    $linkZip = Join-Path $temp 'link.zip'
    New-TestZip $linkZip @('link') -Link
    Assert-Throws { Expand-VerifiedSourceArchive $linkZip (Get-FileHash $linkZip -Algorithm SHA256).Hash (Join-Path $temp 'link-extract') } 'Archive links'
    $duplicateZip = Join-Path $temp 'duplicate.zip'
    New-TestZip $duplicateZip @('A.txt', 'a.txt')
    Assert-Throws { Expand-VerifiedSourceArchive $duplicateZip (Get-FileHash $duplicateZip -Algorithm SHA256).Hash (Join-Path $temp 'duplicate-extract') } 'duplicate archive entry'

    $tools = @{ Node = 'C:\Node Space\node.exe'; Npm = 'C:\Node Space\npm.cmd'; Bash = 'C:\Git\bin\bash.exe'; Uv = 'C:\uv\uv.exe' }
    $pipe = Get-InstallerDaemonPipe 'C:\state' 'S-1-test-a'
    Assert-True ($pipe -ceq (Get-InstallerDaemonPipe 'C:\STATE' 'S-1-test-a')) 'Daemon endpoint is stable and path-case independent'
    Assert-True ($pipe -cne (Get-InstallerDaemonPipe 'C:\other' 'S-1-test-a')) 'Different installations use different pipes'
    Assert-True ($pipe -cne (Get-InstallerDaemonPipe 'C:\state' 'S-1-test-b')) 'Different users use different pipes'
    $content = New-LauncherContent 'C:\release %percent% & space' 'C:\state' $tools
    Assert-True ($content.Contains('"C:\Node Space\node.exe" "C:\release %%percent%% & space')) 'Launcher quotes paths and escapes percent'
    Assert-True ($content.Contains('set "PRIME_AGENT_CODING_AGENT_DIR=C:\state"')) 'Launcher isolates config'
    Assert-True ($content.Contains('set "PRIME_AGENT_KERNEL_VENV=')) 'Launcher isolates kernel'
    Assert-True ($content.Contains('set "PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR=C:\state\supervisor-owners"')) 'Launcher isolates supervisor registry'
    Assert-True ($content.Contains('set "PRIME_AGENT_WINDOWS_DAEMON_PIPE=\\.\pipe\prime-agent-windows-')) 'Launcher isolates the daemon endpoint'
    Assert-True (-not $content.Contains('--daemon-socket')) 'Launcher leaves public command arguments unchanged'
    Assert-True ($content.Contains('setlocal DisableDelayedExpansion')) 'Launcher preserves exclamation marks'
    Assert-True ($content.Contains('chcp 65001 >nul')) 'Launcher supports UTF-8 paths'
    $launcher = Join-Path $temp 'prime-agent-windows.cmd'
    Publish-Launcher $launcher $content
    $second = $content.Replace('C:\state', 'C:\new-state')
    Publish-Launcher $launcher $second
    Assert-True ((Get-Content -LiteralPath $launcher -Raw) -ceq $second) 'New launcher activated'
    Assert-True ((Get-Content -LiteralPath "$launcher.previous" -Raw) -ceq $content) 'Previous launcher retained'
    $unknown = Join-Path $temp 'unknown.cmd'
    Write-FixtureFile $unknown '@echo off'
    Assert-Throws { Publish-Launcher $unknown $content } 'unmanaged launcher'
    Assert-True ((Get-Content -LiteralPath $unknown -Raw) -ceq '@echo off') 'Unknown launcher unchanged'
    Write-FixtureFile "$launcher.previous" '@echo off'
    Assert-Throws { Publish-Launcher $launcher $content } 'unmanaged launcher'
    Assert-True ((Get-Content -LiteralPath $launcher -Raw) -ceq $second) 'Unknown backup blocks activation'


    if ($env:OS -eq 'Windows_NT') {
        $nativeNode = Find-NativeNode
        if (-not $nativeNode) { throw 'Native launcher regression tests require Windows x64 Node.js >=22.8.' }
        $unicodeRoot = Join-Path $temp ('unicode space & ' + [char]0x00e9 + [char]0x65e5)
        $unicodeNode = Join-Path $unicodeRoot 'tools/node.exe'
        [IO.Directory]::CreateDirectory((Split-Path $unicodeNode -Parent)) | Out-Null
        [IO.File]::Copy($nativeNode, $unicodeNode)
        $unicodeRelease = Join-Path $unicodeRoot 'release'
        $capture = Join-Path $unicodeRoot 'result.json'
        $fixtureJs = 'require("fs").writeFileSync(process.env.PRIME_INSTALLER_TEST_RESULT, JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),state:process.env.PRIME_AGENT_CODING_AGENT_DIR,pipe:process.env.PRIME_AGENT_WINDOWS_DAEMON_PIPE,roles:Object.fromEntries(JSON.parse(process.env.PRIME_INSTALLER_TEST_ROLES).map(name=>[name,process.env[name]??null]))})); process.exit(17);'
        Write-FixtureFile (Join-Path $unicodeRelease 'packages/coding-agent/dist/bundle/cli.js') $fixtureJs
        $unicodeTools = @{ Node = $unicodeNode; Bash = 'C:\Git\bin\bash.exe'; Uv = 'C:\uv\uv.exe' }
        $unicodeLauncher = Join-Path $unicodeRoot 'prime-agent-windows.cmd'
        Publish-Launcher $unicodeLauncher (New-LauncherContent $unicodeRelease (Join-Path $unicodeRoot 'state') $unicodeTools)
        $oldRoleList = $env:PRIME_INSTALLER_TEST_ROLES
        $env:PRIME_INSTALLER_TEST_ROLES = ConvertTo-Json -InputObject $script:InstallerRoleVariables -Compress
        $oldRoleValues = @{}
        foreach ($name in $script:InstallerRoleVariables) {
            $oldRoleValues[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
            [Environment]::SetEnvironmentVariable($name, 'contaminated-parent', 'Process')
        }
        $oldCapture = $env:PRIME_INSTALLER_TEST_RESULT
        $env:PRIME_INSTALLER_TEST_RESULT = $capture
        $originalCp = ((& chcp.com) -replace '[^0-9]', '').Trim()
        try {
            & chcp.com 437 | Out-Null
            & $unicodeLauncher 'hello world' 'amp & bang!' > (Join-Path $unicodeRoot 'redirected.txt')
            Assert-True ($LASTEXITCODE -eq 17) 'Generated Unicode launcher preserves child exit status with redirected stdout'
            $captured = Get-Content -LiteralPath $capture -Encoding UTF8 -Raw | ConvertFrom-Json
            Assert-True ($captured.args[0] -ceq 'hello world' -and $captured.args[1] -ceq 'amp & bang!') 'Generated launcher preserves quoted arguments'
            Assert-True ($captured.cwd -ceq $temp) 'Generated launcher preserves caller working directory'
            Assert-True ($captured.state -ceq (Join-Path $unicodeRoot 'state')) 'Generated launcher preserves Unicode state path'
            Assert-True ($captured.pipe -ceq (Get-InstallerDaemonPipe (Join-Path $unicodeRoot 'state'))) 'Generated launcher uses the isolated daemon endpoint'
            foreach ($name in $script:InstallerRoleVariables) {
                Assert-True ($null -eq $captured.roles.PSObject.Properties[$name].Value) "Generated launcher clears inherited $name"
            }
            $restoredCp = ((& chcp.com) -replace '[^0-9]', '').Trim()
            Assert-True ($restoredCp -eq '437') 'Generated launcher restores original OEM code page'

            $cmd = [Diagnostics.Process]::new()
            $cmd.StartInfo.FileName = $env:ComSpec
            $cmd.StartInfo.Arguments = '/d /s /c ""' + $unicodeLauncher + '" "hello world" "amp&bang!""'
            $cmd.StartInfo.WorkingDirectory = $temp
            $cmd.StartInfo.UseShellExecute = $false
            $cmd.StartInfo.RedirectStandardOutput = $true
            $cmd.StartInfo.RedirectStandardError = $true
            try {
                $cmd.Start() | Out-Null
                if (-not $cmd.WaitForExit(30000)) { $cmd.Kill(); throw 'CMD launcher regression timed out.' }
                $diagnostics = $cmd.StandardOutput.ReadToEnd() + $cmd.StandardError.ReadToEnd()
                Assert-True ($cmd.ExitCode -eq 17) "CMD preserves generated launcher exit status: $diagnostics"
                $cmdCaptured = Get-Content -LiteralPath $capture -Encoding UTF8 -Raw | ConvertFrom-Json
                Assert-True ($cmdCaptured.args.Count -eq 2 -and $cmdCaptured.args[0] -ceq 'hello world' -and $cmdCaptured.args[1] -ceq 'amp&bang!') 'Explicit CMD quotes preserve unspaced ampersand and exclamation argument'
                Assert-True ($cmdCaptured.cwd -ceq $temp) 'Explicit CMD invocation preserves caller directory'
            } finally { $cmd.Dispose() }

        } finally {
            if ($originalCp) { & chcp.com $originalCp | Out-Null }
            $env:PRIME_INSTALLER_TEST_RESULT = $oldCapture
            $env:PRIME_INSTALLER_TEST_ROLES = $oldRoleList
            foreach ($name in $script:InstallerRoleVariables) { [Environment]::SetEnvironmentVariable($name, $oldRoleValues[$name], 'Process') }
        }
    }

    # Mock only external effects. Exercise the actual copy, ownership, activation,
    # environment restoration, and failed-build cleanup paths.
    if ($env:OS -eq 'Windows_NT') {
        $originalPrerequisites = (Get-Item function:Get-Prerequisites).ScriptBlock
        $originalNative = (Get-Item function:Invoke-NativeChecked).ScriptBlock
        $originalFind = (Get-Item function:Find-Application).ScriptBlock
        $originalRefresh = (Get-Item function:Refresh-InstallerPath).ScriptBlock
        $originalWinGet = (Get-Item function:Install-WinGetPrerequisite).ScriptBlock
        $savedRoleValues = @{}
        foreach ($name in $script:InstallerRoleVariables) {
            $savedRoleValues[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
            [Environment]::SetEnvironmentVariable($name, 'contaminated-parent', 'Process')
        }
        $script:NativeCalls = @()
        $script:FailBuild = $false
        $script:FixtureBash = Join-Path $temp ('git-' + [char]0x00e9 + '/bash.exe')
        Write-FixtureFile $script:FixtureBash 'mock'
        try {
            function Get-Prerequisites {
                param([switch]$ValidateOnly)
                Assert-True $ValidateOnly 'SkipPrerequisites validates installed prerequisites'
                return @{ Node = 'C:\mock\node.exe'; Npm = 'C:\mock\npm.cmd'; Bash = $script:FixtureBash; Uv = 'C:\mock\uv.exe' }
            }
            function Invoke-NativeChecked {
                param([string]$Command, [string[]]$Arguments)
                $script:NativeCalls += ,@($Command, $Arguments)
                if ($Command -ne 'mock-winget.exe') {
                    foreach ($name in $script:InstallerRoleVariables) {
                        Assert-True ([string]::IsNullOrEmpty([Environment]::GetEnvironmentVariable($name, 'Process'))) "Installer probe clears inherited $name"
                    }
                }
                if ($script:FailBuild -and $Arguments[0] -eq 'run') { throw 'mock build failure' }
            }
            $managed = Join-Path $temp 'installation'
            $oldPath = $env:PATH
            $oldConfig = $env:PRIME_AGENT_CODING_AGENT_DIR
            Install-PrimeAgentWindows -SourcePath $source -InstallDirectory $managed -SkipPrerequisites
            $active = Join-Path $managed 'bin/prime-agent-windows.cmd'
            $firstInstall = Get-Content -LiteralPath $active -Raw
            Assert-True ($script:NativeCalls.Count -eq 5) 'ci, build, version, help and strict kernel bootstrap executed'
            Assert-True ($script:NativeCalls[0][1] -contains '--include=dev') 'Build dependencies explicitly included'
            Assert-True ($script:NativeCalls[0][1] -contains '--include=optional') 'Platform dependencies explicitly included'
            Assert-True ($script:NativeCalls[4][1][0].EndsWith('bootstrap-cli.js')) 'Strict bootstrap entry used'
            Assert-True ($env:PATH -ceq $oldPath) 'Caller PATH restored'
            Assert-True ($env:PRIME_AGENT_CODING_AGENT_DIR -ceq $oldConfig) 'Caller config environment restored'
            foreach ($name in $script:InstallerRoleVariables) {
                Assert-True ([Environment]::GetEnvironmentVariable($name, 'Process') -ceq 'contaminated-parent') "Installer restores caller $name"
            }
            $script:FailBuild = $true
            Assert-Throws { Install-PrimeAgentWindows -SourcePath $source -InstallDirectory $managed -SkipPrerequisites } 'mock build failure'
            Assert-True ((Get-Content -LiteralPath $active -Raw) -ceq $firstInstall) 'Failed install preserves active launcher'
            Assert-True (@(Get-ChildItem -LiteralPath (Join-Path $managed 'versions')).Count -eq 1) 'Only failed new build removed'
            Assert-True (-not (Test-Path -LiteralPath (Join-Path $managed '.install-lock'))) 'Failure releases installer lock'
            $script:FailBuild = $false
            Install-PrimeAgentWindows -SourcePath $source -InstallDirectory $managed -SkipPrerequisites -SkipKernelBootstrap
            Assert-True ((Get-Content -LiteralPath "$active.previous" -Raw) -ceq $firstInstall) 'Rerun retains prior launcher'
            Assert-True (@(Get-ChildItem -LiteralPath (Join-Path $managed 'versions')).Count -eq 2) 'Rerun keeps immutable old version'
            Write-FixtureFile (Join-Path $managed '.install-lock') 'held'
            Assert-Throws { Install-PrimeAgentWindows -SourcePath $source -InstallDirectory $managed -SkipPrerequisites } 'Installation is locked'
            Remove-Item -LiteralPath (Join-Path $managed '.install-lock')
            Assert-Throws { Install-PrimeAgentWindows -SourcePath $source -InstallDirectory $copy -SkipPrerequisites } 'Refusing to take ownership'

            function Find-Application { param([string]$Name); return 'mock-winget.exe' }
            function Refresh-InstallerPath { }
            $script:NativeCalls = @()
            Install-WinGetPrerequisite 'Git.Git'
            Assert-True (($script:NativeCalls[0][1] -join ' ') -eq 'install --id Git.Git --exact --source winget --accept-source-agreements --accept-package-agreements --disable-interactivity') 'WinGet uses exact ID and trusted source'
            function Find-Application { param([string]$Name); return $null }
            Assert-Throws { Install-WinGetPrerequisite 'Git.Git' } 'Microsoft App Installer'
        } finally {
            Set-Item function:Get-Prerequisites $originalPrerequisites
            Set-Item function:Invoke-NativeChecked $originalNative
            Set-Item function:Find-Application $originalFind
            Set-Item function:Refresh-InstallerPath $originalRefresh
            Set-Item function:Install-WinGetPrerequisite $originalWinGet
            foreach ($name in $script:InstallerRoleVariables) { [Environment]::SetEnvironmentVariable($name, $savedRoleValues[$name], 'Process') }
        }
    }

    if ($env:OS -eq 'Windows_NT') {
        $realFindNode = (Get-Item function:Find-NativeNode).ScriptBlock
        $realFindBash = (Get-Item function:Find-GitBash).ScriptBlock
        $realFindUv = (Get-Item function:Find-NativeUv).ScriptBlock
        $realInstallWinGet = (Get-Item function:Install-WinGetPrerequisite).ScriptBlock
        $script:PrerequisiteInstalls = 0
        $script:PrerequisiteNode = Join-Path $temp 'prerequisites/node.exe'
        Write-FixtureFile $script:PrerequisiteNode 'fixture'
        Write-FixtureFile (Join-Path $temp 'prerequisites/npm.cmd') 'fixture'
        try {
            function Find-NativeNode { return $script:PrerequisiteNode }
            function Find-GitBash { return 'C:\Git\bin\bash.exe' }
            function Find-NativeUv { return 'C:\uv\uv.exe' }
            function Install-WinGetPrerequisite { param([string]$PackageId); $script:PrerequisiteInstalls++ }
            $ready = Get-Prerequisites -ValidateOnly
            Assert-True ($ready.Node -ceq $script:PrerequisiteNode) 'Installed prerequisites reused'
            Assert-True ($script:PrerequisiteInstalls -eq 0) 'No WinGet call when prerequisites are ready'
            function Find-NativeNode { return $null }
            Assert-Throws { Get-Prerequisites -ValidateOnly } 'Node.js >=22.8 is required'
            Assert-True ($script:PrerequisiteInstalls -eq 0) 'Validate-only does not install a missing prerequisite'
        } finally {
            Set-Item function:Find-NativeNode $realFindNode
            Set-Item function:Find-GitBash $realFindBash
            Set-Item function:Find-NativeUv $realFindUv
            Set-Item function:Install-WinGetPrerequisite $realInstallWinGet
        }
    }

    Write-Host "Windows installer tests passed ($script:Passed assertions)."
} finally {
    Pop-Location
    Remove-Item -LiteralPath $temp -Recurse -Force
}
