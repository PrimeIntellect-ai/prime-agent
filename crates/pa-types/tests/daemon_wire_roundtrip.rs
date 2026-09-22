//! Round-trip tests over captured daemon wire data.
//!
//! The committed descriptor corpus in `tests/data/` is the verifier: every
//! descriptor must deserialize into [`DaemonWorkerDescriptor`] and
//! re-serialize losslessly. Live descriptors are real daemon state on the
//! host, so they are only read when explicitly opted in with
//! `PA_TYPES_LIVE_WORKERS=1`; the default test run is hermetic.

use pa_types::daemon::DaemonWorkerDescriptor;
use serde_json::Value;
use std::path::PathBuf;

fn roundtrip_descriptor(raw: &str, path: &std::path::Path) {
    let parsed: DaemonWorkerDescriptor = serde_json::from_str(raw)
        .unwrap_or_else(|e| panic!("{}: deserialize failed: {e}", path.display()));
    let out = serde_json::to_string(&parsed).expect("serialize descriptor");
    let original: Value = serde_json::from_str(raw).unwrap();
    let roundtripped: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(
        original,
        roundtripped,
        "{}: round trip changed the value",
        path.display()
    );
}

#[test]
fn committed_fixture_roundtrips() {
    let mut count = 0usize;
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/data");
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path
            .file_name()
            .and_then(|n| n.to_str())
            .is_none_or(|n| !n.starts_with("worker-descriptor"))
            || path.extension().and_then(|e| e.to_str()) != Some("json")
        {
            continue;
        }
        let raw = std::fs::read_to_string(&path).expect("read descriptor fixture");
        roundtrip_descriptor(&raw, &path);
        count += 1;
    }
    assert!(count > 0, "no worker descriptor fixtures found");
}

/// Live descriptors are opt-in: they are real daemon state whose presence
/// varies per machine, so a default test run must not depend on them. Set
/// `PA_TYPES_LIVE_WORKERS=1` (optionally with `PA_TYPES_WORKERS_DIR`
/// pointing at a daemon-workers tree) to sweep them.
#[test]
fn live_worker_descriptors_roundtrip_losslessly() {
    if std::env::var_os("PA_TYPES_LIVE_WORKERS").as_deref() != Some(std::ffi::OsStr::new("1")) {
        eprintln!("PA_TYPES_LIVE_WORKERS not set; skipping live-data sweep");
        return;
    }
    let dir = std::env::var_os("PA_TYPES_WORKERS_DIR")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME").map(|h| {
                PathBuf::from(h)
                    .join(".prime")
                    .join("agent")
                    .join("daemon-workers")
            })
        })
        .unwrap_or_else(|| panic!("PA_TYPES_LIVE_WORKERS=1 but no workers dir configured"));
    assert!(dir.is_dir(), "workers dir not found: {}", dir.display());
    let mut count = 0usize;
    let mut stack = vec![dir];
    while let Some(dir) = stack.pop() {
        let entries = std::fs::read_dir(&dir).expect("read workers dir");
        for entry in entries {
            let path = entry.unwrap().path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let raw = std::fs::read_to_string(&path).expect("read descriptor");
            roundtrip_descriptor(&raw, &path);
            count += 1;
        }
    }
    assert!(count > 0, "no worker descriptors found to verify");
    eprintln!("round-tripped {count} worker descriptors");
}
