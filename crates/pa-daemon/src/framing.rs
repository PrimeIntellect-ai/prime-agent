//! Private-frame codec re-export. The codec is the shared worker-socket wire
//! contract (served by this crate's workers, spoken by direct-attach clients
//! in pa-tui/pa-cli), so it lives in [`pa_types::daemon::framing`].

pub use pa_types::daemon::framing::*;
