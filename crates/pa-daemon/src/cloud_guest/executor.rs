//! The engine-backed guest executor: one real session-engine turn per
//! claimed prompt command, over the daemon's own engine facade (the
//! same `pa-core` session the worker and the faux harnesses drive).
//!
//! Inference credential posture (the offline-turn hard gate): this
//! slice wires NO credential source at all. The engine is built only
//! with a scripted faux provider (the pa-ai faux harness — hermetic,
//! no network, no auth storage); without a faux script the executor
//! REFUSES to run a turn: commands settle as an explicit failure
//! instead of reaching for any real credential. A safe guest inference
//! credential mechanism (a guest-lifetime, revocable,
//! wallet-bound-key) is a platform prerequisite that does not exist
//! yet; until it does, live inference stays disabled here.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use futures::future::BoxFuture;
use pa_types::daemon::cloud::CloudCommandRequest;

use crate::agent_engine::{AgentEngineConfig, AgentSessionEngine};
use crate::cloud_guest::dispatch::{GuestDispatchOutcome, GuestExecutor, GuestSessionSnapshot};
use crate::engine::{EngineEvent, PromptRequest, SessionEngine};

/// The explicit refusal every turn-facing command settles with while
/// no safe guest inference credential exists (honest unsupported, not
/// a stubbed success).
pub const INFERENCE_DISABLED_MESSAGE: &str =
    "guest inference credential wiring is disabled in this slice: no safe delegated-credential mechanism exists yet";

/// The session-engine executor for the resident guest.
pub struct EngineGuestExecutor {
    engine: Option<Arc<AgentSessionEngine>>,
    turn_count: Arc<AtomicU64>,
    cwd: String,
    model: Option<String>,
}

impl EngineGuestExecutor {
    /// Build the executor for one guest session. A `faux_script` wires
    /// the scripted provider (the hermetic turn path); without it the
    /// executor refuses turn-facing commands — it never reaches for a
    /// real credential.
    ///
    /// # Errors
    ///
    /// Returns an error when the engine cannot be constructed.
    pub fn new(config: AgentEngineConfig, model_label: Option<String>) -> anyhow::Result<Self> {
        let cwd = config.cwd.display().to_string();
        let engine = if config.faux_script.is_some() {
            Some(Arc::new(AgentSessionEngine::new(config)?))
        } else {
            None
        };
        Ok(Self {
            engine,
            turn_count: Arc::new(AtomicU64::new(0)),
            cwd,
            model: model_label,
        })
    }

    /// The executor from the guest environment: the workspace is the
    /// session's cwd, the agent dir carries settings, and the only
    /// inference path is an explicit faux script (the boot harness);
    /// no credential env is read, ever.
    ///
    /// # Errors
    ///
    /// Returns an error when the engine cannot be constructed.
    pub fn from_env(env: &crate::cloud_guest::CloudGuestEnv) -> anyhow::Result<Self> {
        let config = AgentEngineConfig {
            cwd: env.workspace_dir.clone(),
            agent_dir: env.agent_dir.clone(),
            provider: None,
            model: None,
            api_key: None,
            thinking: None,
            session_dir: Some(env.state_dir.join("sessions")),
            session_file: None,
            faux_script: std::env::var("PRIME_AGENT_GUEST_FAUX_SCRIPT").ok(),
            supervisor_link: None,
            telemetry_disabled: Some(true),
            cron_store: None,
            queued_steering_probe: None,
        };
        Self::new(config, env.model.clone())
    }

    /// The turns this executor ran (the loopback battery's
    /// duplicate-proof witness).
    #[must_use]
    #[cfg(test)]
    pub fn turn_count(&self) -> u64 {
        self.turn_count.load(Ordering::SeqCst)
    }
}

impl GuestExecutor for EngineGuestExecutor {
    fn dispatch(
        &self,
        _command_id: String,
        request: CloudCommandRequest,
    ) -> BoxFuture<'static, GuestDispatchOutcome> {
        // The session is open by construction (TS boots the root session
        // before dispatch; the engine facade materializes it on the
        // first prompt), so a restored pending prompt always finds an
        // open session — per-process flags would misreport a restart.
        let engine = self.engine.clone();
        let turn_count = Arc::clone(&self.turn_count);
        Box::pin(async move {
            match request {
                CloudCommandRequest::OpenSession { prompt, .. } => {
                    // A duplicate open is a no-op reattach (the engine
                    // exists at boot); a carried prompt runs once, under
                    // this command's own idempotent admission.
                    match prompt {
                        Some(prompt) if !prompt.is_empty() => {
                            run_one_turn(engine.as_ref(), &prompt, turn_count).await
                        }
                        _ => GuestDispatchOutcome::Completed { result: None },
                    }
                }
                CloudCommandRequest::Prompt { text, .. } => {
                    run_one_turn(engine.as_ref(), &text, turn_count).await
                }
                CloudCommandRequest::Abort => {
                    // Sequential claims mean the dispatch loop itself is
                    // the single-flight surface: nothing else runs
                    // while a command executes, so an abort arriving
                    // through the queue finds nothing to abort and
                    // settles as a no-op completion.
                    GuestDispatchOutcome::Completed { result: None }
                }
                CloudCommandRequest::Release => GuestDispatchOutcome::Completed { result: None },
                CloudCommandRequest::Steer { text: _ }
                | CloudCommandRequest::FollowUp { text: _ }
                | CloudCommandRequest::SetModel { .. }
                | CloudCommandRequest::SetThinkingLevel { .. }
                | CloudCommandRequest::SetSessionName { .. }
                | CloudCommandRequest::Compact { .. }
                | CloudCommandRequest::SendMessage { .. }
                | CloudCommandRequest::CancelChild { .. }
                | CloudCommandRequest::DeleteChild { .. }
                | CloudCommandRequest::ExtensionUiResponse { .. }
                | CloudCommandRequest::FamilyRosterResult { .. }
                | CloudCommandRequest::AgentMessageResult { .. } => GuestDispatchOutcome::Failed {
                    error: Some(INFERENCE_DISABLED_MESSAGE.to_string()),
                },
            }
        })
    }

    fn snapshot(&self) -> GuestSessionSnapshot {
        GuestSessionSnapshot {
            cwd: self.cwd.clone(),
            model: self.model.clone(),
        }
    }
}

/// One real session-engine turn through the daemon's engine facade:
/// the run is blocking (the engine drives its own runtime), the event
/// sink maps the settle signal onto the command outcome, and the turn
/// counter advances exactly once per run.
async fn run_one_turn(
    engine: Option<&Arc<AgentSessionEngine>>,
    text: &str,
    turn_count: Arc<AtomicU64>,
) -> GuestDispatchOutcome {
    let Some(engine) = engine else {
        return GuestDispatchOutcome::Failed {
            error: Some(INFERENCE_DISABLED_MESSAGE.to_string()),
        };
    };
    let engine = Arc::clone(engine);
    let text = text.to_string();
    turn_count.fetch_add(1, Ordering::SeqCst);
    let joined = tokio::task::spawn_blocking(move || {
        let mut outcome = GuestDispatchOutcome::Completed { result: None };
        engine.run_prompt(
            0,
            PromptRequest {
                batch: Vec::new(),
                images: Vec::new(),
                message: text,
                source: "user".to_string(),
                agent_message_id: None,
                custom_message: None,
            },
            &|| false,
            &mut |event| {
                if let EngineEvent::Done(Err(ref error)) = event {
                    outcome = GuestDispatchOutcome::Failed {
                        error: Some(error.clone()),
                    };
                }
                if matches!(event, EngineEvent::DoneAborted) {
                    outcome = GuestDispatchOutcome::Cancelled;
                }
                true
            },
        );
        outcome
    })
    .await;
    match joined {
        Ok(outcome) => outcome,
        Err(_) => GuestDispatchOutcome::Failed {
            error: Some("guest session engine task failed".to_string()),
        },
    }
}
