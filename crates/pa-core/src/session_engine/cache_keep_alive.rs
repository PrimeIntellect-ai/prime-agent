//! Prompt-cache keep-alive: while a tool batch is pending, the provider
//! prompt cache the request just wrote expires on its TTL before the next
//! model request — a full cache WRITE (1.25x input for a 5-minute block)
//! rebuys the prefix. The keep-alive fires ONE same-shape request with
//! `max_tokens = 1` at (TTL - margin) per window while the batch is still
//! pending: a nearly-free cache READ (~0.1x input plus one output token)
//! that re-arms the TTL.
//!
//! The loop mechanics live in `pa-agent` (`agent_loop::keep_alive`); this
//! module owns the policy: the settings gate, the TTL window per model,
//! the durable usage attribution row, and the one structured line per
//! fire.

use std::sync::Arc;
use std::time::Duration;

use pa_agent::agent_loop::CacheKeepAliveConfig;
use pa_agent::types::Model as AgentModel;

use crate::session::manager::SessionManager;

/// The safety margin subtracted from the provider cache TTL: the warm
/// request fires at (TTL - margin), so a slow window (the request itself
/// takes time to reach the provider) still lands inside the TTL.
pub const CACHE_KEEP_ALIVE_MARGIN: Duration = Duration::from_secs(60);

/// The per-run keep-alive policy for the loop (the resolver the engine
/// installs on the agent): eligible only when the `cacheKeepAlive` setting
/// has not opted out AND the model's requests carry prompt-cache blocks
/// (the anthropic-messages family; the same retention resolution the
/// provider stream applies). The warm fire is attributed through the
/// session's durable `cache_keep_alive` row, never silent cost.
#[must_use]
pub fn keep_alive_resolver(
    setting: Option<bool>,
    session: Arc<tokio::sync::Mutex<SessionManager>>,
) -> pa_agent::agent::CacheKeepAliveResolver {
    Arc::new(move |model: &AgentModel| {
        // The explicit opt-out (`cacheKeepAlive: false`); unset stays on.
        if setting == Some(false) {
            return None;
        }
        let ttl = pa_ai::prompt_cache_ttl(&model.api, None, None)?;
        let rearm_after = ttl.saturating_sub(CACHE_KEEP_ALIVE_MARGIN);
        if rearm_after.is_zero() {
            return None;
        }
        let session = Arc::clone(&session);
        Some(CacheKeepAliveConfig {
            rearm_after,
            on_fire: Arc::new(move |fire| {
                let session = Arc::clone(&session);
                Box::pin(async move {
                    record_fire(&session, fire).await;
                })
            }),
        })
    })
}

/// One fired warm request: one structured line, and — when the discarded
/// response reported usage — the durable attribution row (the fire is
/// real provider spend; the usage report must show it).
async fn record_fire(
    session: &Arc<tokio::sync::Mutex<SessionManager>>,
    fire: pa_agent::agent_loop::CacheKeepAliveFire,
) {
    let usage = fire.usage.as_ref().map(|usage| {
        // The loop's usage crosses into the session wire shape by the
        // shared JSON form (the two crates' Usage types mirror each other).
        serde_json::from_value::<pa_types::ai::Usage>(
            serde_json::to_value(usage).unwrap_or_default(),
        )
        .unwrap_or_default()
    });
    if let Some(error) = &fire.error {
        tracing::warn!(
            provider = %fire.model.provider,
            model = %fire.model.id,
            error = %error,
            "prompt cache keep-alive warm request failed; the turn proceeds"
        );
        return;
    }
    let Some(usage) = usage else {
        // A failed or aborted fire reported nothing billable: no row.
        tracing::debug!(
            provider = %fire.model.provider,
            model = %fire.model.id,
            "prompt cache keep-alive warm request reported no usage"
        );
        return;
    };
    // One structured line per fire (the observability surface): the
    // attributed usage rides the durable row; this line makes every
    // fire legible in the diagnostic log.
    tracing::info!(
        provider = %fire.model.provider,
        model = %fire.model.id,
        input = usage.input,
        output = usage.output,
        cache_read = usage.cache_read,
        total_tokens = usage.total_tokens,
        cost_total = usage.cost.total.as_f64(),
        "prompt cache keep-alive fired"
    );
    let mut session = session.lock().await;
    if let Err(error) = session.append_cache_keep_alive(&fire.model.provider, &fire.model.id, usage)
    {
        // The attribution row is bookkeeping: a failed append is logged
        // and dropped (the same recoverable-write contract as the child
        // usage attribution), never a turn failure.
        tracing::warn!("prompt cache keep-alive usage row not persisted: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent_model(api: &str) -> AgentModel {
        serde_json::from_value(serde_json::json!({
            "id": "claude-test", "name": "Claude Test", "api": api, "provider": "anthropic",
            "baseUrl": "", "reasoning": false,
            "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
            "contextWindow": 100_000, "maxTokens": 4_096,
        }))
        .expect("agent model parses")
    }

    fn session_manager() -> Arc<tokio::sync::Mutex<SessionManager>> {
        Arc::new(tokio::sync::Mutex::new(SessionManager::in_memory(
            std::path::Path::new("/tmp"),
        )))
    }

    #[test]
    fn eligible_model_arms_at_ttl_minus_margin() {
        let resolver = keep_alive_resolver(None, session_manager());
        let policy = resolver(&agent_model("anthropic-messages")).expect("policy");
        assert_eq!(
            policy.rearm_after,
            pa_ai::CACHE_TTL_FIVE_MINUTES
                .checked_sub(CACHE_KEEP_ALIVE_MARGIN)
                .expect("the 5-minute TTL exceeds the margin")
        );
    }

    #[test]
    fn opt_out_and_non_cache_models_never_arm() {
        // The explicit `cacheKeepAlive: false` opts out entirely.
        let resolver = keep_alive_resolver(Some(false), session_manager());
        assert!(resolver(&agent_model("anthropic-messages")).is_none());
        // Models whose requests carry no anthropic cache blocks never fire.
        let resolver = keep_alive_resolver(None, session_manager());
        assert!(resolver(&agent_model("openai-completions")).is_none());
    }

    #[test]
    fn resolved_fire_appends_the_usage_row() {
        let session = session_manager();
        let resolver = keep_alive_resolver(None, Arc::clone(&session));
        let policy = resolver(&agent_model("anthropic-messages")).expect("policy");
        let fire = pa_agent::agent_loop::CacheKeepAliveFire {
            model: agent_model("anthropic-messages"),
            usage: Some(pa_agent::types::Usage {
                input: 12,
                output: 1,
                cache_read: 12_000,
                cache_write: 0,
                total_tokens: 12_013,
                cost: pa_agent::types::UsageCost {
                    input: 0.000_012,
                    output: 0.000_075,
                    cache_read: 0.001_2,
                    cache_write: 0.0,
                    total: 0.001_287,
                },
            }),
            error: None,
        };
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        rt.block_on((policy.on_fire)(fire));
        let entries = rt.block_on(async { session.lock().await.retained_entries().to_vec() });
        let rows: Vec<_> = entries
            .iter()
            .filter_map(|entry| match entry {
                pa_types::session::FileEntry::CacheKeepAlive { payload, .. } => Some((
                    payload.provider.as_str(),
                    payload.model_id.as_str(),
                    payload.usage.cache_read,
                )),
                _ => None,
            })
            .collect();
        assert_eq!(
            rows,
            vec![("anthropic", "claude-test", 12_000)],
            "the warm usage lands as a distinct durable row: {rows:?}"
        );
    }
}
