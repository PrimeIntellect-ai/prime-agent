#Requires -Version 5.1
$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$env:PRIME_AGENT_LAUNCHER_PATH = Join-Path $ScriptDir "prime-agent.ps1"

try {
  $BuildId = & git -C $ScriptDir describe --tags --always --dirty 2>$null
  if ($LASTEXITCODE -eq 0 -and $BuildId) {
    $env:PRIME_AGENT_BUILD_ID = $BuildId
  }
} catch {}

$UseDist = $false
$NoEnv = $false
$ForwardedArgs = @()
foreach ($Argument in $args) {
  if ($Argument -eq "--dist") {
    $UseDist = $true
  } elseif ($Argument -eq "--no-env") {
    $NoEnv = $true
  } else {
    $ForwardedArgs += $Argument
  }
}

if ($NoEnv) {
  $EnvironmentVariables = @(
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_OAUTH_TOKEN",
    "OPENAI_API_KEY",
    "PRIME_API_KEY",
    "GEMINI_API_KEY",
    "GROQ_API_KEY",
    "CEREBRAS_API_KEY",
    "XAI_API_KEY",
    "OPENROUTER_API_KEY",
    "ZAI_API_KEY",
    "MISTRAL_API_KEY",
    "MINIMAX_API_KEY",
    "MINIMAX_CN_API_KEY",
    "AI_GATEWAY_API_KEY",
    "OPENCODE_API_KEY",
    "COPILOT_GITHUB_TOKEN",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "HF_TOKEN",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_CLOUD_PROJECT",
    "GCLOUD_PROJECT",
    "GOOGLE_CLOUD_LOCATION",
    "AWS_PROFILE",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_REGION",
    "AWS_DEFAULT_REGION",
    "AWS_BEARER_TOKEN_BEDROCK",
    "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
    "AWS_CONTAINER_CREDENTIALS_FULL_URI",
    "AWS_WEB_IDENTITY_TOKEN_FILE",
    "AZURE_OPENAI_API_KEY",
    "AZURE_OPENAI_BASE_URL",
    "AZURE_OPENAI_RESOURCE_NAME"
  )
  foreach ($Name in $EnvironmentVariables) {
    Remove-Item "Env:$Name" -ErrorAction SilentlyContinue
  }
  Write-Host "Running Prime Agent without API keys..."
}

if ($UseDist) {
  $Bundle = Join-Path $ScriptDir "packages\coding-agent\dist\bundle\cli.js"
  if (!(Test-Path -LiteralPath $Bundle)) {
    Write-Error "Bundle not found at $Bundle. Run npm run build first."
    exit 1
  }
  & node $Bundle @ForwardedArgs
  exit $LASTEXITCODE
}

$Tsx = Join-Path $ScriptDir "node_modules\.bin\tsx.cmd"
if (!(Test-Path -LiteralPath $Tsx)) {
  $Tsx = Join-Path $ScriptDir "node_modules\.bin\tsx"
}
if (!(Test-Path -LiteralPath $Tsx)) {
  Write-Error "tsx not found. Run npm install from the repo root first."
  exit 1
}

& $Tsx (Join-Path $ScriptDir "packages\coding-agent\src\cli.ts") @ForwardedArgs
exit $LASTEXITCODE
