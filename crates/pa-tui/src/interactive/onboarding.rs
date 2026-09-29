//! The first-run onboarding concern (moved with its concern): the sink and
//! readiness seams, the flow task, the pane drive over the mounted onboarding
//! screens, and the phase that runs the flow before the session screen.

use super::{
    mpsc, AgentView, Duration, ExitGuard, Instant, KeybindingsManager, Renderer, Result, SessionUi,
    UiInput,
};

/// Persistence for the first-run onboarding answers. The TUI crate owns
/// only the surface; the composition root (pa-cli) implements the sink
/// against the settings manager, keeping pa-tui decoupled from pa-core.
pub trait OnboardingSink: Send + Sync {
    /// The completion marker, read fresh (TS `getOnboardingShown`): the
    /// phase's own one-shot gate. The startup gate evaluates the marker
    /// once, but the agents-view flow re-runs the phase for every session
    /// it opens with the same task, so a completed flow re-checks the
    /// persisted marker here and never shows anything again.
    fn onboarding_shown(&self) -> bool;
    /// Whether a trace-sharing choice was ever written (TS
    /// `settings.agentTraces.enabled` presence): a provisioned or
    /// copied-config home carries one. Such homes never see the question
    /// — the standing choice stands and the flow completes silently;
    /// only a fresh home (no choice written) is asked once.
    fn agent_traces_choice_written(&self) -> bool;
    /// Persist the trace-sharing answer (TS `setAgentTracesEnabled`).
    ///
    /// # Errors
    ///
    /// Returns `Err` when persisting the choice to the settings store
    /// fails.
    fn set_agent_traces_enabled(&self, enabled: bool) -> anyhow::Result<()>;
    /// Mark the onboarding flow completed (TS `markOnboardingShown` +
    /// `flush`); an aborted flow leaves the flag unset.
    ///
    /// # Errors
    ///
    /// Returns `Err` when persisting the completion marker fails.
    fn mark_onboarding_complete(&self) -> anyhow::Result<()>;
}

/// The model-readiness probe (TS `isOnboardingModelReady` over
/// `getOnboardingState`): the composition root re-resolves the startup
/// model chain, because the flow's own steps can change the answer (the
/// Prime sign-in configures the startup model; TS re-checks readiness
/// before the completion marker writes).
pub type ModelReadiness = std::sync::Arc<dyn Fn() -> bool + Send + Sync>;

/// The first-run flow to run before the session screen (TS
/// `runStartupOnboarding`): the model-ready branch asks the trace
/// question on the immediate splash; a home with no usable model runs
/// the full flow (TS `runOnboardingFlow`'s not-ready branch) — the
/// welcome screen's login action, the Prime Inference sign-in through
/// the inline auth panel, the default-model apply, the
/// connect-more-providers picker, and the trace question.
#[derive(Clone)]
pub struct OnboardingTask {
    pub sink: std::sync::Arc<dyn OnboardingSink>,
    /// The startup model's readiness (TS the flow-start branch).
    pub model_ready: ModelReadiness,
    /// The startup model itself (TS `getCurrentModel` at flow time):
    /// the default model applies only without one.
    pub current_model: Option<pa_types::ai::Model>,
    /// The provider auth flows the full branch signs in through (the
    /// composition root's `/login` surface); `None` leaves a
    /// not-ready home without its sign-in step.
    pub provider_auth: Option<crate::provider_auth::ProviderAuthCommandsHandle>,
}

impl std::fmt::Debug for OnboardingTask {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OnboardingTask").finish()
    }
}

/// One onboarding flow's background task (the Prime login, a provider's
/// key prompt): the spawned join plus the flow's cooperative cancel
/// signal, shared with the panel handle the flow holds. The phase
/// drives the pane while it runs and takes the settled outcome.
struct OnboardingFlowTask {
    join: tokio::task::JoinHandle<crate::provider_auth::ProviderAuthOutcome>,
    cancel: crate::auth_panel::FlowCancel,
}

impl OnboardingFlowTask {
    /// Spawn the flow and pair it with the panel handle's cancel signal:
    /// the blocking login body checks the signal before its auth-store
    /// writes, so the pane can end the flow without aborting it
    /// (a `JoinHandle::abort` cannot reach a started `spawn_blocking`
    /// login — without the signal an exited pane would leave the login
    /// running to completion and still writing credentials).
    fn spawn<F>(future: F, cancel: crate::auth_panel::FlowCancel) -> Self
    where
        F: std::future::Future<Output = crate::provider_auth::ProviderAuthOutcome> + Send + 'static,
    {
        OnboardingFlowTask {
            join: tokio::spawn(future),
            cancel,
        }
    }

    /// The flow's settled outcome (the pane waits for it).
    fn settle(
        &mut self,
    ) -> &mut tokio::task::JoinHandle<crate::provider_auth::ProviderAuthOutcome> {
        &mut self.join
    }

    /// End the flow with the exiting pane: mark the cooperative signal,
    /// then wait for the blocking login to observe it (bounded by the
    /// login's request timeouts) — the exit never leaves a detached
    /// flow writing credentials in the background.
    async fn end(self) {
        self.cancel.mark();
        let _ = self.join.await;
    }
}

/// The outcome of one onboarding pane drive: a screen decision, the exit
/// keys, or the background flow settling while the pane waited.
enum PaneOutcome {
    /// A screen decision: the answer to the mounted panel's step, or the
    /// onboarding exit keys (they arrive as a decision, not a drive
    /// outcome — the pane's key loop reports them like any other key).
    Decision(crate::onboarding::OnboardingDecision),
    /// The input channel closed under the pane (the headless plan is done,
    /// the terminal reader is gone): the flow ends without an answer and
    /// the marker stays unset — the next launch re-runs it.
    InputClosed,
    /// The flow settled; `Err` is a crashed task (the flow's outcome
    /// reports the same error surface a failed login does).
    Flow(Result<crate::provider_auth::ProviderAuthOutcome, tokio::task::JoinError>),
}

/// The pane drive's borrowed services: the input channel, the renderer,
/// the force-quit guard, the mounted panels' keybindings, and the auth
/// panel request channel (the same channel the run loop services once
/// the pane ends).
pub(super) struct PaneDrive<'a> {
    pub(super) ui_rx: &'a mut mpsc::UnboundedReceiver<UiInput>,
    pub(super) renderer: &'a mut Renderer,
    pub(super) exit_guard: &'a ExitGuard,
    pub(super) keybindings: KeybindingsManager,
    pub(super) auth_panel_rx: &'a mut mpsc::UnboundedReceiver<crate::auth_panel::AuthPanelRequest>,
    /// The run loop's headless-plan-completed flag: the pane marks it
    /// when the plan's `HeadlessDone` lands while it owns the input
    /// channel, so the run loop's idle gate still ends the run (the
    /// pane keeps driving until the channel closes or a decision ends
    /// it).
    pub(super) headless_done: &'a mut bool,
}

/// The pane drive's render barrier (the run loop's `WaitRender`/
/// `WaitGone` contract, pane-scoped): the headless plan's condition
/// steps hold the queued input batch behind them until a frame rendered
/// after arming satisfies the condition, so later keystrokes land on a
/// pane that is actually ready for them instead of racing the panel
/// mounts (a fixed wall-clock sleep only wins when the machine is idle).
enum PaneBarrier {
    /// `WaitRender`: a frame rendered at or after the baseline contains
    /// the needle.
    Render {
        needle: String,
        baseline: usize,
        deadline: Instant,
    },
    /// `WaitGone`: the newest frame no longer contains the needle.
    Gone { needle: String, deadline: Instant },
}

/// Draw the mounted onboarding screen and drive it until a key decides,
/// the exit keys quit, or the optional background flow settles (TS the
/// splash's render/wait loop). Each iteration draws first and waits
/// after — a deciding key that is already queued still leaves the
/// mounted frame captured — servicing keys, pastes, the auth-panel
/// channel, and the animation tick (TS `ANIMATION_INTERVAL_MS`).
async fn drive_onboarding_pane(
    view: &mut AgentView,
    drive: &mut PaneDrive<'_>,
    mut screen: crate::onboarding::OnboardingScreen,
    mut flow: Option<OnboardingFlowTask>,
    osc_sink: &mut crate::clipboard::OscSink,
) -> Result<(crate::onboarding::OnboardingScreen, PaneOutcome)> {
    // The armed render barrier holds the input batch behind it (the
    // loop's post-draw check pops it on satisfy or timeout).
    let mut barrier: Option<PaneBarrier> = None;
    loop {
        // The barrier check rides the redraw cadence: every iteration
        // drew a fresh frame first, so the condition scans the frames
        // that exist now.
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
        // The pane owns the frame from the mount (TS renders the splash
        // the moment it opens).
        view.onboarding = Some(screen);
        match drive.renderer {
            Renderer::Terminal { .. } => {
                if let Some(renderer) = drive.renderer.is_terminal_mut() {
                    if let Err(error) = crate::app::draw(renderer, view) {
                        // A failed frame ends the pane: end a
                        // still-running login flow with it — the
                        // cooperative cancel reaches the blocking login
                        // body, so the error path never leaves a
                        // detached flow writing credentials in the
                        // background.
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
                // A closed input channel ends the pane (the headless plan
                // is done, the terminal reader is gone): without this arm
                // the always-ready `recv()` spins the redraw loop hot.
                let Some(input) = maybe_input else {
                    // A closed input channel ends the pane: end a
                    // still-running login flow with it — the
                    // cooperative cancel reaches the blocking login
                    // body, so the exit never leaves a detached flow
                    // writing credentials in the background.
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
                    // The onboarding exit keys include Ctrl+C (`app.clear`):
                    // report the handled press so the force-quit guard's
                    // handled counter stays in sync with the reader's
                    // observations.
                    if key_id == "ctrl+c" {
                        drive.exit_guard.note_ctrl_c_handled();
                    }
                    if let Some(decision) = pane.handle_key(&key_id, &drive.keybindings, osc_sink) {
                        // A decision tears the pane down mid-drive: end
                        // a still-running login flow with it (TS the
                        // dialog's abort signal) — the cooperative
                        // cancel reaches the blocking login body, so a
                        // quit never leaves a detached flow writing
                        // credentials in the background.
                        if let Some(task) = flow.take() {
                            task.end().await;
                        }
                        return Ok((pane, PaneOutcome::Decision(decision)));
                    }
                }
                UiInput::Paste(text) => {
                    pane.handle_paste(&text);
                }
                // The headless plan completed while the pane owned the
                // channel: mark the run loop's flag (the pane keeps
                // driving until the channel closes or a decision ends
                // it — the run loop's idle gate ends the run).
                UiInput::HeadlessDone => *drive.headless_done = true,
                // The plan's render barriers (the run loop's
                // `WaitRender`/`WaitGone` contract, pane-scoped): a
                // condition that already holds pops immediately; a
                // pending one arms and holds the input batch behind it
                // until a later frame satisfies it or the deadline pops
                // (the timeout proceeds silently — the harness's
                // assertion then reports the actual frame, the honest
                // failure mode for a stall). The steps only ever come
                // from the headless harness; a terminal pane consumes
                // them as no-ops.
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
                // The plan's driving steps mean nothing to the pane
                // (the headless harness replays them against the session
                // screen once the pane releases).
                UiInput::Submit(_)
                | UiInput::SettleIdle
                | UiInput::Mouse(_)
                | UiInput::WaitIdle { .. }
                | UiInput::ScrollTop
                | UiInput::Resize => {}
                }
            }
            // The login flows drive the mounted dialog through the
            // request channel (the run loop's channel arm equivalent for
            // the pane-owned panel).
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
            // The field animates behind the flow panels until dismissal
            // (TS ANIMATION_INTERVAL_MS).
            () = tokio::time::sleep(Duration::from_millis(120)) => {
                pane.tick();
            }
        }
        // Hand the pane back for the next draw (the non-deciding arms).
        screen = pane;
    }
}

/// Drive the first-run onboarding flow before the session screen (TS
/// `runStartupOnboarding` -> `runOnboardingFlow`). Returns `true` when
/// the exit keys quit the app (TS `onExit` -> shutdown).
pub(super) async fn run_onboarding_phase(
    task: &OnboardingTask,
    session: &mut SessionUi,
    view: &mut AgentView,
    drive: &mut PaneDrive<'_>,
) -> Result<bool> {
    // One-shot: the startup gate read the marker once to mount this task,
    // but the agents-view flow re-runs the phase for every session it
    // opens with the same task. A flow that already completed (the
    // marker now persisted) re-checks here and never shows anything again.
    if task.sink.onboarding_shown() {
        return Ok(false);
    }
    if (task.model_ready)() {
        // The ready branch's standing-choice gate (the operator ruling): a
        // home that already carries a trace-sharing choice (a provisioned
        // or copied-config home, or a `/traces` change made before the
        // flow completed) never sees the question — the standing choice
        // stands and the flow completes silently. The question below is
        // the first-run step for a fresh home only — asked exactly once,
        // then the marker gates every later run.
        if task.sink.agent_traces_choice_written() {
            if let Err(error) = task.sink.mark_onboarding_complete() {
                warn_onboarding_persist_failure(session, view, &error);
            }
            return Ok(false);
        }
        // The model-ready branch (TS `runOnboardingFlow`'s ready case):
        // the immediate splash mounts the trace question alone.
        let screen = crate::onboarding::OnboardingScreen::new();
        let (_screen, outcome) =
            drive_onboarding_pane(view, &mut *drive, screen, None, &mut session.osc_sink).await?;
        match outcome {
            PaneOutcome::InputClosed => return Ok(false),
            PaneOutcome::Decision(crate::onboarding::OnboardingDecision::Exit) => return Ok(true),
            PaneOutcome::Decision(crate::onboarding::OnboardingDecision::Selected(index)) => {
                // `Share` opts in; `Not now` keeps traces off (TS
                // finish(index === 0)). A cancel writes no answer at all,
                // but the flow still completed. A write that fails
                // surfaces as a warning row: the flow still settled this
                // run, but an unpersisted marker re-mounts it next launch —
                // the user must know, the run never dies over it.
                if let Err(error) = task.sink.set_agent_traces_enabled(index == 0) {
                    warn_onboarding_persist_failure(session, view, &error);
                }
            }
            // A cancel writes no answer; the flow still completed (TS
            // finish(undefined)).
            PaneOutcome::Decision(crate::onboarding::OnboardingDecision::Cancelled) => {}
            // The question binds nothing else; a settled flow never ran.
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

    // The full flow (TS `runOnboardingFlow`'s not-ready branch): one
    // sequence for every first launch. Signing in is instant when a
    // Prime CLI token is already on disk, so users who arrive with
    // credentials still reach the same account, provider and trace
    // questions. A flow that aborts (a cancelled or failed sign-in,
    // the exit keys) leaves the marker unset — the next launch retries.
    let screen = crate::onboarding::OnboardingScreen::welcome();
    let (mut screen, outcome) =
        drive_onboarding_pane(view, &mut *drive, screen, None, &mut session.osc_sink).await?;
    // The welcome binds one key: Enter starts the flow (TS: cancel is
    // deliberately unbound — signing in is the only way forward).
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

    // The Prime Inference sign-in (TS `runPrimeInferenceLogin`) through
    // the inline auth panel, over the composition root's auth surface.
    let Some(provider_auth) = task.provider_auth.clone() else {
        // No auth surface means no sign-in: the flow aborts and the
        // marker stays unset (the product always provides the surface).
        return Ok(false);
    };
    let prime_row = provider_auth
        .0
        .login_options()
        .await
        .into_iter()
        .find(|row| row.id == crate::provider_auth::PRIME_INFERENCE_PROVIDER_ID);
    let Some(prime_row) = prime_row else {
        // A composition root without the Prime row has no sign-in to run.
        return Ok(false);
    };
    let prime_panel = session.auth_panel_handle();
    let prime_cancel = prime_panel.cancel_signal();
    // TS `loginDialogOptions()`'s onboarding shape: the panel mounts
    // chrome-less (`topRule: false, hideTitle: true`) — the splash's
    // heading names the step — and the actions row reads the same
    // resolved keybindings the pane answers with; the panel carries the
    // flow's cancel signal, so the row's cancel hint ends the login (TS
    // the dialog's abort signal).
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
    // The dialog consumes every key itself; only the flow settling or
    // the exit keys can end the drive.
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
        // The status row lands behind the pane (the session transcript
        // renders it once the flow dismisses).
        crate::provider_auth::ProviderAuthOutcome::Status(message) => {
            session
                .apply_auth_outcome(
                    crate::provider_auth::ProviderAuthOutcome::Status(message),
                    crate::provider_auth::PRIME_INFERENCE_PROVIDER_ID,
                    view,
                )
                .await;
        }
        // A failed or cancelled sign-in aborts the flow: the marker
        // stays unset and the next launch retries (TS `authResult.status
        // !== "success"`).
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

    // The default-model apply (TS `prepareForModelSelectionAfterLogin`):
    // only a home with no current model picks the Prime default. The
    // daemon resolves the model against its own registry — read fresh at
    // the switch, so the just-stored credential is what makes GLM 5.3
    // available (the client's startup snapshot predates the sign-in and
    // never carries it). A resolution failure surfaces as the switch's
    // error row and the flow still completes.
    if task.current_model.is_none() {
        session
            .apply_model_selection(
                crate::provider_auth::PRIME_INFERENCE_PROVIDER_ID,
                crate::provider_auth::PRIME_INFERENCE_DEFAULT_MODEL_ID,
                view,
            )
            .await;
    }

    // The connect-more-providers picker (TS `askOnboardingProviders`):
    // the picker stays mounted between logins so several can connect in
    // one pass, with fresh connected marks after each one.
    loop {
        let rows = provider_auth.0.login_options().await;
        // One row per provider id (TS dedupes by id), never the Prime
        // row the flow just signed in and never a service (`mcp:`
        // integrations are services, not model providers).
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
                // A custom provider's name is user-controlled bytes (an
                // unknown provider falls back to its id): the control
                // scrub runs before any row renders it.
                name: crate::menu_panel::scrub_controls(&row.name),
                connected: row.configured,
                available: row.available,
            })
            .collect();
        // An empty provider list ends the step (TS `options.length === 0`).
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
            // Continue or Esc ends the step (TS settle(undefined) ->
            // return).
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
        // TS `loginProvider`: the row's flow — the panel-prompted key,
        // or the panel-driven flow.
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
                    // TS `showApiKeyLoginDialog`: the submitted key
                    // stores through the composition root; a cancel is
                    // silent. A pane exit after the submit marks the
                    // signal — the login (the credential write) never
                    // runs once the pane is gone.
                    match panel
                        .paste_prompt(
                            crate::onboarding_flow::API_KEY_PROMPT,
                            // TS `showPrompt` renders the prompt as a
                            // section title in the text colour.
                            crate::auth_panel::PastePromptTone::Text,
                            // The field renders bullets, not the typed key:
                            // a first-run screen is exactly the shared and
                            // recorded surface a secret must never render on
                            // (the token paste panel's rule; TS renders the
                            // typed key — the port masks the secret).
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
            // A terminal-flow row runs its panel-driven flow through the
            // mounted auth panel — the MCP device flow, the ported codex
            // subscription OAuth: the `/login` selector's panel path
            // (the non-panel body answers the silent cancel for OAuth
            // rows, so it would dead-end the available rows; the picker
            // keeps the unavailable ones inert). The panel mounts
            // chrome-less (TS the onboarding `loginDialogOptions`) with
            // the pane's resolved keybindings.
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
        // The loop re-mounts a fresh picker with fresh connected marks.
    }

    // The trace question (TS `askOnboardingTraceOptIn`), the flow's last
    // step — the merged question surface. A home that already carries a
    // standing choice skips it (the operator ruling: the choice stands)
    // while the flow still completes below — an aborted retry (the model
    // still not ready) leaves the marker unset, so the next launch runs
    // the sign-in again without re-asking.
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
                // `Share` opts in; `Not now` keeps traces off. A cancel
                // writes no answer, but the flow still completed.
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
    // TS `runStartupOnboarding`: only a completed flow whose model is
    // ready marks onboarding seen — a flow whose sign-in left the home
    // without a usable model stays unset and retries next launch.
    if (task.model_ready)() {
        if let Err(error) = task.sink.mark_onboarding_complete() {
            warn_onboarding_persist_failure(session, view, &error);
        }
    }
    Ok(false)
}

/// A failed onboarding persistence write surfaces as a warning row in the
/// session: the flow still settled for this run, but an unpersisted marker
/// re-mounts the whole flow on the next launch — the user must know, and the
/// run never dies over a settings write (the session stays usable; `/traces`
/// stays the change path).
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
