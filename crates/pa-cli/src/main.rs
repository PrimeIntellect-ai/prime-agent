fn main() {
    // Allocator tuning before any thread spawns: the session-load and
    // attach-snapshot phases are large transient bursts, and glibc's
    // per-thread arenas otherwise keep each burst's high-water pages
    // resident for the process lifetime.
    pa_core::memory_release::cap_thread_arenas();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let code = pa_cli::main_with_runtime(args, &pa_cli::PrintRuntime);
    std::process::exit(code);
}
