param (
    [string]$InstallDir = "$env:LOCALAPPDATA\PrimeAgent"
)

# Ensure we're in the repository root
$RepoDir = $PWD.Path

Write-Host "Installing Prime Agent dependencies..."
npm install
if ($LASTEXITCODE -ne 0) {
    Write-Error "npm install failed."
    exit 1
}

Write-Host "Building Prime Agent..."
npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Error "npm run build failed."
    exit 1
}

Write-Host "Creating Prime Agent wrapper scripts..."

$CmdScriptPath = Join-Path $RepoDir "prime.cmd"
@"
@echo off
bash "%~dp0prime-agent.sh" %*
"@ | Out-File -FilePath $CmdScriptPath -Encoding ASCII

$Ps1ScriptPath = Join-Path $RepoDir "prime.ps1"
@"
param(
    [Parameter(ValueFromRemainingArguments=`$true)]
    [string[]]`$Args
)
bash "`$PSScriptRoot\prime-agent.sh" `$Args
"@ | Out-File -FilePath $Ps1ScriptPath -Encoding ASCII

Write-Host "Adding repository root to User PATH..."

# Add RepoDir to PATH if not already present
$UserPath = [Environment]::GetEnvironmentVariable("PATH", "User")
$Paths = $UserPath -split ';'

if ($Paths -notcontains $RepoDir) {
    $NewPath = $UserPath + ";$RepoDir"
    [Environment]::SetEnvironmentVariable("PATH", $NewPath, "User")
    Write-Host "Added $RepoDir to User PATH."
    Write-Host "You may need to restart your terminal for the 'prime' command to be available."
} else {
    Write-Host "$RepoDir is already in User PATH."
}

# The wrapper scripts (prime.cmd, prime.ps1) invoke bash to run prime-agent.sh.
# Ensure bash is available on PATH; on Windows it comes from Git for Windows.
Write-Host "Checking for bash (required by wrapper scripts)..."
$bashOnPath = Get-Command bash -ErrorAction SilentlyContinue
if (-not $bashOnPath) {
    $GitBashDirs = @(
        "C:\Program Files\Git\bin",
        "C:\Program Files\Git\usr\bin",
        "C:\Program Files (x86)\Git\bin",
        "C:\Program Files (x86)\Git\usr\bin"
    )
    $GitBashDir = $GitBashDirs | Where-Object { Test-Path (Join-Path $_ "bash.exe") } | Select-Object -First 1
    if ($GitBashDir) {
        $UserPath = [Environment]::GetEnvironmentVariable("PATH", "User")
        $Paths = $UserPath -split ';'
        if ($Paths -notcontains $GitBashDir) {
            [Environment]::SetEnvironmentVariable("PATH", "$UserPath;$GitBashDir", "User")
            Write-Host "Added $GitBashDir to User PATH for bash."
            Write-Host "You may need to restart your terminal for bash to be available."
        } else {
            Write-Host "$GitBashDir is already in User PATH."
        }
    } else {
        Write-Warning "bash was not found on PATH and Git for Windows was not detected at common locations."
        Write-Warning "The 'prime' command requires bash to run. Install Git for Windows or add bash to your PATH."
    }
} else {
    Write-Host "bash found at $($bashOnPath.Source)."
}

Write-Host "Installation complete! You can now use the 'prime' command."
