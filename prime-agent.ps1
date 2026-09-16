$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$runner = Join-Path $PSScriptRoot 'scripts/run-prime-agent.mjs'
try {
    $node = Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1
    & $node.Source $runner @args
    exit $LASTEXITCODE
} catch {
    [Console]::Error.WriteLine("Cannot start Prime Agent. Install Node.js 22.8 or newer and make sure node is on PATH. " + $_.Exception.Message)
    exit 1
}
