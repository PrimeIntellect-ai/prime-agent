//! The daemon-only provenance of RLM child status notices: the reserved custom kinds
//! and the one-shot capability that parks the daemon's own notice injection in a
//! parent session's queue. Wire trust boundary (queue-fold anti-spoof, 2026-09-25):
//! a caller-supplied row claiming a reserved kind is answered LOUDLY, never parked;
//! only the daemon's own delivery or recovery journal reaches a queue lane with a
//! reserved kind.

use std::collections::HashMap;
use std::path::Path;
#[cfg(unix)]
use std::path::PathBuf;
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
/// reserved kind.
pub(crate) fn reserved_intake_error() -> String {
    format!(
        "Invalid customMessage: the {} custom types are reserved for daemon-injected RLM child status notices",
        RESERVED_CUSTOM_KINDS.join("/")
    )
}

/// A mint whose admission never arrived ages out after this window; the notice's own
/// socket round-trip is milliseconds, so the sweep only reclaims dead mints.
const MINT_TTL: Duration = Duration::from_secs(60);

/// The durable capability twin's directory under the agent dir: the
/// daemon's delivery may run in a different process than the consuming
/// queue admission (an embedding host, the e2e harness), so the mint
/// leaves a private one-shot file where the two processes agree to look.
#[cfg(unix)]
const NONCE_DIR: &str = "rlm-notice-nonces";

fn pending() -> &'static Mutex<HashMap<String, Instant>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

#[cfg(unix)]
fn nonce_dir(agent_dir: &Path) -> PathBuf {
    agent_dir.join(NONCE_DIR)
}

/// A capability's wire value must be exactly a UUID before it may name a
/// file: the intake accepts the value from the wire, so anything else is a
/// caller's guess and never touches the filesystem.
fn well_formed_nonce(nonce: &str) -> bool {
    uuid::Uuid::parse_str(nonce).is_ok()
}

/// Record the durable twin (best effort): a write failure keeps the
/// in-process mint authoritative for a same-process admission.
#[cfg(unix)]
fn write_nonce_file(agent_dir: &Path, nonce: &str) {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

    let directory = nonce_dir(agent_dir);
    if std::fs::create_dir_all(&directory).is_err() {
        return;
    }
    // The directory and the nonce files are private to this user: a
    // capability another account could read would be no capability.
    let _ = std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700));
    // Sweep the mints whose admission never arrived (or whose consuming
    // process died): bounded by the same TTL as the in-process map.
    if let Ok(entries) = std::fs::read_dir(&directory) {
        let now = std::time::SystemTime::now();
        for entry in entries.flatten() {
            let expired = entry
                .metadata()
                .and_then(|metadata| metadata.modified())
                .is_ok_and(|modified| now.duration_since(modified).unwrap_or_default() >= MINT_TTL);
            if expired {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    let _ = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(directory.join(nonce));
}

/// The durable twin is a POSIX file claim; the Windows build keeps the
/// in-process map alone (a same-process admission, the only shape the
/// desktop daemon serves).
#[cfg(not(unix))]
fn write_nonce_file(_agent_dir: &Path, _nonce: &str) {}

/// Claim the durable twin exactly once: the unlink is atomic, so two
/// consumers racing the same nonce can never both win.
#[cfg(unix)]
fn consume_nonce_file(agent_dir: &Path, nonce: &str) -> bool {
    if !well_formed_nonce(nonce) {
        return false;
    }
    std::fs::remove_file(nonce_dir(agent_dir).join(nonce)).is_ok()
}

#[cfg(not(unix))]
fn consume_nonce_file(_agent_dir: &Path, _nonce: &str) -> bool {
    false
}

/// Mint a fresh one-shot notice capability: only
/// [`crate::rlm_children::deliver_terminal_notice`] calls this, so a client-plane
/// caller can never mint, observe, or replay one. The in-process map serves a
/// same-process admission; the agent-dir twin covers a delivery whose consuming
/// worker runs in another process. The registry has NO capacity bound on purpose
/// (review round 3): eviction could drop a still-live mint; growth is bounded and
/// mints age out (the files by [`MINT_TTL`], the map by the same window).
pub(crate) fn mint(agent_dir: &Path) -> String {
    let nonce = uuid::Uuid::new_v4().to_string();
    write_nonce_file(agent_dir, &nonce);
    let mut registry = pending().lock().unwrap();
    let now = Instant::now();
    registry.retain(|_, minted| now.duration_since(*minted) < MINT_TTL);
    registry.insert(nonce.clone(), now);
    nonce
}

/// Consume a minted capability exactly once: the queue admission of a
/// reserved-kind custom row requires it. `false` answers everything a
/// caller could send — an absent, unknown, or already-consumed nonce.
pub(crate) fn consume(agent_dir: &Path, nonce: Option<&str>) -> bool {
    let Some(nonce) = nonce else {
        return false;
    };
    if !well_formed_nonce(nonce) {
        // Every mint is a UUID; anything else is a caller's guess.
        return false;
    }
    // Claim BOTH twins on every consume: claiming only the in-process map
    // would leave the durable twin claimable a second time from another
    // process inside the TTL. A miss on both is the caller's no-capability
    // answer.
    let in_process = pending().lock().unwrap().remove(nonce).is_some();
    let durable = consume_nonce_file(agent_dir, nonce);
    in_process || durable
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn agent_dir() -> tempfile::TempDir {
        tempfile::tempdir().expect("test agent dir")
    }

    #[test]
    fn a_mint_consumes_exactly_once() {
        let dir = agent_dir();
        let nonce = mint(dir.path());
        assert!(consume(dir.path(), Some(&nonce)), "a fresh mint consumes");
        assert!(
            !consume(dir.path(), Some(&nonce)),
            "the same mint never consumes twice (replay-proof)"
        );
    }

    #[test]
    fn a_minted_capability_consumes_from_another_process_twin() {
        // The daemon's delivery can run in a different process than the
        // consuming queue admission (an embedding host, the e2e harness):
        // the mint's durable twin under the shared agent dir is what lets
        // that delivery pass the guard. Clearing the in-process map models
        // the consuming process, which never saw the mint.
        let dir = agent_dir();
        let nonce = mint(dir.path());
        // Drop only this mint's in-process entry: the consuming process
        // never saw it (the map is global to the test process).
        assert!(
            pending().lock().unwrap().remove(&nonce).is_some(),
            "the mint registered in-process first"
        );
        assert!(
            consume(dir.path(), Some(&nonce)),
            "the cross-process twin consumes the mint"
        );
        assert!(
            !consume(dir.path(), Some(&nonce)),
            "the cross-process twin is one-shot too"
        );
    }

    #[test]
    fn everything_a_caller_might_send_consumes_nothing() {
        let dir = agent_dir();
        assert!(
            !consume(dir.path(), None),
            "an absent nonce is no capability"
        );
        assert!(
            !consume(dir.path(), Some("")),
            "an empty nonce is no capability"
        );
        assert!(
            !consume(
                dir.path(),
                Some("guessed-8ce7c0a2-0000-4000-8000-000000000000")
            ),
            "an unguessable-but-wrong nonce is no capability"
        );
        // A wire value that is not a UUID never names a file: no traversal,
        // no read of anything outside the nonce directory.
        assert!(
            !consume(dir.path(), Some("../escape")),
            "a non-UUID nonce never touches the durable store"
        );
        assert!(
            !consume_nonce_file(dir.path(), "../escape"),
            "the file claim itself refuses a non-UUID name"
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
