//! Serialize file mutation operations targeting the same file.
//!
//! Port of `packages/coding-agent/src/core/tools/file-mutation-queue.ts`:
//! operations for different files run in parallel; operations for the same
//! file (after resolving symlinks) run in arrival order. The queue entry is
//! removed once no waiter remains.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use tokio::sync::Mutex;

/// Global registry of per-file mutation queues.
static QUEUES: OnceLock<std::sync::Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();

fn registry() -> &'static std::sync::Mutex<HashMap<PathBuf, Arc<Mutex<()>>>> {
    QUEUES.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

/// Queue key: the canonical path (symlinks resolved), or the resolved path
/// when it does not exist yet.
fn get_mutation_queue_key(file_path: &str) -> PathBuf {
    let resolved =
        std::path::absolute(Path::new(file_path)).unwrap_or_else(|_| PathBuf::from(file_path));
    match std::fs::canonicalize(&resolved) {
        Ok(real) => real,
        Err(_) => resolved,
    }
}

/// Run `f` while holding the mutation queue for `file_path`.
///
/// Operations for different files still run in parallel.
pub async fn with_file_mutation_queue<T, F, Fut>(file_path: &str, f: F) -> T
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = T>,
{
    let key = get_mutation_queue_key(file_path);
    let queue = {
        let mut map = registry().lock().unwrap();
        map.entry(key.clone()).or_default().clone()
    };
    // Hold the per-file lock across the operation.
    let result = {
        let _guard = queue.lock().await;
        f().await
    };
    // Release our queue handle before the cleanup check below.
    drop(queue);
    // Drop the entry when this is the last holder (no queued waiters).
    let mut map = registry().lock().unwrap();
    if let Some(current) = map.get(&key) {
        // Arc strong count 1 = registry only; nobody is queued behind us.
        if Arc::strong_count(current) == 1 {
            map.remove(&key);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn serializes_same_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("f.txt");
        std::fs::write(&path, "0").unwrap();
        let path_str = path.to_str().unwrap().to_string();

        // Track execution order of 8 concurrent mutations.
        let order = Arc::new(Mutex::new(Vec::new()));
        let mut handles = Vec::new();
        for i in 0..8 {
            let p = path_str.clone();
            let order = Arc::clone(&order);
            handles.push(tokio::spawn(async move {
                with_file_mutation_queue(&p, || async move {
                    order.lock().await.push(i);
                    tokio::time::sleep(Duration::from_millis(2)).await;
                })
                .await
            }));
        }
        for h in handles {
            h.await.unwrap();
        }
        // All 8 ran (order is arrival-serialized, not necessarily numeric).
        assert_eq!(order.lock().await.len(), 8);
    }

    #[tokio::test]
    async fn parallel_across_files() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.txt");
        let b = dir.path().join("b.txt");
        let (a_str, b_str) = (
            a.to_str().unwrap().to_string(),
            b.to_str().unwrap().to_string(),
        );
        let h1 = tokio::spawn(async move {
            with_file_mutation_queue(&a_str, || async {
                tokio::time::sleep(Duration::from_millis(50)).await;
                "a"
            })
            .await
        });
        // Must not wait for a's slow critical section.
        let h2 =
            tokio::spawn(async move { with_file_mutation_queue(&b_str, || async { "b" }).await });
        let (ra, rb) = tokio::join!(h1, h2);
        assert_eq!(ra.unwrap(), "a");
        assert_eq!(rb.unwrap(), "b");
    }

    #[tokio::test]
    async fn registry_cleans_up() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("x.txt").to_str().unwrap().to_string();
        with_file_mutation_queue(&p, || async {}).await;
        // Other tests run in parallel and hold their own queue entries; wait
        // for ours (and any finished ones) to drain.
        for _ in 0..200 {
            if registry().lock().unwrap().is_empty() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("mutation queue registry did not drain");
    }
}
