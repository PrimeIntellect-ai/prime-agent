#[cfg(test)]
mod resume_settings_tests {
    use crate::engine::{
        BranchSummaryOutcome, BranchSummaryRequest, CompactionOutcome, CompactionRequest,
    };
    use crate::worker::*;
    use pa_agent::abort::AbortSignal;

    #[derive(Default)]
    struct CaptureEngine {
        selected: Mutex<EngineModelSelection>,
        tier: Mutex<Option<pa_types::ai::ServiceTier>>,
    }
    impl SessionEngine for CaptureEngine {
        fn configure_model(&self, selection: EngineModelSelection) {
            let mut current = self.selected.lock().unwrap();
            if selection.provider.is_some() {
                current.provider = selection.provider;
            }
            if selection.model.is_some() {
                current.model = selection.model;
            }
            if selection.thinking.is_some() {
                current.thinking = selection.thinking;
            }
        }
        fn configure_service_tier(&self, tier: Option<pa_types::ai::ServiceTier>) {
            *self.tier.lock().unwrap() = tier;
        }
        fn run_prompt(
            &self,
            _: usize,
            _: PromptRequest,
            _: &dyn Fn() -> bool,
            _: &mut dyn FnMut(EngineEvent) -> bool,
        ) {
        }
        fn run_side_question(
            &self,
            request: crate::engine::SideQuestionRequest,
            signal: &AbortSignal,
            sink: &pa_core::session_engine::side_question::SideQuestionSink,
        ) -> crate::engine::SideQuestionOutcome {
            ScriptedEngine::default().run_side_question(request, signal, sink)
        }
        fn run_compaction(
            &self,
            request: CompactionRequest,
            signal: &AbortSignal,
        ) -> CompactionOutcome {
            ScriptedEngine::default().run_compaction(request, signal)
        }
        fn run_branch_summary(
            &self,
            request: BranchSummaryRequest,
            signal: &AbortSignal,
        ) -> BranchSummaryOutcome {
            ScriptedEngine::default().run_branch_summary(request, signal)
        }
        fn rebuild_session_context(
            &self,
            _: Vec<pa_types::session::FileEntry>,
            _: pa_core::session_engine::goal_driver::GoalBranchReload,
        ) -> anyhow::Result<()> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn compacted_create_restores_settings_and_honors_explicit_overrides() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("resume.jsonl");
        let mut file = SessionFile::create("/tmp", None, 0);
        file.set_path(path.clone());
        file.append_model_change("old", "superseded");
        file.append_thinking_level_change("high");
        file.append_entry("service_tier_change", json!({"serviceTier":null}));
        file.append_message(json!({"role":"assistant","provider":"saved","model":"inferred","api":"openai-responses","content":[],"stopReason":"stop","timestamp":0,"usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0,"cost":{"input":0.0,"output":0.0,"cacheRead":0.0,"cacheWrite":0.0,"total":0.0}}}));
        let kept = file.append_message(json!({"role":"user","content":"kept","timestamp":1}));
        file.append_entry(
            "compaction",
            json!({"summary":"summary","firstKeptEntryId":kept,"tokensBefore":100}),
        );
        file.rewrite().unwrap();
        for mode in [0, 1, 2, 3, 4] {
            let mut fixture = file.clone();
            if mode == 4 {
                for entry in &mut fixture.entries {
                    if entry.type_ == "thinking_level_change" {
                        entry.type_ = "custom".into();
                        entry.fields = json!({"customType":"test"});
                    }
                }
            }
            fixture.rewrite().unwrap();
            let capture = Arc::new(CaptureEngine::default());
            let mut worker = Worker::new(
                WorkerConfig {
                    socket_path: dir.path().join("worker.sock"),
                    supervisor_socket_path: PathBuf::new(),
                    token: "test".into(),
                    worker_instance_id: String::new(),
                    active_session_id: "resume".into(),
                    agent_dir: dir.path().join("agent"),
                    recovery_journal_path: dir.path().join("recovery.jsonl"),
                    telemetry_disabled: Some(true),
                    script: Some(json!({"responses":[]})),
                },
                None,
            );
            worker.engine = capture.clone();
            let mut payload = json!({"sessionPath":path,"cwd":"/tmp"});
            if mode == 1 {
                payload["provider"] = json!("explicit");
                payload["model"] = json!("chosen");
                payload["thinking"] = json!("low");
            }
            if mode == 2 {
                payload["model"] = json!("model-only");
            }
            if mode == 3 {
                payload["thinking"] = json!("off");
            }
            let response = worker.dispatch("create", &payload).await;
            assert!(response.success, "{response:?}");
            assert!(
                crate::lease::acquire_runtime_session_lease(&path, &dir.path().join("agent"))
                    .is_err()
            );
            let selected = capture.selected.lock().unwrap();
            assert_eq!(
                (
                    selected.provider.as_deref(),
                    selected.model.as_deref(),
                    selected.thinking
                ),
                if mode == 4 {
                    (Some("saved"), Some("inferred"), None)
                } else if mode == 3 {
                    (
                        Some("saved"),
                        Some("inferred"),
                        Some(pa_types::ai::ModelThinkingLevel::Off),
                    )
                } else if mode == 2 {
                    (
                        None,
                        Some("model-only"),
                        Some(pa_types::ai::ModelThinkingLevel::High),
                    )
                } else if mode == 1 {
                    (
                        Some("explicit"),
                        Some("chosen"),
                        Some(pa_types::ai::ModelThinkingLevel::Low),
                    )
                } else {
                    (
                        Some("saved"),
                        Some("inferred"),
                        Some(pa_types::ai::ModelThinkingLevel::High),
                    )
                }
            );
            assert_eq!(*capture.tier.lock().unwrap(), None);
            assert!(worker
                .core
                .lock()
                .unwrap()
                .store
                .as_ref()
                .unwrap()
                .window
                .is_some());
            drop(selected);
            if mode == 0 {
                let killed = worker.dispatch("kill", &json!({})).await;
                assert!(killed.success, "{killed:?}");
            }
            drop(worker);
            let released =
                crate::lease::acquire_runtime_session_lease(&path, &dir.path().join("agent"))
                    .unwrap();
            drop(released);
        }
    }
}
