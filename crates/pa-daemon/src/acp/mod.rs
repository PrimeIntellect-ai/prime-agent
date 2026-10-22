//! ACP stdio mode served over a daemon session; see `daemon.rs`.

mod config_options;
pub mod daemon;
mod jsonrpc;
mod mcp;
mod meta;
mod producer;
mod types;
mod wire_config;
mod wire_events;

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

fn internal_error(id: &Value, details: &str) -> Value {
    jsonrpc::error_response(
        id,
        jsonrpc::INTERNAL_ERROR,
        "Internal error",
        Some(&json!({ "details": details })),
    )
}

/// The failed-prompt reply: the nano-rlm #200 `kind`/`retryable` contract.
/// `kind` is `"model_transport"` for the exhausted model connection family
/// (`network_error`/`stream_drop`/`timeout` — the one class a host may
/// re-prompt on) or a context overflow (pa-ai's provider pattern table);
/// every other failure carries the #2117 classifier's category. The fine
/// #2117 category rides separately in `category`. `retryable` is true only
/// for `model_transport`: the harness auto-retry is already exhausted by
/// the time this reply exists, and a host retry is a fresh prompt, not an
/// idempotent replay — `session/prompt` persists the user row and
/// side-effecting tools may already have run, so a rate limit, an empty
/// balance, or a lost supervisor link must not be marked retryable. The
/// flag is advisory: the host's own retry policy decides.
fn turn_failure_error(id: &Value, failure: &str, details: &str) -> Value {
    let classification = pa_core::session_engine::error_classify::classify_error_message(failure);
    let context_overflow = pa_ai::utils::overflow::error_message_has_overflow(failure);
    let kind = if context_overflow {
        "context_limit"
    } else if classification.is_model_transport() {
        "model_transport"
    } else {
        classification.category
    };
    let category = if context_overflow {
        kind
    } else {
        classification.category
    };
    jsonrpc::error_response(
        id,
        jsonrpc::INTERNAL_ERROR,
        "Internal error",
        Some(&json!({
            "details": details,
            "kind": kind,
            "category": category,
            "retryable": kind == "model_transport",
        })),
    )
}

/// Two paths are the same cwd when their canonical forms match, or when they
/// are the same directory on disk (dev/inode) — the bind-mount and
/// case-normalized-FS cases a lexical comparison misses.
fn same_cwd(requested: &Path, actual: &Path) -> bool {
    let canonical = |path: &Path| -> PathBuf {
        std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
    };
    let requested = canonical(requested);
    let actual = canonical(actual);
    if requested == actual {
        return true;
    }
    #[cfg(unix)]
    {
        let identity = |path: &Path| -> Option<(u64, u64)> {
            use std::os::unix::fs::MetadataExt;
            let metadata = std::fs::metadata(path).ok()?;
            if metadata.dev() == 0 || metadata.ino() == 0 {
                return None;
            }
            Some((metadata.dev(), metadata.ino()))
        };
        if let (Some(left), Some(right)) = (identity(&requested), identity(&actual)) {
            return left == right;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The error-data view of one failed prompt arm, as the #200 host
    /// contract reads it.
    fn error_data(failure: &str) -> Value {
        turn_failure_error(&json!(1), failure, "prime-agent turn failed")["error"]["data"].clone()
    }

    #[test]
    fn transport_failures_carry_the_model_transport_contract() {
        for failure in [
            "ECONNRESET: model connection reset mid-stream",
            "Connection error.",
            "Request timed out.",
        ] {
            let data = error_data(failure);
            assert_eq!(data["kind"], "model_transport", "{failure}: {data}");
            assert_eq!(data["retryable"], true, "{failure}: {data}");
            assert_eq!(data["details"], "prime-agent turn failed");
        }
        // The fine #2117 category rides separately.
        let network = error_data("ECONNRESET: model connection reset mid-stream");
        assert_eq!(network["category"], "network");
        let timeout = error_data("Request timed out.");
        assert_eq!(timeout["category"], "timeout");
    }

    #[test]
    fn only_model_transport_is_retryable() {
        // The auto-retry verdicts (rate limit, balance) do not transfer
        // to the boundary: a host retry is a fresh prompt, not an
        // idempotent replay (#200: 400/401 are never marked retryable).
        for failure in [
            "API Error: 429 rate limit exceeded",
            "402 insufficient credits",
            "401 unauthorized",
            "Provider server error",
        ] {
            let data = error_data(failure);
            assert_eq!(data["retryable"], false, "{failure}: {data}");
            assert_ne!(data["kind"], "model_transport", "{failure}: {data}");
        }
        let rate_limited = error_data("API Error: 429 rate limit exceeded");
        assert_eq!(rate_limited["kind"], "rate_limit");
        assert_eq!(rate_limited["category"], "rate_limit");
        let auth = error_data("401 unauthorized");
        assert_eq!(auth["kind"], "authentication");
        assert_eq!(auth["category"], "authentication");
    }

    #[test]
    fn context_overflow_keeps_the_context_limit_kind() {
        // The structured provider pattern table catches the Anthropic
        // overflow the #2117 keyword set misses.
        let data = error_data("prompt is too long: 213462 tokens > 200000 maximum");
        assert_eq!(data["kind"], "context_limit");
        assert_eq!(data["category"], "context_limit");
        assert_eq!(data["retryable"], false);
        // The OpenAI wire `code` reaches the same kind through the
        // classifier.
        let data = error_data("context_length_exceeded");
        assert_eq!(data["kind"], "context_limit");
        assert_eq!(data["retryable"], false);
    }

    #[test]
    fn an_http_408_is_a_provider_category_not_transport() {
        // A 408 is an HTTP status answer over a live connection (#200:
        // HTTP status errors retain the existing behavior): the `timeout`
        // subtype must not leak into the transport family.
        let data = error_data("408 Request Timeout");
        assert_eq!(data["kind"], "timeout");
        assert_eq!(data["category"], "timeout");
        assert_eq!(data["retryable"], false);
    }

    #[test]
    fn unclassified_and_link_failures_are_classified_not_retryable() {
        // A host can tell "classified, not retryable" from an untyped
        // error: every failed-prompt arm carries the typed data.
        for failure in [
            "Prompt cannot be empty",
            "the daemon connection closed mid-request",
            "an opaque harness crash",
            "Failed to publish ACP completion",
        ] {
            let data = error_data(failure);
            assert_eq!(data["kind"], "other", "{failure}: {data}");
            assert_eq!(data["category"], "other", "{failure}: {data}");
            assert_eq!(data["retryable"], false, "{failure}: {data}");
        }
    }
}
