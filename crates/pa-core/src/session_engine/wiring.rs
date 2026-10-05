use super::{
    auxiliary_model, compaction, compaction_exec, image_model_routing, ipython_state,
    provider_adapter, refine, semantic_edges, telemetry, AgentSession, PromptBatchRow,
};

impl AgentSession {
    /// Install the image-model routing host seam (the headless surfaces'
    /// settings + registry + pinned stream target); `None` keeps image
    /// turns on the session model.
    pub fn set_image_model_router(
        &mut self,
        router: Option<image_model_routing::ImageModelRouter>,
    ) {
        self.image_model_router = router;
    }

    /// The dispatch-time routing decision for one admitted batch (TS
    /// `_imageModelOverrideForTurns` at commit): when the batch attaches
    /// image blocks the session model cannot serve, the host's route
    /// takes the stream target and the agent's per-run override, so the
    /// run serves on the configured image model while the session model
    /// keeps identifying the session. The fresh decision of EVERY admitted
    /// batch (image-free included) re-evaluates the route, so retries and
    /// post-compaction continuations of a routed turn keep serving it and
    /// the next image-free batch returns to the session model. `Err` fails
    /// the turn with the actionable refusal.
    pub(super) async fn apply_image_model_routing(
        &self,
        images: &[pa_agent::types::ImageContent],
        batch: &[PromptBatchRow],
    ) -> anyhow::Result<()> {
        let Some(router) = self.image_model_router.as_ref() else {
            return Ok(());
        };
        // The prior episode never outlives this admission (TS
        // `_clearModelOverrideWhenIdle`: an explicit selection wins over
        // routing lingering from the last dispatched turn, and the next
        // dispatch re-evaluates against the new selection). The settle
        // runs only while no run streams — the winner of an admission
        // race keeps its own live serving target — and its still-routed
        // guard leaves a mid-idle model switch alone, so the capture this
        // batch's decision reads is always the live session model, never
        // one from before a switch.
        if !self.agent.state().await.is_streaming {
            (router.swap_target)(None);
            self.agent.set_model_override(None);
        }
        let carries_images = !images.is_empty() || batch.iter().any(|row| !row.images.is_empty());
        // The live thinking level (the agent state's, matching
        // `request_output_budget`'s read) rides the decision: a mid-run
        // `/effort` or model switch must not route with the build-time
        // level.
        let live_level =
            provider_adapter::model_thinking_level(self.agent.state().await.thinking_level);
        let route = (router.decide)(carries_images, live_level).map_err(anyhow::Error::msg)?;
        let Some(resolved) = route.as_ref() else {
            (router.swap_target)(None);
            self.agent.set_model_override(None);
            return Ok(());
        };
        (router.swap_target)(Some(resolved));
        // The conversion failure happens AFTER the swap armed the routed
        // target: unwind the route so the failed turn does not leave it
        // serving the next batch (the same unwind the admission race and
        // the refusal paths perform).
        let Some(agent_model) =
            crate::session_engine::provider_adapter::json_round_trip(&resolved.model)
        else {
            (router.swap_target)(None);
            self.agent.set_model_override(None);
            return Err(anyhow::anyhow!("model conversion failed"));
        };
        self.agent
            .set_model_override(Some(pa_agent::agent::AgentModelOverride {
                model: agent_model,
                thinking_level: crate::session_engine::provider_adapter::map_thinking_level(
                    resolved.thinking_level,
                ),
            }));
        Ok(())
    }

    /// Override the compaction settings from the session's resolved
    /// settings (TS `getCompactionSettings`); the engine wiring calls this
    /// so `/compact` honors `compaction.keepRecentTokens`/`reserveTokens`
    /// like the TS product instead of the defaults.
    pub fn set_compaction_settings(&self, settings: compaction::CompactionSettings) {
        *self
            .compaction
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = settings;
    }

    /// Toggle automatic compaction for this session (TS
    /// `setAutoCompactionEnabled`): the live settings the auto-compaction
    /// arms and `/compact` read.
    pub fn set_auto_compaction_enabled(&self, enabled: bool) {
        let mut settings = self
            .compaction
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        settings.enabled = enabled;
    }

    /// Install the auxiliary-model routing context (TS #2411's
    /// `_resolveAuxiliaryModel` settings/registry access); the engine
    /// wiring calls this so compaction summaries resolve through the
    /// `auxiliaryModel` setting. Without it every summarizer stays on the
    /// session model.
    pub fn set_auxiliary_model_context(&mut self, context: auxiliary_model::AuxiliaryModelContext) {
        self.auxiliary_model = Some(context);
    }

    /// Install the skill inventory `/skill:<name>` submissions expand
    /// against (TS reads the resource loader at expansion time; the Rust
    /// session snapshots the engine's loaded list here).
    pub fn set_skills(&mut self, skills: Vec<crate::skills::Skill>) {
        self.skills = skills;
    }

    /// Bind the telemetry handle the `skill_use_count` counter counts
    /// through (the engine wiring owns the telemetry lifetime and
    /// installs it once the session telemetry is assembled).
    pub fn set_skill_telemetry(&mut self, telemetry: std::sync::Arc<telemetry::SessionTelemetry>) {
        self.skill_telemetry = Some(telemetry);
    }

    /// Bind the auto-refine surface for this session (the engine wiring
    /// resolves both once the session is assembled): whether the session
    /// may auto-refine (TS `_autoRefineAllowedForSession`: depth 0 with a
    /// local harness state dir) and the resolved gates (TS
    /// `getAutoRefineSettings`).
    pub fn set_auto_refine(&mut self, allowed: bool, gates: refine::AutoRefineGates) {
        self.auto_refine_allowed = allowed;
        self.auto_refine = gates;
    }

    /// Bind the session's agent dir (the settings root). The refine flow
    /// reads the `factory.enabled` opt-in from the agent dir's
    /// settings.json on every run — the same live read the kernel-side
    /// factory gate performs — so a session without a wired agent dir
    /// keeps the fail-closed disabled default.
    pub fn set_agent_dir(&mut self, agent_dir: std::path::PathBuf) {
        self.agent_dir = Some(agent_dir);
    }

    /// Bind the kernel-state probe behind the post-compaction
    /// `ipython_state` notice (the engine wiring hands over the session's
    /// kernel provisioner, TS `AgentSession._ipythonKernelProvisioner`).
    /// Without a probe no notice lands: sessions without a kernel keep
    /// the pre-notice compaction flow.
    pub fn set_kernel_state_probe(
        &mut self,
        probe: Option<std::sync::Arc<dyn ipython_state::CompactionKernelProbe>>,
    ) {
        self.kernel_state = probe;
    }

    /// Install the live compaction summary-delta sink (the daemon's
    /// `compaction_summary_delta` broadcast seam): every summarizer text
    /// delta the session's compactions stream reaches the sink while the
    /// summary generates, in arrival order. The daemon wires this onto
    /// the assembled session (the worker's event pump); every other
    /// embedding leaves it unset — the one-shot summarizer completion,
    /// byte-identical to the pre-seam behavior.
    ///
    /// # Panics
    ///
    /// Panics when the sink slot's mutex is poisoned.
    pub fn set_compaction_summary_sink(&self, sink: compaction_exec::SummaryDeltaSink) {
        *self
            .compaction_summary_sink
            .lock()
            .expect("compaction summary sink lock") = Some(sink);
    }

    /// Whether the session may run auto-refinement (TS
    /// `_autoRefineAllowedForSession`).
    pub fn auto_refine_allowed(&self) -> bool {
        self.auto_refine_allowed
    }

    /// The resolved auto-refine gates (TS `getAutoRefineSettings`).
    pub fn auto_refine_gates(&self) -> refine::AutoRefineGates {
        self.auto_refine
    }

    /// Whether automatic compaction is enabled for this session (the TS
    /// `getCompactionSettings().enabled` gate the automatic arms check
    /// before any trigger).
    pub fn auto_compaction_enabled(&self) -> bool {
        self.compaction
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .enabled
    }

    /// The resolved compaction settings (TS `getCompactionSettings`): the
    /// in-run continuation consult reads the threshold headroom without
    /// owning the session (a compaction in flight owns it across its
    /// model turn).
    pub fn compaction_settings(&self) -> compaction::CompactionSettings {
        *self
            .compaction
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Install the session's semantic-edge recorder (the engine build's
    /// handoff; the daemon's child registry and retry park read it back
    /// through [`AgentSession::semantic_edges`]).
    pub fn set_semantic_edges(
        &self,
        recorder: Option<std::sync::Arc<semantic_edges::SemanticEdgeRecorder>>,
    ) {
        *self
            .semantic_edges
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = recorder;
    }

    /// The session's semantic-edge recorder, when the engine built the
    /// session with a semantic identity.
    #[must_use]
    pub fn semantic_edges(&self) -> Option<std::sync::Arc<semantic_edges::SemanticEdgeRecorder>> {
        self.semantic_edges
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    /// Install the pre-semantic stream fn calls outside session history run
    /// on (TS `unwrapSemanticEdgeStreamFn`; the engine wires the
    /// timing-instrumented fn it wrapped semantic edges around).
    pub fn set_side_question_stream_fn(&self, stream_fn: pa_agent::stream::StreamFn) {
        *self
            .side_question_stream_fn
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(stream_fn);
    }

    /// The pre-semantic stream fn for calls outside session history (side
    /// questions carry no request id).
    #[must_use]
    pub fn side_question_stream_fn(&self) -> Option<pa_agent::stream::StreamFn> {
        self.side_question_stream_fn
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }
}
