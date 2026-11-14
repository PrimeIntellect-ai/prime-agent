//! Executable fixtures (fake kernel interpreters) for integration tests.

use std::path::Path;

/// Write an executable fixture from a child process. A writable fd held by this
/// test process would be inherited by a concurrent test's fork until that child
/// execs, and exec'ing a file that is open for writing fails with ETXTBSY.
pub fn write_executable(path: &Path, contents: &str) {
    let status = std::process::Command::new("sh")
        .args(["-c", "printf %s \"$1\" > \"$0\" && chmod 700 \"$0\""])
        .arg(path)
        .arg(contents)
        .status()
        .expect("spawn sh");
    assert!(status.success(), "write {}", path.display());
}
