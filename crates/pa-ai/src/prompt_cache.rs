//! The prompt-cache TTL seam for cache keep-alive: the TTL vocabulary of
//! `cache_control` blocks (`5m` default, `1h` with long cache retention),
//! resolved exactly the way the anthropic-messages provider stream resolves
//! a request's cache control.

use std::time::Duration;

use crate::providers::anthropic::resolve_cache_retention;
use crate::types::{CacheRetention, ModelCompat};
use pa_types::ai::CompatKind;

/// The 5-minute default (`cache_control` without a `ttl`).
pub const CACHE_TTL_FIVE_MINUTES: Duration = Duration::from_secs(300);
/// The one-hour TTL (`cache_control` with `ttl: "1h"`).
pub const CACHE_TTL_ONE_HOUR: Duration = Duration::from_secs(3_600);

/// The prompt-cache TTL a request to `api` carries: five minutes for the
/// anthropic-messages family by default, one hour when cache retention is
/// long AND the model's compat block does not opt out of long retention
/// (the same resolution [`crate::providers::anthropic`]'s
/// `get_cache_control` applies per request; `compat` absent means the
/// provider default of long-retention support). `None` when the request
/// carries no prompt-cache blocks at all: a different api family, or cache
/// retention `None`.
#[must_use]
pub fn prompt_cache_ttl(
    api: &str,
    compat: Option<&ModelCompat>,
    cache_retention: Option<CacheRetention>,
) -> Option<Duration> {
    if api != crate::providers::anthropic::API_ANTHROPIC_MESSAGES {
        return None;
    }
    let retention = resolve_cache_retention(cache_retention);
    if retention == CacheRetention::None {
        return None;
    }
    let supports_long_cache_retention = compat
        .and_then(|compat| compat.kind().ok())
        .and_then(|kind| match kind {
            CompatKind::AnthropicMessages(compat) => compat.supports_long_cache_retention,
            _ => None,
        })
        .unwrap_or(true);
    Some(
        if retention == CacheRetention::Long && supports_long_cache_retention {
            CACHE_TTL_ONE_HOUR
        } else {
            CACHE_TTL_FIVE_MINUTES
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::CacheRetention;

    fn anthropic_compat(supports_long: bool) -> ModelCompat {
        // The eager-tool-input key is what `ModelCompat::kind` sniffs to
        // recognize the anthropic-messages compat block.
        ModelCompat::from_kind(CompatKind::AnthropicMessages(
            pa_types::ai::AnthropicMessagesCompat {
                supports_eager_tool_input_streaming: Some(true),
                supports_long_cache_retention: Some(supports_long),
            },
        ))
    }

    #[test]
    fn anthropic_messages_family_defaults_to_five_minutes() {
        assert_eq!(
            prompt_cache_ttl("anthropic-messages", None, None),
            Some(CACHE_TTL_FIVE_MINUTES)
        );
        assert_eq!(
            prompt_cache_ttl("anthropic-messages", None, Some(CacheRetention::Short)),
            Some(CACHE_TTL_FIVE_MINUTES)
        );
    }

    #[test]
    fn long_retention_promotes_the_one_hour_ttl() {
        assert_eq!(
            prompt_cache_ttl("anthropic-messages", None, Some(CacheRetention::Long)),
            Some(CACHE_TTL_ONE_HOUR)
        );
        // A compat block opting out of long retention keeps the 5m TTL
        // (the provider's `supports_long_cache_retention` resolution).
        let compat = anthropic_compat(false);
        assert_eq!(
            prompt_cache_ttl(
                "anthropic-messages",
                Some(&compat),
                Some(CacheRetention::Long)
            ),
            Some(CACHE_TTL_FIVE_MINUTES)
        );
        let compat = anthropic_compat(true);
        assert_eq!(
            prompt_cache_ttl(
                "anthropic-messages",
                Some(&compat),
                Some(CacheRetention::Long)
            ),
            Some(CACHE_TTL_ONE_HOUR)
        );
    }

    #[test]
    fn no_cache_blocks_means_no_ttl() {
        // Retention None: the request carries no cache_control at all.
        assert_eq!(
            prompt_cache_ttl("anthropic-messages", None, Some(CacheRetention::None)),
            None
        );
        // Other api families never carry anthropic cache blocks.
        assert_eq!(prompt_cache_ttl("openai-responses", None, None), None);
        assert_eq!(
            prompt_cache_ttl("openai-completions", None, Some(CacheRetention::Long)),
            None
        );
    }
}
