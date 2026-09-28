//! The update flow's client-side support (spec §4 coordinator `Planning`
//! through `Staged`): release-manifest fetch, semver/channel policy, the
//! managed install-root layout, and candidate staging. The coordinator
//! driver lives in pa-cli; everything here is the mechanism it drives, kept
//! daemon-free so pa-core stays the shared client/service layer. The
//! `installer` module is the other update body: the installer-takeover
//! funnel `prime-agent update` and the TUI's `/update` run (the branch's
//! install-rust.sh owns the whole move), kept beside the staged flow the
//! `package update` self target still serves.

pub mod download;
pub mod install;
pub mod installer;
pub mod release;
pub mod version;
