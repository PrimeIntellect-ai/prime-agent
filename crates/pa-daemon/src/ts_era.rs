use std::path::Path;

pub(crate) fn sweep_ts_era_leftovers(agent_dir: &Path) -> usize {
    let mut removed = 0;
    for target in [
        agent_dir.join("prime-inference-models-cache.json"),
        agent_dir.join("agent-traces-outbox.json"),
        agent_dir.join("worker-snapshot-cache"),
    ] {
        let gone = match std::fs::remove_file(&target) {
            Ok(()) => true,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Err(_) => std::fs::remove_dir_all(&target).is_ok(),
        };
        removed += usize::from(gone);
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removes_the_ts_leftovers_and_spares_the_rust_read_siblings() {
        let dir = tempfile::tempdir().expect("temp dir");
        let agent_dir = dir.path().join("agent");
        let models_dir = agent_dir.join("models");
        std::fs::create_dir_all(&models_dir).expect("models dir");
        let outbox_dir = agent_dir.join("agent-traces-outbox");
        std::fs::create_dir_all(&outbox_dir).expect("outbox dir");
        std::fs::write(agent_dir.join("prime-inference-models-cache.json"), "{}").expect("stale");
        std::fs::write(models_dir.join("prime-inference-models-cache.json"), "{}")
            .expect("live cache");
        std::fs::write(agent_dir.join("agent-traces-outbox.json"), "{}").expect("outbox marker");
        std::fs::write(outbox_dir.join("hash.json"), "{}").expect("outbox entry");
        std::fs::write(agent_dir.join("cron-jobs.json"), "{}").expect("cron fallback");
        std::fs::create_dir_all(agent_dir.join("harness")).expect("harness dir");
        std::fs::write(agent_dir.join("harness/refinements.jsonl"), "{}").expect("history");

        assert_eq!(sweep_ts_era_leftovers(&agent_dir), 2);

        assert!(!agent_dir.join("prime-inference-models-cache.json").exists());
        assert!(!agent_dir.join("agent-traces-outbox.json").exists());
        assert!(models_dir
            .join("prime-inference-models-cache.json")
            .exists());
        assert!(outbox_dir.join("hash.json").exists());
        assert!(agent_dir.join("cron-jobs.json").exists());
        assert!(agent_dir.join("harness/refinements.jsonl").exists());
    }

    #[test]
    fn removes_the_worker_snapshot_cache_dir() {
        let dir = tempfile::tempdir().expect("temp dir");
        let agent_dir = dir.path().join("agent");
        let cache = agent_dir.join("worker-snapshot-cache");
        std::fs::create_dir_all(cache.join("u-1")).expect("cache dir");
        std::fs::write(cache.join("u-1/snapshot.json"), "{}").expect("snapshot");

        assert_eq!(sweep_ts_era_leftovers(&agent_dir), 1);
        assert!(!cache.exists());
    }
}
