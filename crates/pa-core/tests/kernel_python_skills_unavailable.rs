//! Verifier integration tests for the Python-skills-unavailable notice (TS
//! PR #2381: the `python_skills_unavailable` regression plus the
//! broken-vs-healthy pin):
//!
//! - a kernel boot whose bootstrap fails to import a configured Python
//!   skill reports it through `onUnavailableSkills` (import name + import
//!   error), while a skill that imports cleanly never appears — the model
//!   learns from the notice, not from the placeholder's first-call error;
//! - the session-level row rides the next admitted turn ahead of its
//!   prompt (TS `deliverAs: "nextTurn"`): the provider sees the report,
//!   and the durable entry carries the multi-skill content and the
//!   `details.skills` list.
//!
//! The kernel test needs the ambient product kernel (the auto-bootstrapped
//! venv, exactly the interpreter `prime-agent` spawns); like
//! `kernel_lifecycle.rs` it skips (with a note) on machines without a live
//! install so the suite stays hermetic elsewhere. `PA_CORE_KERNEL_PYTHON`
//! points at an explicit interpreter.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use pa_core::kernel::bootstrap::{KernelPythonSkill, UnavailablePythonSkills};
use pa_core::kernel::provisioner::{IpythonKernelProvisioner, IpythonKernelProvisionerOptions};
use pa_core::kernel::shared::HostRequestHandlers;
use pa_core::session_engine::engine::{create_session, SessionEngineConfig};
use pa_core::session_engine::provider_adapter::{json_round_trip, real_stream_fn};
use pa_core::session_engine::skills_unavailable_notice::{
    notice_message, PYTHON_SKILLS_UNAVAILABLE_CUSTOM_TYPE,
};
use pa_core::session_engine::{PromptOptions, PromptOutcome};
use pa_types::session::FileEntry;

/// The faux provider registry is process-global and the session test
/// drives it: the std lock serializes the contenders (they are the only
/// ones, so holding it across awaits is safe).
static FAUX_LOCK: Mutex<()> = Mutex::new(());

/// The kernel Python with prime-agent-runtime installed (see
/// `kernel_lifecycle.rs`); skipped with a note when absent.
fn kernel_python() -> Option<PathBuf> {
    if let Some(explicit) = std::env::var_os("PA_CORE_KERNEL_PYTHON") {
        let explicit = PathBuf::from(explicit);
        assert!(
            explicit.exists(),
            "PA_CORE_KERNEL_PYTHON {} not found",
            explicit.display()
        );
        return Some(explicit);
    }
    let candidate = PathBuf::from(std::env::var("HOME").map_or_else(
        |_| "/home/ubuntu/.prime/agent/kernel-venv/bin/python".to_string(),
        |home| format!("{home}/.prime/agent/kernel-venv/bin/python"),
    ));
    if candidate.exists() {
        return Some(candidate);
    }
    eprintln!(
        "kernel python {} not found; skipping live notice test",
        candidate.display()
    );
    None
}

/// A configured skill shape; the provisioner's explicit-python path never
/// reads the package paths (they only feed the venv sync, which the
/// override skips).
fn skill(name: &str) -> KernelPythonSkill {
    KernelPythonSkill {
        name: name.to_string(),
        import_name: name.replace('-', "_"),
        package_path: PathBuf::from("/nonexistent/skill"),
        pyproject_path: PathBuf::from("/nonexistent/skill/pyproject.toml"),
    }
}

/// One boot with an explicit kernel python reports the broken import (and
/// only it): the marker line the bootstrap prints carries `json`'s healthy
/// import nowhere, so the model-facing report stays honest about what
/// actually failed.
#[tokio::test]
async fn broken_skill_import_reports_and_healthy_skills_stay_silent() {
    let Some(python) = kernel_python() else {
        return;
    };
    let reported: Arc<Mutex<Vec<UnavailablePythonSkills>>> = Arc::new(Mutex::new(Vec::new()));
    let on_unavailable_skills = {
        let reported = Arc::clone(&reported);
        Arc::new(move |errors: &UnavailablePythonSkills| {
            reported.lock().unwrap().push(errors.clone());
        }) as pa_core::kernel::provisioner::UnavailableSkillsCallback
    };
    let provisioner = IpythonKernelProvisioner::new(
        "/tmp",
        IpythonKernelProvisionerOptions {
            python: Some(python),
            host_handlers: HostRequestHandlers::new(),
            // One broken import (nothing named this in the kernel) and
            // one healthy stdlib import ride the same bootstrap.
            python_skills: vec![skill("broken-skill-lane"), skill("json")],
            on_unavailable_skills: Some(on_unavailable_skills),
            ..Default::default()
        },
    );
    provisioner
        .ensure(None, None)
        .await
        .expect("the broken skill must not cost the kernel (TS: placeholders swallow it)");
    let reported = reported.lock().unwrap().clone();
    let expected: Vec<UnavailablePythonSkills> = vec![vec![(
        "broken_skill_lane".to_string(),
        "No module named 'broken_skill_lane'".to_string(),
    )]];
    assert_eq!(
        reported, expected,
        "the healthy `json` import must stay out"
    );
    provisioner.dispose(None).await;
}

/// The notice rides the next admitted turn as model context (TS
/// `kernel-python-skills-unavailable.test.ts`): the provider's request
/// already carries the report, and the durable row keeps the multi-skill
/// content and `details.skills`.
#[tokio::test]
// The faux lock is held across the turn's awaits: the faux registry is
// process-global and this test's registration is the only contender (see
// `FAUX_LOCK`).
#[allow(clippy::await_holding_lock)]
async fn notice_rides_the_next_turn_as_model_context() {
    let _guard = FAUX_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let cwd = dir.path().join("project");
    std::fs::create_dir_all(&cwd).expect("cwd");

    let provider_saw_notice = Arc::new(Mutex::new(false));
    let seen_provider = Arc::clone(&provider_saw_notice);
    let responses = vec![pa_ai::faux::FauxResponseStep::Factory(Arc::new(
        move |context: &pa_types::ai::Context,
              _options: Option<&pa_ai::types::StreamOptions>,
              _call: u64,
              _model: &pa_types::ai::Model| {
            let saw = context.messages.iter().any(|message| {
                matches!(message, pa_types::ai::Message::User(user) if user
                    .content
                    .text()
                    .contains("failed to import into the Python kernel"))
            });
            *seen_provider.lock().unwrap() = saw;
            Ok(pa_ai::faux::faux_assistant_text_message(
                "queued turn complete",
                pa_ai::faux::FauxAssistantMessageOptions::default(),
            ))
        },
    ))];
    let registration =
        pa_ai::faux::register_faux_provider(pa_ai::faux::RegisterFauxProviderOptions {
            models: Some(vec![pa_ai::faux::FauxModelDefinition {
                id: "faux-1".to_string(),
                name: Some("Faux".to_string()),
                reasoning: Some(false),
                input: Some(vec![pa_types::ai::ModelInput::Text]),
                cost: None,
                context_window: Some(100_000),
                max_tokens: Some(4_096),
            }]),
            ..Default::default()
        });
    registration.set_responses(responses);
    let model = registration.get_model();
    let stream_fn = real_stream_fn(None, model.clone());

    let engine = create_session(SessionEngineConfig {
        cwd,
        agent_dir,
        model: Some(json_round_trip(&model).expect("model conversion")),
        stream_fn: Some(stream_fn),
        tools: Vec::new(),
        ..Default::default()
    })
    .await
    .expect("create the session");

    // The boot-notice queue seam (the engine's `onUnavailableSkills`
    // pushes exactly this row; TS drives `_onPythonSkillsUnavailable` the
    // same way in its regression).
    let errors: UnavailablePythonSkills = vec![
        (
            "websearch".to_string(),
            "No module named 'websearch'".to_string(),
        ),
        ("edit".to_string(), "boom".to_string()),
    ];
    engine
        .session
        .queue_next_turn_row(notice_message(&errors))
        .await;

    let outcome = engine
        .prompt("go", PromptOptions::default())
        .await
        .expect("prompt");
    assert_eq!(outcome, PromptOutcome::Prompt);
    engine.session.agent().wait_for_idle().await;

    assert!(
        *provider_saw_notice.lock().unwrap(),
        "the model must see the report on the same turn"
    );
    let entries = engine.session.entries().await;
    let notice = entries
        .iter()
        .find_map(|entry| match entry {
            FileEntry::CustomMessage { payload, .. }
                if payload.custom_type == PYTHON_SKILLS_UNAVAILABLE_CUSTOM_TYPE =>
            {
                Some(payload.clone())
            }
            _ => None,
        })
        .expect("the notice must land durably");
    assert!(notice.display, "the notice is user-visible");
    assert_eq!(
        notice.details,
        Some(serde_json::json!({ "skills": ["websearch", "edit"] }))
    );
    let pa_types::ai::UserContent::Text(content) = &notice.content else {
        panic!("text content");
    };
    assert!(
        content.contains("- websearch: No module named 'websearch'"),
        "{content}"
    );
    assert!(content.contains("- edit: boom"), "{content}");
}
