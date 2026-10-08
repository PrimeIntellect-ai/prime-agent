fn main() {
    // Allocator tuning before any thread spawns: the session-load and
    // attach-snapshot phases are large transient bursts, and glibc's
    // per-thread arenas otherwise keep each burst's high-water pages
    // resident for the process lifetime.
    pa_types::memory_release::cap_thread_arenas();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let code = pa_cli::main_with_runtime(&args, &pa_cli::PrintRuntime);
    // The console codepages are console-SESSION state: the interactive
    // shell the process hands back must not inherit 65001 when it was not
    // the shell's own (a no-op when nothing was prepared).
    pa_types::platform::console_restore();
    std::process::exit(code);
}
