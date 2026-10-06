//! The first-run onboarding concern: the sink and readiness seams, the flow task, the pane drive
//! over the mounted onboarding screens, and the phase that runs the flow before the session screen.

use super::{
    mpsc, AgentView, Duration, ExitGuard, Future, Instant, KeybindingsManager, Pin, Renderer,
    Result, SessionUi, UiInput,
};

/// Persistence for the first-run onboarding answers. The TUI crate owns only the surface; the
/// composition root (pa-cli) implements the sink, keeping pa-tui decoupled from pa-core.
pub trait OnboardingSink: Send + Sync {
    /// The completion marker, read fresh: the phase's one-shot gate — the agents-view flow
    /// re-runs the phase per session, so a completed flow never shows anything again.
    fn onboarding_shown(&self) -> bool;
    /// Whether a trace-sharing choice was ever written: such homes never see the question.
    fn agent_traces_choice_written(&self) -> bool;
    /// Persist the trace-sharing answer.
    ///
    /// # Errors
    ///
    /// Returns `Err` when persisting the choice to the settings store fails.
    fn set_agent_traces_enabled(&self, enabled: bool) -> anyhow::Result<()>;
    /// Mark the onboarding flow completed; an aborted flow leaves the flag unset.
    ///
    /// # Errors
    ///
    /// Returns `Err` when persisting the completion marker fails.
    fn mark_onboarding_complete(&self) -> anyhow::Result<()>;
    /// The flow ran but did not complete (TS `runStartupOnboarding`'s
    /// `finally`): `outcome` is `aborted` (cancelled, quit, or no usable
    /// model at the end) or `error` (the flow failed). Resolves once the
    /// report is delivered (or dropped), so a quit right after cannot
    /// tear the runtime down under it.
    fn onboarding_incomplete(
        &self,
        outcome: &'static str,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + '_>>;
}

/// The model-readiness probe: the composition root re-resolves the startup model chain, because the
/// flow's own steps can change the answer (the Prime sign-in configures the startup model).
pub type ModelReadiness = std::sync::Arc<dyn Fn() -> bool + Send + Sync>;

/// The first-run flow to run before the session screen: the model-ready branch asks the trace
/// question on the immediate splash; a home with no usable model runs the full flow — the
/// welcome login, the Prime Inference sign-in, the default-model apply, the
/// connect-more-providers picker, and the trace question.
#[derive(Clone)]
pub struct OnboardingTask {
    pub sink: std::sync::Arc<dyn OnboardingSink>,
    pub model_ready: ModelReadiness,
    pub current_model: Option<pa_types::ai::Model>,
    /// The provider auth flows the full branch signs in through; `None` skips its sign-in step.
    pub provider_auth: Option<crate::provider_auth::ProviderAuthCommandsHandle>,
}

impl std::fmt::Debug for OnboardingTask {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OnboardingTask").finish()
    }
}

/// One onboarding flow's background task: the spawned join plus the flow's cooperative cancel
/// signal, shared with the panel handle.
struct OnboardingFlowTask {
    join: tokio::task::JoinHandle<crate::provider_auth::ProviderAuthOutcome>,
    cancel: crate::auth_panel::FlowCancel,
}

impl OnboardingFlowTask {
    /// Spawn the flow and pair it with the panel handle's cancel signal: the blocking login body
    /// checks the signal before its auth-store writes (a `JoinHandle::abort` cannot reach a started
    /// `spawn_blocking` login).
    fn spawn<F>(future: F, cancel: crate::auth_panel::FlowCancel) -> Self
    where
        F: std::future::Future<Output = crate::provider_auth::ProviderAuthOutcome> + Send + 'static,
    {
        OnboardingFlowTask {
            join: tokio::spawn(future),
            cancel,
        }
    }

    fn settle(
        &mut self,
    ) -> &mut tokio::task::JoinHandle<crate::provider_auth::ProviderAuthOutcome> {
        &mut self.join
    }

    /// End the flow with the exiting pane: mark the cooperative signal, then wait for the blocking
    /// login to observe it (bounded by the login's request timeouts).
    async fn end(self) {
        self.cancel.mark();
        let _ = self.join.await;
    }
}

enum PaneOutcome {
    Decision(crate::onboarding::OnboardingDecision),
    /// The input channel closed: the flow ends without an answer and the marker stays unset.
    InputClosed,
    /// The flow settled; `Err` is a crashed task.
    Flow(Result<crate::provider_auth::ProviderAuthOutcome, tokio::task::JoinError>),
}

/// The pane drive's borrowed services.
pub(super) struct PaneDrive<'a> {
    pub(super) ui_rx: &'a mut mpsc::UnboundedReceiver<UiInput>,
    pub(super) renderer: &'a mut Renderer,
    pub(super) exit_guard: &'a ExitGuard,
    pub(super) keybindings: KeybindingsManager,
    pub(super) auth_panel_rx: &'a mut mpsc::UnboundedReceiver<crate::auth_panel::AuthPanelRequest>,
    /// The run loop's headless-plan-completed flag: the pane marks it when the plan's
    /// `HeadlessDone` lands while it owns the input channel, so the run loop's idle gate still ends
    /// the run.
    pub(super) headless_done: &'a mut bool,
}

/// The pane drive's render barrier (the run loop's barrier contract): condition steps hold the
/// queued input batch behind them until a frame rendered after arming satisfies the condition.
enum PaneBarrier {
    /// `WaitRender`: a frame rendered at or after the baseline contains the needle.
    Render {
        needle: String,
        baseline: usize,
        deadline: Instant,
    },
    /// `WaitGone`: the newest frame no longer contains the needle.
    Gone { needle: String, deadline: Instant },
}

/// Draw the mounted onboarding screen and drive it until a key decides, the exit keys quit,
/// or the optional background flow settles. Each iteration draws first and waits after — a
/// deciding key that is already queued still leaves the mounted frame captured.
async fn drive_onboarding_pane(
    view: &mut AgentView,
    drive: &mut PaneDrive<'_>,
    mut screen: crate::onboarding::OnboardingScreen,
    mut flow: Option<OnboardingFlowTask>,
    osc_sink: &mut crate::clipboard::OscSink,
) -> Result<(crate::onboarding::OnboardingScreen, PaneOutcome)> {
    let mut barrier: Option<PaneBarrier> = None;
    loop {
        if let Some(armed) = barrier.take() {
            let satisfied = drive
                .renderer
                .headless_frames()
                .is_some_and(|frames| match &armed {
                    PaneBarrier::Render {
                        needle, baseline, ..
                    } => frames
                        .get(*baseline..)
                        .unwrap_or_default()
                        .iter()
                        .any(|frame| frame.contains(needle.as_str())),
                    PaneBarrier::Gone { needle, .. } => !frames
                        .last()
                        .is_some_and(|frame| frame.contains(needle.as_str())),
                });
            let expired = match &armed {
                PaneBarrier::Render { deadline, .. } | PaneBarrier::Gone { deadline, .. } => {
                    Instant::now() > *deadline
                }
            };
            if !satisfied && !expired {
                barrier = Some(armed);
            }
        }
        view.onboarding = Some(screen);
        match drive.renderer {
            Renderer::Terminal { .. } => {
                if let Some(renderer) = drive.renderer.is_terminal_mut() {
                    if let Err(error) = crate::app::draw(renderer, view) {
                        // A failed frame ends the pane: end a still-running login flow with it
                        // (the cooperative cancel reaches the blocking login body, so no path
                        // leaves a detached flow writing credentials).
                        if let Some(task) = flow.take() {
                            task.end().await;
                        }
                        return Err(error);
                    }
                }
            }
            Renderer::Headless { .. } => drive.renderer.render_headless_pane(view),
        }
        let Some(mut pane) = view.onboarding.take() else {
            unreachable!("the pane mounts at the top of every iteration");
        };
        tokio::select! {
            maybe_input = drive.ui_rx.recv(), if barrier.is_none() => {
                // Without this arm the always-ready `recv()` spins the redraw loop hot.
                let Some(input) = maybe_input else {
                    // The cooperative cancel reaches the blocking login body.
                    if let Some(task) = flow.take() {
                        task.end().await;
                    }
                    return Ok((pane, PaneOutcome::InputClosed));
                };
                match input {
                UiInput::Key(key) => {
                    let Some(key_id) = crate::keys::key_event_to_id(&key) else {
                        screen = pane;
                        continue;
                    };
                    // The onboarding exit keys include Ctrl+C: report the handled press so the
                    // force-quit guard's handled counter stays in sync with the reader's
                    // observations.
                    if key_id == "ctrl+c" {
                        drive.exit_guard.note_ctrl_c_handled();
                    }
                    if let Some(decision) = pane.handle_key(&key_id, &drive.keybindings, osc_sink) {
                        // A decision tears the pane down mid-drive: end a still-running login flow.
                        if let Some(task) = flow.take() {
                            task.end().await;
                        }
                        return Ok((pane, PaneOutcome::Decision(decision)));
                    }
                }
                UiInput::Paste(text) => {
                    pane.handle_paste(&text);
                }
                // The headless plan completed while the pane owned the channel: mark the run loop's
                // flag (the pane keeps driving until the channel closes or a decision ends it).
                UiInput::HeadlessDone => *drive.headless_done = true,
                // The plan's render barriers (pane-scoped): a condition that already holds pops
                // immediately; a pending one arms and holds the input batch behind it until a later
                // frame satisfies it or the deadline pops (the timeout proceeds silently — the
                // harness's assertion then reports the actual frame). The steps only ever come from
                // the headless harness; a terminal pane consumes them as no-ops.
                UiInput::WaitRender { needle, timeout_ms } => {
                    let holds_now = drive.renderer.headless_frames().is_some_and(|frames| {
                        frames.last().is_some_and(|frame| frame.contains(needle.as_str()))
                    });
                    if !holds_now {
                        if let Some(frames) = drive.renderer.headless_frames() {
                            barrier = Some(PaneBarrier::Render {
                                needle,
                                baseline: frames.len(),
                                deadline: Instant::now()
                                    + Duration::from_millis(timeout_ms),
                            });
                        }
                    }
                }
                UiInput::WaitGone { needle, timeout_ms } => {
                    let holds_now = drive.renderer.headless_frames().is_some_and(|frames| {
                        !frames.last().is_some_and(|frame| frame.contains(needle.as_str()))
                    });
                    if !holds_now {
                        barrier = Some(PaneBarrier::Gone {
                            needle,
                            deadline: Instant::now()
                                + Duration::from_millis(timeout_ms),
                        });
                    }
                }
                UiInput::Submit(_)
                | UiInput::SubmitAndSettle { .. }
                | UiInput::SettleIdle
                | UiInput::Mouse(_)
                | UiInput::WaitIdle { .. }
                | UiInput::ScrollTop
                | UiInput::Resize => {}
                }
            }
            maybe_request = drive.auth_panel_rx.recv() => {
                if let Some(request) = maybe_request {
                    pane.apply_auth_request(request);
                }
            }
            settled = async {
                match flow.as_mut() {
                    Some(task) => task.settle().await,
                    None => std::future::pending().await,
                }
            } => {
                return Ok((pane, PaneOutcome::Flow(settled)));
            }
            () = tokio::time::sleep(Duration::from_millis(120)) => {
                pane.tick();
            }
        }
        screen = pane;
    }
}

/// Drive the first-run onboarding flow before the session screen (TS `runStartupOnboarding`).
/// Returns `true` when the exit keys quit the app.
pub(super) async fn run_onboarding_phase(
    task: &OnboardingTask,
    session: &mut SessionUi,
    view: &mut AgentView,
    drive: &mut PaneDrive<'_>,
) -> Result<bool> {
    // One-shot: the agents-view flow re-runs the phase for every session it opens with the
    // same task. A flow that already completed (the marker now persisted) re-checks here
    // and never shows anything again.
    if task.sink.onboarding_shown() {
        return Ok(false);
    }
    let result = run_onboarding_flow(task, session, view, drive).await;
    // Only a completed flow sets the marker; every other ending reports
    // its outcome (TS `onboarding completed` with `aborted` / `error`).
    if !task.sink.onboarding_shown() {
        task.sink
            .onboarding_incomplete(if result.is_err() { "error" } else { "aborted" })
            .await;
    }
    result
}

async fn run_onboarding_flow(
    task: &OnboardingTask,
    session: &mut SessionUi,
    view: &mut AgentView,
    drive: &mut PaneDrive<'_>,
) -> Result<bool> {
    if (task.model_ready)() {
        // The ready branch's standing-choice gate (the operator ruling): a home that already
        // carries a trace-sharing choice never sees the question — the standing choice stands and
        // the flow completes silently.
        if task.sink.agent_traces_choice_written() {
            if let Err(error) = task.sink.mark_onboarding_complete() {
                warn_onboarding_persist_failure(session, view, &error);
            }
            return Ok(false);
        }
        // The model-ready branch: the immediate splash mounts the trace question alone.
        let screen = crate::onboarding::OnboardingScreen::new();
        let (_screen, outcome) =
            drive_onboarding_pane(view, &mut *drive, screen, None, &mut session.osc_sink).await?;
        match outcome {
            PaneOutcome::InputClosed => return Ok(false),
            PaneOutcome::Decision(crate::onboarding::OnboardingDecision::Exit) => return Ok(true),
            PaneOutcome::Decision(crate::onboarding::OnboardingDecision::Selected(index)) => {
                // `Share` opts in; `Not now` keeps traces off. A write that fails surfaces as a
                // warning row: the flow still settled this run, but an unpersisted marker
                // re-mounts it next launch — the user must know, the run never dies over it.
                if let Err(error) = task.sink.set_agent_traces_enabled(index == 0) {
                    warn_onboarding_persist_failure(session, view, &error);
                }
            }
            PaneOutcome::Decision(crate::onboarding::OnboardingDecision::Cancelled) => {}
            PaneOutcome::Decision(
                crate::onboarding::OnboardingDecision::Begin
                | crate::onboarding::OnboardingDecision::Pick(_),
            )
            | PaneOutcome::Flow(_) => {
                unreachable!("the question panel yields Selected or Cancelled only")
            }
        }
        if let Err(error) = task.sink.mark_onboarding_complete() {
            warn_onboarding_persist_failure(session, view, &error);
        }
        return Ok(false);
    }

    // The full flow (the not-ready branch): Signing in is instant when a Prime CLI token is already
    // on disk, so users who arrive with credentials still reach the same account, provider and
    // trace questions. A flow that aborts leaves the marker unset — the next launch retries.
    let screen = crate::onboarding::OnboardingScreen::welcome();
    let (mut screen, outcome) =
        drive_onboarding_pane(view, &mut *drive, screen, None, &mut session.osc_sink).await?;
    // The welcome binds one key: Enter starts the flow (cancel is deliberately unbound).
    match outcome {
        PaneOutcome::InputClosed => return Ok(false),
        PaneOutcome::Decision(crate::onboarding::OnboardingDecision::Exit) => return Ok(true),
        PaneOutcome::Decision(crate::onboarding::OnboardingDecision::Begin) => {}
        PaneOutcome::Decision(
            crate::onboarding::OnboardingDecision::Selected(_)
            | crate::onboarding::OnboardingDecision::Cancelled
            | crate::onboarding::OnboardingDecision::Pick(_),
        )
        | PaneOutcome::Flow(_) => {
            unreachable!("the welcome screen yields Begin or Exit only")
        }
    }

    let Some(provider_auth) = task.provider_auth.clone() else {
        return Ok(false);
    };
    let prime_row = provider_auth
        .0
        .login_options()
        .await
        .into_iter()
        .find(|row| row.id == crate::provider_auth::PRIME_INFERENCE_PROVIDER_ID);
    let Some(prime_row) = prime_row else {
        return Ok(false);
    };
    let prime_panel = session.auth_panel_handle();
    let prime_cancel = prime_panel.cancel_signal();
    // The panel mounts chrome-less — the splash's heading names the step — and the panel
    // carries the flow's cancel signal (TS: the dialog's abort signal).
    let mut prime_dialog =
        crate::auth_panel::AuthPanel::onboarding(format!("Login to {}", prime_row.name));
    prime_dialog.set_cancel_signal(prime_cancel.clone());
    screen.mount_panel(crate::onboarding_flow::OnboardingPanel::Auth {
        panel: std::boxed::Box::new(prime_dialog),
        heading: Some(crate::onboarding_flow::PRIME_LOGIN_HEADING.to_string()),
    });
    let prime_row_for_flow = prime_row.clone();
    let prime_auth = provider_auth.clone();
    let prime_flow = OnboardingFlowTask::spawn(
        async move {
            prime_auth
                .0
                .login_on_panel(&prime_row_for_flow, prime_panel)
                .await
        },
        prime_cancel,
    );
    let (mut screen, outcome) = drive_onboarding_pane(
        view,
        &mut *drive,
        screen,
        Some(prime_flow),
        &mut session.osc_sink,
    )
    .await?;
    let login = match outcome {
        PaneOutcome::InputClosed => return Ok(false),
        PaneOutcome::Decision(crate::onboarding::OnboardingDecision::Exit) => return Ok(true),
        PaneOutcome::Flow(result) => result.unwrap_or_else(|_| {
            crate::provider_auth::ProviderAuthOutcome::Error(
                "the Prime Inference login task failed".to_string(),
            )
        }),
        PaneOutcome::Decision(_) => {
            unreachable!("the login dialog yields no decisions")
        }
    };
    match login {
        crate::provider_auth::ProviderAuthOutcome::Status(message) => {
            session
                .apply_auth_outcome(
                    crate::provider_auth::ProviderAuthOutcome::Status(message),
                    crate::provider_auth::PRIME_INFERENCE_PROVIDER_ID,
                    view,
                )
                .await;
        }
        outcome => {
            session
                .apply_auth_outcome(
                    outcome,
                    crate::provider_auth::PRIME_INFERENCE_PROVIDER_ID,
                    view,
                )
                .await;
            return Ok(false);
        }
    }

    // The default-model apply: only a home with no current model picks the Prime default. The
    // daemon resolves the model against its own registry — read fresh at the switch, so the
    // just-stored credential is what makes the default available (the client's startup snapshot
    // predates the sign-in). A resolution failure surfaces as the switch's error row and the flow
    // still completes.
    if task.current_model.is_none() {
        session
            .apply_model_selection(
                crate::provider_auth::PRIME_INFERENCE_PROVIDER_ID,
                crate::provider_auth::PRIME_INFERENCE_DEFAULT_MODEL_ID,
                view,
            )
            .await;
    }

    // The connect-more-providers picker: the picker stays mounted between logins so several
    // can connect in one pass, with fresh connected marks after each one.
    loop {
        let rows = provider_auth.0.login_options().await;
        // One row per provider id, never the Prime row the flow just signed in and never a
        // service (`mcp:` integrations are services, not model providers).
        let mut seen = std::collections::HashSet::new();
        let options: Vec<crate::onboarding_flow::ProviderPickerOption> = rows
            .iter()
            .filter(|row| {
                row.id != crate::provider_auth::PRIME_INFERENCE_PROVIDER_ID
                    && !row.id.starts_with("mcp:")
            })
            .filter(|row| seen.insert(row.id.clone()))
            .map(|row| crate::onboarding_flow::ProviderPickerOption {
                id: row.id.clone(),
                // A custom provider's name is user-controlled bytes (an unknown provider
                // falls back to its id): the control scrub runs before any row renders it.
                name: crate::menu_panel::scrub_controls(&row.name),
                connected: row.configured,
                available: row.available,
            })
            .collect();
        if options.is_empty() {
            break;
        }
        screen.mount_panel(crate::onboarding_flow::OnboardingPanel::Providers(
            crate::onboarding_flow::ProviderPicker::new(options),
        ));
        let (picked_screen, outcome) =
            drive_onboarding_pane(view, &mut *drive, screen, None, &mut session.osc_sink).await?;
        screen = picked_screen;
        let pick = match outcome {
            PaneOutcome::InputClosed => return Ok(false),
            PaneOutcome::Decision(crate::onboarding::OnboardingDecision::Exit) => return Ok(true),
            PaneOutcome::Decision(crate::onboarding::OnboardingDecision::Pick(
                crate::onboarding_flow::ProviderPick::Continue
                | crate::onboarding_flow::ProviderPick::Cancelled,
            )) => break,
            PaneOutcome::Decision(crate::onboarding::OnboardingDecision::Pick(
                crate::onboarding_flow::ProviderPick::Provider(id),
            )) => id,
            PaneOutcome::Decision(
                crate::onboarding::OnboardingDecision::Selected(_)
                | crate::onboarding::OnboardingDecision::Cancelled
                | crate::onboarding::OnboardingDecision::Begin,
            )
            | PaneOutcome::Flow(_) => unreachable!("the picker yields Pick only"),
        };
        let row = rows
            .iter()
            .find(|row| row.id == pick)
            .expect("the picked row came from the same options list");
        if row.flow == crate::provider_auth::AuthFlow::ApiKeyPrompt {
            let panel = session.auth_panel_handle();
            let prompt_cancel = panel.cancel_signal();
            let mut api_key_dialog =
                crate::auth_panel::AuthPanel::onboarding(format!("Login to {}", row.name));
            api_key_dialog.set_cancel_signal(prompt_cancel.clone());
            screen.mount_panel(crate::onboarding_flow::OnboardingPanel::Auth {
                panel: std::boxed::Box::new(api_key_dialog),
                heading: None,
            });
            let prompt_cancel_body = prompt_cancel.clone();
            let provider_id = row.id.clone();
            let row = row.clone();
            let prompt_auth = provider_auth.clone();
            let prompt_flow = OnboardingFlowTask::spawn(
                async move {
                    // The submitted key stores through the composition root; a cancel is
                    // silent. A pane exit after the submit marks the signal — the login (the
                    // credential write) never runs once the pane is gone.
                    match panel
                        .paste_prompt(
                            crate::onboarding_flow::API_KEY_PROMPT,
                            crate::auth_panel::PastePromptTone::Text,
                            // The field renders bullets, not the typed key: a first-run screen is
                            // exactly the shared and recorded surface a secret must never render
                            // on (TS renders the typed key — the port masks the secret).
                            crate::auth_panel::PasteStyle::Masked,
                        )
                        .await
                    {
                        Some(api_key) if !prompt_cancel_body.cancelled() => {
                            prompt_auth.0.login(&row, Some(&api_key)).await
                        }
                        _ => crate::provider_auth::ProviderAuthOutcome::Cancelled,
                    }
                },
                prompt_cancel,
            );
            let (prompted_screen, outcome) = drive_onboarding_pane(
                view,
                &mut *drive,
                screen,
                Some(prompt_flow),
                &mut session.osc_sink,
            )
            .await?;
            screen = prompted_screen;
            match outcome {
                PaneOutcome::InputClosed => return Ok(false),
                PaneOutcome::Decision(crate::onboarding::OnboardingDecision::Exit) => {
                    return Ok(true);
                }
                PaneOutcome::Flow(result) => {
                    let outcome = result.unwrap_or_else(|_| {
                        crate::provider_auth::ProviderAuthOutcome::Error(
                            "the provider login task failed".to_string(),
                        )
                    });
                    session
                        .apply_auth_outcome(outcome, &provider_id, view)
                        .await;
                }
                PaneOutcome::Decision(_) => {
                    unreachable!("the key prompt dialog yields no decisions")
                }
            }
        } else {
            // A terminal-flow row runs its panel-driven flow through the mounted auth panel — the
            // MCP device flow, the codex subscription OAuth: the `/login` selector's panel path
            // (the non-panel body answers the silent cancel for OAuth rows, so it would dead-end
            // the available rows; the picker keeps the unavailable ones inert).
            let panel = session.auth_panel_handle();
            let service_cancel = panel.cancel_signal();
            let mut service_dialog =
                crate::auth_panel::AuthPanel::onboarding(format!("Login to {}", row.name));
            service_dialog.set_cancel_signal(service_cancel.clone());
            screen.mount_panel(crate::onboarding_flow::OnboardingPanel::Auth {
                panel: std::boxed::Box::new(service_dialog),
                heading: None,
            });
            let provider_id = row.id.clone();
            let row = row.clone();
            let service_auth = provider_auth.clone();
            let provider_login = OnboardingFlowTask::spawn(
                async move { service_auth.0.login_on_panel(&row, panel).await },
                service_cancel,
            );
            let (login_screen, outcome) = drive_onboarding_pane(
                view,
                &mut *drive,
                screen,
                Some(provider_login),
                &mut session.osc_sink,
            )
            .await?;
            screen = login_screen;
            match outcome {
                PaneOutcome::InputClosed => return Ok(false),
                PaneOutcome::Decision(crate::onboarding::OnboardingDecision::Exit) => {
                    return Ok(true);
                }
                PaneOutcome::Flow(result) => {
                    let outcome = result.unwrap_or_else(|_| {
                        crate::provider_auth::ProviderAuthOutcome::Error(
                            "the provider login task failed".to_string(),
                        )
                    });
                    session
                        .apply_auth_outcome(outcome, &provider_id, view)
                        .await;
                }
                PaneOutcome::Decision(_) => {
                    unreachable!("the login dialog yields no decisions")
                }
            }
        }
    }

    // The trace question, the flow's last step — the merged question surface. A home that
    // already carries a standing choice skips it (the operator ruling: the choice stands)
    // while the flow still completes below — an aborted retry (the model still not ready)
    // leaves the marker unset, so the next launch runs the sign-in again without re-asking.
    if !task.sink.agent_traces_choice_written() {
        screen.mount_panel(crate::onboarding_flow::OnboardingPanel::Question(
            crate::onboarding_choice::OnboardingChoice::new(
                crate::onboarding::trace_question_options(),
                None,
                crate::onboarding::trace_question_config(),
            ),
        ));
        let (_screen, outcome) =
            drive_onboarding_pane(view, &mut *drive, screen, None, &mut session.osc_sink).await?;
        match outcome {
            PaneOutcome::InputClosed => return Ok(false),
            PaneOutcome::Decision(crate::onboarding::OnboardingDecision::Exit) => return Ok(true),
            PaneOutcome::Decision(crate::onboarding::OnboardingDecision::Selected(index)) => {
                if let Err(error) = task.sink.set_agent_traces_enabled(index == 0) {
                    warn_onboarding_persist_failure(session, view, &error);
                }
            }
            PaneOutcome::Decision(crate::onboarding::OnboardingDecision::Cancelled) => {}
            PaneOutcome::Decision(
                crate::onboarding::OnboardingDecision::Begin
                | crate::onboarding::OnboardingDecision::Pick(_),
            )
            | PaneOutcome::Flow(_) => {
                unreachable!("the question panel yields Selected or Cancelled only")
            }
        }
    }
    // Only a completed flow whose model is ready marks onboarding seen — a flow whose
    // sign-in left the home without a usable model stays unset and retries next launch.
    if (task.model_ready)() {
        if let Err(error) = task.sink.mark_onboarding_complete() {
            warn_onboarding_persist_failure(session, view, &error);
        }
    }
    Ok(false)
}

/// A failed onboarding persistence write surfaces as a warning row in the session: the flow
/// still settled for this run, but an unpersisted marker re-mounts the whole flow on the next
/// launch — the user must know, and the run never dies over a settings write.
fn warn_onboarding_persist_failure(
    session: &mut SessionUi,
    view: &mut AgentView,
    error: &anyhow::Error,
) {
    view.push_entry(crate::chat::ChatEntry::Status {
        text: format!(
            "\u{26a0} The onboarding answer could not be saved ({error}); the first-run flow may appear again."
        ),
        kind: crate::chat::StatusKind::Warning,
    });
    session.dirty = true;
}
