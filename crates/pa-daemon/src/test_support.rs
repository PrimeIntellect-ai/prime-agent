//! Test-only shared state: one crate-wide lock for the process env.

/// Process-wide env reads and writes (the telemetry override vars)
/// serialize through one lock across the crate's test modules: parallel
/// test threads in the same binary otherwise race the process env. Both
/// the supervisor tests' scrub guard and `agent_engine`'s
/// `telemetry_opt_in` hold this lock through their restores.
#[cfg(test)]
pub(crate) static TELEMETRY_ENV_MUTEX: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Write a harness store holding one factory spec per id (plus a memory, which never counts as a
/// spec) — the on-disk shape the kernel's harness writes.
#[cfg(test)]
pub(crate) fn write_factory_specs(harness_dir: &std::path::Path, ids: &[&str]) {
    let entry = |id: &str, kind: &str| {
        serde_json::json!({
            "id": id, "kind": kind, "title": id, "content": "", "path": "general",
            "reference": {}, "arguments": {}, "metadata": {}, "source": "agent",
            "created_at": "2026-10-16T00:00:00Z", "updated_at": "2026-10-16T00:00:00Z",
            "version": 1,
        })
    };
    let factory: serde_json::Map<String, serde_json::Value> = ids
        .iter()
        .map(|id| ((*id).to_string(), entry(id, "factory")))
        .collect();
    std::fs::create_dir_all(harness_dir).unwrap();
    std::fs::write(
        pa_core::refinement::get_harness_state_path(harness_dir),
        serde_json::json!({
            "schema": 1,
            "entries": { "factory": factory, "memory": { "m": entry("m", "memory") } },
            "refinements": [],
        })
        .to_string(),
    )
    .unwrap();
}

/// Hold a real file read behind a FIFO until another future on the same
/// current-thread runtime releases it. A bounded rescue makes the synchronous
/// regression fail without hanging the process; restore the file before asserting.
#[cfg(all(test, unix))]
pub(crate) async fn assert_async_file_read<T>(
    path: &std::path::Path,
    read: impl std::future::Future<Output = T>,
) -> T {
    let raw = std::fs::read(path).expect("original state");
    std::fs::remove_file(path).expect("replace state with FIFO");
    assert!(std::process::Command::new("mkfifo")
        .arg(path)
        .status()
        .expect("mkfifo")
        .success());
    let (opened_tx, opened_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let fifo_path = path.to_path_buf();
    let fifo_raw = raw.clone();
    let writer = std::thread::spawn(move || {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .open(fifo_path)
            .expect("FIFO writer");
        opened_tx.send(()).expect("reader opened");
        let responsive = release_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .is_ok();
        file.write_all(&fifo_raw).expect("release file read");
        responsive
    });
    let (result, ()) = tokio::join!(read, async {
        opened_rx.await.expect("storage read started");
        let _ = release_tx.send(());
    });
    let responsive = writer.join().expect("FIFO writer");
    std::fs::remove_file(path).expect("remove FIFO");
    std::fs::write(path, raw).expect("restore state");
    assert!(
        responsive,
        "the storage read must not block the async executor"
    );
    result
}
