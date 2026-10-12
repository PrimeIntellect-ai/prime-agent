//! The interactive-mode unit battery: the session flag mapping, the continue-recent
//! view target, the onboarding gate, and the startup fork/select contracts.

use super::*;
// The tests call the trait methods directly (the impl header alone
// does not import them).
use pa_tui::interactive::OnboardingSink;
use serde_json::Map;

#[test]
fn session_flags_map_to_selections() {
    let mut session = crate::mode::SessionOptions::default();
    let dir = tempfile::TempDir::new().expect("temp dir");
    let session_dir = dir.path().join("sessions");
    std::fs::create_dir_all(&session_dir).expect("sessions dir");
    assert_eq!(
        session_selection(&session, Some(session_dir.as_path())),
        SessionSelection::New
    );
    // `--continue` never maps to a resume: the candidate resolves through the
    // agents view or falls through to a fresh session.
    session.continue_recent = true;
    assert_eq!(
        session_selection(&session, Some(session_dir.as_path())),
        SessionSelection::New
    );
    session.continue_recent = false;
    session.resume = Some("a1b2c3".to_string());
    assert_eq!(
        session_selection(&session, Some(session_dir.as_path())),
        SessionSelection::Attach("a1b2c3".to_string())
    );
    let saved = session_dir.join("deadbeefcafe.jsonl");
    std::fs::write(&saved, "{}\n").expect("write file");
    session.resume = Some("deadbeefcafe".to_string());
    assert_eq!(
        session_selection(&session, Some(session_dir.as_path())),
        SessionSelection::Resume(saved)
    );

    let file = dir.path().join("saved.jsonl");
    std::fs::write(&file, "{}\n").expect("write file");
    session.resume = Some(file.to_string_lossy().to_string());
    assert_eq!(
        session_selection(&session, Some(session_dir.as_path())),
        SessionSelection::Resume(file)
    );
}

fn run_options_for_continue(dir: &std::path::Path) -> RunOptions {
    use crate::mode::{AppMode, RuntimeConfig};
    RunOptions {
        app_mode: AppMode::Interactive,
        config: RuntimeConfig {
            cwd: dir.to_path_buf(),
            agent_dir: dir.join("agent"),
            ..Default::default()
        },
        session: crate::mode::SessionOptions::default(),
        messages: Vec::new(),
        file_args: Vec::new(),
        daemon_socket: None,
        daemon_port: None,
        daemon_bind_host: None,
        list_models: None,
        initial_message: None,
        initial_images: Vec::new(),
        verbose: false,
        offline: false,
        agents_view_requested: false,
        attach_agent: None,
    }
}

/// A saved session file the cwd-scoped scans resolve, in the same
/// shape `SessionFile::create` writes (header with id + cwd).
fn seed_saved_session(
    session_dir: &std::path::Path,
    id: &str,
    cwd: &std::path::Path,
) -> std::path::PathBuf {
    use std::io::Write;
    std::fs::create_dir_all(session_dir).expect("sessions dir");
    let path = session_dir.join(format!("{id}.jsonl"));
    let mut file = std::fs::File::create(&path).expect("create session file");
    let header = serde_json::json!({
        "type": "session", "id": id,
        "cwd": cwd.display().to_string(),
        "timestamp": "2024-01-01T00:00:00.000Z", "version": 3,
    });
    writeln!(file, "{header}").expect("write header");
    path
}

#[test]
fn continue_recent_targets_the_newest_saved_session_for_the_cwd() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let session_dir = agent_dir.join("sessions");
    seed_saved_session(&session_dir, "old0000000000000000000000000001", dir.path());
    let candidate =
        seed_saved_session(&session_dir, "newest00000000000000000000000001", dir.path());
    // A session from another cwd is never the candidate.
    let other_cwd = tempfile::TempDir::new().expect("other cwd");
    seed_saved_session(
        &session_dir,
        "foreign0000000000000000000000001",
        other_cwd.path(),
    );

    let future = std::time::SystemTime::now() + std::time::Duration::from_mins(1);
    let handle = std::fs::File::options()
        .append(true)
        .open(&candidate)
        .expect("open candidate");
    handle.set_modified(future).expect("nudge mtime");

    let mut options = run_options_for_continue(dir.path());
    options.session.continue_recent = true;
    options.session.session_dir = Some(session_dir);
    let view = continue_recent_view(&options, false).expect("candidate resolves");
    assert_eq!(
        view.session_id, "newest00000000000000000000000001",
        "the newest saved session for the cwd is the preselected row"
    );
    assert!(
        view.notice.contains("newest00000000000000000000000001"),
        "the notice names the candidate: {}",
        view.notice
    );
    assert!(
        candidate.exists(),
        "resolution only reads the candidate file"
    );
}

#[test]
fn continue_recent_without_a_candidate_opens_a_fresh_session() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let session_dir = agent_dir.join("sessions");
    let other_cwd = tempfile::TempDir::new().expect("other cwd");
    seed_saved_session(
        &session_dir,
        "foreign0000000000000000000000001",
        other_cwd.path(),
    );

    let mut options = run_options_for_continue(dir.path());
    options.session.continue_recent = true;
    options.session.session_dir = Some(session_dir);
    assert!(
        continue_recent_view(&options, false).is_none(),
        "no candidate: the launch opens a fresh session, not the view"
    );
}

#[test]
fn continue_recent_defers_to_resume_and_no_session() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let session_dir = agent_dir.join("sessions");
    seed_saved_session(&session_dir, "newest00000000000000000000000001", dir.path());

    let mut options = run_options_for_continue(dir.path());
    options.session.session_dir = Some(session_dir);
    options.session.continue_recent = true;
    assert!(
        continue_recent_view(&options, false).is_some(),
        "a bare --continue opens the view preselected on the candidate"
    );
    options.session.resume = Some("named-session".to_string());
    assert!(
        continue_recent_view(&options, false).is_none(),
        "an explicit --resume selector wins over --continue"
    );
    options.session.resume = None;
    options.session.no_session = true;
    assert!(
        continue_recent_view(&options, false).is_none(),
        "--no-session owns the launch: nothing to continue"
    );
}

#[test]
fn continue_recent_view_gates_on_onboarding_and_the_flag() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let session_dir = agent_dir.join("sessions");
    seed_saved_session(&session_dir, "newest00000000000000000000000001", dir.path());

    let mut options = run_options_for_continue(dir.path());
    options.session.session_dir = Some(session_dir);
    assert!(
        continue_recent_view(&options, false).is_none(),
        "a non-continue launch never opens the agents view through this path"
    );
    options.session.continue_recent = true;
    assert!(
        continue_recent_view(&options, true).is_none(),
        "a pending onboarding keeps the first-run startup"
    );
    assert!(
        continue_recent_view(&options, false).is_some(),
        "a completed onboarding opens the view preselected on the candidate"
    );
}

#[test]
fn onboarding_gate_follows_settings_and_auth() {
    use crate::mode::{AppMode, RuntimeConfig};

    fn run_options(dir: &std::path::Path) -> RunOptions {
        RunOptions {
            app_mode: AppMode::Interactive,
            config: RuntimeConfig {
                cwd: dir.to_path_buf(),
                agent_dir: dir.join("agent"),
                ..Default::default()
            },
            session: crate::mode::SessionOptions::default(),
            messages: Vec::new(),
            file_args: Vec::new(),
            daemon_socket: None,
            daemon_port: None,
            daemon_bind_host: None,
            list_models: None,
            initial_message: None,
            initial_images: Vec::new(),
            verbose: false,
            offline: false,
            agents_view_requested: false,
            attach_agent: None,
        }
    }

    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent = dir.path().join("agent");
    std::fs::create_dir_all(&agent).expect("agent dir");

    let mut settings = pa_core::settings::SettingsManager::create(dir.path(), &agent);
    settings.set_onboarding_shown(true).expect("set flag");
    let options = run_options(dir.path());
    assert!(onboarding_task(&options, None).0.is_none());

    settings.set_onboarding_shown(false).expect("reset flag");

    // Flagless launch: a models.json provider key + saved default model resolve the
    // startup model, so the onboarding task mounts; a fresh home completes silently.
    std::fs::write(
        agent.join("models.json"),
        r#"{ "providers": {
                "onboard-test": {
                    "baseUrl": "https://onboard.test", "apiKey": "sk-onboard",
                    "api": "openai-completions",
                    "models": [ { "id": "m1", "name": "M1" } ]
                },
                "onboard-naked": {
                    "baseUrl": "https://naked.test",
                    // Present (custom models require "apiKey", same as TS)
                    // but the `!command` resolves to no credential, so the
                    // provider stays unauthorized.
                    "apiKey": "!exit 1",
                    "api": "openai-completions",
                    "models": [ { "id": "m2", "name": "M2" } ]
                }
            } }"#,
    )
    .expect("models.json");
    let mut settings = pa_core::settings::SettingsManager::create(dir.path(), &agent);
    settings
        .set_default_model_and_provider("onboard-test", "m1")
        .expect("saved default");
    let options = run_options(dir.path());
    let task = onboarding_task(&options, None)
        .0
        .expect("the ready home mounts the flow");
    assert!(
        (task.model_ready)(),
        "the configured default model is ready (the question flow)"
    );

    // Explicit flags that resolve to a provider without configured auth mount the
    // task too — the full sign-in flow, not the question.
    let mut options = run_options(dir.path());
    options.config.provider = Some("onboard-naked".into());
    options.config.model = Some("m2".into());
    let task = onboarding_task(&options, None)
        .0
        .expect("the flag alone mounts the flow");
    assert!(
        !(task.model_ready)(),
        "the naked provider leaves the model not ready (the full flow)"
    );
    assert!(
        task.current_model
            .as_ref()
            .is_some_and(|model| model.id == "m2"),
        "the resolved startup model rides the task (TS getCurrentModel)"
    );
}

#[test]
fn settings_sink_completes_a_provisioned_home_without_touching_the_choice() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    // The provisioned home: sharing opted out, telemetry off (no
    // telemetry client for the completion event).
    let mut provisioned = pa_core::settings::SettingsManager::create(dir.path(), &agent_dir);
    provisioned
        .set_agent_traces_enabled(false)
        .expect("provision the opt-out");
    provisioned
        .set_telemetry_enabled(false)
        .expect("telemetry off");

    let sink = SettingsOnboardingSink {
        cwd: dir.path().to_path_buf(),
        agent_dir: agent_dir.clone(),
        created_at: std::time::Instant::now(),
        onboarding_id: uuid::Uuid::new_v4().to_string(),
        ready_emitted: std::sync::atomic::AtomicBool::new(false),
        completion_reported: std::sync::atomic::AtomicBool::new(false),
        probe: StartupModelProbe {
            cwd: dir.path().to_path_buf(),
            agent_dir: agent_dir.clone(),
            cli_provider: None,
            cli_model: None,
            models: None,
            is_continuing: false,
            api_key: None,
        },
    };
    assert!(
        !sink.onboarding_shown(),
        "the never-completed home reads its missing flag through a fresh manager"
    );
    assert!(
        sink.agent_traces_choice_written(),
        "the provisioned opt-out reads through a fresh manager"
    );
    sink.mark_onboarding_complete().expect("silent completion");

    // The next launch reads through its own fresh manager: the gate
    // never mounts the task again.
    let settings = pa_core::settings::SettingsManager::create(dir.path(), &agent_dir);
    assert!(settings.get_onboarding_shown(), "the flag persisted");
    assert!(
        !settings.get_agent_traces_enabled(),
        "the standing opt-out survived the silent completion"
    );
}

/// A flow that ran but did not complete reports `onboarding completed`
/// with the `aborted` outcome (TS `runStartupOnboarding`'s `finally`), and
/// a completed flow never reports a second, aborted outcome. Telemetry is
/// on for this test (the repo's `cargo test` env opts out).
#[test]
fn settings_sink_reports_an_aborted_flow_once() {
    crate::mode::tests::with_clean_telemetry_env(|| {
        tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(report_an_aborted_flow_once());
    });
}

async fn report_an_aborted_flow_once() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let sink = SettingsOnboardingSink {
        cwd: dir.path().to_path_buf(),
        agent_dir: agent_dir.clone(),
        created_at: std::time::Instant::now(),
        onboarding_id: uuid::Uuid::new_v4().to_string(),
        ready_emitted: std::sync::atomic::AtomicBool::new(false),
        completion_reported: std::sync::atomic::AtomicBool::new(false),
        probe: StartupModelProbe {
            cwd: dir.path().to_path_buf(),
            agent_dir: agent_dir.clone(),
            cli_provider: None,
            cli_model: None,
            models: None,
            is_continuing: false,
            api_key: None,
        },
    };
    // The sink's own report resolves only once the event is delivered.
    pa_tui::interactive::OnboardingSink::onboarding_incomplete(&sink, "aborted").await;
    let mirror = std::fs::read_to_string(agent_dir.join("telemetry.jsonl")).unwrap();
    let lines: Vec<&str> = mirror.lines().collect();
    assert_eq!(lines.len(), 1);
    let event: serde_json::Value = serde_json::from_str(lines[0]).unwrap();
    assert_eq!(event["name"], "onboarding completed");
    assert_eq!(event["properties"]["outcome"], "aborted");
    assert_eq!(event["properties"]["execution_mode"], "interactive");

    sink.completion_reported
        .store(true, std::sync::atomic::Ordering::SeqCst);
    assert!(
        sink.track_incomplete("aborted").is_none(),
        "a reported completion never adds an aborted outcome"
    );
}

/// A fresh home (no choice written) is the one home the question still
/// mounts for — the opt-in moment: the flow's `Share` answer persists
/// beside the completion flag, and both read back through the next
/// launch's fresh manager.
#[test]
fn settings_sink_persists_the_fresh_home_answer_with_the_flag() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let mut provisioned = pa_core::settings::SettingsManager::create(dir.path(), &agent_dir);
    provisioned
        .set_telemetry_enabled(false)
        .expect("telemetry off");

    let sink = SettingsOnboardingSink {
        cwd: dir.path().to_path_buf(),
        agent_dir: agent_dir.clone(),
        created_at: std::time::Instant::now(),
        onboarding_id: uuid::Uuid::new_v4().to_string(),
        ready_emitted: std::sync::atomic::AtomicBool::new(false),
        completion_reported: std::sync::atomic::AtomicBool::new(false),
        probe: StartupModelProbe {
            cwd: dir.path().to_path_buf(),
            agent_dir: agent_dir.clone(),
            cli_provider: None,
            cli_model: None,
            models: None,
            is_continuing: false,
            api_key: None,
        },
    };
    assert!(
        !sink.onboarding_shown(),
        "a fresh home has no completion flag yet"
    );
    assert!(
        !sink.agent_traces_choice_written(),
        "a fresh home carries no trace choice (sharing stays off until a choice is made)"
    );
    sink.set_agent_traces_enabled(true).expect("answer Share");
    sink.mark_onboarding_complete()
        .expect("complete onboarding");

    let settings = pa_core::settings::SettingsManager::create(dir.path(), &agent_dir);
    assert!(
        settings.get_onboarding_shown(),
        "the flow marked onboarding shown"
    );
    assert!(
        settings.get_agent_traces_enabled(),
        "the Share answer persisted with the flag"
    );
}

#[test]
fn build_tui_options_reads_code_block_indent_settings() {
    // `markdown.codeBlockIndent` rides InteractiveOptions at startup; a non-default
    // value reaches the TUI, no setting keeps the default two spaces.
    fn run_options(dir: &std::path::Path) -> RunOptions {
        RunOptions {
            app_mode: crate::mode::AppMode::Interactive,
            config: crate::mode::RuntimeConfig {
                cwd: dir.to_path_buf(),
                agent_dir: dir.join("agent"),
                ..Default::default()
            },
            session: crate::mode::SessionOptions::default(),
            messages: Vec::new(),
            file_args: Vec::new(),
            daemon_socket: None,
            daemon_port: None,
            daemon_bind_host: None,
            list_models: None,
            initial_message: None,
            initial_images: Vec::new(),
            verbose: false,
            offline: false,
            agents_view_requested: false,
            attach_agent: None,
        }
    }

    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent = dir.path().join("agent");
    std::fs::create_dir_all(&agent).expect("agent dir");
    std::fs::write(
        agent.join("settings.json"),
        r#"{ "markdown": { "codeBlockIndent": "    " } }"#,
    )
    .expect("settings.json");
    let (options, _) = build_tui_options(
        &run_options(dir.path()),
        dir.path().join("d.sock"),
        std::sync::Arc::default(),
    )
    .expect("options");
    assert_eq!(options.code_block_indent, "    ");

    let bare = tempfile::TempDir::new().expect("temp dir");
    std::fs::create_dir_all(bare.path().join("agent")).expect("agent dir");
    let (options, _) = build_tui_options(
        &run_options(bare.path()),
        bare.path().join("d.sock"),
        std::sync::Arc::default(),
    )
    .expect("options");
    assert_eq!(options.code_block_indent, "  ");
}

/// A session with one user/assistant exchange, in the same shape
/// `SessionManager::persisted` + appends produce.
fn seed_session(
    session_dir: &std::path::Path,
    cwd: &std::path::Path,
    user_text: &str,
) -> (std::path::PathBuf, String) {
    use pa_types::ai::{AssistantMessage, StopReason, Usage, UserContent, UserMessage};
    use pa_types::session::AgentMessage;
    let mut session = pa_core::session::manager::SessionManager::persisted(cwd, session_dir);
    session
        .append_message(AgentMessage::User(UserMessage {
            // The block shape a real run writes, so the assertions read the shape
            // the shipped sessions carry.
            content: UserContent::Blocks(vec![pa_types::ai::UserContentBlock::Text(
                pa_types::ai::TextContent {
                    text: user_text.to_string(),
                    text_signature: None,
                    rest: Map::default(),
                },
            )]),
            timestamp: 0,
            rest: Map::default(),
        }))
        .expect("write user message");
    session
        .append_message(AgentMessage::Assistant(AssistantMessage {
            content: vec![pa_types::ai::AssistantContentBlock::Text(
                pa_types::ai::TextContent {
                    text: "the answer".to_string(),
                    text_signature: None,
                    rest: Map::default(),
                },
            )],
            api: "openai-completions".to_string(),
            provider: "openai".to_string(),
            model: "gpt-x".to_string(),
            response_model: None,
            response_id: None,
            diagnostics: None,
            usage: Usage::default(),
            stop_reason: StopReason::Stop,
            stop_reason_raw: None,
            error_message: None,
            timestamp: 0,
            rest: Map::default(),
        }))
        .expect("write assistant message");
    let id = session.get_session_id().to_string();
    (
        session
            .get_session_file()
            .expect("session file")
            .to_path_buf(),
        id,
    )
}

fn read_jsonl(path: &std::path::Path) -> Vec<serde_json::Value> {
    std::fs::read_to_string(path)
        .expect("read session file")
        .lines()
        .map(serde_json::from_str)
        .collect::<Result<_, _>>()
        .expect("valid session entries")
}

#[test]
fn fork_startup_selection_copies_the_source_under_a_fresh_header() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let cwd = dir.path().join("project");
    let session_dir = dir.path().join("sessions");
    std::fs::create_dir_all(&cwd).expect("cwd");
    std::fs::create_dir_all(&session_dir).expect("sessions dir");
    let (source, id) = seed_session(&session_dir, &cwd, "original question");
    let before = std::fs::read(&source).expect("read source");

    let selection = fork_startup_selection(&id, &cwd, Some(&session_dir)).expect("fork startup");
    let SessionSelection::Resume(fork) = &selection else {
        panic!("the fork opens as a resume of the forked file, got {selection:?}");
    };

    assert!(fork.is_file(), "the fork file landed on disk");
    assert_ne!(fork, &source, "the fork is a new session file");
    assert!(
        fork.starts_with(&session_dir),
        "the fork lives in the session dir"
    );
    let fork_entries = read_jsonl(fork);
    let header = &fork_entries[0];
    assert_eq!(header["type"], "session");
    assert_ne!(header["id"].as_str(), Some(id.as_str()));
    assert_eq!(
        header["parentSession"].as_str(),
        Some(source.display().to_string().as_str()),
        "the fork header parents at the source"
    );
    assert_eq!(
        header["cwd"].as_str(),
        Some(cwd.display().to_string().as_str())
    );
    let texts: Vec<&str> = fork_entries
        .iter()
        .filter(|entry| entry["type"] == "message")
        .filter_map(|entry| entry["message"]["content"][0]["text"].as_str())
        .collect();
    assert!(texts.contains(&"original question"), "texts: {texts:?}");
    assert!(texts.contains(&"the answer"), "texts: {texts:?}");

    let after = std::fs::read(&source).expect("read source");
    assert_eq!(before, after, "the source file is unchanged");
}

#[test]
fn fork_startup_selection_imports_a_global_session_into_this_cwd() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let other_project = dir.path().join("other-project");
    let this_project = dir.path().join("this-project");
    let session_dir = dir.path().join("sessions");
    std::fs::create_dir_all(&other_project).expect("other project");
    std::fs::create_dir_all(&this_project).expect("this project");
    std::fs::create_dir_all(&session_dir).expect("sessions dir");
    let (source, id) = seed_session(&session_dir, &other_project, "global question");
    let before = std::fs::read(&source).expect("read source");

    let selection = fork_startup_selection(&id, &this_project, Some(&session_dir))
        .expect("a GLOBAL session is exactly what --fork is for");
    let SessionSelection::Resume(fork) = &selection else {
        panic!("the fork opens as a resume of the forked file, got {selection:?}");
    };

    let fork_entries = read_jsonl(fork);
    assert_eq!(
        fork_entries[0]["cwd"].as_str(),
        Some(this_project.display().to_string().as_str()),
        "the fork adopts the TARGET cwd"
    );
    assert_eq!(
        fork_entries[0]["parentSession"].as_str(),
        Some(source.display().to_string().as_str())
    );
    let after = std::fs::read(&source).expect("read source");
    assert_eq!(before, after, "the source file is unchanged");
}

#[test]
fn fork_startup_selection_reports_the_ts_contracts() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let cwd = dir.path().join("project");
    let session_dir = dir.path().join("sessions");
    std::fs::create_dir_all(&cwd).expect("cwd");
    std::fs::create_dir_all(&session_dir).expect("sessions dir");

    // An empty source file: the `forkFrom` failure contract.
    let empty = session_dir.join("empty.jsonl");
    std::fs::write(&empty, "").expect("write empty file");
    let error =
        fork_startup_selection(empty.to_str().expect("utf8 path"), &cwd, Some(&session_dir))
            .expect_err("an empty source cannot fork");
    assert!(
        error.to_string().contains(&format!(
            "Cannot fork: source session file is empty or invalid: {}",
            empty.display()
        )),
        "unexpected error: {error:#}"
    );

    // A source file with only an unreadable row: the loader finalizes
    // it to zero entries (the `forkFrom` contract).
    let torn = session_dir.join("torn.jsonl");
    std::fs::write(&torn, "{\"type\":\"message\"}\n").expect("write torn file");
    let error = fork_startup_selection(torn.to_str().expect("utf8 path"), &cwd, Some(&session_dir))
        .expect_err("a source with no readable rows cannot fork");
    assert!(
        error
            .to_string()
            .contains("Cannot fork: source session file is empty or invalid: "),
        "unexpected error: {error:#}"
    );

    // A parseable but headerless source file: the loader finalizes it to zero
    // entries — never a half-copied fork.
    let headerless = session_dir.join("headerless.jsonl");
    std::fs::write(
        &headerless,
        "{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":[],\"timestamp\":0},\"id\":\"aaaa1\",\"parentId\":null}\n",
    )
    .expect("write headerless file");
    let error = fork_startup_selection(
        headerless.to_str().expect("utf8 path"),
        &cwd,
        Some(&session_dir),
    )
    .expect_err("a headerless source cannot fork");
    assert!(
        error
            .to_string()
            .contains("Cannot fork: source session file is empty or invalid: "),
        "unexpected error: {error:#}"
    );

    let error = fork_startup_selection("does-not-exist", &cwd, Some(&session_dir))
        .expect_err("an unknown selector cannot fork");
    let rendered = format!("{error:#}");
    assert!(
        rendered.contains("No session found matching 'does-not-exist'"),
        "unexpected error: {rendered}"
    );
    assert!(
        rendered.contains("Open prime-agent and press left-arrow to browse sessions."),
        "unexpected error: {rendered}"
    );
}

// The tilde selector expands a unix HOME path.
#[cfg(unix)]
#[test]
fn fork_startup_selection_expands_a_tilde_selector() {
    // The resume selector's convention: a leading `~` resolves against the home
    // dir, so forking a home-located session by that path opens it.
    let dir = tempfile::TempDir::new().expect("temp dir");
    let home = dir.path().join("home");
    let project = dir.path().join("project");
    let session_dir = dir.path().join("sessions");
    std::fs::create_dir_all(&home).expect("home");
    std::fs::create_dir_all(&project).expect("project");
    std::fs::create_dir_all(&session_dir).expect("sessions dir");
    let (source, id) = seed_session(&session_dir, &project, "tilde question");
    let home_sessions = home.join("sessions");
    std::fs::create_dir_all(&home_sessions).expect("home sessions dir");
    let home_file = home_sessions.join(format!("{id}.jsonl"));
    std::fs::rename(&source, &home_file).expect("move the source under home");
    let _env = crate::config::env_lock();
    let previous_home = std::env::var("HOME").ok();
    std::env::set_var("HOME", &home);
    let selector = format!("~/sessions/{id}.jsonl");
    let selection = fork_startup_selection(&selector, &project, Some(&session_dir));
    match previous_home {
        Some(value) => std::env::set_var("HOME", value),
        None => std::env::remove_var("HOME"),
    }
    let selection = selection.expect("the tilde selector forks");
    let SessionSelection::Resume(fork) = &selection else {
        panic!("the fork opens as a resume of the forked file, got {selection:?}");
    };
    assert_ne!(fork, &home_file, "the fork is a new session file");
    assert!(
        fork.starts_with(&session_dir),
        "the fork lands in the requested session dir"
    );
    let fork_entries = read_jsonl(fork);
    assert_eq!(
        fork_entries[0]["parentSession"].as_str(),
        Some(home_file.display().to_string().as_str()),
        "the fork header parents at the tilde-resolved source"
    );
}

#[cfg(unix)]
#[test]
fn fork_startup_selection_rejects_a_fifo_source_without_hanging() {
    // A FIFO with no writer blocks the copy's read forever; the guard
    // rejects it before any open.
    let dir = tempfile::TempDir::new().expect("temp dir");
    let project = dir.path().join("project");
    let session_dir = dir.path().join("sessions");
    std::fs::create_dir_all(&project).expect("project");
    std::fs::create_dir_all(&session_dir).expect("sessions dir");
    let fifo = session_dir.join("pipe.jsonl");
    nix::unistd::mkfifo(&fifo, nix::sys::stat::Mode::S_IRWXU).expect("mkfifo");
    let error = fork_startup_selection(
        fifo.to_str().expect("utf8 path"),
        &project,
        Some(&session_dir),
    )
    .expect_err("a FIFO source cannot fork");
    assert!(
        error.to_string().contains(&format!(
            "Cannot fork: source session file is not a regular file: {}",
            fifo.display()
        )),
        "unexpected error: {error:#}"
    );
}

#[test]
fn build_tui_options_opens_a_fork_as_the_startup_session() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let cwd = dir.path().join("project");
    let session_dir = dir.path().join("sessions");
    std::fs::create_dir_all(&cwd).expect("cwd");
    std::fs::create_dir_all(&session_dir).expect("sessions dir");
    let (source, id) = seed_session(&session_dir, &cwd, "interactive question");

    let mut options = run_options_for_continue(dir.path());
    options.config.cwd = cwd;
    options.config.agent_dir = dir.path().join("agent");
    options.session.fork = Some(id);
    options.session.session_dir = Some(session_dir.clone());
    let (tui, _) = build_tui_options(
        &options,
        dir.path().join("d.sock"),
        std::sync::Arc::default(),
    )
    .expect("the interactive launch forks instead of refusing");

    let SessionSelection::Resume(fork) = &tui.session else {
        panic!(
            "the fork opens as a resume of the forked file, got {:?}",
            tui.session
        );
    };
    assert!(
        fork.starts_with(&session_dir),
        "the fork honors --session-dir"
    );
    assert_ne!(fork, &source, "the fork is a new session file");
    let fork_entries = read_jsonl(fork);
    assert_eq!(
        fork_entries[0]["parentSession"].as_str(),
        Some(source.display().to_string().as_str())
    );
}

#[test]
fn a_fork_launch_never_opens_the_agents_view() {
    // `--fork` opens its target directly — even alongside an explicit
    // `agents` request.
    let mut options = run_options_for_continue(std::path::Path::new("/does/not/matter"));
    options.agents_view_requested = true;
    assert!(
        should_open_agents_view(&options, /*onboarding_pending*/ false, /*continue_view*/ false,),
        "an explicit agents request still opens the view"
    );
    options.session.resume_bare = true;
    assert!(
        should_open_agents_view(&options, /*onboarding_pending*/ false, /*continue_view*/ false,),
        "a bare --resume still opens the view"
    );
    options.session.resume_bare = false;
    options.session.fork = Some("source".to_string());
    assert!(
        !should_open_agents_view(&options, /*onboarding_pending*/ false, /*continue_view*/ false,),
        "a fork opens its target, never the agents view"
    );
    assert!(
        should_open_agents_view(&options, /*onboarding_pending*/ false, /*continue_view*/ true,),
        "a --continue with a saved candidate still opens the view"
    );
}

/// A sink whose `send_batch` hangs until the test releases it: the
/// stand-in for the analytics POST's network round-trip (the same
/// delivery contract the production sink carries, minus its own
/// timeout — the point is that delivery takes longer than the paint).
#[derive(Default)]
struct GatedSink {
    /// Send entry: `notify_one` when a batch reaches the sink; a
    /// stored permit keeps the entry wait race-free in both orders.
    entered_notify: tokio::sync::Notify,
    /// The delivered batches' event names (delivery finished).
    delivered: std::sync::Mutex<Vec<String>>,
    /// The release flag the hanging send waits on.
    released: std::sync::atomic::AtomicBool,
    /// The hang gate's waker: `notify_waiters` on release, no
    /// permits — a stale permit would unhang the sink before the
    /// test releases it.
    notify: tokio::sync::Notify,
    /// Delivery completion: `notify_one` stores a permit when no
    /// waiter is registered yet, so the completion future is
    /// race-free in both orders and can be awaited directly.
    delivered_notify: tokio::sync::Notify,
}

impl GatedSink {
    fn release(&self) {
        self.released
            .store(true, std::sync::atomic::Ordering::SeqCst);
        self.notify.notify_waiters();
    }

    fn delivered_names(&self) -> Vec<String> {
        self.delivered.lock().expect("gate lock").clone()
    }

    /// The first send's entry future.
    fn wait_until_entered(&self) -> impl std::future::Future<Output = ()> + '_ {
        self.entered_notify.notified()
    }

    /// The first delivery's completion future.
    fn wait_until_delivered(&self) -> impl std::future::Future<Output = ()> + '_ {
        self.delivered_notify.notified()
    }
}

impl pa_telemetry::TelemetrySink for GatedSink {
    fn send_batch<'a>(
        &'a self,
        _install_id: &'a str,
        events: Vec<pa_telemetry::TelemetryEvent>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = pa_telemetry::SinkOutcome> + Send + 'a>>
    {
        Box::pin(async move {
            self.entered_notify.notify_one();
            // Race-free wait, tokio's documented pattern: the waiter
            // registers (or consumes a permit) BEFORE the flag check, so
            // a release that fires between the check and the await is
            // never lost — a naive `while !flag { notified().await }` can
            // miss `notify_waiters` and hang.
            let notified = self.notify.notified();
            tokio::pin!(notified);
            loop {
                notified.as_mut().enable();
                if self.released.load(std::sync::atomic::Ordering::SeqCst) {
                    break;
                }
                notified.as_mut().await;
                notified.set(self.notify.notified());
            }
            let mut delivered = self.delivered.lock().expect("gate lock");
            for event in &events {
                delivered.push(event.name.clone());
            }
            self.delivered_notify.notify_one();
            pa_telemetry::SinkOutcome::Sent
        })
    }
}

/// The interactive startup flush is fire-and-forget from the paint
/// path's perspective: the first frame must never await the tracked
/// `startup` events' delivery. The gated sink stands in for the
/// analytics POST's network round-trip: the flush hand-off must
/// complete while delivery still hangs, and the released drain must
/// still deliver the tracked events.
#[test]
fn the_startup_flush_never_blocks_the_first_frame() {
    tokio::runtime::Runtime::new()
        .expect("runtime")
        .block_on(startup_flush_never_blocks_the_first_frame());
}

async fn startup_flush_never_blocks_the_first_frame() {
    let sink = std::sync::Arc::new(GatedSink::default());
    let mut config = pa_telemetry::TelemetryClientConfig::new("install-1");
    config.batch_size = 20;
    config.flush_interval = std::time::Duration::from_mins(10);
    config.sinks = vec![sink.clone() as std::sync::Arc<dyn pa_telemetry::TelemetrySink>];
    let client = pa_telemetry::TelemetryClient::spawn(config).expect("startup client");

    // The composition root's startup tracks: the event and the ui_ready
    // stage on the one-shot client.
    let mut properties = pa_telemetry::base_properties("interactive");
    properties.set("duration_ms", serde_json::Value::from(1));
    client.track("startup", properties);
    pa_telemetry::AgentStartupStage {
        stage: "ui_ready",
        outcome: "completed",
        duration_ms: Some(1),
        startup_kind: Some("cold"),
        timing_scope: Some("system_work"),
    }
    .track(&client);

    // The paint path's contract, run as its own task so a regression
    // back to a blocking flush reds the timeout instead of wedging the
    // suite (an inner assert failure reds through the join error).
    let hand_off = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        tokio::spawn(async move {
            // The hand-off: while the sink still hangs, it must already
            // be done — the first frame paints with delivery pending.
            let flush = flush_startup_telemetry(client);
            // The batch must have entered the sink before the boundary
            // is meaningful: a release that beats the send's entry
            // drains without ever hanging, and the hand-off below would
            // pass vacuously. The entry deadline sits under the outer
            // hand-off bound, so a sink that never starts reports
            // here, not as a blocked paint path.
            let entered = tokio::time::timeout(
                std::time::Duration::from_millis(500),
                sink.wait_until_entered(),
            )
            .await;
            assert!(
                entered.is_ok(),
                "the tracked startup batch entered the gated sink"
            );
            assert!(
                sink.delivered_names().is_empty(),
                "delivery was still pending when the paint path proceeded"
            );

            // The released drain still delivers the tracked startup
            // events: completion is awaited on the sink's own notify,
            // the timeout only bounds failure — no polling loop.
            sink.release();
            let delivered = tokio::time::timeout(
                std::time::Duration::from_secs(1),
                sink.wait_until_delivered(),
            )
            .await;
            assert!(
                delivered.is_ok(),
                "the released drain delivered the tracked startup events"
            );
            let names = sink.delivered_names();
            assert!(
                names.contains(&"startup".to_string()),
                "the startup event delivered: {names:?}"
            );
            assert!(
                names.contains(&"agent startup stage".to_string()),
                "the ui_ready stage delivered: {names:?}"
            );

            // The quick-exit seam: the composition root joins this
            // handle under the shared exit bound when a run ends inside
            // the delivery window — the join settles with the drain, so
            // the events never die with the runtime teardown.
            let joined = tokio::time::timeout(std::time::Duration::from_millis(500), flush).await;
            assert!(
                matches!(joined, Ok(Ok(()))),
                "the exit join settled once the drain delivered"
            );
        }),
    )
    .await;
    match hand_off {
        Ok(Ok(())) => {}
        Ok(Err(joined)) => panic!("the first-paint contract task panicked: {joined}"),
        Err(elapsed) => panic!(
            "the flush hand-off completed while the sink still hung (the paint path never waits out delivery): {elapsed}"
        ),
    }
}
