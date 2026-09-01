#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PRIME_AGENT_LAUNCHER_PATH="$SCRIPT_DIR/prime-agent.sh"
if BUILD_ID="$(git -C "$SCRIPT_DIR" describe --tags --always --dirty 2>/dev/null)"; then
  export PRIME_AGENT_BUILD_ID="$BUILD_ID"
fi

# Check for --no-env / --dist flags
NO_ENV=false
USE_DIST=false
ARGS=()
for arg in "$@"; do
  if [[ "$arg" == "--no-env" ]]; then
    NO_ENV=true
  elif [[ "$arg" == "--dist" ]]; then
    USE_DIST=true
  else
    ARGS+=("$arg")
  fi
done

if [[ "$NO_ENV" == "true" ]]; then
  # Unset API keys (see packages/ai/src/env-api-keys.ts)
  unset ANTHROPIC_API_KEY
  unset ANTHROPIC_OAUTH_TOKEN
  unset OPENAI_API_KEY
  unset PRIME_API_KEY
  unset GEMINI_API_KEY
  unset GROQ_API_KEY
  unset CEREBRAS_API_KEY
  unset XAI_API_KEY
  unset OPENROUTER_API_KEY
  unset ZAI_API_KEY
  unset MISTRAL_API_KEY
  unset MINIMAX_API_KEY
  unset MINIMAX_CN_API_KEY
  unset AI_GATEWAY_API_KEY
  unset OPENCODE_API_KEY
  unset COPILOT_GITHUB_TOKEN
  unset GH_TOKEN
  unset GITHUB_TOKEN
  unset HF_TOKEN
  unset GOOGLE_APPLICATION_CREDENTIALS
  unset GOOGLE_CLOUD_PROJECT
  unset GCLOUD_PROJECT
  unset GOOGLE_CLOUD_LOCATION
  unset AWS_PROFILE
  unset AWS_ACCESS_KEY_ID
  unset AWS_SECRET_ACCESS_KEY
  unset AWS_SESSION_TOKEN
  unset AWS_REGION
  unset AWS_DEFAULT_REGION
  unset AWS_BEARER_TOKEN_BEDROCK
  unset AWS_CONTAINER_CREDENTIALS_RELATIVE_URI
  unset AWS_CONTAINER_CREDENTIALS_FULL_URI
  unset AWS_WEB_IDENTITY_TOKEN_FILE
  unset AZURE_OPENAI_API_KEY
  unset AZURE_OPENAI_BASE_URL
  unset AZURE_OPENAI_RESOURCE_NAME
  echo "Running Prime Agent without API keys..."
fi

BUN_BIN="$(command -v bun || true)"
if [[ -z "$BUN_BIN" ]]; then
  echo "Bun is required. Install version $(cat "$SCRIPT_DIR/.bun-version") and run bun install --frozen-lockfile." >&2
  exit 1
fi

EXPECTED_BUN_VERSION="$(cat "$SCRIPT_DIR/.bun-version")"
ACTUAL_BUN_VERSION="$($BUN_BIN --version)"
if [[ "$ACTUAL_BUN_VERSION" != "$EXPECTED_BUN_VERSION" ]]; then
  echo "Prime Agent requires Bun $EXPECTED_BUN_VERSION; found $ACTUAL_BUN_VERSION." >&2
  exit 1
fi

# --dist runs the bundled build. Source mode runs TypeScript directly with Bun.
if [[ "$USE_DIST" == "true" ]]; then
  BUNDLE="$SCRIPT_DIR/packages/coding-agent/dist/bundle/cli.js"
  if [[ ! -f "$BUNDLE" ]]; then
    echo "Bundle not found at $BUNDLE. Run bun run build first." >&2
    exit 1
  fi
  exec "$BUN_BIN" "$BUNDLE" ${ARGS[@]+"${ARGS[@]}"}
fi

exec "$BUN_BIN" "$SCRIPT_DIR/packages/coding-agent/src/bun/cli.ts" ${ARGS[@]+"${ARGS[@]}"}
