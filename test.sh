#!/usr/bin/env bash
set -e

# Credential stores that must stay untouched while the suite runs: the current
# agent store and the legacy one.
AUTH_FILES=(
    "$HOME/.prime/agent/auth.json"
    "$HOME/.pi/agent/auth.json"
)

# Restore every moved auth.json on exit (success or failure)
cleanup() {
    for auth_file in "${AUTH_FILES[@]}"; do
        if [[ -f "$auth_file.bak" ]]; then
            mv "$auth_file.bak" "$auth_file"
            echo "Restored $auth_file"
        fi
    done
}
trap cleanup EXIT

# Move the credential stores out of the way
for auth_file in "${AUTH_FILES[@]}"; do
    if [[ -f "$auth_file" ]]; then
        mv "$auth_file" "$auth_file.bak"
        echo "Moved $auth_file to backup"
    fi
done

# Live provider tests are opt-in (see packages/ai/README.md, "Running tests").
# Make sure the opt-in is off so no test reads or refreshes real credentials.
unset PI_LIVE_TESTS
unset PI_TEST_AUTH_FILE

# Skip local LLM tests (ollama, lmstudio)
export PI_NO_LOCAL_LLM=1

# Unset API keys (see packages/ai/src/stream.ts getEnvApiKey)
unset ANTHROPIC_API_KEY
unset ANTHROPIC_OAUTH_TOKEN
unset OPENAI_API_KEY
unset GEMINI_API_KEY
unset GROQ_API_KEY
unset CEREBRAS_API_KEY
unset XAI_API_KEY
unset OPENROUTER_API_KEY
unset ZAI_API_KEY
unset MISTRAL_API_KEY
unset MINIMAX_API_KEY
unset MINIMAX_CN_API_KEY
unset KIMI_API_KEY
unset HF_TOKEN
unset AI_GATEWAY_API_KEY
unset OPENCODE_API_KEY
unset COPILOT_GITHUB_TOKEN
unset GH_TOKEN
unset GITHUB_TOKEN
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
unset BEDROCK_EXTENSIVE_MODEL_TEST
unset FIREWORKS_API_KEY

echo "Running tests without API keys..."
npm test
