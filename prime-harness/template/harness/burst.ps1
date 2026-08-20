# Bounded autonomous burst launcher for Prime Agent (Windows PowerShell 5.1+).
#
# Usage: .\harness\burst.ps1 <profile> "<prompt>" [extra prime-agent args...]
# Profiles (turns / tokens / wall-time / continuations / gate):
#   repair      8 /  40k / 20m / 3 / quick gate (10m gate budget)
#   feature    24 / 180k / 3h  / 6 / changed-files gate (90m gate budget)
#   formal     20 / 160k / 3h  / 5 / changed-files gate (90m gate budget)
#   simulate   20 / 140k / 4h  / 5 / changed-files gate (90m gate budget)
#
# Gate timeouts dominate the manifest (see manifest _readme invariant). The
# gate definition (verify.py + manifest.json + manifest_policy.py) is frozen to a temp copy at
# launch so mid-burst edits to harness/ cannot change what the gate checks.
#
# All values are passed as SEPARATE arguments (Prime Agent does not parse
# --flag=value). Exit code: 0 = gate passed; 1 = gate failing or limit hit.
param(
    [Parameter(Mandatory = $true)][ValidateSet("repair", "feature", "formal", "simulate")]
    [string]$Profile,
    [Parameter(Mandatory = $true)][string]$Prompt,
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$Extra
)

switch ($Profile) {
    "repair"   { $Turns = 8;  $Tokens = 40000;  $TimeoutMs = 1200000;  $GateMs = 600000;  $Cont = 3; $GateProfile = "quick" }
    "feature"  { $Turns = 24; $Tokens = 180000; $TimeoutMs = 10800000; $GateMs = 5400000; $Cont = 6; $GateProfile = "changed-files" }
    "formal"   { $Turns = 20; $Tokens = 160000; $TimeoutMs = 10800000; $GateMs = 5400000; $Cont = 5; $GateProfile = "changed-files" }
    "simulate" { $Turns = 20; $Tokens = 140000; $TimeoutMs = 14400000; $GateMs = 5400000; $Cont = 5; $GateProfile = "changed-files" }
}

$Bin = $null
foreach ($candidate in @("prime-agent", "pi")) {
    $cmd = Get-Command $candidate -ErrorAction SilentlyContinue
    if ($cmd) { $Bin = $cmd.Source; break }
}
if (-not $Bin) { Write-Error "neither 'prime-agent' nor 'pi' on PATH"; exit 127 }

# Freeze the gate definition so ordinary workspace edits cannot change gate retries.
# This is not isolation from malicious same-account temp-directory tampering.
$GateDir = Join-Path $env:TEMP ("prime-gate-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Path $GateDir | Out-Null
Copy-Item "harness\verify.py" -Destination $GateDir
Copy-Item "harness\manifest.json" -Destination $GateDir
Copy-Item "harness\manifest_policy.py" -Destination $GateDir
$GateDirFwd = $GateDir -replace "\\", "/"

Write-Host "burst: profile=$Profile bin=$Bin turns=$Turns tokens=$Tokens timeout_ms=$TimeoutMs gate=$GateProfile gate_ms=$GateMs"

$ArgList = @(
    "--autonomous",
    "--autonomous-gate", "python `"$GateDirFwd/verify.py`" --manifest `"$GateDirFwd/manifest.json`" --profile $GateProfile",
    "--autonomous-gate-retries", "3",
    "--autonomous-gate-timeout-ms", "$GateMs",
    "--autonomous-max-continuations", "$Cont",
    "--autonomous-max-turns", "$Turns",
    "--autonomous-max-tokens", "$Tokens",
    "--autonomous-timeout-ms", "$TimeoutMs"
)
if ($Extra) { $ArgList += $Extra }
$ArgList += @("-p", "--", $Prompt)

try {
    & $Bin @ArgList
    exit $LASTEXITCODE
}
finally {
    Remove-Item -Recurse -Force $GateDir -ErrorAction SilentlyContinue
}
