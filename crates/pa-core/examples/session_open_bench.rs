//! Read-only context parity and cold/warm latency probe. Use copies of private sessions.
use std::path::Path;
use std::time::Instant;

use pa_core::session::{
    build_session_context, parse_session_entries, window::WindowedSessionStore,
};

fn main() -> anyhow::Result<()> {
    for arg in std::env::args().skip(1) {
        let path = Path::new(&arg);
        let size = path.metadata()?.len();
        let started = Instant::now();
        let text = std::fs::read_to_string(path)?;
        let entries = parse_session_entries(&text);
        let baseline = build_session_context(&entries, None);
        let full_ms = started.elapsed().as_secs_f64() * 1000.0;
        let expected = serde_json::to_vec(&baseline.messages)?;
        println!(
            "fixture={} bytes={size} full_ms={full_ms:.3}",
            path.file_name().unwrap().to_string_lossy()
        );
        let cache_path = path.with_extension("window-cache.json");
        if cache_path.exists() {
            std::fs::remove_file(&cache_path)?;
        }
        for pass in 0..8 {
            let started = Instant::now();
            let Some(window) = WindowedSessionStore::open(path)? else {
                anyhow::bail!("fixture did not use window reader: {}", path.display());
            };
            let reads = window.read_stats();
            let context = window.context();
            let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
            anyhow::ensure!(
                serde_json::to_vec(&context.messages)? == expected,
                "context mismatch"
            );
            anyhow::ensure!(context.model == baseline.model, "model mismatch");
            anyhow::ensure!(
                context.thinking_level == baseline.thinking_level,
                "thinking mismatch"
            );
            anyhow::ensure!(
                context.service_tier == baseline.service_tier,
                "tier mismatch"
            );
            println!("pass={pass} elapsed_ms={elapsed_ms:.3} retained_entries={} context_bytes={} parity=exact cache_hit={} jsonl_bytes={} cache_bytes={} ranges={:?}", window.entries().len(), expected.len(), reads.cache_hit, reads.jsonl_bytes, reads.cache_bytes, reads.jsonl_ranges);
        }
    }
    Ok(())
}
