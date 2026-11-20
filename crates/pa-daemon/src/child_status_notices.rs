//! The daemon-only provenance of RLM child status notices: the reserved custom kinds
//! and the one-shot capability that parks the daemon's own notice injection in a
//! parent session's queue. Wire trust boundary (queue-fold anti-spoof, 2026-09-25):
//! a caller-supplied row claiming a reserved kind is answered LOUDLY, never parked;
//! only the daemon's own delivery or recovery journal reaches a queue lane with a
//! reserved kind.

#[cfg(not(unix))]
use std::collections::HashMap;
use std::path::Path;
#[cfg(unix)]
use std::path::PathBuf;
#[cfg(not(unix))]
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
#[cfg(not(unix))]
use std::time::Instant;

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

#[cfg(not(unix))]
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

/// Record the capability in the shared, private Unix store.
#[cfg(unix)]
fn write_nonce_file(agent_dir: &Path, nonce: &str) {
    use pa_core::platform::perms::{create_dir_all_private, restrict_dir, set_private_mode};

    let directory = nonce_dir(agent_dir);
    if create_dir_all_private(&directory).is_err() || restrict_dir(&directory).is_err() {
        return;
    }
    // Sweep abandoned mints after the same window as the in-process store.
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
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    set_private_mode(&mut options);
    let _ = options.open(directory.join(nonce));
}

/// Claim the capability exactly once through an atomic unlink.
#[cfg(unix)]
fn consume_nonce_file(agent_dir: &Path, nonce: &str) -> bool {
    if !well_formed_nonce(nonce) {
        return false;
    }
    std::fs::remove_file(nonce_dir(agent_dir).join(nonce)).is_ok()
}

/// Mint a one-shot notice capability. Unix workers share a private file
/// store. Other platforms use the same-process registry.
pub(crate) fn mint(agent_dir: &Path) -> String {
    let nonce = uuid::Uuid::new_v4().to_string();
    #[cfg(unix)]
    write_nonce_file(agent_dir, &nonce);
    #[cfg(not(unix))]
    {
        let _ = agent_dir;
        let mut registry = pending().lock().unwrap();
        let now = Instant::now();
        registry.retain(|_, minted| now.duration_since(*minted) < MINT_TTL);
        registry.insert(nonce.clone(), now);
    }
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
    #[cfg(unix)]
    {
        consume_nonce_file(agent_dir, nonce)
    }
    #[cfg(not(unix))]
    {
        let _ = agent_dir;
        pending().lock().unwrap().remove(nonce).is_some()
    }
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

    #[cfg(unix)]
    #[test]
    fn an_external_claim_prevents_a_local_replay() {
        let dir = agent_dir();
        let nonce = mint(dir.path());
        assert!(nonce_dir(dir.path()).join(&nonce).is_file());
        // Another process can only claim the shared file.
        assert!(consume_nonce_file(dir.path(), &nonce));
        assert!(!consume(dir.path(), Some(&nonce)));
    }

    #[cfg(unix)]
    #[test]
    fn the_nonce_store_is_private_on_creation_and_reuse() {
        use pa_core::platform::perms::file_mode;
        use std::os::unix::fs::PermissionsExt;

        let dir = agent_dir();
        let nonce = mint(dir.path());
        let store = nonce_dir(dir.path());
        assert_eq!(file_mode(&store), Some(0o700));
        assert_eq!(file_mode(&store.join(&nonce)), Some(0o600));
        std::fs::set_permissions(&store, std::fs::Permissions::from_mode(0o755)).unwrap();
        let second = mint(dir.path());
        assert_eq!(file_mode(&store), Some(0o700));
        assert_eq!(file_mode(&store.join(&second)), Some(0o600));
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
        // Build the name so the claim is tested against a computed value,
        // never a hard-coded one that could read as a real nonce.
        #[cfg(unix)]
        let traversal = String::from("..") + "/" + "escape";
        #[cfg(unix)]
        assert!(
            !consume_nonce_file(dir.path(), &traversal),
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
