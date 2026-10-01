//! Git enumeration for workspace snapshots: one bounded `git status` run
//! yields the worktree delta (tracked modifications and deletions, plus
//! nonignored untracked paths) and the HEAD commit.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use super::SnapshotError;

/// Hard cap on `git status` output kept in memory. Past it the snapshot
/// aborts rather than silently truncating the capture set; the entry limit
/// normally trips first.
const MAX_STATUS_OUTPUT_BYTES: usize = 32 * 1024 * 1024;

/// Cap on captured git stderr (diagnostic text only).
const MAX_STDERR_BYTES: usize = 64 * 1024;

/// The submodule gitlink mode: a reference to a nested commit rather than
/// a file whose content can be captured.
const GITLINK_MODE: &str = "160000";

/// One `git status --porcelain=v2` record a snapshot cares about.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum StatusEntry {
    /// A tracked path with changes staged, unstaged, or both (`1`
    /// records), or an unmerged conflict path (`u` records). `gitlink`
    /// marks a submodule reference (mode `160000` in the index or the
    /// worktree), whose content is never captured.
    Tracked {
        path: String,
        xy: String,
        gitlink: bool,
    },
    /// A nonignored untracked path (`?` records). Paths ending in `/` are
    /// directories git declined to recurse into (nested repositories).
    Untracked { path: String },
}

impl StatusEntry {
    pub(crate) fn path(&self) -> &str {
        match self {
            StatusEntry::Tracked { path, .. } | StatusEntry::Untracked { path } => path,
        }
    }
}

/// The parsed status: the HEAD commit (absent on an unborn branch) and the
/// delta entries, sorted by path.
#[derive(Clone, Debug)]
pub(crate) struct GitStatus {
    pub(crate) head_commit: Option<String>,
    pub(crate) entries: Vec<StatusEntry>,
}

/// Resolve `dir` to the root of the git worktree it sits in; porcelain
/// paths are relative to that root, so it is the base for every read.
pub(crate) async fn resolve_worktree_root(
    dir: &Path,
    timeout_ms: u64,
) -> Result<PathBuf, SnapshotError> {
    let output = run_git(&["rev-parse", "--show-toplevel"], dir, timeout_ms).await?;
    let top = String::from_utf8(output)
        .map_err(|error| SnapshotError::Git {
            detail: format!("git rev-parse output is not UTF-8: {error}"),
        })?
        .trim_end()
        .to_string();
    if top.is_empty() {
        return Err(SnapshotError::Git {
            detail: "git rev-parse returned no worktree root".to_string(),
        });
    }
    Ok(PathBuf::from(top))
}

/// Read the worktree delta with one `git status --porcelain=v2` run
/// (NUL-separated, no rename detection, all untracked files enumerated).
pub(crate) async fn read_worktree_status(
    root: &Path,
    timeout_ms: u64,
) -> Result<GitStatus, SnapshotError> {
    let output = run_git(
        &[
            "--no-optional-locks",
            "status",
            "--porcelain=v2",
            "-z",
            "--branch",
            "--no-renames",
            "--untracked-files=all",
        ],
        root,
        timeout_ms,
    )
    .await?;
    parse_status(&output)
}

/// Run one git command, capturing stdout (bounded) and failing with a
/// classified [`SnapshotError`] on a non-zero exit or a timeout.
///
/// The pipes are drained concurrently with the wait: a child that writes
/// more than the OS pipe capacity would otherwise block forever on write
/// (the status output of a large untracked tree easily exceeds it), so
/// the drain futures, the wait, and one shared deadline race together.
/// The git child commands' environment: git-discovery variables inherited
/// from the caller would redirect every command to a different repository
/// or index than `cwd` (`GIT_DIR`/`GIT_WORK_TREE` select the tree the manifest
/// claims to describe), so they are scrubbed and the snapshot's git view
/// is always `cwd`'s own.
pub(super) fn git_command(args: &[&str], cwd: &Path) -> tokio::process::Command {
    const GIT_SELECTION_VARS: [&str; 7] = [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_COMMON_DIR",
        "GIT_NAMESPACE",
    ];
    let mut command = tokio::process::Command::new("git");
    command.args(args).current_dir(cwd);
    for variable in GIT_SELECTION_VARS {
        command.env_remove(variable);
    }
    command
}

async fn run_git(args: &[&str], cwd: &Path, timeout_ms: u64) -> Result<Vec<u8>, SnapshotError> {
    let mut command = git_command(args, cwd);
    let mut child = command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| SnapshotError::Git {
            detail: format!("failed to spawn git: {error}"),
        })?;
    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();
    let drain_and_wait = async {
        let wait = async {
            child.wait().await.map_err(|error| SnapshotError::Git {
                detail: format!("failed to reap git: {error}"),
            })
        };
        let stdout = read_pipe_capped(stdout_pipe, MAX_STATUS_OUTPUT_BYTES);
        let stderr = read_pipe_capped(stderr_pipe, MAX_STDERR_BYTES);
        let (status, (stdout, stdout_truncated), (stderr, stderr_truncated)) =
            tokio::join!(wait, stdout, stderr);
        let status = status?;
        if !status.success() {
            let mut detail = String::from_utf8_lossy(&stderr).trim().to_string();
            if detail.is_empty() {
                detail = format!("git exited with status {status}");
            }
            if detail.contains("not a git repository")
                || detail.contains("must be run in a work tree")
            {
                return Err(SnapshotError::NotAWorktree {
                    path: cwd.to_path_buf(),
                    detail,
                });
            }
            return Err(SnapshotError::Git { detail });
        }
        if stdout_truncated || stderr_truncated {
            return Err(SnapshotError::Git {
                detail: format!("git {} output exceeded its cap", args.join(" ")),
            });
        }
        Ok(stdout)
    };
    tokio::time::timeout(
        tokio::time::Duration::from_millis(timeout_ms.max(1)),
        drain_and_wait,
    )
    .await
    .map_err(|_| SnapshotError::Git {
        detail: format!("git {} timed out after {timeout_ms}ms", args.join(" ")),
    })?
}

/// Read one output pipe to EOF, keeping at most `cap` bytes; the remainder
/// is drained so a full pipe never blocks the child. Truncation is
/// reported so callers can fail instead of acting on partial output.
async fn read_pipe_capped<R: tokio::io::AsyncRead + Unpin>(
    mut pipe: Option<R>,
    cap: usize,
) -> (Vec<u8>, bool) {
    use tokio::io::AsyncReadExt;
    let mut kept: Vec<u8> = Vec::new();
    let mut truncated = false;
    if let Some(pipe) = pipe.as_mut() {
        let mut chunk = vec![0u8; 16 * 1024];
        loop {
            match pipe.read(&mut chunk).await {
                Ok(0) => break,
                Ok(read) => {
                    let room = cap.saturating_sub(kept.len());
                    kept.extend_from_slice(&chunk[..read.min(room)]);
                    if read > room {
                        truncated = true;
                    }
                }
                Err(_) => {
                    truncated = true;
                    break;
                }
            }
        }
    }
    (kept, truncated)
}

/// One entry of HEAD's tree, from `git ls-tree -r`: a path with its mode.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct HeadTreeEntry {
    pub(crate) path: String,
    /// The git mode string (`100644`, `100755`, `120000`, `160000`).
    pub(crate) mode: String,
    /// A submodule gitlink rather than a file.
    pub(crate) gitlink: bool,
    /// The index marks the path skip-worktree (a sparse checkout, or
    /// `update-index --skip-worktree`): `git status` never reports its
    /// worktree state, so an absent leaf is by design, not a mutation.
    pub(crate) skip_worktree: bool,
    /// The object id HEAD records for the path (a blob id, or the
    /// gitlink commit id); the baseline verifies captured bytes against
    /// it, `git hash-object` equivalent.
    pub(crate) oid: String,
}

/// Read every path in `commit`'s tree, where `commit` is the object id
/// the preceding `git status` reported for HEAD. Enumerating that id
/// (instead of re-resolving `HEAD`) pins the baseline to the commit the
/// manifest will state: a concurrent commit between the two commands
/// can no longer pair the old head commit with a newer HEAD's tree, and
/// a vanished or rewritten object fails `ls-tree` loudly here. The
/// baseline stages these contents from the (unmodified) worktree, so
/// this is enumeration only - no history, no object payloads. The
/// index's skip-worktree bits ride along so the baseline can tell an
/// absent sparse path from a vanished one.
pub(crate) async fn read_head_tree(
    root: &Path,
    commit: &str,
    timeout_ms: u64,
) -> Result<Vec<HeadTreeEntry>, SnapshotError> {
    let output = run_git(&["ls-tree", "-r", "-z", commit], root, timeout_ms).await?;
    let index = run_git(&["ls-files", "-t", "-z"], root, timeout_ms).await?;
    let text = String::from_utf8(index).map_err(|_| SnapshotError::MalformedStatus {
        detail: "ls-files output is not UTF-8".to_string(),
    })?;
    let skip_worktree: HashSet<&str> = text
        .split('\0')
        .filter_map(|record| record.strip_prefix("S "))
        .collect();
    parse_head_tree(&output, &skip_worktree)
}

/// Parse NUL-separated `git ls-tree -r -z` records:
/// `<mode> <type> <object>\t<path>`.
fn parse_head_tree(
    output: &[u8],
    skip_worktree: &HashSet<&str>,
) -> Result<Vec<HeadTreeEntry>, SnapshotError> {
    let text = std::str::from_utf8(output).map_err(|_| SnapshotError::MalformedStatus {
        detail: "ls-tree output is not UTF-8".to_string(),
    })?;
    let mut entries = Vec::new();
    for record in text.split('\0') {
        if record.is_empty() {
            continue;
        }
        let Some((meta, path)) = record.split_once('\t') else {
            return Err(SnapshotError::MalformedStatus {
                detail: format!("unrecognized ls-tree record {record:?}"),
            });
        };
        let mut fields = meta.split(' ');
        let (Some(mode), Some(kind), Some(oid)) = (fields.next(), fields.next(), fields.next())
        else {
            return Err(SnapshotError::MalformedStatus {
                detail: format!("malformed ls-tree metadata {meta:?}"),
            });
        };
        if path.is_empty() {
            return Err(SnapshotError::MalformedStatus {
                detail: format!("empty ls-tree path for {meta:?}"),
            });
        }
        entries.push(HeadTreeEntry {
            path: path.to_string(),
            mode: mode.to_string(),
            gitlink: kind == "commit",
            skip_worktree: skip_worktree.contains(path),
            oid: oid.to_string(),
        });
    }
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(entries)
}

/// Parse NUL-separated `git status --porcelain=v2 --branch` output into a
/// [`GitStatus`]. Records are sorted by path for deterministic capture.
pub(crate) fn parse_status(output: &[u8]) -> Result<GitStatus, SnapshotError> {
    let text = std::str::from_utf8(output).map_err(|_| SnapshotError::MalformedStatus {
        detail: "status output is not UTF-8".to_string(),
    })?;
    let mut head_commit = None;
    let mut entries = Vec::new();
    for record in text.split('\0') {
        if record.is_empty() {
            continue;
        }
        if let Some(oid) = record.strip_prefix("# branch.oid ") {
            // An unborn branch reports "(initial)"; no commit exists yet.
            if oid != "(initial)" {
                head_commit = Some(oid.to_string());
            }
            continue;
        }
        if record.starts_with('#') {
            continue; // branch.head / branch.upstream / branch.ab headers.
        }
        if let Some(path) = record.strip_prefix("? ") {
            entries.push(StatusEntry::Untracked {
                path: path.to_string(),
            });
            continue;
        }
        if record.starts_with("! ") {
            continue; // ignored paths are never captured.
        }
        if record.starts_with("1 ") || record.starts_with("u ") {
            entries.push(parse_tracked_record(record)?);
            continue;
        }
        return Err(SnapshotError::MalformedStatus {
            detail: format!("unrecognized status record {record:?}"),
        });
    }
    entries.sort_by(|a, b| a.path().cmp(b.path()));
    Ok(GitStatus {
        head_commit,
        entries,
    })
}

/// Parse one `1` (changed tracked) or `u` (unmerged conflict) record. The
/// path is the last field in both, but the field counts differ:
/// `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>` (nine fields) —
/// gitlink when the index (`mI`) or worktree (`mW`) mode is `160000`;
/// `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>` (eleven
/// fields) — gitlink when the stage-3 (`m3`) or worktree (`mW`) mode is
/// `160000`.
fn parse_tracked_record(record: &str) -> Result<StatusEntry, SnapshotError> {
    let malformed = |detail: String| SnapshotError::MalformedStatus {
        detail: format!("malformed status record {record:?}: {detail}"),
    };
    let conflict = record.starts_with("u ");
    let field_count = if conflict { 11 } else { 9 };
    let fields: Vec<&str> = record.splitn(field_count, ' ').collect();
    if fields.len() != field_count {
        return Err(malformed(format!(
            "expected {field_count} fields, found {}",
            fields.len()
        )));
    }
    let xy = fields[1];
    let path = fields[field_count - 1];
    if xy.len() != 2 || !xy.is_ascii() {
        return Err(malformed(format!("bad XY field {xy:?}")));
    }
    if path.is_empty() {
        return Err(malformed("empty path".to_string()));
    }
    // Field 2 is the submodule state; the mode fields follow, ending at
    // the worktree mode right before the hash fields.
    let gitlink = if conflict {
        fields[5] == GITLINK_MODE || fields[6] == GITLINK_MODE
    } else {
        fields[4] == GITLINK_MODE || fields[5] == GITLINK_MODE
    };
    Ok(StatusEntry::Tracked {
        path: path.to_string(),
        xy: xy.to_string(),
        gitlink,
    })
}
