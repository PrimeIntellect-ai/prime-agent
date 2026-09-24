//! Integration tests for npm and git package flows against local fixtures:
//! a bash "npm" shim (no network) and a bare git repo cloned over the
//! filesystem. These exercise the real child-process sequences the CLI runs.

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::packages::source::{GitSource, SourceScope, UserOrProject};
use crate::packages::PackageManager;
use crate::settings::SettingsManager;

/// Minimal npm replacement: bash script with the fixture paths embedded, so
/// parallel tests never share state. Logs every call to `<root>/npm.log`.
fn write_npm_shim(dir: &Path) -> PathBuf {
    let global_root = dir.join("global-root").display().to_string();
    let fixtures = dir.join("fixtures").display().to_string();
    let log = dir.join("npm.log").display().to_string();
    std::fs::create_dir_all(&global_root).unwrap();
    std::fs::create_dir_all(Path::new(&fixtures).join("fake-pkg")).unwrap();

    std::fs::write(
        Path::new(&fixtures).join("fake-pkg").join("package.json"),
        r#"{"name":"fake-pkg","version":"1.0.0"}"#,
    )
    .unwrap();
    std::fs::write(
        Path::new(&fixtures).join("fake-pkg").join("version.txt"),
        "\"1.0.0\"",
    )
    .unwrap();

    let script = format!(
        r#"#!/usr/bin/env bash
echo "npm $*" >> {log}
CMD="$1"; shift
VIEW_NAME="$1"
SPECS=()
PREFIX=""
while [ $# -gt 0 ]; do
  case "$1" in
    -g) ;;
    --prefix) PREFIX="$2"; shift ;;
    *) SPECS+=("$1") ;;
  esac
  shift
done
case "$CMD" in
  root) echo "{global_root}" ;;
  install)
    if [ -n "$PREFIX" ]; then ROOT="$PREFIX/node_modules"; else ROOT="{global_root}"; fi
    for SPEC in "${{SPECS[@]}}"; do
      NAME="${{SPEC%%@*}}"
      mkdir -p "$ROOT/$NAME"
      cp -r "{fixtures}/$NAME/." "$ROOT/$NAME/"
    done ;;
  uninstall)
    if [ -n "$PREFIX" ]; then ROOT="$PREFIX/node_modules"; else ROOT="{global_root}"; fi
    for NAME in "${{SPECS[@]}}"; do rm -rf "$ROOT/$NAME"; done ;;
  view) cat "{fixtures}/$VIEW_NAME/version.txt" ;;
  *) echo "unsupported $CMD" >&2; exit 1 ;;
esac
"#
    );
    let shim = dir.join("npm-shim.sh");
    std::fs::write(&shim, script).unwrap();
    #[cfg(unix)]
    std::fs::set_permissions(&shim, std::fs::Permissions::from_mode(0o755)).unwrap();
    shim
}

/// A bare repo with one commit on `main`, plus a work clone for follow-up
/// commits.
fn make_bare_repo(dir: &Path) -> (PathBuf, PathBuf) {
    let bare = dir.join("bare").join("fixtures").join("repo.git");
    let work = dir.join("work");
    std::fs::create_dir_all(&bare).unwrap();
    std::fs::create_dir_all(&work).unwrap();

    let bare_str = bare.display().to_string();
    run_git(&work, &["init", "-q", "--bare", &bare_str]);
    run_git(&work, &["init", "-q"]);
    run_git(&work, &["config", "user.email", "test@example.com"]);
    run_git(&work, &["config", "user.name", "test"]);
    std::fs::write(work.join("package.json"), r#"{"name":"repo"}"#).unwrap();
    run_git(&work, &["add", "."]);
    run_git(&work, &["commit", "-qm", "init"]);
    run_git(&work, &["branch", "-M", "main"]);
    run_git(&work, &["remote", "add", "origin", &bare_str]);
    run_git(&work, &["push", "-q", "origin", "main"]);
    run_git(&bare, &["symbolic-ref", "HEAD", "refs/heads/main"]);
    (bare, work)
}

fn run_git(cwd: &Path, args: &[&str]) {
    let status = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .status()
        .expect("git is required for package tests");
    assert!(status.success(), "git {args:?} failed");
}

struct Sandbox {
    _dir: tempfile::TempDir,
    root: PathBuf,
    cwd: PathBuf,
    agent_dir: PathBuf,
    npm_shim: PathBuf,
}

impl Sandbox {
    fn new(_prefix: &str) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().join("cwd");
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(&cwd).unwrap();
        std::fs::create_dir_all(&agent_dir).unwrap();
        let root = dir.path().to_path_buf();
        let npm_shim = write_npm_shim(&root);
        // Configure the settings file with the shim as the npm command.
        std::fs::write(
            agent_dir.join("settings.json"),
            serde_json::to_string_pretty(&serde_json::json!({
                "npmCommand": [npm_shim.display().to_string()]
            }))
            .unwrap(),
        )
        .unwrap();
        Self {
            _dir: dir,
            root: root,
            cwd,
            agent_dir,
            npm_shim,
        }
    }

    fn manager(&self) -> PackageManager {
        let settings = SettingsManager::create(&self.cwd, &self.agent_dir);
        PackageManager::new(&self.cwd, &self.agent_dir, settings)
    }

    fn log(&self) -> String {
        std::fs::read_to_string(self.npm_shim.with_file_name("npm.log")).unwrap_or_default()
    }
}

#[test]
fn npm_install_list_remove_flow() {
    let _guard = super::test_support::ENV_MUTEX.lock().unwrap();
    let sandbox = Sandbox::new("npm-flow");
    let mut manager = sandbox.manager();

    manager
        .install_and_persist("npm:fake-pkg", UserOrProject::User)
        .unwrap();
    let configured = manager.list_configured_packages();
    assert_eq!(configured.len(), 1);
    assert_eq!(configured[0].source, "npm:fake-pkg");
    let installed = configured[0]
        .installed_path
        .as_ref()
        .expect("shim installs into its global root");
    assert!(installed.join("package.json").exists());

    // Duplicate install is a settings no-op.
    assert!(!manager.add_source_to_settings("npm:fake-pkg@2.0.0", UserOrProject::User));
    assert_eq!(manager.list_configured_packages().len(), 1);

    assert!(manager
        .remove_and_persist("npm:fake-pkg", UserOrProject::User)
        .unwrap());
    assert!(manager.list_configured_packages().is_empty());
    let log = sandbox.log();
    assert!(log.contains("npm install -g fake-pkg\n"), "{log}");
    assert!(log.contains("npm uninstall -g fake-pkg\n"), "{log}");
}

#[test]
fn npm_update_skips_matching_versions() {
    let _guard = super::test_support::ENV_MUTEX.lock().unwrap();
    let sandbox = Sandbox::new("npm-update-match");
    let mut manager = sandbox.manager();
    manager
        .install_and_persist("npm:fake-pkg", UserOrProject::User)
        .unwrap();
    let log_before = sandbox.log();
    manager.update(None).unwrap();
    // Version matches (1.0.0 == 1.0.0): view ran, reinstall did not.
    let log = sandbox.log();
    assert!(log.len() > log_before.len());
    assert!(log.contains("npm view fake-pkg version --json\n"), "{log}");
    assert!(!log.contains("npm install -g fake-pkg@latest"), "{log}");
}

#[test]
fn npm_update_reinstalls_moved_versions() {
    let _guard = super::test_support::ENV_MUTEX.lock().unwrap();
    let sandbox = Sandbox::new("npm-update-moved");
    let mut manager = sandbox.manager();
    manager
        .install_and_persist("npm:fake-pkg", UserOrProject::User)
        .unwrap();
    // Bump the latest version the shim reports.
    let version_file = sandbox
        .npm_shim
        .with_file_name("fixtures")
        .join("fake-pkg")
        .join("version.txt");
    std::fs::write(&version_file, "\"2.0.0\"").unwrap();
    manager.update(Some("npm:fake-pkg")).unwrap();
    assert!(
        sandbox.log().contains("npm install -g fake-pkg@latest\n"),
        "{}",
        sandbox.log()
    );
}

#[test]
fn update_unknown_source_is_an_error_with_suggestion() {
    let _guard = super::test_support::ENV_MUTEX.lock().unwrap();
    let sandbox = Sandbox::new("npm-update-unknown");
    let mut manager = sandbox.manager();
    manager
        .install_and_persist("npm:fake-pkg", UserOrProject::User)
        .unwrap();
    let error = manager.update(Some("fake-pkg")).unwrap_err();
    assert_eq!(
        error.to_string(),
        "No matching package found for fake-pkg. Did you mean npm:fake-pkg?"
    );
}

#[test]
fn git_clone_update_remove_flow() {
    let _guard = super::test_support::ENV_MUTEX.lock().unwrap();
    let sandbox = Sandbox::new("git-flow");
    let (bare, work) = make_bare_repo(&sandbox.root);

    let source = GitSource {
        repo: bare.display().to_string(),
        host: "localhost".to_string(),
        path: "fixtures/repo".to_string(),
        r#ref: None,
        pinned: false,
    };
    super::git::install_git(
        &source,
        SourceScope::User,
        &sandbox.cwd,
        &sandbox.agent_dir,
        None,
    )
    .unwrap();

    let installed = sandbox
        .agent_dir
        .join("git")
        .join("localhost")
        .join("fixtures")
        .join("repo");
    assert!(installed.join("package.json").exists());
    assert!(sandbox.agent_dir.join("git").join(".gitignore").exists());

    // Move main in the work clone, then update: fetch + reset land the change.
    std::fs::write(work.join("skills.md"), "v2 content").unwrap();
    run_git(&work, &["add", "."]);
    run_git(&work, &["commit", "-qm", "v2"]);
    run_git(&work, &["push", "-q", "origin", "main"]);
    super::git::update_git(
        &source,
        SourceScope::User,
        &sandbox.cwd,
        &sandbox.agent_dir,
        None,
    )
    .unwrap();
    assert!(installed.join("skills.md").exists());

    // A second update with no upstream movement is a no-op.
    super::git::update_git(
        &source,
        SourceScope::User,
        &sandbox.cwd,
        &sandbox.agent_dir,
        None,
    )
    .unwrap();

    // Remove prunes the checkout and the now-empty parents, keeping .gitignore.
    super::git::remove_git(&source, SourceScope::User, &sandbox.cwd, &sandbox.agent_dir).unwrap();
    assert!(!installed.exists());
    assert!(!installed.parent().unwrap().exists());
    assert!(sandbox.agent_dir.join("git").join(".gitignore").exists());
}

#[test]
fn git_ref_checkout_installs_the_pinned_revision() {
    let _guard = super::test_support::ENV_MUTEX.lock().unwrap();
    let sandbox = Sandbox::new("git-ref");
    let dir_root = sandbox.root.clone();
    let (bare, work) = make_bare_repo(&dir_root);
    // Tag the initial commit, then move main.
    run_git(&work, &["tag", "v1"]);
    std::fs::write(work.join("skills.md"), "moved").unwrap();
    run_git(&work, &["add", "."]);
    run_git(&work, &["commit", "-qm", "moved"]);
    run_git(&work, &["push", "-q", "origin", "main"]);
    run_git(&work, &["push", "-q", "origin", "v1"]);

    let source = GitSource {
        repo: bare.display().to_string(),
        host: "localhost".to_string(),
        path: "fixtures/repo".to_string(),
        r#ref: Some("v1".to_string()),
        pinned: true,
    };
    super::git::install_git(
        &source,
        SourceScope::User,
        &sandbox.cwd,
        &sandbox.agent_dir,
        None,
    )
    .unwrap();
    let installed = sandbox
        .agent_dir
        .join("git")
        .join("localhost")
        .join("fixtures")
        .join("repo");
    assert!(installed.join("package.json").exists());
    assert!(!installed.join("skills.md").exists(), "pinned ref checkout");
}
