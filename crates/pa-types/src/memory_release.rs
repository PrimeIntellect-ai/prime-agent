//! Returning freed heap to the OS after large transient phases. Session loads and attach snapshots
//! allocate transient copies of the session body that are dropped right after; glibc keeps freed
//! chunks in its arenas, so the peaks stay resident in RSS. Pure allocator plumbing: a no-op
//! wherever the platform has no glibc seam.

/// Cap glibc's per-thread arenas. The default limit (`8 * ncores`) lets a burst from tokio threads
/// grow one arena per thread, each keeping its high-water pages; a moderate cap leaves the parallel
/// workers their arenas (a hard cap showed allocation contention in the 16-way e2e suite).
pub fn cap_thread_arenas() {
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    unsafe {
        libc::mallopt(libc::M_ARENA_MAX, 8);
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
pub fn trim_freed_heap_if_large(#[allow(unused_variables)] bytes: usize) {
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    if bytes >= (1 << 20) {
        trim_freed_heap();
    }
    // Non-glibc builds keep the parameter named (used only in the linux arm).
    #[cfg(not(all(target_os = "linux", target_env = "gnu")))]
    let _ = bytes;
}
