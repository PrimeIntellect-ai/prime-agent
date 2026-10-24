use super::*;
use serde_json::json;
use std::path::PathBuf;

struct Fixture {
    _temp: tempfile::TempDir,
    cwd: PathBuf,
    agent: PathBuf,
    source: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let cwd = temp.path().join("project");
        let agent = temp.path().join("agent");
        std::fs::create_dir_all(cwd.join(".prime/agent")).unwrap();
        std::fs::create_dir(cwd.join(".git")).unwrap();
        std::fs::create_dir(&agent).unwrap();
        let source = cwd.join(".prime/agent/hooks.json");
        Self {
            _temp: temp,
            cwd,
            agent,
            source,
        }
    }

    fn approve(&self, sources: &[&Path]) {
        let trusted: Vec<_> = sources
            .iter()
            .map(|source| {
                fingerprint(
                    &source.canonicalize().unwrap(),
                    &self.cwd.canonicalize().unwrap(),
                    &std::fs::read(source).unwrap(),
                )
            })
            .collect();
        std::fs::write(
            self.agent.join("hook-trust.json"),
            serde_json::to_vec(&json!({"version":1,"trusted":trusted})).unwrap(),
        )
        .unwrap();
    }
}

fn configuration() -> Vec<u8> {
    serde_json::to_vec(&json!({"hooks":{"PreToolUse":[{"matcher":"^bash$","hooks":[{"type":"command","command":"exit 2","timeout":3}]}]}})).unwrap()
}

#[test]
fn exact_approval_enables_hooks_and_changes_revoke_it() {
    let fixture = Fixture::new();
    let bytes = configuration();
    std::fs::write(&fixture.source, &bytes).unwrap();
    assert!(load(&fixture.cwd, &fixture.agent).unwrap().hooks.is_empty());
    fixture.approve(&[&fixture.source]);
    let hooks = load(&fixture.cwd, &fixture.agent).unwrap().hooks;
    assert_eq!(hooks.len(), 1);
    assert_eq!(hooks[0].command, "exit 2");
    assert!(hooks[0].matches(Event::PreToolUse, "bash"));
    assert!(!hooks[0].matches(Event::PreToolUse, "edit"));
    assert!(!hooks[0].matches(Event::PostToolUse, "bash"));
    let subdir = fixture.cwd.join("subdir");
    std::fs::create_dir(&subdir).unwrap();
    assert!(load(&subdir, &fixture.agent).unwrap().hooks.is_empty());
    let mut changed = bytes;
    changed.push(b' ');
    std::fs::write(&fixture.source, changed).unwrap();
    assert!(load(&fixture.cwd, &fixture.agent).unwrap().hooks.is_empty());
}

#[test]
fn project_local_trust_cannot_authorize_hooks() {
    let fixture = Fixture::new();
    std::fs::write(&fixture.source, configuration()).unwrap();
    let error = load(&fixture.cwd, &fixture.cwd.join(".prime"))
        .err()
        .unwrap();
    let message = format!("{error:#}");
    assert!(
        message.starts_with(&format!(
            "the agent directory {} is inside the project root",
            fixture.cwd.canonicalize().unwrap().join(".prime").display()
        )),
        "{message}"
    );
}

#[test]
fn untrusted_source_reports_its_path_and_fingerprint() {
    let fixture = Fixture::new();
    std::fs::write(&fixture.source, configuration()).unwrap();
    let loaded = load(&fixture.cwd, &fixture.agent).unwrap();
    let cwd = fixture.cwd.canonicalize().unwrap();
    let digest = fingerprint(
        &fixture.source.canonicalize().unwrap(),
        &cwd,
        &configuration(),
    );
    assert!(loaded.hooks.is_empty());
    let [diagnostic] = loaded.diagnostics.as_slice() else {
        panic!("one diagnostic: {:?}", loaded.diagnostics);
    };
    // The notice names the source, the trust file, and the exact fingerprint.
    assert!(diagnostic.starts_with(&format!(
        "Hooks skipped: {} is not trusted",
        cwd.join(".prime/agent/hooks.json").display()
    )));
    assert!(diagnostic.contains(
        &fixture
            .agent
            .canonicalize()
            .unwrap()
            .join("hook-trust.json")
            .display()
            .to_string()
    ));
    assert!(diagnostic.ends_with(&format!("\n{digest}")));
}

#[test]
fn trusted_invalid_source_reports_why_it_was_skipped() {
    let fixture = Fixture::new();
    std::fs::write(&fixture.source, b"{").unwrap();
    fixture.approve(&[&fixture.source]);
    let loaded = load(&fixture.cwd, &fixture.agent).unwrap();
    assert!(loaded.hooks.is_empty());
    let [diagnostic] = loaded.diagnostics.as_slice() else {
        panic!("one diagnostic: {:?}", loaded.diagnostics);
    };
    assert!(diagnostic.starts_with(&format!(
        "Hooks skipped: {}: invalid hook configuration",
        fixture
            .cwd
            .canonicalize()
            .unwrap()
            .join(".prime/agent/hooks.json")
            .display()
    )));
}

/// Codex documents share this format: a Codex-only event, handler type,
/// execution mode or field skips only that part, never the source's other
/// policies, and the skipped parts are reported.
#[test]
fn unsupported_parts_are_skipped_with_a_notice_and_the_rest_loads() {
    let fixture = Fixture::new();
    let bytes = serde_json::to_vec(&json!({"hooks":{
        "PermissionRequest":[{"hooks":[{"type":"command","command":"true"}]}],
        "PreToolUse":[{"matcher":"^bash$","hooks":[
            {"type":"command","command":"exit 2","statusMessage":"Checking","timeout":3},
            {"type":"prompt","prompt":"judge this"},
            {"type":"command","command":"true","additionalContextLimit":10}
        ]}],
        "PostToolUse":[{"hooks":[{"type":"command","command":"sync observer"}]}]
    }}))
    .unwrap();
    std::fs::write(&fixture.source, &bytes).unwrap();
    fixture.approve(&[&fixture.source]);
    let loaded = load(&fixture.cwd, &fixture.agent).unwrap();
    assert_eq!(
        loaded
            .hooks
            .iter()
            .map(|hook| (hook.event, hook.command.as_str()))
            .collect::<Vec<_>>(),
        [(Event::PreToolUse, "exit 2"), (Event::PreToolUse, "true")]
    );
    let [diagnostic] = loaded.diagnostics.as_slice() else {
        panic!("one diagnostic: {:?}", loaded.diagnostics);
    };
    for part in [
        "PreToolUse handler field(s) additionalContextLimit",
        "PermissionRequest hooks (unsupported event)",
        "PreToolUse handler (type prompt is unsupported",
        "PostToolUse handler (PostToolUse requires async:true)",
    ] {
        assert!(diagnostic.contains(part), "{part}: {diagnostic}");
    }
    assert!(!diagnostic.contains("statusMessage"), "{diagnostic}");
}

#[test]
fn skips_unsupported_handlers_and_rejects_malformed_configuration() {
    for value in [
        json!({"hooks":{"UnsupportedEvent":[]}}),
        json!({"hooks":{"PostToolUse":[{"hooks":[{"type":"command","command":"true"}]}]}}),
        json!({"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"true","async":true}]}]}}),
        json!({"hooks":{"PreToolUse":[{"hooks":[{"type":"prompt","command":"true"}]}]}}),
        json!({"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"true","timeout":601}]}]}}),
        json!({"hooks":{"PreToolUse":[{"matcher":"[","hooks":[{"type":"command","command":"true"}]}]}}),
    ] {
        let parsed = parse(&serde_json::to_vec(&value).unwrap(), &mut 0).unwrap();
        assert!(parsed.hooks.is_empty(), "{value}");
        assert_eq!(parsed.notices.len(), 1, "{value}");
    }
    assert!(parse(b"{", &mut 0).is_err());
    assert!(parse(br#"{"hooks":{"PreToolUse":{}}}"#, &mut 0).is_err());
}

#[test]
fn trusted_invalid_source_preserves_other_trusted_policies() {
    let fixture = Fixture::new();
    let user_source = fixture.agent.join("hooks.json");
    std::fs::write(&user_source, configuration()).unwrap();
    std::fs::write(&fixture.source, b"{").unwrap();
    fixture.approve(&[&user_source, &fixture.source]);
    let hooks = load(&fixture.cwd, &fixture.agent).unwrap().hooks;
    assert_eq!(hooks.len(), 1);
    assert_eq!(hooks[0].command, "exit 2");
}

#[test]
fn preserves_handler_order_and_accepts_background_observers() {
    let bytes = serde_json::to_vec(&json!({"hooks":{"PostToolUse":[{"hooks":[
        {"type":"command","command":"first","async":true},
        {"type":"command","command":"second","async":true}
    ]}]}}))
    .unwrap();
    let hooks = parse(&bytes, &mut 0).unwrap().hooks;
    assert_eq!(
        hooks
            .iter()
            .map(|hook| hook.command.as_str())
            .collect::<Vec<_>>(),
        ["first", "second"]
    );
    assert!(hooks
        .iter()
        .all(|hook| hook.matches(Event::PostToolUse, "bash")));
}

#[test]
fn caps_groups_even_when_they_have_no_handlers() {
    let groups = vec![json!({"hooks":[]}); 33];
    let bytes = serde_json::to_vec(&json!({"hooks":{"PreToolUse":groups}})).unwrap();
    assert!(parse(&bytes, &mut 0).is_err());
    let fixture = Fixture::new();
    let mut groups = vec![json!({"hooks":[]}); 17];
    groups[0] = json!({"hooks":[{"type":"command","command":"exit 2"}]});
    let bytes = serde_json::to_vec(&json!({"hooks":{"PreToolUse":groups}})).unwrap();
    let user_source = fixture.agent.join("hooks.json");
    std::fs::write(&fixture.source, &bytes).unwrap();
    std::fs::write(&user_source, &bytes).unwrap();
    fixture.approve(&[&fixture.source, &user_source]);
    let hooks = load(&fixture.cwd, &fixture.agent).unwrap().hooks;
    assert_eq!(hooks.len(), 1);
    assert_eq!(hooks[0].command, "exit 2");
}

#[test]
fn caps_handlers_and_file_bytes() {
    let handlers = vec![json!({"type":"command","command":"true"}); 33];
    let bytes = serde_json::to_vec(&json!({"hooks":{"PreToolUse":[{"hooks":handlers}]}})).unwrap();
    assert!(parse(&bytes, &mut 0).is_err());
    let fixture = Fixture::new();
    std::fs::write(
        &fixture.source,
        vec![b' '; usize::try_from(FILE_LIMIT + 1).unwrap()],
    )
    .unwrap();
    assert!(read_bounded(&fixture.source, SourceKind::Configuration).is_err());
}

#[cfg(unix)]
#[test]
fn rejects_symlink_sources_and_symlink_trust() {
    use std::os::unix::fs::symlink;
    let fixture = Fixture::new();
    let actual = fixture.cwd.join("actual.json");
    std::fs::write(&actual, configuration()).unwrap();
    symlink(&actual, &fixture.source).unwrap();
    assert!(load(&fixture.cwd, &fixture.agent).unwrap().hooks.is_empty());
    std::fs::remove_file(&fixture.source).unwrap();
    std::fs::write(&fixture.source, configuration()).unwrap();
    fixture.approve(&[&fixture.source]);
    let trust = fixture.agent.join("hook-trust.json");
    let renamed = fixture.agent.join("trust-target.json");
    std::fs::rename(&trust, &renamed).unwrap();
    symlink(renamed, trust).unwrap();
    assert!(load(&fixture.cwd, &fixture.agent).is_err());
}

#[cfg(unix)]
#[test]
fn rejects_writable_trust_file_and_directory() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::new();
    std::fs::write(&fixture.source, configuration()).unwrap();
    fixture.approve(&[&fixture.source]);
    let trust = fixture.agent.join("hook-trust.json");
    std::fs::set_permissions(&trust, std::fs::Permissions::from_mode(0o666)).unwrap();
    assert!(load(&fixture.cwd, &fixture.agent).is_err());
    std::fs::set_permissions(&trust, std::fs::Permissions::from_mode(0o600)).unwrap();
    std::fs::set_permissions(&fixture.agent, std::fs::Permissions::from_mode(0o777)).unwrap();
    assert!(load(&fixture.cwd, &fixture.agent).is_err());
}

#[cfg(unix)]
#[test]
fn fifo_is_rejected_without_waiting_for_a_writer() {
    let fixture = Fixture::new();
    nix::unistd::mkfifo(&fixture.source, nix::sys::stat::Mode::S_IRUSR).unwrap();
    let path = fixture.source.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || {
        tx.send(read_bounded(&path, SourceKind::Configuration).is_err())
            .unwrap();
    });
    let outcome = rx.recv_timeout(Duration::from_secs(2));
    if outcome.is_err() {
        // Release a regressed blocking open so the test never leaks a thread.
        use std::os::unix::fs::OpenOptionsExt;
        let _ = std::fs::OpenOptions::new()
            .write(true)
            .custom_flags(libc::O_NONBLOCK)
            .open(&fixture.source);
    }
    worker.join().unwrap();
    assert!(outcome.unwrap());
}

#[cfg(unix)]
#[test]
fn malicious_project_sources_cannot_disable_trusted_user_denials() {
    let fixture = Fixture::new();
    let user_source = fixture.agent.join("hooks.json");
    std::fs::write(&user_source, configuration()).unwrap();
    fixture.approve(&[&user_source]);
    for source_kind in ["fifo", "symlink", "oversized"] {
        match source_kind {
            "fifo" => nix::unistd::mkfifo(&fixture.source, nix::sys::stat::Mode::S_IRUSR).unwrap(),
            "symlink" => std::os::unix::fs::symlink(&user_source, &fixture.source).unwrap(),
            "oversized" => std::fs::write(
                &fixture.source,
                vec![b' '; usize::try_from(FILE_LIMIT + 1).unwrap()],
            )
            .unwrap(),
            _ => unreachable!(),
        }
        let hooks = load(&fixture.cwd, &fixture.agent).unwrap().hooks;
        assert_eq!(hooks.len(), 1, "source kind: {source_kind}");
        assert_eq!(hooks[0].command, "exit 2");
        std::fs::remove_file(&fixture.source).unwrap();
    }
}

#[test]
fn combined_handler_limit_retains_the_accepted_user_source() {
    let fixture = Fixture::new();
    let user_source = fixture.agent.join("hooks.json");
    let handlers = vec![json!({"type":"command","command":"exit 2"}); 17];
    let bytes = serde_json::to_vec(&json!({"hooks":{"PreToolUse":[{"hooks":handlers}]}})).unwrap();
    std::fs::write(&user_source, &bytes).unwrap();
    std::fs::write(&fixture.source, &bytes).unwrap();
    fixture.approve(&[&user_source, &fixture.source]);
    let hooks = load(&fixture.cwd, &fixture.agent).unwrap().hooks;
    assert_eq!(hooks.len(), 17);
    assert!(hooks.iter().all(|hook| hook.command == "exit 2"));
}

#[test]
fn lifecycle_configuration_preserves_matchers_and_end_deadlines() {
    let bytes = serde_json::to_vec(&json!({"hooks":{
        "SessionStart":[{"matcher":"^resume$","hooks":[{"type":"command","command":"true"}]}],
        "UserPromptSubmit":[{"matcher":"[","hooks":[{"type":"command","command":"true"}]}],
        "Stop":[{"matcher":"never","hooks":[{"type":"command","command":"true"}]}],
        "PreCompact":[{"matcher":"^auto$","hooks":[{"type":"command","command":"true"}]}],
        "SessionEnd":[{"matcher":"other","hooks":[{"type":"command","command":"true","async":true}]}]
    }})).unwrap();
    let hooks = parse(&bytes, &mut 0).unwrap().hooks;
    assert!(hooks
        .iter()
        .any(|hook| hook.matches(Event::SessionStart, "resume")));
    assert!(!hooks
        .iter()
        .any(|hook| hook.matches(Event::SessionStart, "startup")));
    assert!(hooks
        .iter()
        .any(|hook| hook.matches(Event::UserPromptSubmit, "anything")));
    assert!(hooks
        .iter()
        .any(|hook| hook.matches(Event::Stop, "anything")));
    assert!(hooks
        .iter()
        .any(|hook| hook.matches(Event::PreCompact, "auto")));
    assert!(!hooks
        .iter()
        .any(|hook| hook.matches(Event::PreCompact, "manual")));
    assert_eq!(
        hooks
            .iter()
            .find(|hook| hook.event == Event::SessionEnd)
            .unwrap()
            .timeout,
        Duration::from_secs(1)
    );
    for event in ["SessionStart", "UserPromptSubmit", "PreCompact", "Stop"] {
        let config =
            json!({"hooks":{event:[{"hooks":[{"type":"command","command":"true","async":true}]}]}});
        let parsed = parse(&serde_json::to_vec(&config).unwrap(), &mut 0).unwrap();
        assert!(parsed.hooks.is_empty() && parsed.notices.len() == 1);
    }
    let too_long = json!({"hooks":{"SessionEnd":[{"hooks":[{"type":"command","command":"true","timeout":4}]}]}});
    let parsed = parse(&serde_json::to_vec(&too_long).unwrap(), &mut 0).unwrap();
    assert!(parsed.hooks.is_empty() && parsed.notices.len() == 1);
}
