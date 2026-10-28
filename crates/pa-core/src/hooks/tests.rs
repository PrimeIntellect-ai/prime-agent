use super::*;
use serde_json::json;

fn input(event: &str) -> Value {
    json!({"session_id":"test", "transcript_path":null,"cwd":"/tmp", "hook_event_name":event,
        "model":"test", "permission_mode":"default", "turn_id":"turn", "tool_name":"Bash",
        "tool_use_id":"call", "tool_input":{"command":"echo normal"}})
}

#[cfg(unix)]
fn fixture(config: &Value) -> (tempfile::TempDir, HookRuntime) {
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().join("project");
    let agent = dir.path().join("agent");
    std::fs::create_dir_all(&cwd).unwrap();
    std::fs::create_dir_all(&agent).unwrap();
    let source = agent.join("hooks.json");
    std::fs::write(&source, serde_json::to_vec(config).unwrap()).unwrap();
    // The user source needs no trust entry.
    let runtime = HookRuntime::new(cwd, agent);
    (dir, runtime)
}

#[tokio::test]
async fn discovery_is_lazy_and_missing_configuration_is_cached() {
    let dir = tempfile::tempdir().unwrap();
    let runtime = HookRuntime::new(dir.path().into(), dir.path().join("not-created"));
    assert!(runtime.state.config.get().is_none());
    assert_eq!(
        runtime
            .evaluate(input("PreToolUse"), AbortSignal::default())
            .await,
        None
    );
    assert!(runtime.state.config.get().unwrap().is_empty());
    runtime.observe(&input("PostToolUse"));
    assert!(runtime.observers.lock().unwrap().is_empty());
}

#[test]
fn serialized_input_is_bounded_without_allocating_the_whole_encoding() {
    let value = json!({"prompt":"x".repeat(INPUT_LIMIT)});
    assert!(bounded_input(&value).is_err());
    assert_eq!(bounded_input(&json!({"x":1})).unwrap(), br#"{"x":1}"#);
}

#[cfg(unix)]
#[tokio::test]
async fn all_vetoes_run_and_first_configured_reason_wins() {
    let (_dir, runtime) = fixture(&json!({"hooks":{"PreToolUse":[{"hooks":[
        {"type":"command","command":"cat >/dev/null; while [ ! -e second-ran ]; do sleep 0.01; done; printf first >&2; exit 2"},
        {"type":"command","command":"cat >/dev/null; printf ran > second-ran; printf second >&2; exit 2"}
    ]}]}}));
    let count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let seen = count.clone();
    runtime.set_on_execute(Arc::new(move || {
        seen.fetch_add(1, Ordering::Relaxed);
    }));
    assert_eq!(
        runtime
            .evaluate(input("PreToolUse"), AbortSignal::default())
            .await,
        Some("first".into())
    );
    assert_eq!(
        runtime
            .evaluate(input("PreToolUse"), AbortSignal::default())
            .await,
        Some("first".into())
    );
    assert_eq!(
        std::fs::read(runtime.state.cwd.join("second-ran")).unwrap(),
        b"ran"
    );
    assert_eq!(
        count.load(Ordering::Relaxed),
        1,
        "adoption callback fires once per session"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn malformed_policy_output_cannot_partly_deny() {
    let (_dir, runtime) = fixture(&json!({"hooks":{"PreToolUse":[{"hooks":[
        {"type":"command","command":"printf '%s' '{\"decision\":\"block\",\"continue\":false}'"}
    ]}]}}));
    assert_eq!(
        runtime
            .evaluate(input("PreToolUse"), AbortSignal::default())
            .await,
        None
    );
}

#[cfg(unix)]
#[tokio::test]
async fn observer_queue_is_bounded_and_never_awaits_delivery() {
    let (_dir, runtime) = fixture(&json!({"hooks":{"PostToolUse":[{"hooks":[
        {"type":"command","command":"cat >/dev/null; sleep 20","async":true,"timeout":1}
    ]}]}}));
    // No await between submissions: observers cannot run before the queue is inspected.
    for _ in 0..20 {
        runtime.observe(&input("PostToolUse"));
    }
    assert_eq!(runtime.observers.lock().unwrap().len(), 8);
    let tasks: Vec<_> = runtime
        .observers
        .lock()
        .unwrap()
        .iter()
        .map(tokio::task::JoinHandle::abort_handle)
        .collect();
    drop(runtime);
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while tasks.iter().any(|task| !task.is_finished()) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn long_observers_never_delay_a_synchronous_denial() {
    let observers: Vec<_> = (0..4)
        .map(|index| {
            json!({
                "type":"command", "async":true, "timeout":10,
                "command":format!("cat >/dev/null; touch ready-{index}; sleep 30")
            })
        })
        .collect();
    let (_dir, runtime) = fixture(&json!({"hooks":{
        "PreToolUse":[{"hooks":[{"type":"command","command":"printf deny >&2; exit 2","timeout":2}]}],
        "PostToolUse":[{"hooks":observers}]
    }}));
    runtime.observe(&input("PostToolUse"));
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        let mut readiness = tokio::time::interval(std::time::Duration::from_millis(10));
        loop {
            readiness.tick().await;
            let count = (0..4)
                .filter(|index| runtime.state.cwd.join(format!("ready-{index}")).exists())
                .count();
            if count == 4 {
                break;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(
        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            runtime.evaluate(input("PreToolUse"), AbortSignal::default())
        )
        .await
        .unwrap(),
        Some("deny".into())
    );
}

#[cfg(unix)]
#[tokio::test]
async fn execution_uses_the_canonical_directory_bound_to_trust() {
    let (dir, original) = fixture(&json!({"hooks":{"PreToolUse":[{"hooks":[
        {"type":"command","command":"pwd >&2; exit 2"}
    ]}]}}));
    let link = dir.path().join("cwd-link");
    std::os::unix::fs::symlink(&original.state.cwd, &link).unwrap();
    let runtime = HookRuntime::new(link.clone(), original.state.agent_dir.clone());
    let expected = Some(
        original
            .state
            .cwd
            .canonicalize()
            .unwrap()
            .display()
            .to_string(),
    );
    assert_eq!(
        runtime
            .evaluate(input("PreToolUse"), AbortSignal::default())
            .await,
        expected
    );
    let replacement = dir.path().join("replacement");
    std::fs::create_dir(&replacement).unwrap();
    std::fs::remove_file(&link).unwrap();
    std::os::unix::fs::symlink(&replacement, &link).unwrap();
    assert_eq!(
        runtime
            .evaluate(input("PreToolUse"), AbortSignal::default())
            .await,
        expected
    );
}

#[cfg(unix)]
#[tokio::test]
async fn lifecycle_dispatch_combines_stop_reasons_in_source_order() {
    let (_dir, runtime) = fixture(&json!({"hooks":{"Stop":[{"matcher":"ignored","hooks":[
        {"type":"command","command":"printf first >&2; exit 2"},
        {"type":"command","command":"printf second >&2; exit 2"}
    ]}]}}));
    assert_eq!(
        runtime
            .dispatch(input("Stop"), AbortSignal::default())
            .await,
        HookOutcome {
            continuation: Some("first\nsecond".into()),
            ..Default::default()
        }
    );
    let (_dir, runtime) = fixture(&json!({"hooks":{"Stop":[{"hooks":[
        {"type":"command","command":"printf retry >&2; exit 2"},
        {"type":"command","command":"printf '%s' '{\"continue\":false,\"stopReason\":\"halt\"}'"}
    ]}]}}));
    assert_eq!(
        runtime
            .dispatch(input("Stop"), AbortSignal::default())
            .await,
        HookOutcome {
            stop: Some("halt".into()),
            ..Default::default()
        }
    );
}

#[test]
fn combined_feedback_is_bounded_on_utf8_boundaries() {
    let mut value = Some("x".repeat(65534));
    append_bounded(&mut value, "éé");
    assert_eq!(value.unwrap(), format!("{}\n", "x".repeat(65534)));
}

#[cfg(unix)]
#[tokio::test]
async fn session_end_is_joined_once_and_canceled_waiters_do_not_restart_it() {
    let (_dir, runtime) = fixture(&json!({"hooks":{"SessionEnd":[{"hooks":[
        {"type":"command","command":"printf x >> count; touch started; while [ ! -f release ]; do sleep 0.01; done; touch finished","timeout":3,"async":true}
    ]}]}}));
    let runtime = Arc::new(runtime);
    let first_runtime = runtime.clone();
    let first = tokio::spawn(async move {
        first_runtime.finish(Some(input("SessionEnd"))).await;
    });
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while !runtime.state.cwd.join("started").exists() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    first.abort();
    let second_runtime = runtime.clone();
    let second = tokio::spawn(async move {
        second_runtime.finish(Some(input("SessionEnd"))).await;
    });
    tokio::task::yield_now().await;
    assert!(!second.is_finished());
    assert!(!runtime.might_run("PreToolUse"));
    std::fs::write(runtime.state.cwd.join("release"), b"").unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(2), second)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        std::fs::read(runtime.state.cwd.join("count")).unwrap(),
        b"x"
    );
    assert!(runtime.state.cwd.join("finished").exists());
    runtime.finish(Some(input("SessionEnd"))).await;
    assert_eq!(
        std::fs::read(runtime.state.cwd.join("count")).unwrap(),
        b"x"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn session_end_total_deadline_covers_multiple_command_waves() {
    let handlers = vec![json!({"type":"command","command":"sleep 20","timeout":3}); 8];
    let (_dir, runtime) = fixture(&json!({"hooks":{"SessionEnd":[{"hooks":handlers}]}}));
    tokio::time::timeout(
        std::time::Duration::from_secs(4),
        runtime.finish(Some(input("SessionEnd"))),
    )
    .await
    .unwrap();
    assert!(runtime.finished.initialized());
}

#[cfg(unix)]
#[tokio::test]
async fn finish_cancels_and_joins_synchronous_commands_before_end() {
    let (_dir, runtime) = fixture(&json!({"hooks":{
        "PreCompact":[{"hooks":[{"type":"command","command":"printf '%s' $$ > decision-pid; touch decision-ready; sleep 30","timeout":30}]}],
        "SessionEnd":[{"hooks":[{"type":"command","command":"touch ended"}]}]
    }}));
    let runtime = Arc::new(runtime);
    let decision_runtime = runtime.clone();
    let decision = tokio::spawn(async move {
        decision_runtime
            .dispatch(input("PreCompact"), AbortSignal::default())
            .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while !runtime.state.cwd.join("decision-ready").exists() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    runtime.finish(Some(input("SessionEnd"))).await;
    assert_eq!(decision.await.unwrap(), HookOutcome::default());
    assert_eq!(*runtime.state.active.borrow(), 0);
    assert!(runtime.state.cwd.join("ended").exists());
    let pid: u32 = std::fs::read_to_string(runtime.state.cwd.join("decision-pid"))
        .unwrap()
        .parse()
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while crate::platform::process::pid_exists(pid) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        runtime
            .dispatch(input("PreCompact"), AbortSignal::default())
            .await,
        HookOutcome::default()
    );
}

#[cfg(unix)]
fn recorded_notices(runtime: &HookRuntime) -> Arc<Mutex<Vec<String>>> {
    let notices = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&notices);
    runtime.set_on_notice(Arc::new(move |text| {
        sink.lock().unwrap().push(text);
        Box::pin(async {})
    }));
    notices
}

#[cfg(unix)]
#[tokio::test]
async fn failed_hooks_report_their_event_and_command_once() {
    let (_dir, runtime) = fixture(&json!({"hooks":{"PreToolUse":[{"hooks":[
        {"type":"command","command":"cat >/dev/null; echo lint broke >&2;\n  exit 1"},
        {"type":"command","command":"cat >/dev/null; sleep 5","timeout":1},
        {"type":"command","command":"printf '{\"systemMessage\":\"lint is slow\"}'"}
    ]}]}}));
    let notices = recorded_notices(&runtime);
    for _ in 0..2 {
        assert_eq!(
            runtime
                .evaluate(input("PreToolUse"), AbortSignal::default())
                .await,
            None
        );
    }
    let mut notices = notices.lock().unwrap().clone();
    notices.sort();
    assert_eq!(
        notices,
        [
            "PreToolUse hook failed, operation unchanged: command exited with status 1: lint broke\ncommand: cat >/dev/null; echo lint broke >&2; exit 1",
            "PreToolUse hook failed, operation unchanged: timed out after 1s\ncommand: cat >/dev/null; sleep 5",
            "PreToolUse hook message: lint is slow",
        ]
    );
}

/// A `failClosed` gating handler that cannot decide (timeout, failed command,
/// malformed output) blocks; the same failures without it pass through.
#[cfg(unix)]
#[tokio::test]
async fn fail_closed_handlers_block_when_they_cannot_decide() {
    for (command, timeout, failure) in [
        ("cat >/dev/null; sleep 5", 1, "timed out after 1s"),
        ("cat >/dev/null; exit 1", 5, "command exited with status 1"),
        ("cat >/dev/null; printf '{'", 5, "EOF"),
    ] {
        let (_dir, runtime) = fixture(&json!({"hooks":{"PreToolUse":[{"hooks":[
            {"type":"command","command":command,"timeout":timeout,"failClosed":true}
        ]}]}}));
        let reason = runtime
            .evaluate(input("PreToolUse"), AbortSignal::default())
            .await
            .expect("a fail-closed failure denies");
        assert!(
            reason.starts_with("a required PreToolUse hook could not decide (")
                && reason.contains(failure),
            "{reason}"
        );
    }
    // Observe-only events ignore it.
    let (_dir, runtime) = fixture(&json!({"hooks":{"PostToolUse":[{"hooks":[
        {"type":"command","command":"exit 1","async":true,"failClosed":true}
    ]}]}}));
    assert!(!runtime
        .state
        .config()
        .await
        .iter()
        .any(|hook| hook.fail_closed));
}

#[cfg(unix)]
#[tokio::test]
async fn untrusted_sources_are_reported_once_per_session() {
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().join("project");
    let agent = dir.path().join("agent");
    std::fs::create_dir_all(cwd.join(".prime/agent")).unwrap();
    std::fs::create_dir_all(&agent).unwrap();
    std::fs::write(
        cwd.join(".prime/agent/hooks.json"),
        br#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"true"}]}]}}"#,
    )
    .unwrap();
    let runtime = HookRuntime::new(cwd.clone(), agent.clone());
    let notices = recorded_notices(&runtime);
    for _ in 0..2 {
        runtime
            .dispatch(input("PreToolUse"), AbortSignal::default())
            .await;
    }
    let notices = notices.lock().unwrap().clone();
    assert_eq!(notices.len(), 1, "{notices:?}");
    assert!(
        notices[0].starts_with(&format!(
            "Project hooks skipped: {} is not trusted.",
            cwd.canonicalize()
                .unwrap()
                .join(".prime/agent/hooks.json")
                .display()
        )),
        "{notices:?}"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn unsafe_agent_directory_reports_that_hooks_are_disabled() {
    use std::os::unix::fs::PermissionsExt;
    let (_dir, runtime) = fixture(&json!({"hooks":{"Stop":[{"hooks":[
        {"type":"command","command":"true"}
    ]}]}}));
    let trust = runtime.state.agent_dir.clone();
    std::fs::set_permissions(&trust, std::fs::Permissions::from_mode(0o777)).unwrap();
    let notices = recorded_notices(&runtime);
    runtime
        .dispatch(input("Stop"), AbortSignal::default())
        .await;
    assert_eq!(
        *notices.lock().unwrap(),
        [format!(
            "Hooks disabled for this session: {} must be owned by the current user and not group/world writable. See docs/hooks.md.",
            trust.canonicalize().unwrap().display()
        )]
    );
}

#[test]
fn diagnostics_are_capped_per_session() {
    let runtime = HookRuntime::new(".".into(), ".".into());
    let notices = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&notices);
    runtime.set_on_notice(Arc::new(move |text| {
        sink.lock().unwrap().push(text);
        Box::pin(async {})
    }));
    for index in 0..40 {
        if let Some((sink, text)) = runtime.state.admit_notice(format!("notice {index}")) {
            drop(sink(text));
        }
    }
    let notices = notices.lock().unwrap();
    assert_eq!(notices.len(), NOTICE_LIMIT + 1);
    assert_eq!(
        notices.last().unwrap(),
        "Further hook diagnostics in this session are suppressed."
    );
}
