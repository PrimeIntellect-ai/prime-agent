//! Git context parity tests: fixture git repos drive `capture_git_context`
//! (TS `captureGitContext`, utils/git.ts) and the session git-state lifecycle
//! (TS `SessionManager.recordGitStateIfChanged`, session-manager.ts).

use std::path::Path;

use pa_core::session::manager::{capture_git_context, SessionManager};
use pa_types::session::{AgentMessage, FileEntry};

fn git(cwd: &Path, args: &[&str]) -> String {
    let output = std::process::Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .expect("git is available in the test environment");
    assert!(
        output.status.success(),
        "git {:?} failed: {}",
        args,
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

fn init_repo(dir: &Path) {
    git(dir, &["init", "-q", "-b", "main"]);
    git(dir, &["config", "user.email", "t@t.co"]);
    git(dir, &["config", "user.name", "t"]);
}

fn commit(dir: &Path, message: &str) -> String {
    std::fs::write(dir.join("file.txt"), format!("{message}\n")).unwrap();
    git(dir, &["add", "-A"]);
    git(dir, &["commit", "-q", "-m", message]);
    git(dir, &["rev-parse", "HEAD"])
}

fn user(text: &str) -> AgentMessage {
    AgentMessage::User(pa_types::ai::UserMessage {
        content: pa_types::ai::UserContent::Text(text.to_string()),
        timestamp: 0,
        rest: serde_json::Map::default(),
    })
}

#[test]
fn reads_branch_commit_and_normalized_repo_url() {
    let repo = tempfile::tempdir().unwrap();
    init_repo(repo.path());
    git(
        repo.path(),
        &[
            "remote",
            "add",
            "origin",
            "https://github.com/acme/widgets.git",
        ],
    );
    let sha = commit(repo.path(), "init");

    assert_eq!(
        capture_git_context(repo.path()),
        Some(pa_types::session::GitContext {
            repo_url: Some("https://github.com/acme/widgets.git".to_string()),
            commit: Some(sha),
            branch: Some("main".to_string()),
        })
    );
}

#[test]
fn detached_head_reports_commit_without_branch() {
    let repo = tempfile::tempdir().unwrap();
    init_repo(repo.path());
    let sha = commit(repo.path(), "init");
    git(repo.path(), &["checkout", "-q", &sha]);

    let context = capture_git_context(repo.path()).unwrap();
    assert_eq!(context.commit.as_deref(), Some(sha.as_str()));
    assert_eq!(context.branch, None);
}

#[test]
fn omits_repo_url_without_origin() {
    let repo = tempfile::tempdir().unwrap();
    init_repo(repo.path());
    let sha = commit(repo.path(), "init");

    let context = capture_git_context(repo.path()).unwrap();
    assert_eq!(context.repo_url, None);
    assert_eq!(context.commit.as_deref(), Some(sha.as_str()));
}

#[test]
fn keeps_ssh_remote_url_verbatim_when_unnormalizable() {
    let repo = tempfile::tempdir().unwrap();
    init_repo(repo.path());
    git(
        repo.path(),
        &["remote", "add", "origin", "git@github.com:acme/widgets.git"],
    );
    commit(repo.path(), "init");

    let context = capture_git_context(repo.path()).unwrap();
    assert_eq!(
        context.repo_url.as_deref(),
        Some("git@github.com:acme/widgets.git")
    );
}

#[test]
fn returns_none_outside_a_git_repo() {
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(capture_git_context(dir.path()), None);
}

#[test]
fn fresh_repo_without_commits_still_reports_branch() {
    let repo = tempfile::tempdir().unwrap();
    init_repo(repo.path());
    // No commit yet: `rev-parse HEAD` fails, but the branch exists.
    let context = capture_git_context(repo.path()).unwrap();
    assert_eq!(context.branch.as_deref(), Some("main"));
    assert_eq!(context.commit, None);
}

#[test]
fn dirty_tree_does_not_change_capture() {
    let repo = tempfile::tempdir().unwrap();
    init_repo(repo.path());
    git(
        repo.path(),
        &[
            "remote",
            "add",
            "origin",
            "https://github.com/acme/widgets.git",
        ],
    );
    let sha = commit(repo.path(), "init");
    // Leave the tree dirty: capture ignores worktree state.
    std::fs::write(repo.path().join("file.txt"), "dirty\n").unwrap();

    assert_eq!(
        capture_git_context(repo.path()),
        Some(pa_types::session::GitContext {
            repo_url: Some("https://github.com/acme/widgets.git".to_string()),
            commit: Some(sha),
            branch: Some("main".to_string()),
        })
    );
}

/// Byte-parity pin: a session header captured by the installed TS binary
/// (0.9.5) in a fixture repo parses into the same Rust git context, wire
/// shape included. The line below is the verbatim first line of
/// `~/.prime/sessions/<id>.jsonl` produced by
/// `prime-agent -p --session-dir ... "say hi"` in that repo (the turn itself
/// failed on billing; the header is written before any model call).
#[test]
fn ts_binary_session_header_round_trips() {
    let ts_header = concat!(
        r#"{"type":"session","version":3,"id":"01a0b89b-3ac8-7020-bcc9-22d06e1c05f6","#,
        r#""timestamp":"2026-09-19T07:39:36.008Z","cwd":"/tmp/ts-par-repo","rlmDepth":0,"#,
        r#""git":{"repoUrl":"https://github.com/acme/widgets.git","#,
        r#""commit":"5a0875f3b33b639d2d7a57ee51ca19d44fa7ce70","branch":"main"}}"#
    );
    let entries = pa_core::session::parse_session_entries(&format!("{ts_header}\n"));
    let [FileEntry::Header { header }] = &entries[..] else {
        panic!("expected exactly one session header, got {entries:?}");
    };
    assert_eq!(
        header.git,
        Some(pa_types::session::GitContext {
            repo_url: Some("https://github.com/acme/widgets.git".to_string()),
            commit: Some("5a0875f3b33b639d2d7a57ee51ca19d44fa7ce70".to_string()),
            branch: Some("main".to_string()),
        })
    );
    // The Rust side re-serializes to the same camelCase wire shape.
    let round_trip = serde_json::to_value(&header.git).unwrap();
    assert_eq!(
        round_trip,
        serde_json::json!({
            "repoUrl": "https://github.com/acme/widgets.git",
            "commit": "5a0875f3b33b639d2d7a57ee51ca19d44fa7ce70",
            "branch": "main"
        })
    );
}

// ---------------------------------------------------------------------------
// Session git-state lifecycle (TS session-manager-git-state.test.ts)
// ---------------------------------------------------------------------------

#[test]
fn session_header_captures_git_context() {
    let repo = tempfile::tempdir().unwrap();
    let sessions = tempfile::tempdir().unwrap();
    init_repo(repo.path());
    git(
        repo.path(),
        &[
            "remote",
            "add",
            "origin",
            "https://github.com/acme/widgets.git",
        ],
    );
    let sha = commit(repo.path(), "init");

    let manager = SessionManager::persisted(repo.path(), sessions.path());
    assert_eq!(
        manager.get_header().and_then(|header| header.git.clone()),
        Some(pa_types::session::GitContext {
            repo_url: Some("https://github.com/acme/widgets.git".to_string()),
            commit: Some(sha),
            branch: Some("main".to_string()),
        })
    );
}

#[test]
fn no_git_state_entry_when_nothing_changed() {
    let repo = tempfile::tempdir().unwrap();
    let sessions = tempfile::tempdir().unwrap();
    init_repo(repo.path());
    commit(repo.path(), "init");

    let mut manager = SessionManager::persisted(repo.path(), sessions.path());
    assert_eq!(manager.record_git_state_if_changed(), None);
    assert!(!manager
        .get_entries()
        .iter()
        .any(|entry| matches!(entry, FileEntry::GitState { .. })));
}

#[test]
fn records_git_state_when_commit_changes() {
    let repo = tempfile::tempdir().unwrap();
    let sessions = tempfile::tempdir().unwrap();
    init_repo(repo.path());
    commit(repo.path(), "init");

    // The header captures the first commit; the run lands on the second.
    let mut manager = SessionManager::persisted(repo.path(), sessions.path());
    let second_sha = commit(repo.path(), "second");
    assert!(manager.record_git_state_if_changed().is_some());
    let entries = manager.get_entries();
    let git_states: Vec<_> = entries
        .iter()
        .filter(|entry| matches!(entry, FileEntry::GitState { .. }))
        .collect();
    assert_eq!(git_states.len(), 1);
    match &git_states[0] {
        FileEntry::GitState { payload, .. } => {
            assert_eq!(payload.git.commit.as_deref(), Some(second_sha.as_str()));
        }
        other => panic!("expected git_state, got {other:?}"),
    }
    // Unchanged context dedupes away.
    assert_eq!(manager.record_git_state_if_changed(), None);
}

#[test]
fn re_records_git_state_on_branch_without_it_on_active_path() {
    let repo = tempfile::tempdir().unwrap();
    let sessions = tempfile::tempdir().unwrap();
    init_repo(repo.path());
    commit(repo.path(), "init");

    let mut manager = SessionManager::persisted(repo.path(), sessions.path());
    let msg_id = manager.append_message(user("hi")).unwrap();
    commit(repo.path(), "second");
    assert!(manager.record_git_state_if_changed().is_some());

    // Move the leaf before the git_state entry: the nearest git context on
    // this path is the header again, so a new entry must be appended rather
    // than deduped against the sibling's.
    manager.branch(&msg_id);
    assert!(manager.record_git_state_if_changed().is_some());
}

#[test]
fn git_state_entries_stay_out_of_llm_context() {
    let repo = tempfile::tempdir().unwrap();
    let sessions = tempfile::tempdir().unwrap();
    init_repo(repo.path());
    commit(repo.path(), "init");

    let mut manager = SessionManager::persisted(repo.path(), sessions.path());
    commit(repo.path(), "second");
    manager.record_git_state_if_changed();
    let context = pa_core::session::build_session_context(
        &manager.get_entries(),
        manager.get_leaf_id().map(str::to_string).as_deref(),
    );
    assert!(context.messages.is_empty());
}
