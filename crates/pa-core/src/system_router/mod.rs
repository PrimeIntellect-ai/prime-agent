//! System 1 / System 2 harness router (#2484).
//!
//! The session model (System 2) declares an environment with a finite action
//! space and an action-only System 1 sub-model; the router runs the step loop
//! (observe -> decide -> gate -> execute -> record) and hands back the
//! complete trace for steering. One model call per step, the finite action
//! space compiled into a single typed choice, every decision gated by
//! confidence, no free-form generated actions.
//!
//! Rust port of `packages/coding-agent/src/core/system-router/` (the
//! TypeScript-era PR #2484). The module is pure and host-agnostic: it makes no
//! assumptions about where the model, auth, or environment come from. The
//! kernel host-request bridge lives in
//! [`crate::session_engine::system_router_host`].

mod action_space;
mod decide;
mod r#loop;
mod segment;
mod stdio_environment;
mod types;

// The unit batteries live in per-module `tests.rs` children; the shared test
// doubles live in `test_support`.
#[cfg(test)]
pub(crate) mod test_support;

// The host bridge consumes the module through these three names only; the
// rest of the subsystem stays on its internal module paths (the unit
// batteries reach it through their parent modules' own imports).
pub use segment::{run_router_segment, RouterSegmentOptions};
pub use types::parse_system_router_run_spec;
