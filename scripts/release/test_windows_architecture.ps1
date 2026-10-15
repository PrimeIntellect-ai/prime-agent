# Exercise the installer's actual architecture selection without downloading or
# installing a payload. Emulated PowerShell must select the OS architecture.
$ErrorActionPreference = 'Stop'
$installer = Join-Path $PSScriptRoot '../../install.ps1'
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    $installer, [ref]$null, [ref]$parseErrors)
if ($parseErrors) { throw ($parseErrors | Out-String) }
$assignments = @($ast.FindAll({
    param($node)
    $node -is [System.Management.Automation.Language.AssignmentStatementAst] -and
        $node.Left.Extent.Text -in @('$effectiveArchitecture', '$platform')
}, $true))
if ($assignments.Count -ne 2) { throw 'could not locate installer architecture selection' }
$selector = [scriptblock]::Create(($assignments.Extent.Text -join "`n") + "`n`$platform")
function Fail($message) { throw $message }
$originalArchitecture = $env:PROCESSOR_ARCHITECTURE
$originalNativeArchitecture = $env:PROCESSOR_ARCHITEW6432
try {
    foreach ($case in @(
        @{ Process = 'AMD64'; Native = ''; Expected = 'win32-x64' },
        @{ Process = 'ARM64'; Native = ''; Expected = 'win32-arm64' },
        @{ Process = 'AMD64'; Native = 'ARM64'; Expected = 'win32-arm64' },
        @{ Process = 'x86'; Native = 'ARM64'; Expected = 'win32-arm64' },
        @{ Process = 'x86'; Native = 'AMD64'; Expected = 'win32-x64' }
    )) {
        $env:PROCESSOR_ARCHITECTURE = $case.Process
        $env:PROCESSOR_ARCHITEW6432 = $case.Native
        $actual = & $selector
        if ($actual -ne $case.Expected) {
            throw "architecture $($case.Process)/$($case.Native): expected $($case.Expected), got $actual"
        }
    }
    $env:PROCESSOR_ARCHITECTURE = 'x86'
    $env:PROCESSOR_ARCHITEW6432 = $null
    $refused = $false
    try { & $selector | Out-Null } catch {
        if ($_.Exception.Message -notlike '*unsupported Windows architecture*') { throw }
        $refused = $true
    }
    if (-not $refused) { throw 'unsupported 32-bit Windows was accepted' }
    Write-Output 'Windows installer architecture selection passed (native and emulated shells)'
} finally {
    $env:PROCESSOR_ARCHITECTURE = $originalArchitecture
    $env:PROCESSOR_ARCHITEW6432 = $originalNativeArchitecture
}
