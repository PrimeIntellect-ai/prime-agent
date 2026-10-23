//! pa-perf: the prime-agent performance corpus generator and TUI bench
//! harness. A dev/CI tooling crate at the top of the workspace dependency
//! graph — nothing depends on it, and it never ships in a release.
//!
//! The corpus generator writes the product's real on-disk layout under an
//! isolated agent dir, using the product's own serializers and writers
//! (pa-types payloads, pa-daemon `SessionEntry`/`session_header_line`/
//! `RlmSpawnLedger`, pa-core's `WindowedSessionStore` for the warm
//! sidecars). The bench harness drives the real release binary under a pty.

pub mod bench;
pub mod corpus;
pub mod report;

mod rng;
