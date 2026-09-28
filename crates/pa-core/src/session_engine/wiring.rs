use super::*;

impl AgentSession {
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

    /// Bind the telemetry handle the `skill used` adoption event reports
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
}
