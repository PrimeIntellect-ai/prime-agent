//! The autonomous continuation driver: the policy seam between a session turn
//! loop and the autonomous runtime state. After every settled assistant turn
//! the engine asks the driver what follows — an injected continuation user
//! message, a stop with its reason, or nothing (autonomous mode inactive).
//! The engine never inspects autonomous state itself.

use std::path::PathBuf;
use std::pin::Pin;

use super::gates::{should_autonomously_continue, GateCommandRunner, ShellGateRunner};
use super::{
    add_autonomous_continuation, add_autonomous_usage, autonomous_limit_reason, autonomous_status,
    build_autonomous_gate_failure_continuation, now_millis, AgentAutonomousStatus,
    AutonomousDecisionReason, AutonomousLimitReason, AutonomousRuntimeState,
};

/// Future returned by [`AutonomousDriver::after_turn`].
pub type AutonomousFollowUpFuture<'a> =
    Pin<Box<dyn std::future::Future<Output = AutonomousFollowUp> + Send + 'a>>;

/// How one settled assistant turn is followed up.
#[derive(Debug, Clone, PartialEq)]
pub enum AutonomousFollowUp {
    /// Autonomous mode does not apply (disabled, or the turn errored or was
    /// aborted): the session behaves like a normal run.
    Inactive,
    /// Inject this user-message text as the next turn.
    Continue { text: String },
    /// Stop the run; the reason and a final status snapshot are surfaced
    /// durably by the engine (boxed: the snapshot is much larger than the
    /// other variants).
    Stop {
        reason: AutonomousStopReason,
        status: Box<AgentAutonomousStatus>,
    },
}

/// Why an autonomous run stopped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AutonomousStopReason {
    /// Every configured gate command passed: the run is complete.
    GatePassed,
    /// A failing gate exhausted its retry window without a pass.
    GateRetryExhausted,
    /// A configured budget limit stopped the run.
    Limit(AutonomousLimitReason),
}

/// Per-turn policy for the autonomous continuation loop.
///
/// The engine calls [`account_message`](AutonomousDriver::account_message)
/// for every settled assistant message (whatever the stop reason except
/// errors) and [`after_turn`](AutonomousDriver::after_turn) once per settled
/// turn with its final assistant message. Implementations decide entirely
/// through these two methods; the engine holds no autonomous-mode logic of
/// its own.
pub trait AutonomousDriver: Send + Sync {
    /// Account one settled assistant message into the run state.
    fn account_message(
        &self,
        state: &mut AutonomousRuntimeState,
        message: &pa_types::ai::AssistantMessage,
    );

    /// Decide the follow-up for one settled turn.
    fn after_turn<'a>(
        &'a self,
        state: &'a mut AutonomousRuntimeState,
        message: &'a pa_types::ai::AssistantMessage,
    ) -> AutonomousFollowUpFuture<'a>;
}

/// The product driver: per-message usage accounting, gate evaluation through
/// a [`GateCommandRunner`], and continuation text from the run state.
#[derive(Clone)]
pub struct ShellAutonomousDriver<R = ShellGateRunner> {
    gates: R,
}

/// The driver over real shell gates in the session cwd.
impl ShellAutonomousDriver<ShellGateRunner> {
    pub fn new(cwd: impl Into<PathBuf>) -> Self {
        Self {
            gates: ShellGateRunner::new(cwd),
        }
    }
}

impl<R: GateCommandRunner> ShellAutonomousDriver<R> {
    /// The driver over a custom gate runner (eval harnesses, tests).
    pub fn with_gate_runner(gates: R) -> Self {
        Self { gates }
    }
}

impl<R: GateCommandRunner> AutonomousDriver for ShellAutonomousDriver<R> {
    fn account_message(
        &self,
        state: &mut AutonomousRuntimeState,
        message: &pa_types::ai::AssistantMessage,
    ) {
        if message.stop_reason != pa_types::ai::StopReason::Error {
            add_autonomous_usage(state, Some(&message.usage));
        }
    }

    fn after_turn<'a>(
        &'a self,
        state: &'a mut AutonomousRuntimeState,
        message: &'a pa_types::ai::AssistantMessage,
    ) -> AutonomousFollowUpFuture<'a> {
        Box::pin(async move {
            use pa_types::ai::StopReason;
            if !state.enabled
                || message.stop_reason == StopReason::Error
                || message.stop_reason == StopReason::Aborted
            {
                return AutonomousFollowUp::Inactive;
            }
            let decision =
                should_autonomously_continue(state, Some(message.stop_reason), &self.gates).await;
            if decision.should_continue {
                add_autonomous_continuation(state);
                let text = match decision.reason {
                    AutonomousDecisionReason::GateFailed => state
                        .last_gate_failure
                        .as_ref()
                        .map(|failure| {
                            build_autonomous_gate_failure_continuation(
                                failure,
                                state.gates.max_retries,
                                now_millis(),
                            )
                        })
                        .unwrap_or_else(|| super::autonomous_continuation_text(state)),
                    _ => super::autonomous_continuation_text(state),
                };
                return AutonomousFollowUp::Continue { text };
            }
            match decision.reason {
                AutonomousDecisionReason::NotNeeded => {
                    // Gates evaluated and passed (mode/stop-reason cases were
                    // handled above).
                    AutonomousFollowUp::Stop {
                        reason: AutonomousStopReason::GatePassed,
                        status: Box::new(autonomous_status(state)),
                    }
                }
                AutonomousDecisionReason::LimitReached => {
                    let reason = autonomous_limit_reason(state, now_millis())
                        .map(AutonomousStopReason::Limit)
                        .unwrap_or(AutonomousStopReason::GateRetryExhausted);
                    AutonomousFollowUp::Stop {
                        reason,
                        status: Box::new(autonomous_status(state)),
                    }
                }
                reason => {
                    unreachable!("stop decisions carry NotNeeded or LimitReached: {reason:?}")
                }
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::autonomous::gates::{
        ChildProcessResult, GateCommandRunner, GateRunFuture, SnapshotFuture,
    };
    use crate::autonomous::{
        create_autonomous_runtime_state, AgentAutonomousConfig, AgentAutonomousGateConfig,
        GitWorktreeSnapshot,
    };
    use pa_types::ai::{AssistantContentBlock, AssistantMessage, StopReason, TextContent, Usage};
    use std::pin::pin;

    fn message(stop_reason: StopReason, usage: Usage) -> AssistantMessage {
        AssistantMessage {
            content: vec![AssistantContentBlock::Text(TextContent {
                text: "working".to_string(),
                text_signature: None,
                rest: Default::default(),
            })],
            api: "faux".to_string(),
            provider: "faux".to_string(),
            model: "faux-1".to_string(),
            response_model: None,
            response_id: None,
            diagnostics: None,
            usage,
            stop_reason,
            stop_reason_raw: None,
            error_message: None,
            timestamp: 0,
            rest: Default::default(),
        }
    }

    fn usage(input: u64, output: u64) -> Usage {
        Usage {
            input,
            output,
            cache_read: 0,
            cache_write: 0,
            ..Default::default()
        }
    }

    /// Scripted gate runner with per-call results, so driver tests are
    /// deterministic without touching the shell.
    struct ScriptedRunner {
        results: Vec<ChildProcessResult>,
        call: std::sync::atomic::AtomicUsize,
    }

    impl ScriptedRunner {
        fn new(results: Vec<ChildProcessResult>) -> Self {
            Self {
                results,
                call: std::sync::atomic::AtomicUsize::new(0),
            }
        }
    }

    impl GateCommandRunner for ScriptedRunner {
        fn run_gate(&self, _command: &str, _timeout_ms: u64) -> GateRunFuture<'_> {
            let index = self
                .call
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
                .min(self.results.len().saturating_sub(1));
            let result = self.results[index].clone();
            Box::pin(async move { Ok(result) })
        }

        fn capture_snapshot(&self) -> SnapshotFuture<'_> {
            Box::pin(async { None })
        }
    }

    fn enabled_config(gates: Option<AgentAutonomousGateConfig>) -> AgentAutonomousConfig {
        AgentAutonomousConfig {
            enabled: Some(true),
            gates,
            ..Default::default()
        }
    }

    fn driver_with(results: Vec<ChildProcessResult>) -> ShellAutonomousDriver<ScriptedRunner> {
        ShellAutonomousDriver::with_gate_runner(ScriptedRunner::new(results))
    }

    fn ok() -> ChildProcessResult {
        ChildProcessResult {
            status: Some(0),
            ..Default::default()
        }
    }

    fn fail() -> ChildProcessResult {
        ChildProcessResult {
            status: Some(1),
            stdout: "boom".to_string(),
            ..Default::default()
        }
    }

    async fn after_turn<R: GateCommandRunner>(
        driver: &ShellAutonomousDriver<R>,
        state: &mut AutonomousRuntimeState,
    ) -> AutonomousFollowUp {
        let message = message(StopReason::Stop, usage(10, 5));
        let future = pin!(driver.after_turn(state, &message));
        future.await
    }

    #[tokio::test]
    async fn limit_hit_stops_with_reason_and_status() {
        let config = AgentAutonomousConfig {
            enabled: Some(true),
            max_continuations: Some(1),
            ..Default::default()
        };
        let mut state = create_autonomous_runtime_state(Some(&config), None);
        let driver = driver_with(vec![]);
        // First turn: no limit yet -> continue (consumes the only
        // continuation slot).
        match after_turn(&driver, &mut state).await {
            AutonomousFollowUp::Continue { text } => {
                assert!(text.starts_with("[autonomous-continuation]\n\n"));
            }
            other => panic!("expected continuation, got {other:?}"),
        }
        assert_eq!(state.continuations_used, 1);
        // Second turn: the continuation limit is now reached -> stop.
        match after_turn(&driver, &mut state).await {
            AutonomousFollowUp::Stop { reason, status } => {
                assert_eq!(
                    reason,
                    AutonomousStopReason::Limit(AutonomousLimitReason::MaxContinuations)
                );
                assert_eq!(status.continuations_used, 1);
                assert_eq!(status.limits.max_continuations, 1);
            }
            other => panic!("expected stop, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn gate_pass_stops_the_run() {
        let config = enabled_config(Some(AgentAutonomousGateConfig {
            commands: Some(vec!["make check".to_string()]),
            ..Default::default()
        }));
        let mut state = create_autonomous_runtime_state(Some(&config), None);
        let driver = driver_with(vec![ok()]);
        match after_turn(&driver, &mut state).await {
            AutonomousFollowUp::Stop { reason, status } => {
                assert_eq!(reason, AutonomousStopReason::GatePassed);
                assert!(status.gate_attempts["make check"] == 0);
            }
            other => panic!("expected stop, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn gate_fail_injects_gate_failure_continuation() {
        let config = enabled_config(Some(AgentAutonomousGateConfig {
            commands: Some(vec!["make check".to_string()]),
            ..Default::default()
        }));
        let mut state = create_autonomous_runtime_state(Some(&config), None);
        let driver = driver_with(vec![fail()]);
        match after_turn(&driver, &mut state).await {
            AutonomousFollowUp::Continue { text } => {
                assert!(text.starts_with("[autonomous-continuation: gate-failed]\n\n"));
                assert!(text.contains("`make check` exited with code 1"));
                assert!(text.contains("Output:\nboom"));
            }
            other => panic!("expected continuation, got {other:?}"),
        }
        assert_eq!(state.continuations_used, 1);
        // Gate timeouts surface through the same continuation.
        let mut state = create_autonomous_runtime_state(Some(&config), None);
        let driver = driver_with(vec![ChildProcessResult {
            status: None,
            timed_out: true,
            ..Default::default()
        }]);
        match after_turn(&driver, &mut state).await {
            AutonomousFollowUp::Continue { text } => {
                assert!(text.contains("`make check` timed out"));
            }
            other => panic!("expected continuation, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn gate_retry_exhaustion_stops_without_a_limit() {
        let config = enabled_config(Some(AgentAutonomousGateConfig {
            commands: Some(vec!["make check".to_string()]),
            max_retries: Some(2),
            ..Default::default()
        }));
        let mut state = create_autonomous_runtime_state(Some(&config), None);
        // Every consult runs the same failing gate over the same snapshot:
        // attempt 1 fails, attempt 2 is held (workspace unchanged), and
        // attempt 3 exhausts the window without any limit being hit.
        let driver = ShellAutonomousDriver::with_gate_runner(HeldRunner {
            snapshot: GitWorktreeSnapshot::default(),
        });
        assert!(matches!(
            after_turn(&driver, &mut state).await,
            AutonomousFollowUp::Continue { .. }
        ));
        assert_eq!(state.last_gate_failure.as_ref().unwrap().attempt, 1);
        assert!(matches!(
            after_turn(&driver, &mut state).await,
            AutonomousFollowUp::Continue { .. }
        ));
        let reason = match after_turn(&driver, &mut state).await {
            AutonomousFollowUp::Stop { reason, status } => {
                assert_eq!(status.last_gate_failure.as_ref().unwrap().attempt, 3);
                reason
            }
            other => panic!("expected stop, got {other:?}"),
        };
        assert_eq!(reason, AutonomousStopReason::GateRetryExhausted);
        assert_eq!(
            state.last_gate_failure.as_ref().unwrap().exit_text,
            "not rerun: workspace unchanged since previous failed gate"
        );
    }

    /// A runner whose snapshot matches the recorded failure, so gate
    /// consults take the held (not-rerun) path.
    struct HeldRunner {
        snapshot: GitWorktreeSnapshot,
    }

    impl GateCommandRunner for HeldRunner {
        fn run_gate(&self, _command: &str, _timeout_ms: u64) -> GateRunFuture<'_> {
            Box::pin(async { Ok(fail()) })
        }

        fn capture_snapshot(&self) -> SnapshotFuture<'_> {
            let snapshot = self.snapshot.clone();
            Box::pin(async move { Some(snapshot) })
        }
    }

    #[tokio::test]
    async fn inactive_turns_and_error_turns_never_continue() {
        let mut state = create_autonomous_runtime_state(Some(&enabled_config(None)), None);
        let driver = driver_with(vec![]);
        // Disabled state is inactive.
        state.enabled = false;
        assert_eq!(
            after_turn(&driver, &mut state).await,
            AutonomousFollowUp::Inactive
        );
        // Error and aborted turns never trigger autonomous behavior.
        state.enabled = true;
        let driver_ref = ShellAutonomousDriver::with_gate_runner(ScriptedRunner::new(vec![]));
        for stop_reason in [StopReason::Error, StopReason::Aborted] {
            let message = message(stop_reason, usage(1, 1));
            let future = pin!(driver_ref.after_turn(&mut state, &message));
            assert_eq!(future.await, AutonomousFollowUp::Inactive);
        }
    }

    #[tokio::test]
    async fn usage_accounting_per_message_skips_errors() {
        let config = enabled_config(Some(AgentAutonomousGateConfig {
            commands: Some(vec!["true".to_string()]),
            ..Default::default()
        }));
        let mut state = create_autonomous_runtime_state(Some(&config), None);
        let driver = driver_with(vec![ok()]);
        driver.account_message(&mut state, &message(StopReason::Stop, usage(100, 40)));
        assert_eq!(state.turns_used, 1);
        assert_eq!(state.tokens_used, 140);
        // Error turns never count.
        driver.account_message(&mut state, &message(StopReason::Error, usage(100, 40)));
        assert_eq!(state.turns_used, 1);
        // Aborted turns still count, like the settled message it was.
        driver.account_message(&mut state, &message(StopReason::Aborted, usage(10, 10)));
        assert_eq!(state.turns_used, 2);
    }

    /// A stop carries the reason and a status snapshot (the surfaces map
    /// them: the headless exit contract, the ACP stop reason): the stop
    /// itself never writes a row (probed against the TS binary — a
    /// limit-ended print run's stream ends at `agent_end` with no
    /// `autonomous_status` row, and the headless stderr contract carries
    /// the stop).
    #[tokio::test]
    async fn stop_carries_reason_and_status_only() {
        let config = enabled_config(Some(AgentAutonomousGateConfig {
            commands: Some(vec!["make check".to_string()]),
            ..Default::default()
        }));
        let mut state = create_autonomous_runtime_state(Some(&config), None);
        let stop = after_turn(&driver_with(vec![ok()]), &mut state).await;
        let AutonomousFollowUp::Stop { reason, status } = stop else {
            panic!("the passing gate stops the run");
        };
        assert_eq!(reason, AutonomousStopReason::GatePassed);
        assert!(status.enabled);
        assert_eq!(status.gates.commands[0], "make check");
    }
}
