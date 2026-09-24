//! Environment variable API key resolution.
//! Ported from `packages/ai/src/env-api-keys.ts`.

use std::path::PathBuf;

/// Environment variable names that can provide an API key for a provider.
pub fn get_api_key_env_vars(provider: &str) -> Option<Vec<&'static str>> {
    match provider {
        "github-copilot" => Some(vec!["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]),
        // ANTHROPIC_OAUTH_TOKEN takes precedence over ANTHROPIC_API_KEY.
        "anthropic" => Some(vec!["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]),
        other => {
            let env_var = match other {
                "openai" => "OPENAI_API_KEY",
                "azure-openai-responses" => "AZURE_OPENAI_API_KEY",
                "prime-inference" => "PRIME_API_KEY",
                "deepseek" => "DEEPSEEK_API_KEY",
                "google" => "GEMINI_API_KEY",
                "google-vertex" => "GOOGLE_CLOUD_API_KEY",
                "groq" => "GROQ_API_KEY",
                "cerebras" => "CEREBRAS_API_KEY",
                "xai" => "XAI_API_KEY",
                "openrouter" => "OPENROUTER_API_KEY",
                "vercel-ai-gateway" => "AI_GATEWAY_API_KEY",
                "zai" => "ZAI_API_KEY",
                "mistral" => "MISTRAL_API_KEY",
                "minimax" => "MINIMAX_API_KEY",
                "minimax-cn" => "MINIMAX_CN_API_KEY",
                "moonshotai" | "moonshotai-cn" => "MOONSHOT_API_KEY",
                "huggingface" => "HF_TOKEN",
                "fireworks" => "FIREWORKS_API_KEY",
                "opencode" | "opencode-go" => "OPENCODE_API_KEY",
                "kimi-coding" => "KIMI_API_KEY",
                "cloudflare-workers-ai" | "cloudflare-ai-gateway" => "CLOUDFLARE_API_KEY",
                "xiaomi" => "XIAOMI_API_KEY",
                "xiaomi-token-plan-cn" => "XIAOMI_TOKEN_PLAN_CN_API_KEY",
                "xiaomi-token-plan-ams" => "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
                "xiaomi-token-plan-sgp" => "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
                _ => return None,
            };
            Some(vec![env_var])
        }
    }
}

/// Find configured environment variables that can provide an API key for a
/// provider. Ambient credential sources (AWS profiles, Google ADC) are
/// intentionally excluded here; see `get_env_api_key`.
pub fn find_env_keys(provider: &str) -> Option<Vec<String>> {
    let env_vars = get_api_key_env_vars(provider)?;
    let found: Vec<String> = env_vars
        .into_iter()
        .filter(|env_var| {
            std::env::var_os(env_var)
                .map(|v| !v.is_empty())
                .unwrap_or(false)
        })
        .map(std::string::ToString::to_string)
        .collect();
    if found.is_empty() {
        None
    } else {
        Some(found)
    }
}

/// Get an API key for a provider from known environment variables.
/// Returns the sentinel "<authenticated>" for providers configured through
/// ambient credential sources (Google Vertex ADC, Amazon Bedrock profiles).
pub fn get_env_api_key(provider: &str) -> Option<String> {
    if let Some(keys) = find_env_keys(provider) {
        if let Some(first) = keys.first() {
            if let Ok(value) = std::env::var(first) {
                if !value.is_empty() {
                    return Some(value);
                }
            }
        }
    }

    if provider == "google-vertex" {
        let has_credentials = has_vertex_adc_credentials();
        let has_project = ["GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT"]
            .iter()
            .any(|var| std::env::var(var).map(|v| !v.is_empty()).unwrap_or(false));
        let has_location = std::env::var("GOOGLE_CLOUD_LOCATION")
            .map(|v| !v.is_empty())
            .unwrap_or(false);
        if has_credentials && has_project && has_location {
            return Some("<authenticated>".to_string());
        }
    }

    if provider == "amazon-bedrock" {
        let env = |name: &str| std::env::var(name).map(|v| !v.is_empty()).unwrap_or(false);
        if env("AWS_PROFILE")
            || (env("AWS_ACCESS_KEY_ID") && env("AWS_SECRET_ACCESS_KEY"))
            || env("AWS_BEARER_TOKEN_BEDROCK")
            || env("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI")
            || env("AWS_CONTAINER_CREDENTIALS_FULL_URI")
            || env("AWS_WEB_IDENTITY_TOKEN_FILE")
        {
            return Some("<authenticated>".to_string());
        }
    }

    None
}

fn has_vertex_adc_credentials() -> bool {
    if let Ok(gac_path) = std::env::var("GOOGLE_APPLICATION_CREDENTIALS") {
        if !gac_path.is_empty() {
            return std::path::Path::new(&gac_path).exists();
        }
    }
    default_adc_path().exists()
}

fn default_adc_path() -> PathBuf {
    let home = pa_types::platform::home_dir().unwrap_or_else(|| PathBuf::from("/"));
    home.join(".config")
        .join("gcloud")
        .join("application_default_credentials.json")
}

/// Prime team id from PRIME_TEAM_ID or ~/.prime/config.json.
pub fn get_prime_team_id() -> Option<String> {
    if let Ok(from_env) = std::env::var("PRIME_TEAM_ID") {
        let trimmed = from_env.trim().to_string();
        if !trimmed.is_empty() {
            return Some(trimmed);
        }
    }
    let home = pa_types::platform::home_dir()?;
    let config_path = home.join(".prime").join("config.json");
    let text = std::fs::read_to_string(config_path).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&text).ok()?;
    parsed
        .get("team_id")
        .and_then(|value| value.as_str())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_provider_env_vars() {
        assert_eq!(
            get_api_key_env_vars("prime-inference").unwrap(),
            vec!["PRIME_API_KEY"]
        );
        assert_eq!(
            get_api_key_env_vars("anthropic").unwrap(),
            vec!["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]
        );
        assert!(get_api_key_env_vars("unknown-provider").is_none());
    }
}
