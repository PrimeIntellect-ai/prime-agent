$ErrorActionPreference = "Stop"

$Repository = if ($env:PREME_AGENT_SOURCE_REPO) { $env:PREME_AGENT_SOURCE_REPO } else { "https://github.com/JonusNattapong/preme-agent.git" }
$InstallDir = if ($env:PREME_AGENT_SOURCE_DIR) { $env:PREME_AGENT_SOURCE_DIR } else { Join-Path $HOME ".preme-agent" }

function Require-Command([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "$Name is required. Install it and run this installer again."
  }
}

Require-Command "git"
Require-Command "node"
Require-Command "npm"

if (Test-Path -LiteralPath $InstallDir) {
  if (-not (Test-Path -LiteralPath (Join-Path $InstallDir ".git"))) {
    throw "Install directory exists but is not a git checkout: $InstallDir"
  }
  Push-Location $InstallDir
  try {
    $dirty = git status --porcelain
    if ($LASTEXITCODE -ne 0) { throw "Could not inspect the install checkout." }
    if ($dirty) { throw "Install directory has local changes: $InstallDir" }
    git pull --ff-only origin main
    if ($LASTEXITCODE -ne 0) { throw "Could not update the existing checkout." }
  } finally {
    Pop-Location
  }
} else {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $InstallDir) | Out-Null
  git clone --depth 1 $Repository $InstallDir
  if ($LASTEXITCODE -ne 0) { throw "Could not clone $Repository" }
}

Push-Location $InstallDir
try {
  npm ci
  if ($LASTEXITCODE -ne 0) { throw "npm ci failed." }
  Push-Location (Join-Path $InstallDir "packages\coding-agent")
  try {
    npm link
    if ($LASTEXITCODE -ne 0) { throw "npm link failed." }
  } finally {
    Pop-Location
  }
} finally {
  Pop-Location
}

Write-Host "Preme Agent was installed successfully."
Write-Host "Run it with: preme-agent"
