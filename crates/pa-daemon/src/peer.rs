//! Direct peer transport on the worker's own socket (TS `daemon-mode.ts`
//! worker branch: `peer_auth`, `worker_register_peer_transport`, and the
//! in-memory `peerGrants` map).
//!
//! A session client never learns the worker's bootstrap token. Instead the
//! supervisor issues a single-use grant (TTL 10s) and pushes it to the worker
//! over its supervisor connection; the client presents the grant on the
//! worker socket via `peer_auth`. The grant burns on first use - before the
//! token is even checked - so a leaked or replayed ticket is worthless.
//!
//! Roles on one worker-socket connection:
//! - [`ConnectionRole::Supervisor`]: authenticated with the bootstrap token;
//!   full worker command set, unconditional event fan-out.
//! - [`ConnectionRole::SessionClient`]: authenticated with a burned grant;
//!   session-plane commands for the grant's session only, and event fan-out
//!   only while the client holds an attach on the session.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use pa_types::daemon::{
    is_session_plane_daemon_command, DaemonPeerCommand, DaemonWorkerCommand, DaemonWorkerPeerGrant,
};
use serde_json::Value;

use crate::protocol::{response_failure, response_success, DaemonResponse};
use crate::util::iso_to_unix_ms;
use crate::worker::AuthOutcome;
use crate::worker::Worker;

/// TS `PEER_GRANT_TTL_LIMIT_MS`: a grant whose expiry is further out than
/// this is invalid at registration, so a supervisor cannot mint long-lived
/// credentials even if compromised.
pub(crate) const PEER_GRANT_TTL_LIMIT_MS: i64 = 30_000;
/// TS `PEER_GRANT_LIMIT`: maximum concurrently live grants (expired grants
/// are swept first).
pub(crate) const PEER_GRANT_LIMIT: usize = 1024;

/// TS failure strings (wire parity).
pub(crate) const PEER_AUTH_FAILED: &str = "Peer authentication failed";
pub(crate) const PEER_GRANT_INVALID: &str = "Peer transport grant is invalid";
pub(crate) const PEER_COMMAND_NOT_ALLOWED: &str =
    "Command is not allowed on this direct peer transport";

/// TS purposes plus the stage-3 extension: a `worker` grant admits a peer
/// worker (agent-message delivery), not a session client.
pub(crate) const PEER_PURPOSE_SESSION_CLIENT: &str = "session_client";
pub(crate) const PEER_PURPOSE_WORKER: &str = "worker";

/// Whether a grant purpose is one this worker accepts.
pub(crate) fn peer_purpose_valid(purpose: &str) -> bool {
    purpose == PEER_PURPOSE_SESSION_CLIENT || purpose == PEER_PURPOSE_WORKER
}

/// The authenticated role one worker-socket connection holds.
#[derive(Debug, Clone)]
pub(crate) enum ConnectionRole {
    Unauthenticated,
    /// The supervisor: owns the worker, may send every worker command.
    Supervisor {
        generation: String,
    },
    /// A session client admitted through `peer_auth` with a single-use
    /// grant bound to one session.
    SessionClient {
        session: Arc<PeerSession>,
    },
    /// A peer worker admitted through `peer_auth` with a single-use
    /// `worker`-purpose grant: agent-message delivery only, no session
    /// events (thin-supervisor stage 3).
    PeerWorker {
        session: Arc<PeerSession>,
    },
}

impl ConnectionRole {
    /// Whether event fan-out may stream to this connection.
    pub(crate) fn streams_events(&self) -> bool {
        match self {
            ConnectionRole::Unauthenticated => false,
            ConnectionRole::Supervisor { .. } => true,
            ConnectionRole::SessionClient { session } => session.is_attached(),
            ConnectionRole::PeerWorker { .. } => false,
        }
    }
}

/// One admitted session client: the burned grant plus its attach state.
#[derive(Debug)]
pub(crate) struct PeerSession {
    pub(crate) grant: DaemonWorkerPeerGrant,
    attached: AtomicBool,
}

impl PeerSession {
    fn new(grant: DaemonWorkerPeerGrant) -> Self {
        PeerSession {
            grant,
            attached: AtomicBool::new(false),
        }
    }

    pub(crate) fn is_attached(&self) -> bool {
        self.attached.load(Ordering::SeqCst)
    }

    pub(crate) fn mark_attached(&self) {
        self.attached.store(true, Ordering::SeqCst);
    }

    pub(crate) fn mark_detached(&self) {
        self.attached.store(false, Ordering::SeqCst);
    }
}

/// The worker identity a grant must match (TS compares against the live
/// worker's own instance id and its known sessions).
pub(crate) struct GrantContext {
    pub(crate) worker_instance_id: String,
    pub(crate) active_session_id: String,
    /// The grant's session exists (the worker's create has completed).
    pub(crate) session_created: bool,
}

/// In-memory grant store: worker-memory only, never persisted, swept on
/// every registration.
#[derive(Default)]
pub(crate) struct PeerGrantStore {
    grants: Mutex<HashMap<String, DaemonWorkerPeerGrant>>,
}

impl PeerGrantStore {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// TS `worker_register_peer_transport` validation: the grant must name
    /// this exact worker instance and one of its live sessions, expire in
    /// the future but no further out than the TTL limit, and fit under the
    /// grant cap after the expired sweep. Rejected grants return the TS
    /// error string; the reason is logged by the caller.
    pub(crate) fn register(
        &self,
        grant: DaemonWorkerPeerGrant,
        context: &GrantContext,
        issuer_generation: &str,
        now_ms: u64,
    ) -> Result<(), &'static str> {
        let mut grants = self.grants.lock().unwrap();
        let now = now_ms as i64;
        grants.retain(|_, pending| match iso_to_unix_ms(&pending.expires_at) {
            Some(expires) => expires as i64 > now,
            None => false,
        });
        let expires = iso_to_unix_ms(&grant.expires_at).map(|ms| ms as i64);
        let valid_expiry = matches!(expires, Some(expires) if expires > now && expires - now <= PEER_GRANT_TTL_LIMIT_MS);
        let known_session =
            context.session_created && grant.active_session_id == context.active_session_id;
        if !peer_purpose_valid(&grant.purpose)
            || grant.grant_id.is_empty()
            || grant.token.is_empty()
            || grant.worker_instance_id != context.worker_instance_id
            || !known_session
            || grants.len() >= PEER_GRANT_LIMIT
            || !valid_expiry
            || grant.issuer_generation != issuer_generation
        {
            return Err(PEER_GRANT_INVALID);
        }
        grants.insert(grant.grant_id.clone(), grant);
        Ok(())
    }

    /// TS `peer_auth`: the grant burns first (single use, even on a failed
    /// presentation), then the token, instance, purpose, and expiry are
    /// checked against the burned grant. Success returns the grant so the
    /// connection can be bound to its session.
    pub(crate) fn authenticate(
        &self,
        presented: &DaemonPeerCommand,
        context: &GrantContext,
        now_ms: u64,
    ) -> Result<DaemonWorkerPeerGrant, &'static str> {
        let DaemonPeerCommand::PeerAuth {
            grant_id,
            token,
            worker_instance_id,
            purpose,
            ..
        } = presented;
        let burned = self.grants.lock().unwrap().remove(grant_id);
        let Some(grant) = burned else {
            return Err(PEER_AUTH_FAILED);
        };
        let expires_ok =
            matches!(iso_to_unix_ms(&grant.expires_at), Some(expires) if expires > now_ms);
        // The local instance id must match too: a grant minted for a dead
        // worker incarnation is useless here.
        let token_ok = grant_token_matches(token, &grant.token);
        let instance_ok = worker_instance_id.as_str() == grant.worker_instance_id.as_str()
            && grant.worker_instance_id == context.worker_instance_id;
        if token_ok
            && instance_ok
            && purpose.as_str() == grant.purpose.as_str()
            && peer_purpose_valid(&grant.purpose)
            && expires_ok
        {
            return Ok(grant);
        }
        Err(PEER_AUTH_FAILED)
    }
}

/// Timing-safe grant-token comparison: both sides are hashed (sha256, the
/// same digest TS compares) so the comparison never short-circuits on a
/// matching prefix.
fn grant_token_matches(presented: &str, expected: &str) -> bool {
    use sha2::{Digest, Sha256};
    let presented = Sha256::digest(presented.as_bytes());
    let expected = Sha256::digest(expected.as_bytes());
    constant_time_eq(&presented, &expected)
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut difference = 0u8;
    for (left, right) in a.iter().zip(b.iter()) {
        difference |= left ^ right;
    }
    difference == 0
}

/// Parse one `peer_auth` presentation from the wire.
pub(crate) fn parse_peer_auth(payload: &Value) -> Result<DaemonPeerCommand, &'static str> {
    serde_json::from_value::<DaemonPeerCommand>(payload.clone()).map_err(|_| PEER_AUTH_FAILED)
}

/// Parse one `worker_register_peer_transport` command from the wire.
pub(crate) fn parse_grant_registration(
    payload: &Value,
) -> Result<DaemonWorkerCommand, &'static str> {
    serde_json::from_value::<DaemonWorkerCommand>(payload.clone()).map_err(|_| PEER_GRANT_INVALID)
}

/// Command gate for a peer-worker connection (stage 3): agent-message
/// delivery only, addressed to the grant's session.
pub(crate) fn worker_peer_command_allowed(
    command_type: &str,
    payload: &Value,
    grant: &DaemonWorkerPeerGrant,
) -> bool {
    command_type == "worker_deliver_message"
        && payload.get("targetActiveSessionId").and_then(Value::as_str)
            == Some(grant.active_session_id.as_str())
}

/// Session-plane gate for a direct peer command (TS `peerClaims` branch):
/// the command must be session-plane and address the grant's session.
pub(crate) fn peer_command_allowed(
    command_type: &str,
    payload: &Value,
    grant: &DaemonWorkerPeerGrant,
) -> bool {
    is_session_plane_daemon_command(command_type)
        && payload.get("activeSessionId").and_then(Value::as_str)
            == Some(grant.active_session_id.as_str())
}

/// The grant fields a peer-auth success response echoes (TS `peer_auth`
/// response data).
pub(crate) fn peer_auth_success_data(grant: &DaemonWorkerPeerGrant) -> Value {
    serde_json::json!({
        "workerInstanceId": grant.worker_instance_id,
        "activeSessionId": grant.active_session_id,
        "purpose": grant.purpose,
    })
}

impl Worker {
    /// One `peer_auth` presentation on an unauthenticated connection: burn
    /// the grant, validate it, promote the connection to a session client,
    /// and write the response. Failure ends the connection.
    pub(crate) async fn handle_peer_auth(
        self: &Arc<Self>,
        payload: &Value,
        request_id: &str,
        role: &Arc<Mutex<ConnectionRole>>,
        sink: &crate::worker::ConnectionSink,
    ) -> AuthOutcome {
        let presentation = match parse_peer_auth(payload) {
            Ok(presentation) => presentation,
            Err(reason) => {
                let failure = response_failure(Some(request_id), "peer_auth", reason, None);
                self.write_response_frame(sink, request_id, &failure).await;
                return AuthOutcome::Failed;
            }
        };
        let context = self.grant_context();
        match self
            .peer_grants
            .authenticate(&presentation, &context, crate::util::now_ms())
        {
            Ok(grant) => {
                let session = Arc::new(PeerSession::new(grant.clone()));
                *role.lock().unwrap() = if grant.purpose == PEER_PURPOSE_WORKER {
                    ConnectionRole::PeerWorker {
                        session: Arc::clone(&session),
                    }
                } else {
                    ConnectionRole::SessionClient {
                        session: Arc::clone(&session),
                    }
                };
                let success = response_success(
                    Some(request_id),
                    "peer_auth",
                    Some(peer_auth_success_data(&grant)),
                );
                self.write_response_frame(sink, request_id, &success).await;
                AuthOutcome::Authenticated
            }
            Err(reason) => {
                let failure = response_failure(Some(request_id), "peer_auth", reason, None);
                self.write_response_frame(sink, request_id, &failure).await;
                AuthOutcome::Failed
            }
        }
    }

    /// `worker_register_peer_transport` (supervisor role only): accept one
    /// single-use grant into the worker-memory store. The grant's issuer
    /// generation must match the authenticated supervisor's.
    pub(crate) fn handle_worker_register_peer_transport(
        &self,
        payload: &Value,
        issuer_generation: &str,
    ) -> DaemonResponse {
        const COMMAND: &str = "worker_register_peer_transport";
        let grant = match parse_grant_registration(payload) {
            Ok(pa_types::daemon::DaemonWorkerCommand::WorkerRegisterPeerTransport {
                grant,
                ..
            }) => grant,
            Ok(_) => {
                return response_failure(None, COMMAND, PEER_GRANT_INVALID, None);
            }
            Err(reason) => {
                return response_failure(None, COMMAND, reason, None);
            }
        };
        let context = self.grant_context();
        match self
            .peer_grants
            .register(grant, &context, issuer_generation, crate::util::now_ms())
        {
            Ok(()) => response_success(None, COMMAND, None),
            Err(reason) => response_failure(None, COMMAND, reason, None),
        }
    }

    /// The worker identity grants are validated against, read under the
    /// core lock (the session-known check is the live `created` state).
    fn grant_context(&self) -> GrantContext {
        let core = self.core.lock().unwrap();
        GrantContext {
            worker_instance_id: self.config.worker_instance_id.clone(),
            active_session_id: self.config.active_session_id.clone(),
            session_created: core.created,
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    fn grant_context() -> GrantContext {
        GrantContext {
            worker_instance_id: "inst-1".to_string(),
            active_session_id: "abc123".to_string(),
            session_created: true,
        }
    }

    fn grant(expires_at: &str) -> DaemonWorkerPeerGrant {
        DaemonWorkerPeerGrant {
            grant_id: "g1".to_string(),
            token: "secret".to_string(),
            expires_at: expires_at.to_string(),
            purpose: "session_client".to_string(),
            worker_instance_id: "inst-1".to_string(),
            active_session_id: "abc123".to_string(),
            issuer_generation: "sup:1".to_string(),
        }
    }

    fn peer_auth(token: &str) -> DaemonPeerCommand {
        DaemonPeerCommand::PeerAuth {
            id: None,
            grant_id: "g1".to_string(),
            token: token.to_string(),
            worker_instance_id: "inst-1".to_string(),
            purpose: "session_client".to_string(),
            rest: Default::default(),
        }
    }

    fn soon(now_ms: u64, delta_ms: i64) -> String {
        crate::util::iso_from_unix_ms(((now_ms as i64) + delta_ms) as u64)
    }

    const NOW: u64 = 1_000_000;

    #[test]
    fn grant_issue_burn_single_use() {
        let store = PeerGrantStore::new();
        let context = grant_context();
        store
            .register(grant(&soon(NOW, 10_000)), &context, "sup:1", NOW)
            .expect("register");
        let admitted = store
            .authenticate(&peer_auth("secret"), &context, NOW)
            .expect("auth");
        assert_eq!(admitted.active_session_id, "abc123");
        // Single use: the second presentation of the same grant fails.
        let replay = store.authenticate(&peer_auth("secret"), &context, NOW);
        assert_eq!(replay.unwrap_err(), PEER_AUTH_FAILED);
    }

    #[test]
    fn grant_burns_even_on_wrong_token() {
        let store = PeerGrantStore::new();
        let context = grant_context();
        store
            .register(grant(&soon(NOW, 10_000)), &context, "sup:1", NOW)
            .expect("register");
        assert_eq!(
            store
                .authenticate(&peer_auth("wrong"), &context, NOW)
                .unwrap_err(),
            PEER_AUTH_FAILED
        );
        // Burned by the failed attempt: the correct token no longer works.
        assert_eq!(
            store
                .authenticate(&peer_auth("secret"), &context, NOW)
                .unwrap_err(),
            PEER_AUTH_FAILED
        );
    }

    #[test]
    fn grant_expires() {
        let store = PeerGrantStore::new();
        let context = grant_context();
        store
            .register(grant(&soon(NOW, 10_000)), &context, "sup:1", NOW)
            .expect("register");
        // Past the TTL window: the grant is expired.
        let later = NOW + 10_001;
        assert_eq!(
            store
                .authenticate(&peer_auth("secret"), &context, later)
                .unwrap_err(),
            PEER_AUTH_FAILED
        );
    }

    #[test]
    fn grant_registration_rejects_bad_shape() {
        let store = PeerGrantStore::new();
        let context = grant_context();
        // Expired at registration time.
        let mut expired = grant(&soon(NOW, 10_000));
        expired.expires_at = soon(NOW, -1);
        assert_eq!(
            store.register(expired, &context, "sup:1", NOW).unwrap_err(),
            PEER_GRANT_INVALID
        );
        // TTL over the limit (31s out).
        assert_eq!(
            store
                .register(grant(&soon(NOW, 31_000)), &context, "sup:1", NOW)
                .unwrap_err(),
            PEER_GRANT_INVALID
        );
        // Wrong purpose.
        let mut purpose = grant(&soon(NOW, 10_000));
        purpose.purpose = "supervisor".to_string();
        assert_eq!(
            store.register(purpose, &context, "sup:1", NOW).unwrap_err(),
            PEER_GRANT_INVALID
        );
        // Wrong worker instance.
        let mut instance = grant(&soon(NOW, 10_000));
        instance.worker_instance_id = "inst-2".to_string();
        assert_eq!(
            store
                .register(instance, &context, "sup:1", NOW)
                .unwrap_err(),
            PEER_GRANT_INVALID
        );
        // Unknown session.
        let mut session = grant(&soon(NOW, 10_000));
        session.active_session_id = "other".to_string();
        assert_eq!(
            store.register(session, &context, "sup:1", NOW).unwrap_err(),
            PEER_GRANT_INVALID
        );
        // Not yet created session.
        let mut uncreated = grant_context();
        uncreated.session_created = false;
        assert_eq!(
            store
                .register(grant(&soon(NOW, 10_000)), &uncreated, "sup:1", NOW)
                .unwrap_err(),
            PEER_GRANT_INVALID
        );
        // Issued by a different supervisor generation.
        assert_eq!(
            store
                .register(grant(&soon(NOW, 10_000)), &context, "sup:2", NOW)
                .unwrap_err(),
            PEER_GRANT_INVALID
        );
        // A fresh grant is still accepted after the rejects.
        store
            .register(grant(&soon(NOW, 10_000)), &context, "sup:1", NOW)
            .expect("register");
    }

    #[test]
    fn grant_cap_sweeps_expired() {
        let store = PeerGrantStore::new();
        let context = grant_context();
        for index in 0..PEER_GRANT_LIMIT {
            let mut one = grant(&soon(NOW, 10_000));
            one.grant_id = format!("live-{index}");
            store
                .register(one, &context, "sup:1", NOW)
                .expect("register within cap");
        }
        let mut over = grant(&soon(NOW, 10_000));
        over.grant_id = "over-cap".to_string();
        assert_eq!(
            store.register(over, &context, "sup:1", NOW).unwrap_err(),
            PEER_GRANT_INVALID
        );
        // Advance past the live grants' expiry: the registration sweep
        // frees the cap for fresh grants.
        let later = NOW + 10_001;
        let mut fresh = grant(&soon(later, 10_000));
        fresh.grant_id = "fresh".to_string();
        store
            .register(fresh, &context, "sup:1", later)
            .expect("swept the expired grants");
        // The swept grants are gone: presenting one no longer authenticates.
        let mut stale_auth = peer_auth("secret");
        let DaemonPeerCommand::PeerAuth {
            grant_id: stale_id, ..
        } = &mut stale_auth;
        *stale_id = "live-0".to_string();
        assert_eq!(
            store
                .authenticate(&stale_auth, &context, later)
                .unwrap_err(),
            PEER_AUTH_FAILED
        );
    }

    #[test]
    fn peer_gate_requires_session_plane_and_matching_session() {
        let grant = grant(&soon(NOW, 10_000));
        let attach = serde_json::json!({ "activeSessionId": "abc123" });
        let wrong = serde_json::json!({ "activeSessionId": "other" });
        assert!(peer_command_allowed("attach", &attach, &grant));
        assert!(peer_command_allowed("prompt", &attach, &grant));
        // The abort-and-send interrupt rides the session plane too (TS
        // `abort_and_send_queued: "session"`).
        assert!(peer_command_allowed(
            "abort_and_send_queued",
            &attach,
            &grant
        ));
        assert!(!peer_command_allowed("prompt", &wrong, &grant));
        assert!(!peer_command_allowed(
            "attach",
            &serde_json::json!({}),
            &grant
        ));
        assert!(!peer_command_allowed("shutdown", &attach, &grant));
        assert!(!peer_command_allowed("create", &attach, &grant));
        assert!(!peer_command_allowed("rename", &attach, &grant));
        assert!(!peer_command_allowed(
            "worker_register_peer_transport",
            &attach,
            &grant
        ));
    }

    #[test]
    fn worker_purpose_grants_burn_and_gate_to_delivery() {
        let store = PeerGrantStore::new();
        let context = grant_context();
        let mut grant = grant(&soon(NOW, 10_000));
        grant.purpose = "worker".to_string();
        store
            .register(grant.clone(), &context, "sup:1", NOW)
            .expect("worker grant registers");
        let mut presentation = peer_auth("secret");
        let DaemonPeerCommand::PeerAuth {
            purpose: auth_purpose,
            ..
        } = &mut presentation;
        *auth_purpose = "worker".to_string();
        let admitted = store
            .authenticate(&presentation, &context, NOW)
            .expect("worker grant authenticates");
        assert_eq!(admitted.purpose, "worker");
        // Single use, like the session-client grant.
        assert_eq!(
            store
                .authenticate(&presentation, &context, NOW)
                .unwrap_err(),
            PEER_AUTH_FAILED
        );
        // The peer-worker gate: only worker_deliver_message, only for the
        // grant's session.
        let delivery = serde_json::json!({ "targetActiveSessionId": "abc123" });
        let wrong = serde_json::json!({ "targetActiveSessionId": "other" });
        assert!(worker_peer_command_allowed(
            "worker_deliver_message",
            &delivery,
            &grant
        ));
        assert!(!worker_peer_command_allowed(
            "worker_deliver_message",
            &wrong,
            &grant
        ));
        assert!(!worker_peer_command_allowed("get_state", &delivery, &grant));
        assert!(!worker_peer_command_allowed("list", &delivery, &grant));
        assert!(!worker_peer_command_allowed("shutdown", &delivery, &grant));
        // Worker connections never stream session events.
        let role = ConnectionRole::PeerWorker {
            session: Arc::new(PeerSession::new(grant)),
        };
        assert!(!role.streams_events());
    }

    #[test]
    fn peer_session_attach_gates_event_stream() {
        let role = ConnectionRole::SessionClient {
            session: Arc::new(PeerSession::new(grant(&soon(NOW, 10_000)))),
        };
        assert!(!role.streams_events(), "not attached yet");
        if let ConnectionRole::SessionClient { session } = &role {
            session.mark_attached();
        }
        assert!(role.streams_events());
        if let ConnectionRole::SessionClient { session } = &role {
            session.mark_detached();
        }
        assert!(!role.streams_events());
        assert!(!ConnectionRole::Unauthenticated.streams_events());
        assert!(ConnectionRole::Supervisor {
            generation: "sup:1".to_string()
        }
        .streams_events());
    }
}
