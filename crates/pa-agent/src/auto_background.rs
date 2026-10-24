//! Inline-bash auto-backgrounding (the promotion seam): the agent loop
//! arms a per-call watchdog for `bash` tool calls, and the bash dispatch
//! (pa-core) consumes the arm to promote a long-running command to a
//! detached job instead of holding the turn. The registry here is the one
//! hand-off channel between the loop (which knows the configured window)
//! and the tool (which owns the running process).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// The default auto-background window: an inline bash call is promoted to
/// a background job after one minute.
pub const DEFAULT_AUTO_BACKGROUND_AFTER_MS: u64 = 60_000;

/// One promoted bash job's completion, handed to the notice lane.
#[derive(Debug, Clone)]
pub struct AutoBackgroundCompletion {
    /// The promoted command's process id (`None` when the operations
    /// backend does not report pids).
    pub pid: Option<u32>,
    /// The process exit code (`None` when killed by a signal).
    pub exit_code: Option<i32>,
    /// The executed command text.
    pub command: String,
    /// The job's final accumulated output.
    pub output: String,
    /// The spilled full-output file, when output was truncated.
    pub full_output_path: Option<String>,
    /// The terminal failure status line ("Command aborted" /
    /// "Command timed out after N seconds") when the job died without an
    /// exit code, so the wake row can explain the -1.
    pub status: Option<String>,
}

/// The wake contract for a promoted job: the embedding wires this to the
/// same notice lane backgrounded bash jobs already use (the daemon feeds
/// its `[bash-done pid:N exit:M]` completion sink).
pub type AutoBackgroundNoticeFn = Arc<dyn Fn(AutoBackgroundCompletion) + Send + Sync>;

/// The per-call watchdog the loop arms for one inline bash call.
#[derive(Clone)]
pub struct AutoBackgroundArm {
    /// The promotion window; a zero duration disables promotion.
    pub window: Duration,
    /// The completion notice hook (`None` keeps the job's completion
    /// silent — no wake lane).
    pub notice: Option<AutoBackgroundNoticeFn>,
}

/// The loop-level directive derived from [`crate::agent::AgentOptions`]:
/// the resolved window plus the embedding's notice hook, and this agent's
/// arm registry.
#[derive(Clone)]
pub struct AutoBackgroundDirective {
    /// The promotion window; a zero duration disables promotion (the arm
    /// still reaches the bash dispatch so the disable is the loop's, not
    /// the tool options' fallback).
    pub window: Duration,
    pub notice: Option<AutoBackgroundNoticeFn>,
    /// This agent's arm registry: the loop arms here, the bash dispatch
    /// takes from here. One instance per agent, never process-global:
    /// provider tool-call ids (e.g. `call_0`) repeat across concurrent
    /// agents, and a global map would cross-wire their windows and notice
    /// lanes.
    pub registry: Arc<AutoBackgroundRegistry>,
}

/// One agent's per-call arm registry: the hand-off channel between the
/// agent loop (which knows the configured window and notice lane) and the
/// bash dispatch running its tool calls.
#[derive(Default)]
pub struct AutoBackgroundRegistry {
    arms: Mutex<HashMap<String, AutoBackgroundArm>>,
}

impl AutoBackgroundRegistry {
    /// An empty registry.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Arm the watchdog for one tool call. The bash dispatch consumes the
    /// arm (see [`Self::take`]); the loop also disarms after the call
    /// settles, so an arm for a call that never reached the bash dispatch
    /// cannot leak.
    pub fn arm(&self, tool_call_id: &str, value: AutoBackgroundArm) {
        self.arms
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(tool_call_id.to_string(), value);
    }

    /// Consume the arm for one tool call (the bash dispatch's promotion
    /// window and notice lane for this call).
    #[must_use]
    pub fn take(&self, tool_call_id: &str) -> Option<AutoBackgroundArm> {
        self.arms
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(tool_call_id)
    }

    /// Remove an unconsumed arm (the loop's post-call cleanup).
    pub fn disarm(&self, tool_call_id: &str) {
        self.arms
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(tool_call_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arm_take_and_disarm_round_trip() {
        let registry = AutoBackgroundRegistry::new();
        registry.arm(
            "t1",
            AutoBackgroundArm {
                window: Duration::from_secs(2),
                notice: None,
            },
        );
        let taken = registry.take("t1");
        assert_eq!(taken.expect("arm consumed").window, Duration::from_secs(2));
        assert!(registry.take("t1").is_none(), "arm consumed once");

        registry.arm(
            "t2",
            AutoBackgroundArm {
                window: Duration::from_secs(1),
                notice: None,
            },
        );
        registry.disarm("t2");
        assert!(registry.take("t2").is_none(), "disarmed arm is gone");
    }

    #[test]
    fn registries_do_not_cross_wire() {
        // The same provider id across two agents (a `call_0` repeat) must
        // not reach into the other agent's window or notice lane.
        let a = AutoBackgroundRegistry::new();
        let b = AutoBackgroundRegistry::new();
        a.arm(
            "call_0",
            AutoBackgroundArm {
                window: Duration::from_millis(100),
                notice: None,
            },
        );
        b.arm(
            "call_0",
            AutoBackgroundArm {
                window: Duration::from_millis(900),
                notice: None,
            },
        );
        assert_eq!(
            a.take("call_0").expect("a's arm").window,
            Duration::from_millis(100)
        );
        assert_eq!(
            b.take("call_0").expect("b's arm").window,
            Duration::from_millis(900)
        );
        assert!(a.take("call_0").is_none(), "each arm consumed once");
        let fresh = AutoBackgroundRegistry::new();
        assert!(
            fresh.take("call_0").is_none(),
            "a fresh registry has no arms"
        );
    }
}
