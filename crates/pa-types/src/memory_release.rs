//! Returning freed heap to the OS after large transient phases.
//!
//! Session loads and attach snapshots allocate several transient copies of
//! the session body (parsed entry trees, wire JSON, replay contexts) that
//! are dropped right after the phase ends. glibc keeps freed chunks in its
//! arenas, so those phases' peaks stay resident in RSS forever. The helpers
//! here are pure allocator plumbing: no data, capability, or protocol
//! behavior changes, and they are no-ops wherever the platform has no
//! glibc seam (every non-glibc/Linux build).

/// Cap glibc's per-thread arenas.
///
/// The default arena limit (`8 * ncores`) lets a burst of allocation from
/// tokio worker and blocking-pool threads grow one arena per thread; every
/// arena keeps its high-water pages. A small cap keeps the parallelism the
/// runtime actually uses while collapsing that sprawl.
pub fn cap_thread_arenas() {
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    unsafe {
        libc::mallopt(libc::M_ARENA_MAX, 4);
    }
}

/// Return freed heap pages to the OS after a large transient phase.
pub fn trim_freed_heap() {
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    unsafe {
        libc::malloc_trim(0);
    }
}

/// Trim only when a phase actually allocated: `bytes` is the transient's
/// size (a serialized frame, a loaded file); small responses skip the
/// arena walk entirely.
pub fn trim_freed_heap_if_large(bytes: usize) {
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    if bytes >= (1 << 20) {
        trim_freed_heap();
    }
}
