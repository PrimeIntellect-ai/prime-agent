//! Fixture-repo tests for workspace snapshots: real `git` in tempdirs (the
//! crate's established pattern for worktree-touching tests) plus pure
//! parser, manifest, and verification cases.

use std::path::Path;

use sha2::{Digest, Sha256};

use super::git::{git_command, parse_status, GitStatus, HeadTreeEntry, StatusEntry};
#[cfg(unix)]
use super::git::{read_head_tree, read_worktree_status};
use super::manifest::{is_safe_relative_path, symlink_target_stays_inside};
use super::{
    build_manifest, capture_leaf, create_workspace_snapshot, git_blob_oid, is_secret_path,
    verify_workspace_snapshot, Baseline, BaselineMode, CapturedEntry, ExcludeReason, ExcludedEntry,
    LeafOutcome, SnapshotError, SnapshotLimits, SnapshotManifest,
};
#[cfg(unix)]
use super::{open_leaf, OpenLeaf};

#[cfg(unix)]
fn git(dir: &Path, args: &[&str]) {
    let output = git_command(args, dir).into_std().output().unwrap();
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[cfg(unix)]
fn init_repo(dir: &Path) {
    git(dir, &["init", "-q"]);
    git(dir, &["config", "user.email", "t@example.com"]);
    git(dir, &["config", "user.name", "t"]);
}

#[cfg(unix)]
fn write(dir: &Path, rel: &str, content: &str) {
    let path = dir.join(rel);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(path, content).unwrap();
}

#[cfg(unix)]
fn git_show(dir: &Path, revision: &str) -> String {
    let output = git_command(&["show", revision], dir)
        .into_std()
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git show {revision} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

#[cfg(unix)]
fn head_commit(dir: &Path) -> String {
    let output = git_command(&["rev-parse", "HEAD"], dir)
        .into_std()
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

fn head_tree(entries: Vec<CapturedEntry>) -> Baseline {
    Baseline::HeadTree {
        entries,
        excluded: vec![],
    }
}

/// A manifest for hand-built staging: no commits, no baseline, version 2.
fn bare_manifest(captured: Vec<CapturedEntry>, excluded: Vec<ExcludedEntry>) -> SnapshotManifest {
    SnapshotManifest {
        version: 2,
        head_commit: None,
        baseline: None,
        captured,
        excluded,
    }
}

/// The manifest a committed repository produces with a HEAD-tree
/// baseline.
#[cfg(unix)]
fn repo_manifest(
    root: &Path,
    baseline: Baseline,
    captured: Vec<CapturedEntry>,
    excluded: Vec<ExcludedEntry>,
) -> SnapshotManifest {
    SnapshotManifest {
        version: 2,
        head_commit: Some(head_commit(root)),
        baseline: Some(baseline),
        captured,
        excluded,
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

#[cfg(unix)]
fn read_blob(staging: &Path, sha256: &str) -> Vec<u8> {
    std::fs::read(staging.join("blobs").join(sha256)).unwrap()
}

/// Capture refuses before querying git or creating private-looking files
/// when owner-only modes cannot be guaranteed by the platform wall.
#[cfg(not(unix))]
#[tokio::test]
async fn capture_refuses_unsupported_platform_without_staging() {
    let dir = tempfile::tempdir().unwrap();
    let staging = dir.path().join("staging");
    let error = create_workspace_snapshot(dir.path(), &staging, BaselineMode::External, &limits())
        .await
        .unwrap_err();
    assert!(matches!(error, SnapshotError::UnsupportedPlatform));
    assert!(!staging.exists());
}

/// A SHA-256 repository snapshots and verifies the same as a SHA-1 one:
/// the object ids follow the repository's own format, and the manifest's
/// head commit is the repository's 64-character branch id.
#[cfg(unix)]
#[tokio::test]
async fn a_sha256_repository_snapshots_and_verifies() {
    let repo = tempfile::tempdir().unwrap();
    let root = repo.path();
    git(root, &["init", "-q", "--object-format=sha256", "."]);
    git(root, &["config", "user.email", "t@example.com"]);
    git(root, &["config", "user.name", "t"]);
    write(root, "a.txt", "sha256\n");
    git(root, &["add", "."]);
    git(root, &["commit", "-q", "-m", "base"]);
    let staging = tempfile::tempdir().unwrap();
    let snapshot =
        create_workspace_snapshot(root, staging.path(), BaselineMode::HeadTree, &limits())
            .await
            .unwrap();
    let manifest = verify_workspace_snapshot(staging.path()).unwrap();
    assert_eq!(snapshot.manifest, manifest);
    assert_eq!(
        manifest.head_commit.as_deref().map(str::len),
        Some(64),
        "a SHA-256 repository publishes a 64-character head commit"
    );
    // The whole worktree is clean, so the HEAD-tree baseline carries it
    // and the delta is empty: the baseline entry landing at all is the
    // SHA-256 proof — the object-id cross-check passed, and a SHA-1 hash
    // of the same content could never match the repository's
    // 64-character tree ids.
    assert!(manifest.captured.is_empty());
    let Baseline::HeadTree { entries, .. } = manifest.baseline.as_ref().unwrap() else {
        panic!("the HEAD-tree baseline");
    };
    let CapturedEntry::File {
        path,
        sha256,
        bytes,
        ..
    } = &entries[0]
    else {
        panic!("the baseline file entry");
    };
    assert_eq!(path, "a.txt");
    assert_eq!(*sha256, digest(b"sha256\n"));
    assert_eq!(*bytes, 7);
}

#[cfg(unix)]
#[tokio::test]
async fn snapshot_collapses_a_path_git_lists_twice() {
    // `git rm --cached` leaves a staged deletion and an untracked row
    // for the same path in one `git status` run; the manifest carries
    // the path once, and its own verify accepts the result.
    let repo = tempfile::tempdir().unwrap();
    let root = repo.path();
    init_repo(root);
    write(root, "tracked.txt", "base\n");
    git(root, &["add", "."]);
    git(root, &["commit", "-q", "-m", "base"]);
    git(root, &["rm", "-q", "--cached", "tracked.txt"]);
    let staging = tempfile::tempdir().unwrap();
    let snapshot =
        create_workspace_snapshot(root, staging.path(), BaselineMode::HeadTree, &limits())
            .await
            .unwrap();
    let expected = repo_manifest(
        root,
        // The delta row covers the path, so the HEAD-tree baseline does not
        // restate it.
        head_tree(vec![]),
        vec![file_entry("tracked.txt", "??", "base\n")],
        vec![],
    );
    assert_eq!(snapshot.manifest, expected);
    assert_eq!(verify_workspace_snapshot(staging.path()).unwrap(), expected);
}

#[cfg(unix)]
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
    let snapshot =
        create_workspace_snapshot(root, staging.path(), BaselineMode::HeadTree, &limits())
            .await
            .unwrap();
    // Only .gitignore is unmodified, so it alone forms the HEAD-tree
    // baseline; every changed path is carried by the delta instead.
    let expected = repo_manifest(
        root,
        head_tree(vec![file_entry(".gitignore", "100644", "ignored.log\n")]),
        vec![
            CapturedEntry::Deleted {
                path: "gone.txt".to_string(),
                status: "D.".to_string(),
            },
            file_entry("staged.txt", "A.", "staged\n"),
            file_entry("sub/deep.txt", "??", "deep\n"),
            file_entry("tracked.txt", ".M", "modified\n"),
            file_entry("untracked.txt", "??", "fresh\n"),
        ],
        vec![],
    );
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

#[cfg(unix)]
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
    let snapshot_a =
        create_workspace_snapshot(root, first.path(), BaselineMode::HeadTree, &limits())
            .await
            .unwrap();
    let snapshot_b =
        create_workspace_snapshot(root, second.path(), BaselineMode::HeadTree, &limits())
            .await
            .unwrap();
    // No timestamps and no git pack bytes: identical manifests, byte for
    // byte, and each one verifies in full.
    assert_eq!(snapshot_a.manifest, snapshot_b.manifest);
    let bytes_a = std::fs::read(&snapshot_a.manifest_path).unwrap();
    let bytes_b = std::fs::read(&snapshot_b.manifest_path).unwrap();
    assert_eq!(bytes_a, bytes_b);
    assert!(verify_workspace_snapshot(first.path()).is_ok());
    assert!(verify_workspace_snapshot(second.path()).is_ok());
}

#[cfg(unix)]
#[tokio::test]
async fn snapshot_excludes_secret_named_files_in_delta_and_baseline() {
    let repo = tempfile::tempdir().unwrap();
    let root = repo.path();
    init_repo(root);
    // A committed secret left unmodified and a modified tracked one: the
    // denylist must reach the baseline exactly like the delta.
    write(root, "old.pem", "committed-secret\n");
    write(root, ".env", "old-secret\n");
    write(root, "keep.txt", "kept\n");
    git(root, &["add", "."]);
    git(root, &["commit", "-q", "-m", "base"]);
    write(root, ".env", "new-secret\n");
    write(root, ".env.local", "local\n");
    write(root, "cert.pem", "cert\n");
    write(root, "id_rsa", "key\n");
    write(root, "keys/private.key", "key\n");
    let staging = tempfile::tempdir().unwrap();
    let snapshot =
        create_workspace_snapshot(root, staging.path(), BaselineMode::HeadTree, &limits())
            .await
            .unwrap();
    assert_eq!(
        snapshot.manifest,
        repo_manifest(
            root,
            Baseline::HeadTree {
                entries: vec![file_entry("keep.txt", "100644", "kept\n")],
                excluded: vec![secret("old.pem")],
            },
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
    // Exactly one blob is staged - the unmodified keep.txt baseline -
    // and no secret content from either layer.
    let staged_blobs: Vec<String> = std::fs::read_dir(staging.path().join("blobs"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(staged_blobs, vec![digest(b"kept\n")]);
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
    let snapshot =
        create_workspace_snapshot(root, staging.path(), BaselineMode::HeadTree, &limits())
            .await
            .unwrap();
    assert_eq!(
        snapshot.manifest,
        repo_manifest(
            root,
            head_tree(vec![file_entry("tracked.txt", "100644", "base\n")]),
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

#[cfg(unix)]
#[tokio::test]
async fn snapshot_never_reads_behind_symlinked_ancestors() {
    let repo = tempfile::tempdir().unwrap();
    let root = repo.path();
    init_repo(root);
    write(root, "sub/file.txt", "tracked\n");
    git(root, &["add", "."]);
    git(root, &["commit", "-q", "-m", "base"]);
    // Replace the tracked directory with a symlink to a directory outside
    // the worktree that carries a file with the same name: a naive
    // `root.join(path)` read would stage the victim's content.
    let victim = tempfile::tempdir().unwrap();
    std::fs::write(victim.path().join("file.txt"), "VICTIM-SECRET\n").unwrap();
    std::fs::remove_dir_all(root.join("sub")).unwrap();
    std::os::unix::fs::symlink(victim.path(), root.join("sub")).unwrap();
    let staging = tempfile::tempdir().unwrap();
    let snapshot =
        create_workspace_snapshot(root, staging.path(), BaselineMode::HeadTree, &limits())
            .await
            .unwrap();
    // The tracked path behind the symlink is excluded unread; the
    // symlink itself is excluded for its escaping target. The HEAD tree
    // only holds sub/file.txt, which the delta already covers.
    assert_eq!(
        snapshot.manifest,
        repo_manifest(
            root,
            head_tree(vec![]),
            vec![],
            vec![
                ExcludedEntry {
                    path: "sub".to_string(),
                    reason: ExcludeReason::EscapingSymlink,
                },
                ExcludedEntry {
                    path: "sub/file.txt".to_string(),
                    reason: ExcludeReason::SymlinkedAncestor,
                },
            ]
        )
    );
    // No file content was staged at all, victim's or otherwise.
    assert!(std::fs::read_dir(staging.path().join("blobs"))
        .unwrap()
        .next()
        .is_none());
    assert!(verify_workspace_snapshot(staging.path()).is_ok());
}

#[cfg(unix)]
#[tokio::test]
async fn a_directory_replaced_by_a_file_deletes_its_tracked_paths() {
    let repo = tempfile::tempdir().unwrap();
    let root = repo.path();
    init_repo(root);
    write(root, "dir/x", "x\n");
    write(root, "keep.txt", "k\n");
    git(root, &["add", "."]);
    git(root, &["commit", "-q", "-m", "base"]);
    std::fs::remove_dir_all(root.join("dir")).unwrap();
    write(root, "dir", "file now\n");
    let staging = tempfile::tempdir().unwrap();
    let snapshot =
        create_workspace_snapshot(root, staging.path(), BaselineMode::HeadTree, &limits())
            .await
            .unwrap();
    assert_eq!(
        snapshot.manifest,
        repo_manifest(
            root,
            head_tree(vec![file_entry("keep.txt", "100644", "k\n")]),
            vec![
                file_entry("dir", "??", "file now\n"),
                CapturedEntry::Deleted {
                    path: "dir/x".to_string(),
                    status: ".D".to_string(),
                },
            ],
            vec![]
        )
    );
    assert!(verify_workspace_snapshot(staging.path()).is_ok());
    // The replaced directory read as a baseline path after the status
    // run: HEAD still records dir/x, but the standing file is not a
    // path to it, so the baseline can no longer be the stated commit.
    let staging = tempfile::tempdir().unwrap();
    let error = build_manifest(
        root,
        staging.path(),
        &GitStatus {
            head_commit: Some(head_commit(root)),
            entries: vec![],
        },
        BaselineMode::HeadTree,
        &[HeadTreeEntry {
            path: "dir/x".to_string(),
            mode: "100644".to_string(),
            gitlink: false,
            skip_worktree: false,
            oid: git_blob_oid(b"x\n", false),
        }],
        &limits(),
    )
    .unwrap_err();
    assert!(
        matches!(error, SnapshotError::ConcurrentMutation { .. }),
        "{error}"
    );
}

#[cfg(unix)]
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
    let snapshot =
        create_workspace_snapshot(root, staging.path(), BaselineMode::HeadTree, &limits())
            .await
            .unwrap();
    assert_eq!(
        snapshot.manifest,
        repo_manifest(
            root,
            head_tree(vec![file_entry("tracked.txt", "100644", "base\n")]),
            vec![file_entry("untracked.txt", "??", "fresh\n")],
            vec![ExcludedEntry {
                path: "nested/".to_string(),
                reason: ExcludeReason::NestedRepository,
            }]
        )
    );
}

#[cfg(unix)]
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
    let snapshot =
        create_workspace_snapshot(root, staging.path(), BaselineMode::HeadTree, &limits())
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
    let snapshot =
        create_workspace_snapshot(root, staging.path(), BaselineMode::HeadTree, &limits())
            .await
            .unwrap();
    assert_eq!(
        snapshot.manifest,
        repo_manifest(
            root,
            head_tree(vec![file_entry("tracked.txt", "100644", "base\n")]),
            vec![],
            vec![ExcludedEntry {
                path: "submod".to_string(),
                reason: ExcludeReason::Submodule,
            }]
        )
    );
}

#[cfg(unix)]
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
    let merge = git_command(&["merge", "side"], root)
        .into_std()
        .output()
        .unwrap();
    assert!(!merge.status.success(), "expected a conflict");
    let conflict = std::fs::read_to_string(root.join("f.txt")).unwrap();
    let staging = tempfile::tempdir().unwrap();
    let snapshot =
        create_workspace_snapshot(root, staging.path(), BaselineMode::HeadTree, &limits())
            .await
            .unwrap();
    // f.txt differs from HEAD, so the delta covers it and the HEAD-tree
    // baseline stays empty.
    assert_eq!(
        snapshot.manifest,
        repo_manifest(
            root,
            head_tree(vec![]),
            vec![file_entry("f.txt", "UU", &conflict)],
            vec![]
        )
    );
    assert!(verify_workspace_snapshot(staging.path()).is_ok());
}

#[cfg(unix)]
#[tokio::test]
async fn head_tree_baseline_ships_head_content_and_full_coverage() {
    let repo = tempfile::tempdir().unwrap();
    let root = repo.path();
    init_repo(root);
    write(root, "a.txt", "one\n");
    write(root, "b.txt", "bee\n");
    git(root, &["add", "."]);
    git(root, &["commit", "-q", "-m", "one"]);
    write(root, "a.txt", "two\n");
    git(root, &["commit", "-q", "-am", "two"]);
    // A dirty delta on top of history that exists nowhere but here: the
    // unpushed-worktree case the baseline exists for. a.txt changes, so
    // the delta carries it; unmodified b.txt is what the HEAD-tree
    // baseline stages.
    write(root, "a.txt", "working\n");
    let staging = tempfile::tempdir().unwrap();
    let snapshot =
        create_workspace_snapshot(root, staging.path(), BaselineMode::HeadTree, &limits())
            .await
            .unwrap();
    let head = head_commit(root);
    assert_eq!(
        snapshot.manifest.head_commit.as_deref(),
        Some(head.as_str())
    );
    // The baseline holds HEAD's content for the unmodified path - the
    // changed path is carried by the delta instead.
    assert_eq!(
        snapshot.manifest.baseline,
        Some(head_tree(vec![file_entry("b.txt", "100644", "bee\n")]))
    );
    assert_eq!(
        snapshot.manifest.captured,
        vec![file_entry("a.txt", ".M", "working\n")]
    );
    // Proven with git itself: the staged baseline blob is exactly what
    // `git show HEAD:b.txt` reports, and the object-id verification
    // matches `git hash-object` byte for byte.
    assert_eq!(git_show(root, "HEAD:b.txt"), "bee\n");
    assert_eq!(read_blob(staging.path(), &digest(b"bee\n")), b"bee\n");
    let hash_object = git_command(&["hash-object", "--", "b.txt"], root)
        .into_std()
        .output()
        .unwrap();
    assert!(hash_object.status.success());
    let head_content = std::fs::read(root.join("b.txt")).unwrap();
    assert_eq!(
        git_blob_oid(&head_content, false),
        String::from_utf8(hash_object.stdout).unwrap().trim()
    );
    // Materializing = baseline plus delta blobs: the worktree's content,
    // reproduced from the staging directory alone.
    assert_eq!(
        read_blob(staging.path(), &digest(b"working\n")),
        b"working\n"
    );
    // Full coverage: every path in HEAD's tree is carried by the delta,
    // the baseline, or an exclusion with a reason.
    let ls_tree = git_command(&["ls-tree", "-r", "--name-only", "HEAD"], root)
        .into_std()
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&ls_tree.stdout);
    let head_paths: Vec<&str> = stdout.lines().filter(|line| !line.is_empty()).collect();
    let carried = |path: &str| -> bool {
        snapshot.manifest.baseline.as_ref().is_some_and(|baseline| {
            matches!(
                baseline,
                Baseline::HeadTree { entries, excluded }
                    if entries.iter().any(|entry| entry.path() == path)
                        || excluded.iter().any(|entry| entry.path == path)
            )
        }) || snapshot
            .manifest
            .captured
            .iter()
            .any(|entry| entry.path() == path)
            || snapshot
                .manifest
                .excluded
                .iter()
                .any(|entry| entry.path == path)
    };
    assert!(!head_paths.is_empty());
    for path in head_paths {
        assert!(carried(path), "HEAD path {path} is not covered");
    }
    assert!(verify_workspace_snapshot(staging.path()).is_ok());
}

#[cfg(unix)]
#[tokio::test]
async fn head_tree_pins_to_the_status_reported_commit() {
    let repo = tempfile::tempdir().unwrap();
    let root = repo.path();
    init_repo(root);
    write(root, "a.txt", "A\n");
    git(root, &["add", "."]);
    git(root, &["commit", "-q", "-m", "one"]);
    let pinned = read_worktree_status(root, limits().git_timeout_ms)
        .await
        .unwrap()
        .head_commit
        .unwrap();
    // Another process commits between the status run and the tree
    // enumeration: the enumeration must describe the status-reported
    // commit, not the moved HEAD, or the manifest would publish the
    // old head commit with the new HEAD's tree.
    write(root, "a.txt", "B\n");
    write(root, "b.txt", "new\n");
    git(root, &["add", "."]);
    git(root, &["commit", "-q", "-m", "two"]);
    let tree = read_head_tree(root, &pinned, limits().git_timeout_ms)
        .await
        .unwrap();
    assert_eq!(
        tree,
        vec![HeadTreeEntry {
            path: "a.txt".to_string(),
            mode: "100644".to_string(),
            gitlink: false,
            skip_worktree: false,
            oid: git_blob_oid(b"A\n", false),
        }]
    );
}

#[cfg(unix)]
#[tokio::test]
async fn head_tree_baseline_excludes_only_absent_skip_worktree_paths() {
    let repo = tempfile::tempdir().unwrap();
    let root = repo.path();
    init_repo(root);
    write(root, "keep.txt", "k\n");
    write(root, "sparse/x.txt", "x\n");
    git(root, &["add", "."]);
    git(root, &["commit", "-q", "-m", "base"]);
    // A cone-mode sparse checkout keeps only root-level files: git
    // status reports nothing for the absent path, but the index still
    // marks it skip-worktree.
    git(root, &["sparse-checkout", "set", "--cone"]);
    let staging = tempfile::tempdir().unwrap();
    let snapshot =
        create_workspace_snapshot(root, staging.path(), BaselineMode::HeadTree, &limits())
            .await
            .unwrap();
    assert_eq!(
        snapshot.manifest,
        repo_manifest(
            root,
            Baseline::HeadTree {
                entries: vec![file_entry("keep.txt", "100644", "k\n")],
                excluded: vec![ExcludedEntry {
                    path: "sparse/x.txt".to_string(),
                    reason: ExcludeReason::SkipWorktree,
                }],
            },
            vec![],
            vec![]
        )
    );
    assert!(verify_workspace_snapshot(staging.path()).is_ok());
    // Without a sparse checkout, git keeps the bit on a present file
    // (`update-index --skip-worktree`): the leaf is on disk and must
    // stage.
    git(root, &["sparse-checkout", "disable"]);
    git(root, &["update-index", "--skip-worktree", "keep.txt"]);
    let staging = tempfile::tempdir().unwrap();
    let snapshot =
        create_workspace_snapshot(root, staging.path(), BaselineMode::HeadTree, &limits())
            .await
            .unwrap();
    assert_eq!(
        snapshot.manifest,
        repo_manifest(
            root,
            head_tree(vec![
                file_entry("keep.txt", "100644", "k\n"),
                file_entry("sparse/x.txt", "100644", "x\n"),
            ]),
            vec![],
            vec![]
        )
    );
}

#[test]
fn baseline_rejects_concurrent_mutation_loudly() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("a.txt"), "right\n").unwrap();
    let staging = tempfile::tempdir().unwrap();
    let blobs = staging.path().join("blobs");
    std::fs::create_dir(&blobs).unwrap();
    let limits = SnapshotLimits::default();
    let mut total_bytes = 0u64;
    let head_entry = |oid: &str, mode: &str| HeadTreeEntry {
        path: "a.txt".to_string(),
        mode: mode.to_string(),
        gitlink: false,
        skip_worktree: false,
        oid: oid.to_string(),
    };
    // Matching content, mode, and object id stages the leaf.
    let expected = head_entry(&git_blob_oid(b"right\n", false), "100644");
    let outcome = capture_leaf(
        root.path(),
        &blobs,
        "a.txt",
        "100644",
        Some(&expected),
        &limits,
        &mut total_bytes,
    )
    .unwrap();
    assert!(matches!(outcome, LeafOutcome::Entry(_)));
    // Content that no longer reproduces HEAD's object id fails loudly.
    let mutated = head_entry(&git_blob_oid(b"other\n", false), "100644");
    let error = capture_leaf(
        root.path(),
        &blobs,
        "a.txt",
        "100644",
        Some(&mutated),
        &limits,
        &mut total_bytes,
    )
    .unwrap_err();
    assert!(
        matches!(error, SnapshotError::ConcurrentMutation { .. }),
        "{error}"
    );
    assert!(error.to_string().contains("hashes to object"), "{error}");
    // A path HEAD records that vanished from the worktree is an error,
    // never a silent omission: drive it through build_manifest itself.
    let bare = tempfile::tempdir().unwrap();
    let status = GitStatus {
        head_commit: Some("ee3a902349fa5446bf3edd1e1e8d8f7f48013081".to_string()),
        entries: vec![],
    };
    let staging = tempfile::tempdir().unwrap();
    let error = build_manifest(
        bare.path(),
        staging.path(),
        &status,
        BaselineMode::HeadTree,
        &[expected],
        &limits,
    )
    .unwrap_err();
    assert!(
        matches!(error, SnapshotError::ConcurrentMutation { .. }),
        "{error}"
    );
    assert!(
        error.to_string().contains("vanished from the worktree"),
        "{error}"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn external_baseline_mode_records_the_choice() {
    let repo = tempfile::tempdir().unwrap();
    let root = repo.path();
    init_repo(root);
    write(root, "tracked.txt", "base\n");
    git(root, &["add", "."]);
    git(root, &["commit", "-q", "-m", "base"]);
    write(root, "untracked.txt", "fresh\n");
    let staging = tempfile::tempdir().unwrap();
    let snapshot =
        create_workspace_snapshot(root, staging.path(), BaselineMode::External, &limits())
            .await
            .unwrap();
    // The delta ships and the manifest states explicitly that the
    // consumer must obtain the head commit itself.
    assert_eq!(
        snapshot.manifest,
        repo_manifest(
            root,
            Baseline::External,
            vec![file_entry("untracked.txt", "??", "fresh\n")],
            vec![]
        )
    );
    assert!(verify_workspace_snapshot(staging.path()).is_ok());
}

#[cfg(unix)]
#[tokio::test]
async fn unborn_repository_snapshot_is_self_contained() {
    let repo = tempfile::tempdir().unwrap();
    let root = repo.path();
    init_repo(root);
    write(root, "fresh.txt", "fresh\n");
    let staging = tempfile::tempdir().unwrap();
    let snapshot =
        create_workspace_snapshot(root, staging.path(), BaselineMode::HeadTree, &limits())
            .await
            .unwrap();
    // No commits: no baseline to stage, and the manifest says so
    // explicitly - the delta already is the whole worktree.
    assert_eq!(
        snapshot.manifest,
        bare_manifest(vec![file_entry("fresh.txt", "??", "fresh\n")], vec![])
    );
    assert!(verify_workspace_snapshot(staging.path()).is_ok());
}

#[cfg(unix)]
#[tokio::test]
async fn snapshot_drains_status_output_beyond_pipe_capacity() {
    // Regression guard for the child-process drain: `git status` writing
    // more than the OS pipe capacity must not deadlock the capture (the
    // drain races with the wait, not after it).
    let repo = tempfile::tempdir().unwrap();
    let root = repo.path();
    init_repo(root);
    for i in 0..3000 {
        let path = root.join(format!("u/file_{i:04}.txt"));
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(&path, format!("{i}\n")).unwrap();
    }
    let staging = tempfile::tempdir().unwrap();
    let snapshot =
        create_workspace_snapshot(root, staging.path(), BaselineMode::HeadTree, &limits())
            .await
            .unwrap();
    assert_eq!(snapshot.manifest.captured.len(), 3000);
    assert!(verify_workspace_snapshot(staging.path()).is_ok());
}

#[cfg(unix)]
async fn capture_error(root: &Path, limits: &SnapshotLimits) -> String {
    let staging = tempfile::tempdir().unwrap();
    create_workspace_snapshot(root, staging.path(), BaselineMode::HeadTree, limits)
        .await
        .unwrap_err()
        .to_string()
}

#[cfg(unix)]
#[tokio::test]
async fn snapshot_enforces_limits() {
    let repo = tempfile::tempdir().unwrap();
    let root = repo.path();
    init_repo(root);
    write(root, "one.txt", "one\n");
    write(root, "two.txt", "two\n");
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
    // An oversized HEAD tree fails its own bound.
    let error = capture_error(
        root,
        &SnapshotLimits {
            max_baseline_entries: 1,
            ..limits()
        },
    )
    .await;
    assert!(error.contains("max_baseline_entries"), "{error}");
}

#[cfg(unix)]
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
    let error = create_workspace_snapshot(root, occupied.path(), BaselineMode::HeadTree, &limits())
        .await
        .unwrap_err();
    assert!(
        matches!(error, SnapshotError::StagingDirNotEmpty { .. }),
        "{error}"
    );
    // A staging directory inside the worktree would capture itself.
    let inside = root.join(".staging");
    let error = create_workspace_snapshot(root, &inside, BaselineMode::HeadTree, &limits())
        .await
        .unwrap_err();
    assert!(
        matches!(error, SnapshotError::StagingDirInsideWorktree { .. }),
        "{error}"
    );
    // A missing nested staging directory is created.
    let outside = tempfile::tempdir().unwrap();
    let staging = outside.path().join("nested/stage");
    create_workspace_snapshot(root, &staging, BaselineMode::HeadTree, &limits())
        .await
        .unwrap();
    assert!(staging.join("manifest.json").is_file());
}

#[cfg(unix)]
#[tokio::test]
async fn untracked_special_paths_never_block_the_leaf_open() {
    // Regression guard: a plain read-only open of a FIFO (or a unix
    // socket) blocks until a writer or client appears, which would hang
    // the whole capture. git does not enumerate special files as
    // untracked (probed), so this is defense in depth for the open
    // itself: with O_NONBLOCK it must classify immediately instead.
    let repo = tempfile::tempdir().unwrap();
    let root = repo.path();
    nix::unistd::mkfifo(&root.join("pipe"), nix::sys::stat::Mode::S_IRWXU).unwrap();
    let listener = std::os::unix::net::UnixListener::bind(root.join("sock")).unwrap();
    assert!(matches!(
        open_leaf(root, "pipe", 1024, false),
        Ok(OpenLeaf::NotRegularFile)
    ));
    assert!(matches!(
        open_leaf(root, "sock", 1024, false),
        Ok(OpenLeaf::NotRegularFile)
    ));
    drop(listener);
    // The fix's end-to-end behavior: a repo holding such files snapshots
    // and verifies fine, mentioning them nowhere (git does not list them).
    init_repo(root);
    write(root, "tracked.txt", "base\n");
    git(root, &["add", "tracked.txt"]);
    git(root, &["commit", "-q", "-m", "base"]);
    let staging = tempfile::tempdir().unwrap();
    let snapshot =
        create_workspace_snapshot(root, staging.path(), BaselineMode::HeadTree, &limits())
            .await
            .unwrap();
    assert_eq!(
        snapshot.manifest,
        repo_manifest(
            root,
            head_tree(vec![file_entry("tracked.txt", "100644", "base\n")]),
            vec![],
            vec![]
        )
    );
    assert!(verify_workspace_snapshot(staging.path()).is_ok());
}

#[cfg(unix)]
#[tokio::test]
async fn staging_and_staged_files_are_owner_private() {
    let repo = tempfile::tempdir().unwrap();
    let root = repo.path();
    init_repo(root);
    write(root, "tracked.txt", "base\n");
    git(root, &["add", "."]);
    git(root, &["commit", "-q", "-m", "base"]);
    write(root, "untracked.txt", "fresh\n");
    let mode_of = |path: &Path| {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    };
    // A pre-existing empty staging directory is tightened, not trusted.
    let staging = tempfile::tempdir().unwrap();
    create_workspace_snapshot(root, staging.path(), BaselineMode::HeadTree, &limits())
        .await
        .unwrap();
    assert_eq!(mode_of(staging.path()), 0o700);
    assert_eq!(mode_of(&staging.path().join("blobs")), 0o700);
    // Staged files stay owner-only even if later moved out of staging.
    for entry in std::fs::read_dir(staging.path().join("blobs")).unwrap() {
        assert_eq!(mode_of(&entry.unwrap().path()), 0o600);
    }
    assert_eq!(mode_of(&staging.path().join("manifest.json")), 0o600);
    // A freshly created nested staging directory is private from birth.
    let parent = tempfile::tempdir().unwrap();
    let staging = parent.path().join("nested/stage");
    create_workspace_snapshot(root, &staging, BaselineMode::HeadTree, &limits())
        .await
        .unwrap();
    assert_eq!(mode_of(&staging), 0o700);
}

#[cfg(unix)]
#[tokio::test]
async fn snapshot_requires_a_git_worktree() {
    let plain = tempfile::tempdir().unwrap();
    let staging = tempfile::tempdir().unwrap();
    let error = create_workspace_snapshot(
        plain.path(),
        staging.path(),
        BaselineMode::HeadTree,
        &limits(),
    )
    .await
    .unwrap_err();
    assert!(
        matches!(error, SnapshotError::NotAWorktree { .. }),
        "{error}"
    );
    assert!(staging.path().join("manifest.json").read_dir().is_err());
}

#[cfg(unix)]
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
    let snapshot = create_workspace_snapshot(
        &root.join("sub"),
        staging.path(),
        BaselineMode::HeadTree,
        &limits(),
    )
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
    let snapshot =
        create_workspace_snapshot(root, staging.path(), BaselineMode::HeadTree, &limits())
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

#[cfg(unix)]
#[tokio::test]
async fn head_tree_baseline_restates_head_mode_under_core_filemode_false() {
    use std::os::unix::fs::PermissionsExt;
    let repo = tempfile::tempdir().unwrap();
    let root = repo.path();
    init_repo(root);
    write(root, "run.sh", "#!/bin/sh\n");
    std::fs::set_permissions(root.join("run.sh"), std::fs::Permissions::from_mode(0o755)).unwrap();
    git(root, &["add", "."]);
    git(root, &["commit", "-q", "-m", "base"]);
    // What a FAT or WSL drvfs mount reports for the bit: the mode is
    // gone from the filesystem and git is told to ignore mode drift, so
    // a clean worktree stays a clean worktree.
    git(root, &["config", "core.filemode", "false"]);
    std::fs::set_permissions(root.join("run.sh"), std::fs::Permissions::from_mode(0o644)).unwrap();
    let staging = tempfile::tempdir().unwrap();
    let snapshot =
        create_workspace_snapshot(root, staging.path(), BaselineMode::HeadTree, &limits())
            .await
            .unwrap();
    assert_eq!(
        snapshot.manifest,
        repo_manifest(
            root,
            head_tree(vec![CapturedEntry::File {
                path: "run.sh".to_string(),
                status: "100755".to_string(),
                sha256: digest(b"#!/bin/sh\n"),
                bytes: 10,
                executable: true,
            }]),
            vec![],
            vec![]
        )
    );
}

#[test]
fn git_selection_env_is_scrubbed_from_child_commands() {
    // GIT_DIR/GIT_WORK_TREE inherited from the caller would point every
    // git command at another repository; the child command drops the
    // git-discovery variables so the capture always describes the root
    // it was given.
    let command = git_command(&["status"], Path::new("/tmp"));
    let removed: Vec<String> = command
        .as_std()
        .get_envs()
        .filter(|(_, value)| value.is_none())
        .map(|(key, _)| key.to_string_lossy().into_owned())
        .collect();
    for variable in [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_COMMON_DIR",
        "GIT_NAMESPACE",
    ] {
        assert!(
            removed.iter().any(|entry| entry == variable),
            "{variable} must be scrubbed from the git child env"
        );
    }
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
    for unsafe_path in ["", "/abs", "../up", "./cur", "a/../../b", "a\\b.txt"] {
        assert!(!is_safe_relative_path(unsafe_path));
    }
    assert!(symlink_target_stays_inside("link", "a.txt"));
    assert!(symlink_target_stays_inside("a/b/link", "../c.txt"));
    assert!(!symlink_target_stays_inside("a/link", "../../x"));
    assert!(!symlink_target_stays_inside("link", "/absolute"));
    assert!(!symlink_target_stays_inside("link", "C:/x"));
    assert!(!symlink_target_stays_inside("link", ""));
    // Backslash forms climb or address a root on Windows (UNC,
    // drive-root-relative), so a portable manifest never blesses them.
    assert!(!symlink_target_stays_inside("link", "..\\..\\evil"));
    assert!(!symlink_target_stays_inside("link", "\\\\server\\share\\x"));
    assert!(!symlink_target_stays_inside("link", "\\root"));
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
fn verification_hashes_a_shared_blob_once_and_accepts_it() {
    // Two paths sharing one digest: every entry's size claim is checked,
    // the content hash runs once, and the snapshot verifies.
    let shared = digest(b"same\n");
    let manifest = bare_manifest(
        vec![
            CapturedEntry::File {
                path: "one.txt".to_string(),
                status: "??".to_string(),
                sha256: shared.clone(),
                bytes: 5,
                executable: false,
            },
            CapturedEntry::File {
                path: "two.txt".to_string(),
                status: "??".to_string(),
                sha256: shared,
                bytes: 5,
                executable: false,
            },
        ],
        vec![],
    );
    let staging = stage(&manifest, &[(&digest(b"same\n"), b"same\n")]);
    assert_eq!(verify_workspace_snapshot(staging.path()).unwrap(), manifest);
}

#[test]
fn verification_rejects_a_non_regular_file_manifest() {
    // A FIFO named manifest.json reports length zero but blocks the
    // open until a writer appears; it is a malformed staging area.
    #[cfg(unix)]
    {
        let staging = tempfile::tempdir().unwrap();
        let fifo = staging.path().join("manifest.json");
        let mkfifo = std::process::Command::new("mkfifo")
            .arg(&fifo)
            .output()
            .unwrap();
        assert!(mkfifo.status.success(), "mkfifo works on unix");
        let error = verify_workspace_snapshot(staging.path())
            .err()
            .unwrap()
            .to_string();
        assert!(error.contains("not a regular file"), "{error}");
    }
}

#[test]
fn verification_accepts_a_hand_built_snapshot() {
    let manifest = bare_manifest(
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
    let manifest = bare_manifest(
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
    let lying = bare_manifest(
        vec![CapturedEntry::File {
            path: "hello.txt".to_string(),
            status: "??".to_string(),
            sha256: digest(b"hello\n"),
            bytes: 99,
            executable: false,
        }],
        vec![],
    );
    let staging = stage(&lying, &[(&digest(b"hello\n"), b"hello\n")]);
    assert!(
        error(&staging).contains("manifest says"),
        "{}",
        error(&staging)
    );
}

#[test]
fn verification_rejects_baseline_tampering() {
    let head = "ee3a902349fa5446bf3edd1e1e8d8f7f48013081";
    let manifest = SnapshotManifest {
        version: 2,
        head_commit: Some(head.to_string()),
        baseline: Some(head_tree(vec![CapturedEntry::File {
            path: "a.txt".to_string(),
            status: "100644".to_string(),
            sha256: digest(b"a\n"),
            bytes: 2,
            executable: false,
        }])),
        captured: vec![],
        excluded: vec![],
    };
    let error = |staging: &tempfile::TempDir| {
        verify_workspace_snapshot(staging.path())
            .err()
            .unwrap()
            .to_string()
    };
    // A manifest head without a baseline is rejected.
    let headless = SnapshotManifest {
        baseline: None,
        ..manifest.clone()
    };
    let staging = stage(&headless, &[]);
    assert!(
        error(&staging).contains("no baseline in the manifest"),
        "{}",
        error(&staging)
    );
    // A baseline without a head commit is rejected.
    let headless = SnapshotManifest {
        head_commit: None,
        ..manifest.clone()
    };
    let staging = stage(&headless, &[]);
    assert!(
        error(&staging).contains("without a head commit"),
        "{}",
        error(&staging)
    );
    // A baseline entry's missing blob is rejected.
    let staging = stage(&manifest, &[]);
    assert!(
        error(&staging).contains("missing blob"),
        "{}",
        error(&staging)
    );
    // A tampered baseline blob fails the recorded hash.
    let staging = stage(&manifest, &[(&digest(b"a\n"), b"b\n")]);
    assert!(error(&staging).contains("hashes to"), "{}", error(&staging));
    // The untampered pair verifies.
    let staging = stage(&manifest, &[(&digest(b"a\n"), b"a\n")]);
    assert_eq!(verify_workspace_snapshot(staging.path()).unwrap(), manifest);
}

#[test]
fn verification_rejects_paths_claimed_by_two_lists() {
    let head = "ee3a902349fa5446bf3edd1e1e8d8f7f48013081";
    let error = |staging: &tempfile::TempDir| {
        verify_workspace_snapshot(staging.path())
            .err()
            .unwrap()
            .to_string()
    };
    // A delta path cannot be captured and excluded at once.
    let overlap = bare_manifest(
        vec![CapturedEntry::Deleted {
            path: "a.txt".to_string(),
            status: "D.".to_string(),
        }],
        vec![ExcludedEntry {
            path: "a.txt".to_string(),
            reason: ExcludeReason::NotRegularFile,
        }],
    );
    let staging = stage(&overlap, &[]);
    assert!(
        error(&staging).contains("claimed by both the captured and excluded lists"),
        "{}",
        error(&staging)
    );
    // Nor can a baseline path be staged and excluded at once.
    let overlap = SnapshotManifest {
        version: 2,
        head_commit: Some(head.to_string()),
        baseline: Some(Baseline::HeadTree {
            entries: vec![file_entry("a.txt", "100644", "a\n")],
            excluded: vec![ExcludedEntry {
                path: "a.txt".to_string(),
                reason: ExcludeReason::Secret,
            }],
        }),
        captured: vec![],
        excluded: vec![],
    };
    let staging = stage(&overlap, &[(&digest(b"a\n"), b"a\n")]);
    assert!(
        error(&staging).contains("claimed by both the baseline and baseline excluded lists"),
        "{}",
        error(&staging)
    );
    // Nor can the delta and the baseline carry the same path - the
    // delta holds the newer state, so the baseline must omit it.
    let overlap = SnapshotManifest {
        version: 2,
        head_commit: Some(head.to_string()),
        baseline: Some(head_tree(vec![file_entry("a.txt", "100644", "a\n")])),
        captured: vec![file_entry("a.txt", ".M", "b\n")],
        excluded: vec![],
    };
    let staging = stage(
        &overlap,
        &[(&digest(b"a\n"), b"a\n"), (&digest(b"b\n"), b"b\n")],
    );
    assert!(
        error(&staging).contains("claimed by both the captured and baseline lists"),
        "{}",
        error(&staging)
    );
}

#[test]
fn verification_rejects_deletions_in_a_head_tree_baseline() {
    // A deletion restates nothing HEAD's tree holds; it would tell the
    // materializer to remove a path the baseline exists to provide.
    let manifest = SnapshotManifest {
        version: 2,
        head_commit: Some("ee3a902349fa5446bf3edd1e1e8d8f7f48013081".to_string()),
        baseline: Some(head_tree(vec![CapturedEntry::Deleted {
            path: "a.txt".to_string(),
            status: "100644".to_string(),
        }])),
        captured: vec![],
        excluded: vec![],
    };
    let staging = stage(&manifest, &[]);
    let error = verify_workspace_snapshot(staging.path())
        .err()
        .unwrap()
        .to_string();
    assert!(error.contains("deletion in baseline"), "{error}");
}

#[test]
fn verification_rejects_bad_manifests() {
    let good = bare_manifest(
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
    // A manifest past the read cap is rejected before it is loaded: entry
    // counts are bounded at capture, so a larger file is tampering.
    let staging = tempfile::tempdir().unwrap();
    std::fs::write(
        staging.path().join("manifest.json"),
        vec![b'x'; super::verify::MAX_MANIFEST_BYTES as usize + 1],
    )
    .unwrap();
    let oversized = verify_workspace_snapshot(staging.path())
        .err()
        .unwrap()
        .to_string();
    assert!(oversized.contains("cap is"), "{oversized}");
    // Unsupported version.
    let future = SnapshotManifest {
        version: 3,
        ..good.clone()
    };
    let staging = stage(&future, &[]);
    assert!(
        error(&staging).contains("unsupported version"),
        "{}",
        error(&staging)
    );
    // Unsafe, duplicated, and unsorted paths.
    let escaping = bare_manifest(
        vec![CapturedEntry::Deleted {
            path: "../evil".to_string(),
            status: "D.".to_string(),
        }],
        vec![],
    );
    let staging = stage(&escaping, &[]);
    assert!(error(&staging).contains("unsafe"), "{}", error(&staging));
    // An unsafe path inside a HEAD-tree baseline is rejected too.
    let bad_baseline = SnapshotManifest {
        head_commit: Some("ee3a902349fa5446bf3edd1e1e8d8f7f48013081".to_string()),
        baseline: Some(head_tree(vec![CapturedEntry::Deleted {
            path: "../evil".to_string(),
            status: "100644".to_string(),
        }])),
        ..good.clone()
    };
    let staging = stage(&bad_baseline, &[]);
    assert!(error(&staging).contains("unsafe"), "{}", error(&staging));
    let duplicated = bare_manifest(
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
    let escaping_link = bare_manifest(
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
    let bad_digest = bare_manifest(
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
