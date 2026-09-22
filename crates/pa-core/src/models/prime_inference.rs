//! Private Prime Inference models (prime-inference-models.ts) and the
//! private-model id predicate (packages/ai prime-inference-model-catalog.ts).

use pa_types::ai::{CompatKind, Model, ModelCompat, ModelCost};
use pa_types::JsNumber;

pub const PRIME_INFERENCE_BASE_URL: &str = "https://api.pinference.ai/api/v1";

/// Private ids: `internal/*`, `dev/*`, or any id containing `:`.
pub fn is_private_prime_inference_model_id(model_id: &str) -> bool {
    let normalized = model_id.to_lowercase();
    normalized.starts_with("internal/")
        || normalized.starts_with("dev/")
        || normalized.contains(':')
}

pub fn is_private_prime_inference_model(model: &Model) -> bool {
    model.provider == "prime-inference" && is_private_prime_inference_model_id(&model.id)
}

/// The bundled private model table. Private route templates matter: the public
/// provider default carries request shapes the private endpoint rejects.
pub fn private_prime_inference_models() -> Vec<Model> {
    vec![Model {
        id: "internal/glm-5.2-fast".to_string(),
        name: "GLM 5.2 Fast".to_string(),
        api: "openai-completions".to_string(),
        provider: "prime-inference".to_string(),
        base_url: PRIME_INFERENCE_BASE_URL.to_string(),
        reasoning: true,
        input: vec![pa_types::ai::ModelInput::Text],
        headers: None,
        thinking_level_map: None,
        cost: ModelCost {
            input: JsNumber::from(0u64),
            output: JsNumber::from(0u64),
            cache_read: JsNumber::from(0u64),
            cache_write: JsNumber::from(0u64),
        },
        context_window: 400_000,
        max_tokens: 131_072,
        featured: Some(true),
        compat: Some(ModelCompat::from_kind(CompatKind::OpenAiCompletions(
            Box::new(pa_types::ai::OpenAiCompletionsCompat {
                supports_developer_role: Some(false),
                max_tokens_field: Some(pa_types::ai::MaxTokensField::MaxTokens),
                ..pa_types::ai::OpenAiCompletionsCompat::default()
            }),
        ))),
    }]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_id_predicate() {
        assert!(is_private_prime_inference_model_id("internal/glm-5.2-fast"));
        assert!(is_private_prime_inference_model_id("DEV/x"));
        assert!(is_private_prime_inference_model_id("z-ai/glm:exacto"));
        assert!(!is_private_prime_inference_model_id("z-ai/glm-5.3"));
    }

    /// Locate the TS reference repo: `PA_TS_REFERENCE` or `~/prime-agent`.
    /// The repo ships with the dev box; other environments skip the
    /// differential check.
    fn ts_reference_root() -> Option<std::path::PathBuf> {
        if let Ok(path) = std::env::var("PA_TS_REFERENCE") {
            let path = std::path::PathBuf::from(path);
            return path.is_dir().then_some(path);
        }
        let path = pa_types::platform::home_dir()?.join("prime-agent");
        path.is_dir().then_some(path)
    }

    /// Differential: the provider base URL must equal the TS reference's
    /// `PRIME_INFERENCE_BASE_URL` - the URL the installed TS binary actually
    /// calls. Golden is read from the TS source, no network.
    #[test]
    fn base_url_matches_ts_reference() {
        let Some(root) = ts_reference_root() else {
            eprintln!("SKIPPED: TS reference repo not found (set PA_TS_REFERENCE)");
            return;
        };
        let catalog = root.join("packages/coding-agent/src/core/prime-inference-model-catalog.ts");
        let Ok(source) = std::fs::read_to_string(catalog) else {
            eprintln!("SKIPPED: TS prime-inference-model-catalog.ts unreadable");
            return;
        };
        let expected = source
            .lines()
            .find(|line| {
                line.trim()
                    .starts_with("export const PRIME_INFERENCE_BASE_URL")
            })
            .and_then(|line| line.split('"').nth(1))
            .expect("TS reference defines a quoted PRIME_INFERENCE_BASE_URL");
        assert_eq!(PRIME_INFERENCE_BASE_URL, expected);
    }

    /// Internal consistency: every bundled prime-inference catalog entry in
    /// the generated model registry carries the same base URL as the
    /// private-model / live-catalog constant.
    #[test]
    fn generated_catalog_base_urls_match_const() {
        let models = pa_ai::models_generated::get_models("prime-inference");
        assert!(
            !models.is_empty(),
            "generated prime-inference catalog is empty"
        );
        for model in models {
            assert_eq!(
                model.base_url, PRIME_INFERENCE_BASE_URL,
                "generated model {} diverges from PRIME_INFERENCE_BASE_URL",
                model.id
            );
        }
    }
}
