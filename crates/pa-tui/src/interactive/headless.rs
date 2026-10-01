//! The headless source (moved with its concern): the scripted plan's
//! vocabulary and the exit gate's settle snapshot - the verifier seam that
//! drives the identical attach/submit/stream/render path without a TTY.

use super::{AgentView, SessionUi};

/// How the UI is driven.
pub enum UiMode {
    /// Raw-mode terminal on stdout.
    Terminal,
    /// Headless plan: submitted prompts plus idle barriers, with rendered
    /// frames captured for assertions.
    Headless(HeadlessPlan),
}

/// A scripted headless run.
#[derive(Debug, Clone)]
pub struct HeadlessPlan {
    pub steps: Vec<HeadlessStep>,
    pub width: u16,
    pub height: u16,
}

#[derive(Debug, Clone)]
pub enum HeadlessStep {
    /// Submit text (the same editor submit path as a user typing it).
    Submit(String),
    /// Submit `text` as a `prompt_and_wait` and hold until this run has
    /// processed every event the turn emitted (each daemon request and the
    /// event drain are each bounded by `timeout_ms`):
    /// the daemon answers the wait only at the turn's full settle (after
    /// its queue-projection update), `get_rlm_children` then reports the
    /// session's final event sequence, and the barrier releases once the
    /// run's live tracker reaches it. The supervisor races its response
    /// and event queues in one select, so the barrier compares sequence
    /// values instead of trusting arrival order. The run is parked while
    /// the turn runs (the loop neither paints nor drains events during
    /// the submit); use `Submit` to observe mid-turn frames. `Submit`
    /// stays the composer path.
    SubmitAndSettle { text: String, timeout_ms: u64 },
    /// Type text character by character (raw editor input, so autocomplete
    /// and editor state react exactly as to a keystroke).
    Type(String),
    /// A bracketed-paste payload (the same editor paste path a terminal's
    /// paste takes, including the large-paste marker rules).
    Paste(String),
    /// Materialize the parked editor suggestions — the state a live user
    /// gets after pausing typing for one input-idle tick, so the next step
    /// (typically `Enter`) completes against the open dropdown. A burst of
    /// `Type` steps without this barrier submits as typed, exactly like a
    /// terminal keystroke burst.
    SettleIdle,
    /// Hold until the current turn finishes (bounded by `timeout_ms`).
    WaitIdle { timeout_ms: u64 },
    /// Hold until a frame rendered after this step contains `needle`
    /// (bounded by `timeout_ms`): the condition wait for daemon-driven
    /// rows (side-question answers, streamed notices), which arrive on
    /// the event cadence rather than a known wall-clock delay.
    WaitRender { needle: String, timeout_ms: u64 },
    /// Hold until the newest frame no longer contains `needle` (bounded by
    /// `timeout_ms`): the verifier's condition wait for a surface closing
    /// (the pane going away, a banner clearing).
    WaitGone { needle: String, timeout_ms: u64 },
    /// Hold the plan for `ms` before the next step: the verifier's timing
    /// window (queue prompts deterministically inside a scripted
    /// `delayMs` hold, where the turn is provably busy).
    WaitMs(u64),
    /// Scroll the transcript to its top row (the `tui.viewport.top` key
    /// path): the verifier's window into the head of the transcript.
    ScrollTop,
    /// A raw mouse sequence: decoded by the same parser the terminal's SGR
    /// reports flow through, so the verifier drives the wheel dispatch with
    /// byte-identical sequences.
    Mouse(String),
    /// One raw key event: the verifier's window into the selector/picker
    /// surfaces (arrows, escape), which typed text cannot express.
    Key(crossterm::event::KeyEvent),
}

/// The headless exit gate's settle, snapshotted: the members the gate
/// requires before the run may end (every one is work the harness must
/// not cut short — a live terminal never ends the run on its own; TS
/// exits the PROCESS at shutdown and lets in-flight work dangle, so the
/// harness's settle has no TS counterpart). `settled()` is the gate;
/// `blockers()` is the same members named, so the settle bound's failure
/// names exactly what stuck (the wedge family's conversion from a
/// job-budget hang with no failure name into an attributable error).
#[derive(Debug, Default)]
pub(super) struct HeadlessSettle {
    /// Plan inputs still queued behind a barrier.
    pub(super) pending_inputs: usize,
    /// A turn still streaming (or latched).
    pub(super) turn_active: bool,
    /// Prompt round trips whose ack has not landed.
    pub(super) submits_in_flight: usize,
    /// The queued-message strip's items.
    pub(super) queued: usize,
    /// An armed idle barrier waiting out its deadline.
    pub(super) idle_barrier: bool,
    /// A frame the loop has not painted yet.
    pub(super) dirty: bool,
    /// A `/share` upload whose outcome has not landed.
    pub(super) share_pending: bool,
    /// A `/reload` whose outcome has not landed.
    pub(super) reload_pending: bool,
    /// A `/traces` upload whose outcome has not landed.
    pub(super) traces_upload_pending: bool,
    /// The inline auth panel is mounted.
    pub(super) auth_panel_open: bool,
    /// A `/traces login` flow is pending.
    pub(super) traces_login_pending: bool,
    /// An MCP auth flow is pending.
    pub(super) mcp_auth_pending: bool,
    /// The Anthropic subscription warning's `mark_anthropic_warning_shown`
    /// write is still in flight (fire-and-forget in the product — the run
    /// must still not end with the durable write un-acked; a lost mark
    /// costs a repeated warning on the session's next open).
    pub(super) anthropic_warning_mark_pending: bool,
}

impl HeadlessSettle {
    /// Read the gate's members off the loop state (the gate's exact
    /// conditions, in the same order the gate historically checked them).
    pub(super) fn snapshot(
        session: &SessionUi,
        view: &AgentView,
        pending_inputs: usize,
        idle_barrier: bool,
    ) -> Self {
        Self {
            pending_inputs,
            turn_active: session.turn_active,
            submits_in_flight: session.prompt_submits_in_flight(),
            queued: view.queued.steering.len() + view.queued.follow_ups.len(),
            idle_barrier,
            dirty: session.dirty,
            share_pending: session.share_pending(),
            reload_pending: session.reload_pending(),
            traces_upload_pending: session.traces_upload_pending(),
            auth_panel_open: view.auth_panel.is_some(),
            traces_login_pending: session.pending_traces_login(),
            mcp_auth_pending: session.pending_mcp_auth(),
            anthropic_warning_mark_pending: session.anthropic_warning_mark_pending(),
        }
    }

    /// Whether every settle member drained (the exit gate).
    pub(super) fn settled(&self) -> bool {
        self.blockers().is_empty()
    }

    /// The members that are holding the run open, named for the settle
    /// bound's failure (empty when settled).
    pub(super) fn blockers(&self) -> Vec<String> {
        let mut blockers = Vec::new();
        if self.pending_inputs > 0 {
            blockers.push(format!(
                "{} queued plan input(s) behind a barrier",
                self.pending_inputs
            ));
        }
        if self.turn_active {
            blockers.push("a turn still active".to_string());
        }
        if self.submits_in_flight > 0 {
            blockers.push(format!(
                "{} prompt submit(s) without an ack",
                self.submits_in_flight
            ));
        }
        if self.queued > 0 {
            blockers.push(format!("{} queued message(s) undelivered", self.queued));
        }
        if self.idle_barrier {
            blockers.push("an idle barrier waiting out its deadline".to_string());
        }
        if self.dirty {
            blockers.push("an unpainted frame".to_string());
        }
        if self.share_pending {
            blockers.push("a share upload in flight".to_string());
        }
        if self.reload_pending {
            blockers.push("a reload in flight".to_string());
        }
        if self.traces_upload_pending {
            blockers.push("a traces upload in flight".to_string());
        }
        if self.auth_panel_open {
            blockers.push("the inline auth panel open".to_string());
        }
        if self.traces_login_pending {
            blockers.push("a pending traces login".to_string());
        }
        if self.mcp_auth_pending {
            blockers.push("a pending MCP auth flow".to_string());
        }
        if self.anthropic_warning_mark_pending {
            blockers.push("the Anthropic warning's mark write in flight".to_string());
        }
        blockers
    }
}
