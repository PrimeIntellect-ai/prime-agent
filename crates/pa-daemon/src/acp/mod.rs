//! ACP stdio mode served over a daemon session; see `daemon.rs`.

mod config_options;
pub mod daemon;
mod jsonrpc;
mod mcp;
mod meta;
mod producer;
mod types;
mod wire_config;
mod wire_events;

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

fn internal_error(id: &Value, details: &str) -> Value {
    jsonrpc::error_response(
        id,
        jsonrpc::INTERNAL_ERROR,
        "Internal error",
        Some(&json!({ "details": details })),
    )
}

/// The failed-turn reply: the #2117 classifier's category (`kind`) and
/// retryable verdict ride as typed data alongside the details, so an
/// ACP host can programmatically separate retryable model-transport
/// failures from harness bugs instead of guessing from the text (the
/// nano-rlm #200 `kind`/`retryable` contract; the retryable flag is
/// advisory — the host's own retry policy decides).
fn turn_failure_error(id: &Value, kind: &str, retryable: bool, details: &str) -> Value {
    jsonrpc::error_response(
        id,
        jsonrpc::INTERNAL_ERROR,
        "Internal error",
        Some(&json!({ "details": details, "kind": kind, "retryable": retryable })),
    )
}

/// Two paths are the same cwd when their canonical forms match, or when they
/// are the same directory on disk (dev/inode) — the bind-mount and
/// case-normalized-FS cases a lexical comparison misses.
fn same_cwd(requested: &Path, actual: &Path) -> bool {
    let canonical = |path: &Path| -> PathBuf {
        std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
    };
    let requested = canonical(requested);
    let actual = canonical(actual);
    if requested == actual {
        return true;
    }
    #[cfg(unix)]
    {
        let identity = |path: &Path| -> Option<(u64, u64)> {
            use std::os::unix::fs::MetadataExt;
            let metadata = std::fs::metadata(path).ok()?;
            if metadata.dev() == 0 || metadata.ino() == 0 {
                return None;
            }
            Some((metadata.dev(), metadata.ino()))
        };
        if let (Some(left), Some(right)) = (identity(&requested), identity(&actual)) {
            return left == right;
        }
    }
    false
}
