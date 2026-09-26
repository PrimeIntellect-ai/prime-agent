//! The cross-process runtime-ready memo: a tiny on-disk map of probe
//! verdicts keyed by the same identity composite as the in-process memo
//! ([`super::venv::runtime_probe_key`]). A fresh process — every cold open
//! boots a fresh worker, and every spawned child is one too — starts with
//! an empty in-process map, so this file is what carries the verdict
//! across process boundaries while the key (recomputed fresh on every
//! check: interpreter stat + installed `rlm`/`dill` content walk +
//! runtime identity + raw `.bootstrap-version` text) stays the damage
//! detector. Only the two interpreter probes are skipped on a hit, never
//! the witnesses.
//!
//! The file lives inside the venv directory: its trust domain is the
//! venv's own (anyone who can write here can already inject kernel
//! Python — the memo adds no attack surface), and its lifetime is the
//! venv's own (a rebuild removes it by construction). Every I/O error is
//! fail-open: an unreadable, corrupt, or unwritable memo costs one
//! re-probe, never a verdict.
//!
//! Managed-venv path only: a caller-owned `PRIME_AGENT_KERNEL_PYTHON`
//! override never reads or writes this memo (the d14 ruling — the
//! override path keeps the direct probe).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The on-disk schema. Bumped when the memo key format changes; every
/// entry written under an older schema then reads as a miss and
/// re-probes.
pub(crate) const DISK_MEMO_SCHEMA: u64 = 1;
pub(crate) const DISK_MEMO_FILE: &str = ".runtime-probe-memo.json";

/// Same bound and same clear-at-cap rule as the in-process memo: one
/// rule, two layers. A map (not a single entry) because keys churn with
/// the runtime identity — a single entry would re-probe on every
/// alternating binary in a shared venv.
const DISK_MEMO_CAP: usize = 16;

#[derive(Serialize, Deserialize)]
struct DiskMemo {
    schema: u64,
    keys: Vec<String>,
}

pub(crate) fn disk_memo_path(venv: &Path) -> PathBuf {
    venv.join(DISK_MEMO_FILE)
}

/// A hit requires a regular file at the memo path: a symlink or a
/// directory reads as a miss (fail-open), and the write side replaces a
/// symlink at the destination rather than following it.
pub(crate) fn disk_memo_hit(path: &Path, key: &str) -> bool {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    let Ok(raw) = std::fs::read(path) else {
        return false;
    };
    let Ok(memo) = serde_json::from_slice::<DiskMemo>(&raw) else {
        return false;
    };
    memo.schema == DISK_MEMO_SCHEMA && memo.keys.iter().any(|k| k == key)
}

/// Publish a successful probe verdict. The temp file is written inside
/// the venv dir and renamed over the memo path (rename replaces a symlink
/// at the destination instead of following it), so the map is never
/// observed half-written; same-process writers serialize on the
/// in-process probe-memo lock the caller holds, so the per-process temp
/// name cannot collide. Fail-open: an unwritable venv skips persistence
/// silently. A concurrent process's read-modify-write can lose the other
/// side's key — that costs one re-probe, never a verdict.
pub(crate) fn disk_memo_write(path: &Path, key: &str) {
    let mut keys = read_keys(path);
    keys.retain(|k| k != key);
    if keys.len() >= DISK_MEMO_CAP {
        keys.clear();
    }
    keys.push(key.to_string());
    write_map(path, &keys);
}

/// Ensure the memo at `path` serves no hits. Tries the delete first and
/// falls back to an atomic empty-map overwrite (an empty map serves no
/// hits by construction), so a delete failure after a failed kernel
/// start cannot resurrect the stale verdict on the retry. `false` means
/// both failed: the venv directory is read-only, in which case no
/// rebuild-based heal is possible in any design (the bootstrap itself
/// cannot rewrite `.bootstrap-version` there either) — the equivalence,
/// not a divergence, is the guarantee.
pub(crate) fn disk_memo_invalidate(path: &Path) -> bool {
    match std::fs::remove_file(path) {
        Ok(()) => true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
        Err(_) => {
            let tmp = tmp_path(path);
            let empty = DiskMemo {
                schema: DISK_MEMO_SCHEMA,
                keys: Vec::new(),
            };
            let Ok(body) = serde_json::to_vec(&empty) else {
                return false;
            };
            if std::fs::write(&tmp, &body).is_ok() && std::fs::rename(&tmp, path).is_ok() {
                true
            } else {
                let _ = std::fs::remove_file(&tmp);
                false
            }
        }
    }
}

fn read_keys(path: &Path) -> Vec<String> {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return Vec::new();
    };
    if !meta.is_file() {
        return Vec::new();
    }
    let Ok(raw) = std::fs::read(path) else {
        return Vec::new();
    };
    match serde_json::from_slice::<DiskMemo>(&raw) {
        Ok(memo) if memo.schema == DISK_MEMO_SCHEMA => memo.keys,
        _ => Vec::new(),
    }
}

fn write_map(path: &Path, keys: &[String]) {
    let map = DiskMemo {
        schema: DISK_MEMO_SCHEMA,
        keys: keys.to_vec(),
    };
    let Ok(body) = serde_json::to_vec(&map) else {
        return;
    };
    let tmp = tmp_path(path);
    if std::fs::write(&tmp, &body).is_err() {
        return;
    }
    if std::fs::rename(&tmp, path).is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
}

fn tmp_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().map_or_else(
        || DISK_MEMO_FILE.to_string(),
        |name| name.to_string_lossy().into_owned(),
    );
    name.push_str(&format!(".tmp.{}", std::process::id()));
    path.with_file_name(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memo_keys(path: &Path) -> Vec<String> {
        read_keys(path)
    }

    #[test]
    fn write_then_hit_and_dedupe() {
        let dir = tempfile::tempdir().unwrap();
        let path = disk_memo_path(dir.path());
        disk_memo_write(&path, "k1");
        assert!(disk_memo_hit(&path, "k1"));
        assert!(!disk_memo_hit(&path, "k2"));
        disk_memo_write(&path, "k1");
        assert_eq!(memo_keys(&path), vec!["k1".to_string()], "dedupe");
        disk_memo_write(&path, "k2");
        assert_eq!(memo_keys(&path), vec!["k1".to_string(), "k2".to_string()]);
        // The published file is regular and parseable.
        assert!(std::fs::symlink_metadata(&path).is_ok_and(|m| m.is_file()));
    }

    #[test]
    fn cap_then_clear_matches_the_in_process_rule() {
        let dir = tempfile::tempdir().unwrap();
        let path = disk_memo_path(dir.path());
        for i in 0..DISK_MEMO_CAP {
            disk_memo_write(&path, &format!("k{i}"));
        }
        assert_eq!(memo_keys(&path).len(), DISK_MEMO_CAP);
        disk_memo_write(&path, "fresh");
        assert_eq!(
            memo_keys(&path),
            vec!["fresh".to_string()],
            "cap clears the map like the in-process memo"
        );
    }

    #[test]
    fn stale_and_forged_entries_never_hit() {
        let dir = tempfile::tempdir().unwrap();
        let path = disk_memo_path(dir.path());
        // Wrong key, right shape.
        disk_memo_write(&path, "other");
        assert!(!disk_memo_hit(&path, "mine"));
        // Wrong schema.
        std::fs::write(
            &path,
            serde_json::json!({"schema": DISK_MEMO_SCHEMA + 1, "keys": ["mine"]}).to_string(),
        )
        .unwrap();
        assert!(!disk_memo_hit(&path, "mine"));
        // Corrupt JSON and an empty file.
        std::fs::write(&path, "{not-json").unwrap();
        assert!(!disk_memo_hit(&path, "mine"));
        std::fs::write(&path, "").unwrap();
        assert!(!disk_memo_hit(&path, "mine"));
        // A directory at the memo path is never a hit.
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();
        assert!(!disk_memo_hit(&path, "mine"));
        std::fs::remove_dir(&path).unwrap();
        // A symlink at the memo path is never followed to a hit.
        #[cfg(unix)]
        {
            let target = dir.path().join("target.json");
            disk_memo_write(&target, "mine");
            std::os::unix::fs::symlink(&target, &path).unwrap();
            assert!(
                !disk_memo_hit(&path, "mine"),
                "a linked memo file reads as a miss, never followed"
            );
            // The write side replaces the symlink itself, not the target.
            disk_memo_write(&path, "fresh");
            assert!(std::fs::symlink_metadata(&path).is_ok_and(|m| m.is_file()));
            assert!(disk_memo_hit(&path, "fresh"));
            assert!(
                std::fs::symlink_metadata(&target).is_ok_and(|m| m.is_file()),
                "the symlink's target stays untouched"
            );
            assert_eq!(memo_keys(&target), vec!["mine".to_string()]);
        }
    }

    #[test]
    fn invalidate_serves_no_hits_with_the_fallback() {
        let dir = tempfile::tempdir().unwrap();
        let path = disk_memo_path(dir.path());
        disk_memo_write(&path, "k1");
        assert!(disk_memo_invalidate(&path));
        assert!(!disk_memo_hit(&path, "k1"), "delete removes the verdict");
        assert!(!path.exists(), "plain delete removed the file");
        // Missing file: still true (nothing to serve).
        assert!(disk_memo_invalidate(&path));
        // Undeletable-but-writable: the fallback overwrites with the
        // empty map, which serves no hits. (Deterministic across
        // privileges: the fallback is pinned directly here; the
        // both-fail equivalence is the next test.)
        disk_memo_write(&path, "k1");
        write_map(&path, &[]);
        assert!(disk_memo_invalidate(&path));
        assert!(path.exists());
        assert!(!disk_memo_hit(&path, "k1"), "the empty map serves no hits");
        // Both fail (a directory occupies the memo path): documented
        // equivalence — a read-only venv admits no rebuild-based heal in
        // any design.
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();
        assert!(!disk_memo_invalidate(&path));
        std::fs::remove_dir(&path).unwrap();
    }

    #[test]
    fn unwritable_dir_is_fail_open_on_write() {
        let dir = tempfile::tempdir().unwrap();
        let unwritable = dir.path().join("unwritable");
        std::fs::create_dir(&unwritable).unwrap();
        let path = disk_memo_path(&unwritable);
        // A missing venv dir: the write skips persistence silently.
        disk_memo_write(&path, "k1");
        assert!(!path.exists());
    }
}
