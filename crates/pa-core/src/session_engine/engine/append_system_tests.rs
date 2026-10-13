//! Assert the actual provider context, without inference or a Python kernel.
use super::*;
use pa_agent::scripted::ScriptedProvider;

struct PromptCase {
    custom_system: bool,
    global: Option<&'static str>,
    project: Option<&'static str>,
    explicit: Vec<String>,
    expected: &'static str,
}

async fn assert_prompt_case(case: PromptCase) {
    // Both daemon workers and print sessions enter through create_session.
    for daemonless in [false, true] {
        let tmp = tempfile::tempdir().unwrap();
        let cwd = tmp.path().join("project");
        let agent_dir = tmp.path().join("agent");
        std::fs::create_dir_all(cwd.join(".prime/agent")).unwrap();
        std::fs::create_dir_all(&agent_dir).unwrap();
        std::fs::write(cwd.join("AGENTS.md"), "PROJECT_CONTEXT_SENTINEL").unwrap();
        std::fs::write(agent_dir.join("AGENTS.md"), "GLOBAL_CONTEXT_SENTINEL").unwrap();
        if case.custom_system {
            std::fs::write(agent_dir.join("SYSTEM.md"), "CUSTOM_SYSTEM_SENTINEL").unwrap();
        }
        if let Some(content) = case.global {
            std::fs::write(agent_dir.join("APPEND_SYSTEM.md"), content).unwrap();
        }
        if let Some(content) = case.project {
            std::fs::write(cwd.join(".prime/agent/APPEND_SYSTEM.md"), content).unwrap();
        }
        let model = Model {
            id: "m".into(),
            name: "m".into(),
            api: "test".into(),
            provider: "test".into(),
            base_url: "http://localhost".into(),
            reasoning: false,
            cost: pa_agent::types::UsageCost::default(),
            context_window: 100_000,
            max_tokens: 100,
            max_tokens_explicit: false,
        };
        let provider = Arc::new(ScriptedProvider::new(model.clone()));
        provider.push_text_turn("scripted response");
        let engine = create_session(SessionEngineConfig {
            cwd,
            agent_dir,
            model: Some(model),
            stream_fn: Some(provider.stream_fn()),
            prompt_guidelines: case.explicit.clone(),
            daemonless,
            prewarm_ipython_kernel: Some(false),
            ..Default::default()
        })
        .await
        .unwrap();
        engine
            .prompt("hello", PromptOptions::default())
            .await
            .unwrap();
        engine.session.agent().wait_for_idle().await;
        let calls = provider.calls();
        assert_eq!(calls.len(), 1);
        let prompt = calls[0].system_prompt.as_deref().unwrap();
        assert_eq!(prompt, engine.system_prompt);
        if case.custom_system {
            assert!(prompt.starts_with("CUSTOM_SYSTEM_SENTINEL"));
        } else {
            assert!(prompt.starts_with("# prime-agent harness"));
        }
        for context in ["PROJECT_CONTEXT_SENTINEL", "GLOBAL_CONTEXT_SENTINEL"] {
            assert_eq!(prompt.matches(context).count(), 1);
        }
        let expected = case.expected;
        assert!(
            prompt.ends_with(expected),
            "daemonless={daemonless}: missing appended {expected:?}"
        );
        for candidate in [case.global, case.project].into_iter().flatten() {
            if !candidate.is_empty() && candidate != expected {
                assert!(
                    !prompt.contains(candidate),
                    "overridden file leaked into prompt"
                );
            }
        }
        if !expected.is_empty() {
            assert_eq!(prompt.matches(expected).count(), 1);
        }
    }
}

#[tokio::test]
async fn append_system_global_reaches_provider() {
    assert_prompt_case(PromptCase {
        custom_system: true,
        global: Some("Always end replies with the token ZULU"),
        project: None,
        explicit: vec![],
        expected: "Always end replies with the token ZULU",
    })
    .await;
}

#[tokio::test]
async fn append_system_project_overrides_global() {
    assert_prompt_case(PromptCase {
        custom_system: true,
        global: Some("GLOBAL_APPEND_SENTINEL"),
        project: Some("PROJECT_APPEND_SENTINEL"),
        explicit: vec![],
        expected: "PROJECT_APPEND_SENTINEL",
    })
    .await;
}

#[tokio::test]
async fn append_system_explicit_overrides_files() {
    assert_prompt_case(PromptCase {
        custom_system: true,
        global: Some("GLOBAL_APPEND_SENTINEL"),
        project: Some("PROJECT_APPEND_SENTINEL"),
        explicit: vec!["EXPLICIT_ONE".into(), "EXPLICIT_TWO".into()],
        expected: "EXPLICIT_ONE\n\nEXPLICIT_TWO",
    })
    .await;
}

#[tokio::test]
async fn append_system_explicit_file_is_resolved() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("override.md");
    std::fs::write(&path, "EXPLICIT_FILE_SENTINEL").unwrap();
    assert_prompt_case(PromptCase {
        custom_system: true,
        global: Some("GLOBAL_APPEND_SENTINEL"),
        project: Some("PROJECT_APPEND_SENTINEL"),
        explicit: vec![path.display().to_string()],
        expected: "EXPLICIT_FILE_SENTINEL",
    })
    .await;
}

#[tokio::test]
async fn append_system_empty_project_suppresses_global() {
    assert_prompt_case(PromptCase {
        custom_system: true,
        global: Some("GLOBAL_APPEND_SENTINEL"),
        project: Some(""),
        explicit: vec![],
        expected: "",
    })
    .await;
}

#[tokio::test]
async fn append_system_empty_explicit_suppresses_files() {
    assert_prompt_case(PromptCase {
        custom_system: true,
        global: Some("GLOBAL_APPEND_SENTINEL"),
        project: Some("PROJECT_APPEND_SENTINEL"),
        explicit: vec![String::new()],
        expected: "",
    })
    .await;
}

#[tokio::test]
async fn append_system_preserves_default_system_layers() {
    assert_prompt_case(PromptCase {
        custom_system: false,
        global: Some("Always end replies with the token ZULU"),
        project: None,
        explicit: vec![],
        expected: "Always end replies with the token ZULU",
    })
    .await;
}
