//! The daemon-only provenance of RLM child status notices: the reserved
//! custom kinds and the one-shot capability that lets the daemon's own
//! notice injection park them in a parent session's queue.
//!
//! Wire trust boundary (the queue-fold anti-spoof, 2026-09-25): a
//! caller-supplied `customMessage` on `prompt`/`steer`/`follow_up` — and a
//! custom row restored through `restore_actions` — is answered LOUDLY
//! whenever it claims either reserved kind; the row never parks. The only
//! rows that reach a queue lane with a reserved kind are the ones
//! [`crate::rlm_children::deliver_terminal_notice`] parks with a
//! capability minted here (same process, one socket round-trip) and the
//! ones the daemon-written recovery journal restores, so
//! [`crate::worker::is_rlm_child_status_item`]'s classification sees only
//! daemon-authentic kinds.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::Value;

/// The custom kinds ONLY the daemon's notice producer creates (pa-core
/// `rlm_notices`): the terminal-notice and failure rows.
pub(crate) const RESERVED_CUSTOM_KINDS: [&str; 2] = [
    pa_core::session_engine::rlm_notices::RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE,
    pa_core::session_engine::rlm_notices::RLM_CHILD_FAILURE_CUSTOM_TYPE,
];

/// Whether one custom row claims a reserved child-status kind (exact
/// match, case sensitive — never a prefix family).
pub(crate) fn is_reserved_child_status_custom_type(custom_message: &Value) -> bool {
    matches!(
        custom_message.get("customType").and_then(Value::as_str),
        Some(
            pa_core::session_engine::rlm_notices::RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE
                | pa_core::session_engine::rlm_notices::RLM_CHILD_FAILURE_CUSTOM_TYPE
        )
    )
}

/// The loud intake rejection for a caller-supplied row claiming a
/// reserved kind (one string on every client surface, so the rule reads
/// as one rule).
pub(crate) fn reserved_intake_error() -> String {
    format!(
        "Invalid customMessage: the {} custom types are reserved for daemon-injected RLM child status notices",
        RESERVED_CUSTOM_KINDS.join("/")
    )
}

/// A mint whose admission never arrived (the child died before the
/// parent parked the notice, or the command failed in flight) ages out
/// after this window; the notice's own socket round-trip is
/// milliseconds, so the sweep only reclaims dead mints.
const MINT_TTL: Duration = Duration::from_secs(60);

fn pending() -> &'static Mutex<HashMap<String, Instant>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Mint a fresh one-shot notice capability. Only
/// [`crate::rlm_children::deliver_terminal_notice`] calls this — it runs
/// in the same worker process as the queue admission that consumes the
/// mint, and the map is process memory, so a caller on the client command
/// plane can never mint, observe, or replay one.
///
/// The registry has NO capacity bound on purpose (review round 3): a
/// capacity eviction could drop a still-live mint and with it that
/// child's outcome at admission — a burst of settling watchers must keep
/// every notice deliverable. Growth is inherently bounded instead: each
/// entry is a short uuid minted once per child-exit notice round-trip by
/// the daemon's own delivery (nothing client-facing can mint), and dead
/// mints age out with the sweep below.
pub(crate) fn mint() -> String {
    let nonce = uuid::Uuid::new_v4().to_string();
    let mut registry = pending().lock().unwrap();
    let now = Instant::now();
    registry.retain(|_, minted| now.duration_since(*minted) < MINT_TTL);
    registry.insert(nonce.clone(), now);
    nonce
}

/// Consume a minted capability exactly once: the queue admission of a
/// reserved-kind custom row requires it. `false` answers everything a
/// caller could send — an absent, unknown, or already-consumed nonce.
pub(crate) fn consume(nonce: Option<&str>) -> bool {
    let Some(nonce) = nonce else {
        return false;
    };
    pending().lock().unwrap().remove(nonce).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_mint_consumes_exactly_once() {
        let nonce = mint();
        assert!(consume(Some(&nonce)), "a fresh mint consumes");
        assert!(
            !consume(Some(&nonce)),
            "the same mint never consumes twice (replay-proof)"
        );
    }

    #[test]
    fn everything_a_caller_might_send_consumes_nothing() {
        assert!(!consume(None), "an absent nonce is no capability");
        assert!(!consume(Some("")), "an empty nonce is no capability");
        assert!(
            !consume(Some("guessed-8ce7c0a2-0000-4000-8000-000000000000")),
            "an unguessable-but-wrong nonce is no capability"
        );
    }

    #[test]
    fn the_reserved_kinds_match_exactly() {
        for kind in RESERVED_CUSTOM_KINDS {
            assert!(
                is_reserved_child_status_custom_type(&json!({
                    "role": "custom",
                    "customType": kind,
                    "content": "notice",
                })),
                "the reserved kind {kind} is exact-matched"
            );
        }
        for lookalike in [
            "rlm_child_terminal_notice_v2",
            "rlm_child_terminal_notice ",
            " rlm_child_terminal_notice",
            "RLM_CHILD_TERMINAL_NOTICE",
            "rlm_child_terminal",
            "rlmchildterminalnotice",
        ] {
            assert!(
                !is_reserved_child_status_custom_type(&json!({
                    "role": "custom",
                    "customType": lookalike,
                    "content": "spoof",
                })),
                "the lookalike {lookalike:?} is NOT a reserved kind (exact, case-sensitive match)"
            );
        }
        assert!(
            !is_reserved_child_status_custom_type(&json!({ "role": "custom" })),
            "a row without a customType is not a reserved kind"
        );
    }
}
