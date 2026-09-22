//! The update flow's client-side support (spec §4 coordinator `Planning`
//! through `Staged`): release-manifest fetch, semver/channel policy, the
//! managed install-root layout, and candidate staging. The coordinator
//! driver lives in pa-cli; everything here is the mechanism it drives, kept
//! daemon-free so pa-core stays the shared client/service layer.

pub mod download;
pub mod install;
pub mod release;
pub mod version;
