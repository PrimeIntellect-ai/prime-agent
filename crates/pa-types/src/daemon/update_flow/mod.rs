//! The update-flow state-machine vocabulary (`docs/update-flow-state-machine.md`).
//!
//! Slice 1 of the update flow: pure serde types and path layout shared by the
//! coordinator (pa-cli detached process mode), the old and new supervisor
//! (pa-daemon), and the clients (pa-tui/pa-cli). No behavior lives here —
//! the FSM drivers and watchdogs are owned by pa-daemon/pa-cli.
//!
//! Naming convention: `intent.json`, `marker.json`, and `roster.json` are
//! Rust-owned scratch artifacts and use `snake_case` field names exactly as the
//! spec writes them. `status.json` keeps the TS status-file schema (camelCase
//! field names, TS `DaemonUpdateRestartStatus` parity), extended with the
//! spec's `updateId`/`state`/`epoch` fields, so differential tests against the
//! TS binary can compare the files directly.
//!
//! All artifacts live under `<agent-dir>/update-restarts/<socket-hash>/` and
//! are per-update scratch state, swept unconditionally at supervisor boot
//! (spec §6): nothing here is durable session state, and the update flow
//! never touches `sessions/`, `session-artifacts/`, `harness/`, or
//! `rlm-ledger/`.

mod artifact;
mod budget;
mod marker;
mod roster;
mod state;

pub use artifact::{
    legacy_update_restart_status, legacy_update_restarts_dir, socket_update_dir,
    update_intent_path, update_marker_path, update_prepared_dir, update_restarts_dir,
    update_roster_path, update_status_path, DaemonUpdateResume, UpdateId, UpdateIntent,
    UpdateProcessIdentity, UpdateStatus, UpdateStatusCounts, UpdateStatusFailure,
    UPDATE_ROSTER_ENV, UPDATE_STATUS_FORMAT_VERSION,
};
pub use budget::{UpdateTimeoutBudget, UPDATE_ENV_PREFIX};
pub use marker::{
    prepared_marker_expiry, PreparedMarkerExpiry, UpdatePreparedMarker, UpdateSupervisorIdentity,
};
pub use roster::{
    UpdateHeartbeatDeliveryMode, UpdateHeartbeatStatus, UpdateRoster, UpdateRosterBinary,
    UpdateRosterHeartbeat, UpdateRosterInFlight, UpdateRosterQueue, UpdateRosterSession,
    UpdateRosterSessionKind, UpdateRosterSubagent, UpdateRosterSubagentStatus, UpdateRosterWorker,
    UPDATE_ROSTER_FORMAT_VERSION,
};
pub use state::{update_transition_allowed, UpdateState};
