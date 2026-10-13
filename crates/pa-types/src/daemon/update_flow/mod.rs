//! The update-flow state-machine vocabulary: pure serde types and path layout shared by the
//! coordinator, the supervisors, and the clients. `intent.json`/`marker.json`/`roster.json` are
//! Rust-owned scratch (`snake_case`, per spec); `status.json` keeps the TS camelCase schema plus
//! `updateId`/`state`/`epoch`, so differential tests compare directly. All artifacts are
//! per-update scratch, swept at supervisor boot - never durable session state.

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
