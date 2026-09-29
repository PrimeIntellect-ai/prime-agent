//! Fixture-repo tests for workspace snapshots: real `git` in tempdirs (the
//! crate's established pattern for worktree-touching tests) plus pure
//! parser, manifest, and verification cases.

use std::path::Path;

use sha2::{Digest, Sha256};

use super::git::{parse_status, StatusEntry};
use super::manifest::{is_safe_relative_path, symlink_target_stays_inside};
use super::{
    create_workspace_snapshot, is_secret_path, verify_workspace_snapshot, CapturedEntry,
    ExcludeReason, ExcludedEntry, SnapshotError, SnapshotLimits, SnapshotManifest,
};

fn git(dir: &Path, args: &[&str]) {
    let output = std::process::Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn init_repo(dir: &Path) {
    git(dir, &["init", "-q"]);
    git(dir, &["config", "user.email", "t@example.com"]);
    git(dir, &["config", "user.name", "t"]);
}

fn write(dir: &Path, rel: &str, content: &str) {
    let path = dir.join(rel);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(path, content).unwrap();
}

fn head_commit(dir: &Path) -> String {
    let output = std::process::Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(dir)
        .output()
        .unwrap();
    assert!(output.status.success());
    String::from_utf8(output.stdout).unwrap().trim().to_string()
}

fn digest(content: &[u8]) -> String {
    format!("{:x}", Sha256::digest(content))
}

fn file_entry(path: &str, status: &str, content: &str) -> CapturedEntry {
    CapturedEntry::File {
        path: path.to_string(),
        status: status.to_string(),
        sha256: digest(content.as_bytes()),
        bytes: content.len() as u64,
        executable: false,
    }
}

fn limits() -> SnapshotLimits {
    SnapshotLimits::default()
}

fn secret(path: &str) -> ExcludedEntry {
    ExcludedEntry {
        path: path.to_string(),
        reason: ExcludeReason::Secret,
    }
}

fn stage(manifest: &SnapshotManifest, blobs: &[(&str, &[u8])]) -> tempfile::TempDir {
    let staging = tempfile::tempdir().unwrap();
    let blobs_dir = staging.path().join("blobs");
    std::fs::create_dir(&blobs_dir).unwrap();
    for (name, content) in blobs {
        std::fs::write(blobs_dir.join(name), content).unwrap();
    }
    std::fs::write(
        staging.path().join("manifest.json"),
        serde_json::to_vec(manifest).unwrap(),
    )
    .unwrap();
    staging
}

fn manifest_of(
    head_commit: Option<String>,
    captured: Vec<CapturedEntry>,
    excluded: Vec<ExcludedEntry>,
) -> SnapshotManifest {
    SnapshotManifest {
        version: 1,
        head_commit,
        captured,
        excluded,
    }
}

fn read_blob(staging: &Path, sha256: &str) -> Vec<u8> {
    std::fs::read(staging.join("blobs").join(sha256)).unwrap()
}

#[tokio::test]
async fn snapshot_captures_worktree_delta() {
    let repo = tempfile::tempdir().unwrap();
    let root = repo.path();
    init_repo(root);
    write(root, "tracked.txt", "base\n");
    write(root, "gone.txt", "gone\n");
    write(root, ".gitignore", "ignored.log\n");
    git(root, &["add", "."]);
    git(root, &["commit", "-q", "-m", "base"]);
    // The working-state delta: unstaged modification, staged addition,
    // staged deletion, two untracked paths, and one ignored path.
    write(root, "tracked.txt", "modified\n");
    write(root, "staged.txt", "staged\n");
    git(root, &["add", "staged.txt"]);
    git(root, &["rm", "-q", "gone.txt"]);
    write(root, "untracked.txt", "fresh\n");
    write(root, "sub/deep.txt", "deep\n");
    write(root, "ignored.log", "never\n");
    let staging = tempfile::tempdir().unwrap();
    let snapshot = create_workspace_snapshot(root, staging.path(), &limits())
        .await
        .unwrap();
    let expected = SnapshotManifest {
        version: 1,
        head_commit: Some(head_commit(root)),
        captured: vec![
            CapturedEntry::Deleted {
                path: "gone.txt".to_string(),
                status: "D.".to_string(),
            },
            file_entry("staged.txt", "A.", "staged\n"),
            file_entry("sub/deep.txt", "??", "deep\n"),
            file_entry("tracked.txt", ".M", "modified\n"),
            file_entry("untracked.txt", "??", "fresh\n"),
        ],
        excluded: vec![],
    };
    assert_eq!(snapshot.manifest, expected);
    assert_eq!(snapshot.staging_dir, staging.path());
    assert_eq!(snapshot.manifest_path, staging.path().join("manifest.json"));
    assert_eq!(
        read_blob(staging.path(), &digest(b"modified\n")),
        b"modified\n"
    );
    assert_eq!(read_blob(staging.path(), &digest(b"staged\n")), b"staged\n");
    // Verification agrees with what was staged, manifest included.
    assert_eq!(verify_workspace_snapshot(staging.path()).unwrap(), expected);
}

#[tokio::test]
async fn snapshot_is_deterministic() {
    let repo = tempfile::tempdir().unwrap();
    let root = repo.path();
    init_repo(root);
    write(root, "a.txt", "one\n");
    git(root, &["add", "."]);
    git(root, &["commit", "-q", "-m", "base"]);
    write(root, "b.txt", "two\n");
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    let snapshot_a = create_workspace_snapshot(root, first.path(), &limits())
        .await
        .unwrap();
    let snapshot_b = create_workspace_snapshot(root, second.path(), &limits())
        .await
        .unwrap();
    assert_eq!(snapshot_a.manifest, snapshot_b.manifest);
    let bytes_a = std::fs::read(&snapshot_a.manifest_path).unwrap();
    let bytes_b = std::fs::read(&snapshot_b.manifest_path).unwrap();
    assert_eq!(bytes_a, bytes_b);
}

#[tokio::test]
async fn snapshot_excludes_secret_named_files() {
    let repo = tempfile::tempdir().unwrap();
    let root = repo.path();
    init_repo(root);
    write(root, ".env", "old-secret\n");
    write(root, "keep.txt", "kept\n");
    git(root, &["add", "."]);
    git(root, &["commit", "-q", "-m", "base"]);
    // A modified tracked secret and several untracked ones.
    write(root, ".env", "new-secret\n");
    write(root, ".env.local", "local\n");
    write(root, "cert.pem", "cert\n");
    write(root, "id_rsa", "key\n");
    write(root, "keys/private.key", "key\n");
    let staging = tempfile::tempdir().unwrap();
    let snapshot = create_workspace_snapshot(root, staging.path(), &limits())
        .await
        .unwrap();
    assert_eq!(
        snapshot.manifest,
        manifest_of(
            Some(head_commit(root)),
            vec![],
            vec![
                secret(".env"),
                secret(".env.local"),
                secret("cert.pem"),
                secret("id_rsa"),
                secret("keys/private.key"),
            ]
        )
    );
    // No secret content staged: the blobs directory stays empty.
    assert!(std::fs::read_dir(staging.path().join("blobs"))
        .unwrap()
        .next()
        .is_none());
    assert!(verify_workspace_snapshot(staging.path()).is_ok());
}

#[cfg(unix)]
#[tokio::test]
async fn snapshot_captures_in_root_symlinks_and_excludes_escaping_ones() {
    let repo = tempfile::tempdir().unwrap();
    let root = repo.path();
    init_repo(root);
    write(root, "tracked.txt", "base\n");
    git(root, &["add", "."]);
    git(root, &["commit", "-q", "-m", "base"]);
    std::os::unix::fs::symlink("tracked.txt", root.join("ok-link")).unwrap();
    std::os::unix::fs::symlink("../escape", root.join("escape-link")).unwrap();
    std::os::unix::fs::symlink("/absolute", root.join("abs-link")).unwrap();
    let staging = tempfile::tempdir().unwrap();
    let snapshot = create_workspace_snapshot(root, staging.path(), &limits())
        .await
        .unwrap();
    assert_eq!(
        snapshot.manifest,
        manifest_of(
            Some(head_commit(root)),
            vec![CapturedEntry::Symlink {
                path: "ok-link".to_string(),
                status: "??".to_string(),
                target: "tracked.txt".to_string(),
            }],
            vec![
                ExcludedEntry {
                    path: "abs-link".to_string(),
                    reason: ExcludeReason::EscapingSymlink,
                },
                ExcludedEntry {
                    path: "escape-link".to_string(),
                    reason: ExcludeReason::EscapingSymlink,
                },
            ]
        )
    );
    assert!(verify_workspace_snapshot(staging.path()).is_ok());
}

#[tokio::test]
async fn snapshot_excludes_nested_repositories() {
    let repo = tempfile::tempdir().unwrap();
    let root = repo.path();
    init_repo(root);
    write(root, "tracked.txt", "base\n");
    git(root, &["add", "."]);
    git(root, &["commit", "-q", "-m", "base"]);
    let nested = root.join("nested");
    std::fs::create_dir(&nested).unwrap();
    init_repo(&nested);
    write(&nested, "inner.txt", "inner\n");
    git(&nested, &["add", "."]);
    git(&nested, &["commit", "-q", "-m", "inner"]);
    write(root, "untracked.txt", "fresh\n");
    let staging = tempfile::tempdir().unwrap();
    let snapshot = create_workspace_snapshot(root, staging.path(), &limits())
        .await
        .unwrap();
    assert_eq!(
        snapshot.manifest,
        manifest_of(
            Some(head_commit(root)),
            vec![file_entry("untracked.txt", "??", "fresh\n")],
            vec![ExcludedEntry {
                path: "nested/".to_string(),
                reason: ExcludeReason::NestedRepository,
            }]
        )
    );
}

#[tokio::test]
async fn snapshot_records_gitlink_absence_and_excludes_present_submodules() {
    let repo = tempfile::tempdir().unwrap();
    let root = repo.path();
    init_repo(root);
    write(root, "tracked.txt", "base\n");
    git(root, &["add", "."]);
    git(root, &["commit", "-q", "-m", "base"]);
    // A gitlink registered without its directory: only the absence is
    // meaningful, so it is recorded as a deletion.
    git(
        root,
        &[
            "update-index",
            "--add",
            "--cacheinfo",
            "160000,5b1c2d3e4f6071829b34a5678901234567890abc,submod",
        ],
    );
    let staging = tempfile::tempdir().unwrap();
    let snapshot = create_workspace_snapshot(root, staging.path(), &limits())
        .await
        .unwrap();
    assert_eq!(
        snapshot.manifest.captured,
        vec![CapturedEntry::Deleted {
            path: "submod".to_string(),
            status: "AD".to_string(),
        }]
    );
    // Once the submodule directory exists its content is never captured.
    std::fs::create_dir(root.join("submod")).unwrap();
    let staging = tempfile::tempdir().unwrap();
    let snapshot = create_workspace_snapshot(root, staging.path(), &limits())
        .await
        .unwrap();
    assert_eq!(
        snapshot.manifest,
        manifest_of(
            Some(head_commit(root)),
            vec![],
            vec![ExcludedEntry {
                path: "submod".to_string(),
                reason: ExcludeReason::Submodule,
            }]
        )
    );
}

#[tokio::test]
async fn snapshot_captures_unmerged_conflict_worktree_content() {
    let repo = tempfile::tempdir().unwrap();
    let root = repo.path();
    init_repo(root);
    write(root, "f.txt", "base\n");
    git(root, &["add", "."]);
    git(root, &["commit", "-q", "-m", "base"]);
    git(root, &["checkout", "-q", "-b", "side"]);
    write(root, "f.txt", "side\n");
    git(root, &["commit", "-q", "-am", "side"]);
    git(root, &["checkout", "-q", "-"]);
    write(root, "f.txt", "main\n");
    git(root, &["commit", "-q", "-am", "main"]);
    let merge = std::process::Command::new("git")
        .args(["merge", "side"])
        .current_dir(root)
        .output()
        .unwrap();
    assert!(!merge.status.success(), "expected a conflict");
    let conflict = std::fs::read_to_string(root.join("f.txt")).unwrap();
    let staging = tempfile::tempdir().unwrap();
    let snapshot = create_workspace_snapshot(root, staging.path(), &limits())
        .await
        .unwrap();
    assert_eq!(
        snapshot.manifest.captured,
        vec![file_entry("f.txt", "UU", &conflict)]
    );
    assert!(verify_workspace_snapshot(staging.path()).is_ok());
}

async fn capture_error(root: &Path, limits: &SnapshotLimits) -> String {
    let staging = tempfile::tempdir().unwrap();
    create_workspace_snapshot(root, staging.path(), limits)
        .await
        .unwrap_err()
        .to_string()
}

#[tokio::test]
async fn snapshot_enforces_limits() {
    let repo = tempfile::tempdir().unwrap();
    let root = repo.path();
    init_repo(root);
    write(root, "tracked.txt", "base\n");
    git(root, &["add", "."]);
    git(root, &["commit", "-q", "-m", "base"]);
    write(root, "big.txt", "0123456789");
    write(root, "small.txt", "01234");
    let error = capture_error(
        root,
        &SnapshotLimits {
            max_entries: 1,
            ..limits()
        },
    )
    .await;
    assert!(error.contains("max_entries"), "{error}");
    let error = capture_error(
        root,
        &SnapshotLimits {
            max_file_bytes: 4,
            ..limits()
        },
    )
    .await;
    assert!(error.contains("big.txt"), "{error}");
    let error = capture_error(
        root,
        &SnapshotLimits {
            max_total_bytes: 12,
            ..limits()
        },
    )
    .await;
    assert!(error.contains("max_total_bytes"), "{error}");
}

#[tokio::test]
async fn snapshot_rejects_unusable_staging_directories() {
    let repo = tempfile::tempdir().unwrap();
    let root = repo.path();
    init_repo(root);
    write(root, "tracked.txt", "base\n");
    git(root, &["add", "."]);
    git(root, &["commit", "-q", "-m", "base"]);
    write(root, "untracked.txt", "fresh\n");
    // A staging directory holding prior content is refused.
    let occupied = tempfile::tempdir().unwrap();
    std::fs::write(occupied.path().join("prior.txt"), "prior\n").unwrap();
    let error = create_workspace_snapshot(root, occupied.path(), &limits())
        .await
        .unwrap_err();
    assert!(
        matches!(error, SnapshotError::StagingDirNotEmpty { .. }),
        "{error}"
    );
    // A staging directory inside the worktree would capture itself.
    let inside = root.join(".staging");
    let error = create_workspace_snapshot(root, &inside, &limits())
        .await
        .unwrap_err();
    assert!(
        matches!(error, SnapshotError::StagingDirInsideWorktree { .. }),
        "{error}"
    );
    // A missing nested staging directory is created.
    let outside = tempfile::tempdir().unwrap();
    let staging = outside.path().join("nested/stage");
    create_workspace_snapshot(root, &staging, &limits())
        .await
        .unwrap();
    assert!(staging.join("manifest.json").is_file());
}

#[tokio::test]
async fn snapshot_requires_a_git_worktree() {
    let plain = tempfile::tempdir().unwrap();
    let staging = tempfile::tempdir().unwrap();
    let error = create_workspace_snapshot(plain.path(), staging.path(), &limits())
        .await
        .unwrap_err();
    assert!(
        matches!(error, SnapshotError::NotAWorktree { .. }),
        "{error}"
    );
    assert!(staging.path().join("manifest.json").read_dir().is_err());
}

#[tokio::test]
async fn snapshot_from_a_subdirectory_captures_the_whole_repository() {
    let repo = tempfile::tempdir().unwrap();
    let root = repo.path();
    init_repo(root);
    write(root, "tracked.txt", "base\n");
    git(root, &["add", "."]);
    git(root, &["commit", "-q", "-m", "base"]);
    write(root, "tracked.txt", "modified\n");
    write(root, "sub/deep.txt", "deep\n");
    let staging = tempfile::tempdir().unwrap();
    let snapshot = create_workspace_snapshot(&root.join("sub"), staging.path(), &limits())
        .await
        .unwrap();
    // Porcelain paths are repository-root-relative from any cwd.
    assert_eq!(
        snapshot.manifest.captured,
        vec![
            file_entry("sub/deep.txt", "??", "deep\n"),
            file_entry("tracked.txt", ".M", "modified\n"),
        ]
    );
}

#[cfg(unix)]
#[tokio::test]
async fn snapshot_records_executable_bits() {
    let repo = tempfile::tempdir().unwrap();
    let root = repo.path();
    init_repo(root);
    write(root, "tracked.txt", "base\n");
    git(root, &["add", "."]);
    git(root, &["commit", "-q", "-m", "base"]);
    write(root, "script.sh", "#!/bin/sh\n");
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(
            root.join("script.sh"),
            std::fs::Permissions::from_mode(0o755),
        )
        .unwrap();
    }
    write(root, "plain.txt", "plain\n");
    let staging = tempfile::tempdir().unwrap();
    let snapshot = create_workspace_snapshot(root, staging.path(), &limits())
        .await
        .unwrap();
    let executable = |path: &str| {
        snapshot
            .manifest
            .captured
            .iter()
            .find_map(|entry| match entry {
                CapturedEntry::File {
                    path: entry_path,
                    executable,
                    ..
                } if entry_path == path => Some(*executable),
                _ => None,
            })
            .unwrap()
    };
    assert!(executable("script.sh"));
    assert!(!executable("plain.txt"));
}

#[test]
fn status_parser_reads_porcelain_v2_records() {
    let output = b"# branch.oid ee3a902349fa5446bf3edd1e1e8d8f7f48013081\0\
# branch.head main\0\
? untracked.txt\0\
! ignored.txt\0\
1 .M N... 100644 100644 100644 h1 h2 tracked.txt\0\
1 A. S... 000000 160000 000000 h1 h2 submod\0\
u UU N... 100644 100644 100644 100644 h1 h2 h3 f.txt\0";
    let status = parse_status(output).unwrap();
    assert_eq!(
        status.head_commit.as_deref(),
        Some("ee3a902349fa5446bf3edd1e1e8d8f7f48013081")
    );
    assert_eq!(
        status.entries,
        vec![
            StatusEntry::Tracked {
                path: "f.txt".to_string(),
                xy: "UU".to_string(),
                gitlink: false,
            },
            StatusEntry::Tracked {
                path: "submod".to_string(),
                xy: "A.".to_string(),
                gitlink: true,
            },
            StatusEntry::Tracked {
                path: "tracked.txt".to_string(),
                xy: ".M".to_string(),
                gitlink: false,
            },
            StatusEntry::Untracked {
                path: "untracked.txt".to_string(),
            },
        ]
    );
    // An unborn branch has no commit to pin.
    let unborn = b"# branch.oid (initial)\0# branch.head main\0";
    assert_eq!(parse_status(unborn).unwrap().head_commit, None);
}

#[test]
fn status_parser_rejects_unknown_records() {
    // Rename records cannot appear under --no-renames; treat them, and
    // anything else unrecognized, as a failure rather than guessing.
    let renamed = b"2 R. N... 100644 100644 100644 h1 h2\0old.txt\0new.txt\0";
    assert!(matches!(
        parse_status(renamed),
        Err(SnapshotError::MalformedStatus { .. })
    ));
    let truncated = b"1 .M N...\0";
    assert!(matches!(
        parse_status(truncated),
        Err(SnapshotError::MalformedStatus { .. })
    ));
}

#[test]
fn path_and_target_safety_rules() {
    assert!(is_safe_relative_path("a/b.txt"));
    assert!(is_safe_relative_path("nested/"));
    for unsafe_path in ["", "/abs", "../up", "./cur", "a/../../b"] {
        assert!(!is_safe_relative_path(unsafe_path));
    }
    assert!(symlink_target_stays_inside("link", "a.txt"));
    assert!(symlink_target_stays_inside("a/b/link", "../c.txt"));
    assert!(!symlink_target_stays_inside("a/link", "../../x"));
    assert!(!symlink_target_stays_inside("link", "/absolute"));
    assert!(!symlink_target_stays_inside("link", "C:/x"));
    assert!(!symlink_target_stays_inside("link", ""));
}

#[test]
fn secret_name_rules() {
    for path in [
        ".env",
        ".env.production",
        ".envrc",
        ".npmrc",
        "cert.pem",
        "id_rsa",
        "ssh/id_ed25519",
        "keys/private.key",
        "bundle.p12",
        "bundle.pfx",
    ] {
        assert!(is_secret_path(path), "{path} should be excluded");
    }
    for path in [
        "environment.rs",
        ".envoys",
        ".gitignore",
        "key.json",
        "id_rsa.pub",
        "README.md",
    ] {
        assert!(!is_secret_path(path), "{path} should be captured");
    }
}

#[test]
fn verification_accepts_a_hand_built_snapshot() {
    let manifest = manifest_of(
        None,
        vec![
            CapturedEntry::Deleted {
                path: "gone.txt".to_string(),
                status: "D.".to_string(),
            },
            CapturedEntry::File {
                path: "hello.txt".to_string(),
                status: "??".to_string(),
                sha256: digest(b"hello\n"),
                bytes: 6,
                executable: false,
            },
            CapturedEntry::Symlink {
                path: "link".to_string(),
                status: "??".to_string(),
                target: "hello.txt".to_string(),
            },
        ],
        vec![secret(".env")],
    );
    let staging = stage(&manifest, &[(&digest(b"hello\n"), b"hello\n")]);
    assert_eq!(verify_workspace_snapshot(staging.path()).unwrap(), manifest);
}

#[test]
fn verification_rejects_tampered_blobs() {
    let manifest = manifest_of(
        None,
        vec![CapturedEntry::File {
            path: "hello.txt".to_string(),
            status: "??".to_string(),
            sha256: digest(b"hello\n"),
            bytes: 6,
            executable: false,
        }],
        vec![],
    );
    let error = |staging: &tempfile::TempDir| {
        verify_workspace_snapshot(staging.path())
            .err()
            .unwrap()
            .to_string()
    };
    // A flipped byte fails the recorded hash.
    let staging = stage(&manifest, &[(&digest(b"hello\n"), b"jello\n")]);
    assert!(error(&staging).contains("hashes to"), "{}", error(&staging));
    // A missing blob fails its file entry.
    let staging = stage(&manifest, &[]);
    assert!(
        error(&staging).contains("missing blob"),
        "{}",
        error(&staging)
    );
    // An unreferenced blob fails the set check.
    let staging = stage(
        &manifest,
        &[
            (&digest(b"hello\n"), b"hello\n"),
            (&digest(b"extra\n"), b"extra\n"),
        ],
    );
    assert!(
        error(&staging).contains("unreferenced blob"),
        "{}",
        error(&staging)
    );
    // A size lie fails before any hashing.
    let lying = SnapshotManifest {
        captured: vec![CapturedEntry::File {
            path: "hello.txt".to_string(),
            status: "??".to_string(),
            sha256: digest(b"hello\n"),
            bytes: 99,
            executable: false,
        }],
        ..manifest
    };
    let staging = stage(&lying, &[(&digest(b"hello\n"), b"hello\n")]);
    assert!(
        error(&staging).contains("manifest says"),
        "{}",
        error(&staging)
    );
}

#[test]
fn verification_rejects_bad_manifests() {
    let good = manifest_of(
        None,
        vec![CapturedEntry::Deleted {
            path: "gone.txt".to_string(),
            status: "D.".to_string(),
        }],
        vec![],
    );
    let error = |staging: &tempfile::TempDir| {
        verify_workspace_snapshot(staging.path())
            .err()
            .unwrap()
            .to_string()
    };
    // Missing, unreadable, or unparseable manifests.
    let empty = tempfile::tempdir().unwrap();
    assert!(error(&empty).contains("unreadable"), "{}", error(&empty));
    let staging = tempfile::tempdir().unwrap();
    std::fs::write(staging.path().join("manifest.json"), "not json").unwrap();
    let unreadable = verify_workspace_snapshot(staging.path())
        .err()
        .unwrap()
        .to_string();
    assert!(unreadable.contains("invalid JSON"), "{unreadable}");
    // Unsupported version.
    let future = SnapshotManifest {
        version: 2,
        ..good.clone()
    };
    let staging = stage(&future, &[]);
    assert!(
        error(&staging).contains("unsupported version"),
        "{}",
        error(&staging)
    );
    // Unsafe, duplicated, and unsorted paths.
    let escaping = manifest_of(
        None,
        vec![CapturedEntry::Deleted {
            path: "../evil".to_string(),
            status: "D.".to_string(),
        }],
        vec![],
    );
    let staging = stage(&escaping, &[]);
    assert!(error(&staging).contains("unsafe"), "{}", error(&staging));
    let duplicated = manifest_of(
        None,
        vec![
            CapturedEntry::Deleted {
                path: "a.txt".to_string(),
                status: "D.".to_string(),
            },
            CapturedEntry::Deleted {
                path: "a.txt".to_string(),
                status: "D.".to_string(),
            },
        ],
        vec![],
    );
    let staging = stage(&duplicated, &[]);
    assert!(
        error(&staging).contains("duplicated"),
        "{}",
        error(&staging)
    );
    // Escaping symlink target.
    let escaping_link = manifest_of(
        None,
        vec![CapturedEntry::Symlink {
            path: "link".to_string(),
            status: "??".to_string(),
            target: "../../outside".to_string(),
        }],
        vec![],
    );
    let staging = stage(&escaping_link, &[]);
    assert!(
        error(&staging).contains("escapes the worktree"),
        "{}",
        error(&staging)
    );
    // Malformed digests and commit ids.
    let bad_digest = manifest_of(
        None,
        vec![CapturedEntry::File {
            path: "hello.txt".to_string(),
            status: "??".to_string(),
            sha256: "nothex".to_string(),
            bytes: 6,
            executable: false,
        }],
        vec![],
    );
    let staging = stage(&bad_digest, &[("nothex", b"hello\n")]);
    assert!(
        error(&staging).contains("malformed blob digest"),
        "{}",
        error(&staging)
    );
    let bad_head = SnapshotManifest {
        head_commit: Some("nothex".to_string()),
        ..good
    };
    let staging = stage(&bad_head, &[]);
    assert!(
        error(&staging).contains("malformed head commit"),
        "{}",
        error(&staging)
    );
}
