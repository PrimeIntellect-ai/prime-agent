//! Package-manager e2e verifier: a fixture root (local package, npm shim,
//! bare git repo with an ssh shim) plus a scripted corpus of `package`
//! invocations run against BOTH the installed TypeScript `prime-agent`
//! binary (parity ground truth) and the Rust binary. Exit codes, stdout, and
//! stderr must match after normalizing sandbox paths, version numbers, and
//! commit hashes; the Rust sandbox state is additionally asserted directly
//! (settings documents, install directories).
//!
//! No network is used: npm installs run against a bash shim wired through
//! the `npmCommand` setting, and git sources clone through an ssh shim that
//! maps `ssh://localhost/...` onto the local bare repo (the product only
//! accepts https/ssh/git protocol URLs for git sources).
#![cfg(unix)]

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;

const NPM_SHIM: &str = r#"#!/usr/bin/env bash
echo "npm $*" >> {LOG}
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
  root) echo "{GLOBAL_ROOT}" ;;
  install)
    if [ -n "$PREFIX" ]; then ROOT="$PREFIX/node_modules"; else ROOT="{GLOBAL_ROOT}"; fi
    for SPEC in "${SPECS[@]}"; do
      NAME="${SPEC%%@*}"
      if [ ! -d "{FIXTURES}/$NAME" ]; then echo "missing fixture package: $NAME" >&2; exit 1; fi
      mkdir -p "$ROOT/$NAME"
      cp -r "{FIXTURES}/$NAME/." "$ROOT/$NAME/"
    done ;;
  uninstall)
    if [ -n "$PREFIX" ]; then ROOT="$PREFIX/node_modules"; else ROOT="{GLOBAL_ROOT}"; fi
    for NAME in "${SPECS[@]}"; do rm -rf "$ROOT/$NAME"; done ;;
  view) cat "{FIXTURES}/$VIEW_NAME/version.txt" ;;
  *) echo "unsupported $CMD" >&2; exit 1 ;;
esac
"#;

const SSH_SHIM: &str = r#"#!/usr/bin/env bash
# git invokes: <ssh> [opts] localhost "git-upload-pack '<path>'"
REQ="${@: -1}"
REQ="${REQ//\'/}"
CMD="${REQ%% *}"
PATHARG="${REQ#* }"
CMD="${CMD#git-}"
exec git "$CMD" "{GITBASE}$PATHARG"
"#;

/// One scripted step of the e2e corpus.
enum Step {
    /// Run the binary with these args.
    Run(&'static [&'static str]),
    /// Mutate the fixture state between runs (same mutation for both binaries).
    Setup(&'static str),
}

fn steps() -> Vec<Step> {
    [
        Step::Run(&["package", "list"]),
        Step::Run(&["package", "install", "./local-pkg"]),
        Step::Run(&["package", "list"]),
        Step::Run(&["package", "install", "./local-pkg"]),
        Step::Run(&["package", "remove", "./local-pkg"]),
        Step::Run(&["package", "remove", "./local-pkg"]),
        Step::Run(&["package", "install", "/no/such/dir"]),
        Step::Run(&["package", "install", "npm:fake-pkg"]),
        Step::Run(&["package", "list"]),
        Step::Run(&["package", "update"]),
        Step::Run(&["package", "update", "npm:fake-pkg"]),
        Step::Run(&["package", "update", "fake-pkg"]),
        Step::Run(&["package", "remove", "npm:fake-pkg"]),
        Step::Run(&["package", "install", "npm:fake-pkg", "--local"]),
        Step::Run(&["package", "list"]),
        // Move the reported npm version, then reinstall through update.
        Step::Setup("bump-npm-version"),
        Step::Run(&["package", "update"]),
        Step::Run(&["package", "remove", "npm:fake-pkg", "--local"]),
        Step::Run(&[
            "package",
            "install",
            "git:ssh://localhost/fixtures/repo.git",
        ]),
        Step::Run(&["package", "list"]),
        Step::Run(&["package", "update"]),
        // Move git main, then update: fetch + reset output must match too.
        Step::Setup("move-git-main"),
        Step::Run(&["package", "update"]),
        Step::Run(&["package", "remove", "git:ssh://localhost/fixtures/repo.git"]),
        Step::Run(&["package", "install", "./local-pkg", "--local"]),
        Step::Run(&["package", "list"]),
    ]
    .into_iter()
    .collect()
}

struct Fixtures {
    root: PathBuf,
    #[allow(dead_code)]
    gitbase: PathBuf,
    work: PathBuf,
    /// Hash of the initial `main` commit; each binary run starts from here.
    initial_main: String,
}

fn write_executable(path: &Path, content: &str) {
    std::fs::write(path, content).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

fn run_git(cwd: &Path, args: &[&str]) {
    let status = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .status()
        .expect("git is required for the package e2e test");
    assert!(status.success(), "git {args:?} failed");
}

/// Build the shared fixture root: local package, npm shim + fixture package,
/// bare git repo with a work clone, ssh shim.
fn make_fixtures() -> Fixtures {
    let root = tempfile::tempdir_in(std::env::temp_dir()).unwrap();
    let root_path = root.path().to_path_buf();

    // Local package in the sandbox cwd (created per-run, see below).
    let npm_dir = root_path.join("npm");
    std::fs::create_dir_all(npm_dir.join("fake-pkg")).unwrap();
    std::fs::write(
        npm_dir.join("fake-pkg").join("package.json"),
        r#"{"name":"fake-pkg","version":"1.0.0"}"#,
    )
    .unwrap();
    std::fs::write(npm_dir.join("fake-pkg").join("version.txt"), "\"1.0.0\"").unwrap();

    // Bare git repo + work clone with one commit on main.
    let gitbase = root_path.join("gitbase");
    let work = root_path.join("work");
    std::fs::create_dir_all(gitbase.join("fixtures")).unwrap();
    std::fs::create_dir_all(&work).unwrap();
    run_git(
        &work,
        &[
            "init",
            "-q",
            "--bare",
            &gitbase
                .join("fixtures")
                .join("repo.git")
                .display()
                .to_string(),
        ],
    );
    run_git(&work, &["init", "-q"]);
    run_git(&work, &["config", "user.email", "e2e@example.com"]);
    run_git(&work, &["config", "user.name", "e2e"]);
    std::fs::write(work.join("package.json"), r#"{"name":"repo-pkg"}"#).unwrap();
    std::fs::create_dir_all(work.join("skills")).unwrap();
    std::fs::write(work.join("skills").join("g.md"), "# git skill\n").unwrap();
    run_git(&work, &["add", "."]);
    run_git(&work, &["commit", "-qm", "init"]);
    run_git(&work, &["branch", "-M", "main"]);
    run_git(
        &work,
        &[
            "remote",
            "add",
            "origin",
            &gitbase
                .join("fixtures")
                .join("repo.git")
                .display()
                .to_string(),
        ],
    );
    run_git(&work, &["push", "-q", "origin", "main"]);
    run_git(
        &gitbase.join("fixtures").join("repo.git"),
        &["symbolic-ref", "HEAD", "refs/heads/main"],
    );

    // Shims (paths embedded; stateful dirs are per-sandbox).
    let npm_shim = root_path.join("npm.sh");
    write_executable(
        &npm_shim,
        &NPM_SHIM
            .replace("{LOG}", &root_path.join("npm.log").display().to_string())
            .replace("{GLOBAL_ROOT}", "{SANDBOX_GLOBAL_ROOT}")
            .replace("{FIXTURES}", &npm_dir.display().to_string()),
    );
    let ssh_shim = root_path.join("ssh.sh");
    write_executable(
        &ssh_shim,
        &SSH_SHIM.replace("{GITBASE}", &gitbase.display().to_string()),
    );

    let initial_main = {
        let out = Command::new("git")
            .args(["rev-parse", "HEAD"])
            .current_dir(&work)
            .output()
            .expect("git rev-parse");
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    };

    std::mem::forget(root); // keep the fixture root for the whole test
    Fixtures {
        root: root_path,
        gitbase,
        work,
        initial_main,
    }
}

/// Per-binary sandbox: HOME, cwd with a local package, agent dir pre-seeded
/// with the npm shim as the configured npm command.
struct Sandbox {
    home: PathBuf,
    cwd: PathBuf,
    agent_dir: PathBuf,
    ssh_shim: PathBuf,
}

impl Sandbox {
    fn new(base: &Path, fixtures: &Fixtures) -> Self {
        let home = base.join("home");
        let cwd = base.join("cwd");
        let agent_dir = base.join("agent");
        let global_root = base.join("global-root");
        for dir in [&home, &cwd, &agent_dir, &global_root] {
            std::fs::create_dir_all(dir).unwrap();
        }
        // Local fixture package in the sandbox cwd.
        std::fs::create_dir_all(cwd.join("local-pkg").join("skills")).unwrap();
        std::fs::write(
            cwd.join("local-pkg").join("package.json"),
            r#"{"name":"local-pkg","version":"1.0.0"}"#,
        )
        .unwrap();
        std::fs::write(cwd.join("local-pkg").join("skills").join("hi.md"), "# hi\n").unwrap();

        // The npm shim needs the sandbox global root; derive a per-sandbox copy.
        let npm_shim = base.join("npm.sh");
        let template = std::fs::read_to_string(fixtures.root.join("npm.sh")).unwrap();
        write_executable(
            &npm_shim,
            &template.replace("{SANDBOX_GLOBAL_ROOT}", &global_root.display().to_string()),
        );
        std::fs::write(
            agent_dir.join("settings.json"),
            serde_json::to_string_pretty(&serde_json::json!({
                "npmCommand": [npm_shim.display().to_string()]
            }))
            .unwrap(),
        )
        .unwrap();
        Self {
            home,
            cwd,
            agent_dir,
            ssh_shim: fixtures.root.join("ssh.sh"),
        }
    }
}

struct Output {
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
}

fn run(binary: &Path, args: &[&str], sandbox: &Sandbox) -> Output {
    let output = Command::new("timeout")
        .arg("60")
        .arg(binary)
        .args(args)
        .env("HOME", &sandbox.home)
        .env("PRIME_AGENT_CODING_AGENT_DIR", &sandbox.agent_dir)
        .env("GIT_SSH_COMMAND", &sandbox.ssh_shim)
        .current_dir(&sandbox.cwd)
        .output()
        .expect("failed to spawn binary under test");
    Output {
        exit_code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    }
}

/// Replace sandbox paths, fixture paths, dotted version numbers, and git
/// commit hashes so the two binaries' transcripts compare equal.
fn normalize(text: &str, sandbox: &Path) -> String {
    let text = text
        .replace(&sandbox.display().to_string(), "<SANDBOX>")
        .replace(&sandbox.join("home").display().to_string(), "<SANDBOX>")
        .replace(&sandbox.join("cwd").display().to_string(), "<SANDBOX>")
        .replace(&sandbox.join("agent").display().to_string(), "<SANDBOX>")
        .replace(
            &sandbox.join("global-root").display().to_string(),
            "<SANDBOX>",
        );
    let text = normalize_versions(&text);
    normalize_hashes(&text)
}

fn normalize_versions(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() {
            let start = i;
            while i < bytes.len() && (bytes[i].is_ascii_digit() || bytes[i] == b'.') {
                i += 1;
            }
            let token = text[start..].chars().take(i - start).collect::<String>();
            let trailing = token.ends_with('.');
            let version_candidate = token.trim_end_matches('.');
            let parts: Vec<&str> = version_candidate.split('.').collect();
            if parts.len() >= 2
                && parts
                    .iter()
                    .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()))
            {
                out.push_str("X.X.X");
                if trailing {
                    out.push('.');
                }
            } else {
                // Non-version digit runs (hash fragments, numbers) are kept
                // verbatim: trimming here would corrupt adjacent separators
                // such as the `..` between git fetch commit ranges.
                out.push_str(&token);
            }
        } else {
            let ch = text[i..].chars().next().unwrap();
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    out
}

/// Git abbreviates commits to 7 hex chars in fetch/reset output; both runs
/// commit at different times, so hashes are normalized to a placeholder.
fn normalize_hashes(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_hexdigit() {
            let start = i;
            while i < bytes.len() && bytes[i].is_ascii_hexdigit() {
                i += 1;
            }
            let token = &text[start..i];
            if token.len() >= 7 && token.len() <= 40 {
                out.push_str("<HASH>");
            } else {
                out.push_str(token);
            }
        } else {
            let ch = text[i..].chars().next().unwrap();
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    out
}

/// Git fetch ranges (`<old>..<new>`) must survive version normalization
/// regardless of where digits appear in the commit hashes; `normalize_hashes`
/// then reduces both sides to `<HASH>..<HASH>`. Regression: the old
/// normalizer trimmed a `..` to `.` whenever the old hash ended in a digit
/// and the new one started with a letter, which made the two drives'
/// transcripts differ for ~29% of runs (the `move` commits are new every
/// run, so the fetch line normalized asymmetrically).
#[test]
fn normalize_keeps_git_fetch_ranges_for_all_hash_shapes() {
    let fetch_ranges = [
        // Old hash ends in a digit, new hash starts with a letter.
        "bbcac419e0abdc1240759f79111401e5e752bdc6..b3eb69bbb53ea3eaa2dd4ee957b572c2b598b346",
        // Old hash ends in a digit, new hash starts with a digit.
        "bbcac419e0abdc1240759f79111401e5e752bdc6..5ded43e37d19d1150f0c51cd6077b810ab876a24",
        // Old hash ends in a letter.
        "239ee46d9d33bb4ffebacbbca200b05116a1b0eb..ba60bc927f0cfc1fa2f10d7edd33c6f10d7c582b",
    ];
    for range in fetch_ranges {
        assert_eq!(
            normalize_hashes(&normalize_versions(range)),
            "<HASH>..<HASH>",
            "range: {range}"
        );
    }
    // Real dotted versions still collapse to the placeholder.
    assert_eq!(normalize_versions("version 1.0.0\n"), "version X.X.X\n");
    assert_eq!(normalize_versions("9.9.9"), "X.X.X");
}

fn ts_binary() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("PA_TS_BINARY") {
        return Some(PathBuf::from(path));
    }
    let found = Command::new("which")
        .arg("prime-agent")
        .output()
        .ok()
        .filter(|out| out.status.success())?;
    let path = String::from_utf8_lossy(&found.stdout).trim().to_string();
    (!path.is_empty()).then(|| PathBuf::from(path))
}

/// Run the whole scripted corpus against one binary, returning the combined
/// transcript.
fn drive(binary: &Path, base: &Path, fixtures: &Fixtures) -> (String, Sandbox) {
    // Reset the shared fixtures to their per-run initial state so both
    // binaries drive identical state transitions.
    std::fs::write(
        fixtures
            .root
            .join("npm")
            .join("fake-pkg")
            .join("version.txt"),
        "\"1.0.0\"",
    )
    .unwrap();
    run_git(
        &fixtures.work,
        &[
            "push",
            "-q",
            "--force",
            "origin",
            &format!("{}:refs/heads/main", fixtures.initial_main),
        ],
    );

    let sandbox = Sandbox::new(base, fixtures);
    let mut transcript = String::new();
    for step in steps() {
        match step {
            Step::Run(args) => {
                let output = run(binary, args, &sandbox);
                let cwd = sandbox.cwd.clone();
                let base_path = cwd.parent().unwrap().to_path_buf();
                transcript.push_str(&format!(
                    ">>> {} (exit {:?})\nSTDOUT:\n{}STDERR:\n{}",
                    args.join(" "),
                    output.exit_code,
                    normalize(&output.stdout, &base_path),
                    normalize(&output.stderr, &base_path)
                ));
            }
            Step::Setup("bump-npm-version") => {
                let version_file = fixtures
                    .root
                    .join("npm")
                    .join("fake-pkg")
                    .join("version.txt");
                std::fs::write(&version_file, "\"9.9.9\"").unwrap();
                // The installed copy still reports 1.0.0 for the next view.
            }
            Step::Setup("move-git-main") => {
                let gitwork = fixtures.work.clone();
                let content = std::fs::read_to_string(gitwork.join("skills").join("g.md")).unwrap();
                std::fs::write(
                    gitwork.join("skills").join("g.md"),
                    format!("{content}more\n"),
                )
                .unwrap();
                run_git(&gitwork, &["add", "."]);
                run_git(&gitwork, &["commit", "-qm", "move"]);
                run_git(&gitwork, &["push", "-q", "origin", "main"]);
            }
            Step::Setup(other) => unreachable!("unknown setup step {other}"),
        }
    }
    (transcript, sandbox)
}

#[test]
fn package_manager_corpus_matches_ts_binary() {
    let Some(ts) = ts_binary() else {
        eprintln!("SKIPPED: TS prime-agent binary not installed");
        return;
    };
    let rust_bin = PathBuf::from(env!("CARGO_BIN_EXE_prime-agent"));
    let fixtures = make_fixtures();

    let base = std::env::temp_dir().join(format!("pa-package-e2e-{}", std::process::id()));
    let ts_base = base.join("ts");
    let rust_base = base.join("rust");
    std::fs::create_dir_all(&ts_base).unwrap();
    std::fs::create_dir_all(&rust_base).unwrap();

    let (ts_transcript, _ts_sandbox) = drive(&ts, &ts_base, &fixtures);
    let (rust_transcript, rust_sandbox) = drive(&rust_bin, &rust_base, &fixtures);

    assert_eq!(
        ts_transcript, rust_transcript,
        "TS transcript:\n{ts_transcript}\nRust transcript:\n{rust_transcript}"
    );

    // Rust sandbox state assertions (the verifier half): the local package
    // is the only configured entry, bound at its project-scope path, and the
    // git/npm installs left the expected directories behind.
    let project_settings: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(
            rust_sandbox
                .cwd
                .join(".prime")
                .join("agent")
                .join("settings.json"),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        project_settings["packages"],
        serde_json::json!(["../../local-pkg"])
    );
    let global_settings: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(rust_sandbox.agent_dir.join("settings.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(global_settings["packages"], serde_json::json!([]));

    let list_output = run(&rust_bin, &["package", "list"], &rust_sandbox);
    assert_eq!(
        list_output.stdout,
        format!(
            "Project packages:\n  ../../local-pkg\n    {}\n",
            rust_sandbox.cwd.join("local-pkg").display()
        )
    );

    // Project npm prefix survives the earlier npm --local round trip.
    let npm_root = rust_sandbox.cwd.join(".prime").join("agent").join("npm");
    assert!(npm_root.join("package.json").exists());
    assert!(npm_root.join(".gitignore").exists());
    // Git installs are fully pruned, leaving only the gitignore guard file.
    let git_root = rust_sandbox.agent_dir.join("git");
    assert!(git_root.join(".gitignore").exists());
    assert_eq!(
        std::fs::read_dir(&git_root)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .count(),
        1
    );

    std::fs::remove_dir_all(&base).ok();
}
