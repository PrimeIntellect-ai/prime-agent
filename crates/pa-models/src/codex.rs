//! Credentialed Codex discovery; transport stays pinned to the compiled provider.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;

use pa_types::ai::{ModelCost, ModelInput, ModelThinkingLevel};
use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::cache::{CatalogCache, RefreshOptions};
use crate::fetch::CatalogFetcher;
use crate::{transports, Model};

// Codex requires a client version, not Prime Agent's version. Use the current
// release's catalog contract (openai/codex rust-v0.162.1). The server may gate
// future models on a newer client contract; this is not an API version.
pub(crate) const MODELS_URL: &str =
    "https://chatgpt.com/backend-api/codex/models?client_version=0.162.1";
const CACHE_FILE: &str = "openai-codex-models-cache.json";

/// Credentials for the `ChatGPT` subscription model catalog. Never persisted or logged.
#[derive(Clone)]
pub struct CodexCredentials {
    pub access_token: String,
    pub account_id: String,
}

pub(crate) struct CodexCatalog {
    cache: CatalogCache<Vec<Model>>,
}

impl CodexCatalog {
    pub(crate) fn new(models_dir: Option<PathBuf>, url: &str) -> Self {
        Self {
            cache: CatalogCache::new(
                url,
                models_dir.map(|dir| dir.join(CACHE_FILE)),
                Arc::new(CatalogFetcher::new()),
                Arc::new(|payload, _scope| parse_models(payload)),
            ),
        }
    }

    pub(crate) fn get(&self, account_id: &str) -> Option<Vec<Model>> {
        self.cache.get(&scope(account_id))
    }

    #[tracing::instrument(skip_all)]
    pub(crate) async fn refresh(&self, credentials: &CodexCredentials) -> Option<Vec<Model>> {
        self.cache
            .refresh(
                &scope(&credentials.account_id),
                RefreshOptions {
                    // Honor the disk TTL even on startup; account changes naturally use a new scope.
                    force: false,
                    headers: vec![
                        (
                            "Authorization".into(),
                            format!("Bearer {}", credentials.access_token),
                        ),
                        ("ChatGPT-Account-Id".into(), credentials.account_id.clone()),
                        ("originator".into(), "pi".into()), // Existing Codex wire identifier.
                    ],
                    is_current: None,
                },
            )
            .await
    }
}

fn scope(account_id: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(b"prime-agent:codex-models:v1\0");
    hash.update(account_id.as_bytes());
    hex::encode(hash.finalize())
}

#[derive(Deserialize)]
struct Entry {
    slug: String,
    display_name: String,
    visibility: String,
    context_window: Option<u64>,
    max_context_window: Option<u64>,
    supported_reasoning_levels: Option<Vec<Effort>>,
    input_modalities: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct Effort {
    effort: String,
}

fn parse_models(payload: &serde_json::Value) -> Result<Vec<Model>, String> {
    let items = payload
        .get("models")
        .and_then(serde_json::Value::as_array)
        .ok_or("Invalid Codex model catalog")?;
    let template = transports::compiled_models()
        .iter()
        .find(|model| model.provider == "openai-codex")
        .ok_or("Missing compiled Codex transport")?;
    let mut seen = HashSet::new();
    let mut models = Vec::new();
    for item in items {
        let Ok(entry) = serde_json::from_value::<Entry>(item.clone()) else {
            continue;
        };
        if entry.visibility != "list"
            || entry.slug.trim().is_empty()
            || entry.slug.len() > 1024
            || entry.slug.chars().any(char::is_control)
            || !seen.insert(entry.slug.clone())
        {
            continue;
        }
        let known = transports::compiled_models()
            .iter()
            .find(|model| model.provider == "openai-codex" && model.id == entry.slug);
        let mut model = known.unwrap_or(template).clone();
        model.id = entry.slug;
        model.name = entry
            .display_name
            .chars()
            .filter(|c| !c.is_control())
            .collect();
        if model.name.trim().is_empty() {
            model.name.clone_from(&model.id);
        }
        if let Some(context) = entry
            .context_window
            .or(entry.max_context_window)
            .filter(|context| *context > 0)
        {
            model.context_window = context;
        }
        // The API has no output-token or price metadata. Keep known values; new models
        // use the compiled output limit (bounded by context), with unknown pricing = zero.
        model.max_tokens = model.max_tokens.min(model.context_window);
        if known.is_none() {
            model.cost = ModelCost {
                input: 0.0.into(),
                output: 0.0.into(),
                cache_read: 0.0.into(),
                cache_write: 0.0.into(),
            };
        }
        if let Some(modalities) = entry.input_modalities {
            model.input = vec![ModelInput::Text];
            if modalities.iter().any(|mode| mode == "image") {
                model.input.push(ModelInput::Image);
            }
        }
        if let Some(levels) = entry.supported_reasoning_levels {
            model.reasoning = levels.iter().any(|level| level.effort != "none");
            model.thinking_level_map = Some(
                [
                    ModelThinkingLevel::Off,
                    ModelThinkingLevel::Minimal,
                    ModelThinkingLevel::Low,
                    ModelThinkingLevel::Medium,
                    ModelThinkingLevel::High,
                    ModelThinkingLevel::Xhigh,
                    ModelThinkingLevel::Max,
                ]
                .into_iter()
                .map(|level| {
                    let wire = if level == ModelThinkingLevel::Off {
                        "none"
                    } else {
                        level.wire_name()
                    };
                    (
                        level,
                        levels
                            .iter()
                            .any(|effort| effort.effort == wire)
                            .then(|| wire.to_string()),
                    )
                })
                .collect(),
            );
        }
        models.push(model);
    }
    if models.is_empty() {
        return Err("Codex model catalog has no visible models".into());
    }
    Ok(models)
}
