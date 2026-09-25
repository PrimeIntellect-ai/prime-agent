//! Returning freed heap to the OS after the TUI's large transient phases.
//!
//! An attach parse holds the wire frame, its decoded `Value` tree, and the
//! folded transcript at once; the frame and the tree drop once the fold
//! lands. glibc keeps those freed chunks resident, so the load's peak stays
//! in RSS for the process lifetime. Pure allocator plumbing: no behavior
//! change, and a no-op wherever the platform has no glibc seam.

/// Return freed heap pages to the OS after a large transient phase.
pub(crate) fn trim_freed_heap() {
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    unsafe {
        libc::malloc_trim(0);
    }
}
