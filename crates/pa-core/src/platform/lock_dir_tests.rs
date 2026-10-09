use super::*;

fn lock_of(file: &Path) -> PathBuf {
    LockDir::path_for(file)
}

/// A missing parent must fail as the real error, not as contention:
/// the short candidate name made `ENAMETOOLONG` unreachable, so the
/// only remaining acquisition failures are genuine I/O errors, and
/// acquire must surface them instead of retrying a phantom lock.
#[test]
#[cfg(target_os = "linux")]
fn missing_parent_is_a_real_error_not_contention() {
    let missing = Path::new("/nonexistent-pa-lock-parent-probe/foo");
    let error = LockDir::acquire(missing, MIN_STALE).unwrap_err();
    assert!(
        error.kind() == io::ErrorKind::NotFound,
        "the real missing-parent error must surface: {error}"
    );
}

/// A lock path whose component is near the filesystem limit still
/// acquires: the candidate is a short, basename-independent name, so
/// the old suffix-driven ENAMETOOLONG cannot recur.
#[test]
#[cfg(target_os = "linux")]
fn long_component_lock_path_still_acquires() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("l".repeat(240));
    std::fs::write(&file, "{}").unwrap();
    {
        let guard = LockDir::acquire(&file, MIN_STALE);
        assert!(
            guard.is_ok(),
            "a near-limit component must acquire: {:?}",
            guard.err()
        );
    }
    assert!(!lock_of(&file).exists());
}

#[test]
fn lock_is_an_empty_directory_and_cleans_up() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("auth.json");
    std::fs::write(&file, "{}").unwrap();
    {
        let _guard = LockDir::acquire(&file, MIN_STALE).unwrap();
        let path = lock_of(&file);
        let metadata = std::fs::metadata(&path).unwrap();
        assert!(metadata.is_dir(), "lock must be a directory");
        assert!(std::fs::read_dir(&path).unwrap().next().is_none());
    }
    assert!(!lock_of(&file).exists(), "release removes the directory");
}

#[test]
fn mtime_matches_the_proper_lockfile_probe_shape() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("auth.json");
    std::fs::write(&file, "{}").unwrap();
    let _guard = LockDir::acquire(&file, MIN_STALE).unwrap();
    let modified = std::fs::metadata(lock_of(&file))
        .unwrap()
        .modified()
        .unwrap()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap();

    assert_eq!(modified.as_millis() % 1000, 5);
    assert!(
        modified.as_millis()
            >= std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis()
    );
}

#[test]
#[cfg(unix)]
fn pinned_handle_matches_the_created_directory() {
    use std::os::unix::fs::MetadataExt;
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("auth.json");
    std::fs::write(&file, "{}").unwrap();
    let guard = LockDir::acquire(&file, MIN_STALE).unwrap();
    let (path, handle) = guard.into_parts();
    let metadata = std::fs::symlink_metadata(&path).unwrap();
    let pinned = handle.metadata().unwrap();
    assert_eq!(
        (metadata.dev(), metadata.ino()),
        (pinned.dev(), pinned.ino())
    );
}

#[test]
#[cfg(unix)]
fn pinned_handle_survives_a_path_swap() {
    use std::os::unix::fs::MetadataExt;
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("auth.json");
    std::fs::write(&file, "{}").unwrap();
    let guard = LockDir::acquire(&file, MIN_STALE).unwrap();
    let (path, handle) = guard.into_parts();
    let acquired = {
        let metadata = handle.metadata().unwrap();
        (metadata.dev(), metadata.ino())
    };
    // A stale takeover of the public pathname: the pinned handle
    // keeps the acquired inode, not the successor's.
    let aside = dir.path().join("displaced.lock");
    std::fs::rename(&path, &aside).unwrap();
    std::fs::create_dir(&path).unwrap();
    let successor = std::fs::symlink_metadata(&path).unwrap();
    let still_pinned = handle.metadata().unwrap();
    assert_eq!((still_pinned.dev(), still_pinned.ino()), acquired);
    assert_ne!(
        acquired,
        (successor.dev(), successor.ino()),
        "the swap must install a different inode or the oracle is vacuous"
    );
}

#[test]
#[cfg(unix)]
fn into_parts_transfers_the_path_and_pinned_handle() {
    use std::os::unix::fs::MetadataExt;
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("auth.json");
    std::fs::write(&file, "{}").unwrap();
    let guard = LockDir::acquire(&file, MIN_STALE).unwrap();
    let (path, handle) = guard.into_parts();
    assert!(path.is_dir());
    let metadata = handle.metadata().unwrap();
    let at_path = std::fs::symlink_metadata(&path).unwrap();
    assert_eq!(
        (metadata.dev(), metadata.ino()),
        (at_path.dev(), at_path.ino())
    );
}

#[test]
#[cfg(target_os = "linux")]
fn rename_noreplace_unsupported_only_matches_missing_support() {
    use super::LockDir;
    assert!(LockDir::rename_noreplace_unsupported(
        &io::Error::from_raw_os_error(libc::EINVAL)
    ));
    assert!(LockDir::rename_noreplace_unsupported(
        &io::Error::from_raw_os_error(libc::ENOSYS)
    ));
    // NFS/FUSE mounts reject the flag with EOPNOTSUPP: same fallback.
    assert!(LockDir::rename_noreplace_unsupported(
        &io::Error::from_raw_os_error(libc::EOPNOTSUPP)
    ));
    // Contention and real I/O failures must keep their own errors.
    assert!(!LockDir::rename_noreplace_unsupported(
        &io::Error::from_raw_os_error(libc::EEXIST)
    ));
    assert!(!LockDir::rename_noreplace_unsupported(
        &io::Error::from_raw_os_error(libc::EACCES)
    ));
}

#[test]
#[cfg(unix)]
fn mkdir_protocol_create_pins_and_probes_the_lock() {
    use std::os::unix::fs::MetadataExt;
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("auth.json");
    std::fs::write(&file, "{}").unwrap();
    let lock = lock_of(&file);
    let handle = LockDir::create_by_mkdir(&lock, None).unwrap();
    let metadata = std::fs::symlink_metadata(&lock).unwrap();
    let pinned = handle.metadata().unwrap();
    assert_eq!(
        (metadata.dev(), metadata.ino()),
        (pinned.dev(), pinned.ino()),
        "the handle must pin the created directory"
    );
    let modified = metadata.modified().unwrap();
    assert_eq!(
        modified
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis()
            % 1000,
        5,
        "the probe mtime shape must survive the fallback"
    );
    let _ = fs::remove_dir(&lock);
}

#[test]
fn second_acquire_reports_contention() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("settings.json");
    std::fs::write(&file, "{}").unwrap();
    let _guard = LockDir::acquire(&file, MIN_STALE).unwrap();
    let error = LockDir::acquire(&file, MIN_STALE).unwrap_err();
    assert_eq!(error.kind(), std::io::ErrorKind::WouldBlock);
}

#[test]
fn stale_lock_is_taken_over() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("auth.json");
    std::fs::write(&file, "{}").unwrap();
    let stale = lock_of(&file);
    std::fs::create_dir(&stale).unwrap();
    // Age it past the staleness threshold.
    set_mtime(&stale, 1, 0).unwrap();
    let guard = LockDir::acquire(&file, MIN_STALE).unwrap();
    let metadata = std::fs::metadata(&stale).unwrap();
    assert!(metadata.is_dir());
    drop(guard);
    assert!(!stale.exists());
}

#[test]
fn legacy_lock_file_is_removed_not_choked_on() {
    // A pre-compat Rust build left flock FILES at the lock path (the TS
    // product rmdir()s them and dies with ENOTDIR): acquisition must heal.
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("auth.json");
    std::fs::write(&file, "{}").unwrap();
    std::fs::write(lock_of(&file), "legacy flock artifact").unwrap();
    let guard = LockDir::acquire(&file, MIN_STALE).unwrap();
    assert!(std::fs::metadata(lock_of(&file)).unwrap().is_dir());
    drop(guard);
    assert!(!lock_of(&file).exists());
}

#[cfg(target_os = "linux")]
#[test]
fn displaced_owned_release_completes_at_the_claimed_location() {
    // The stale-reclaim dance displaces a live successor's directory
    // to a private name while a placeholder holds the public path.
    // The successor's guard drops during that interval: its release
    // must complete at the location the placeholder names, or the
    // still-running process's owner record wedges the lock forever.
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("harness_state.json");
    let path = LockDir::path_for(&file);
    let guard =
        LockDir::acquire_owned_retrying(&file, Duration::from_secs(10), 1, MIN_STALE).unwrap();
    // Stand in for the dance: move the guard's directory to a private
    // name and seat a placeholder with a live owner record and a
    // claimed-at note at the public path.
    let displaced_dir = dir.path().join(".j-displaced-probe");
    fs::rename(&path, &displaced_dir).unwrap();
    fs::create_dir(&path).unwrap();
    fs::write(path.join("owner"), process_owner_record()).unwrap();
    fs::write(path.join("claimed-at"), ".j-displaced-probe").unwrap();
    // Drop the guard mid-dance: the release must consume the
    // displaced directory and leave the placeholder untouched.
    drop(guard);
    assert!(
        !displaced_dir.exists(),
        "the displaced release consumed its own directory at the claimed location"
    );
    assert!(
        path.join("claimed-at").exists(),
        "the placeholder stays until its own process clears it"
    );
    let _ = remove_candidate_dir(&path);
}

/// Whether file permission denials actually reproduce in this
/// environment: a root or `CAP_DAC_OVERRIDE` process bypasses them,
/// so every restrictive-mode scenario (EACCES paths) would silently
/// test the wrong branch. Those tests skip when this reads false.
#[cfg(target_os = "linux")]
fn permission_denial_reproducible() -> bool {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let dir = tempfile::tempdir().unwrap();
    let probe = dir.path().join("probe");
    std::fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .mode(0o400)
        .open(&probe)
        .unwrap();
    std::fs::set_permissions(&probe, std::fs::Permissions::from_mode(0o400)).unwrap();
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&probe)
        .is_err()
}

#[cfg(target_os = "linux")]
#[test]
fn planted_fifo_at_the_sidecar_fails_closed_without_blocking() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("state.json");
    let sidecar = reclaim_guard_path(&file);
    std::fs::write(std::path::Path::new(&sidecar).with_file_name("warmup"), b"").ok();
    // Plant a FIFO at the sidecar path: an ordinary write-open
    // blocks forever; the hardened open must fail closed fast.
    let fifo_name =
        std::ffi::CString::new(std::os::unix::ffi::OsStrExt::as_bytes(sidecar.as_os_str()))
            .unwrap();
    assert_eq!(
        unsafe { libc::mkfifo(fifo_name.as_ptr(), 0o600) },
        0,
        "the FIFO fixture must exist: {}",
        std::io::Error::last_os_error()
    );
    let started = std::time::Instant::now();
    let guard = try_reclaim_guard(&file, Duration::from_millis(200));
    assert!(guard.is_none(), "a planted sidecar fails closed");
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "the failed open is nonblocking"
    );
}

#[cfg(target_os = "linux")]
#[test]
fn umask_tightened_sidecar_still_serializes() {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("state.json");
    let sidecar = reclaim_guard_path(&file);
    std::fs::create_dir_all(sidecar.parent().unwrap()).unwrap();
    // An umask-0277 creation: owner-read only - the write-open of
    // every later guard acquisition would fail EACCES.
    std::fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .mode(0o600)
        .open(&sidecar)
        .unwrap();
    std::fs::set_permissions(&sidecar, std::fs::Permissions::from_mode(0o400)).unwrap();
    if !permission_denial_reproducible() {
        // Root/CAP_DAC_OVERRIDE bypasses the denial these tests
        // exist to reproduce: skip instead of testing the wrong
        // branch.
        return;
    }
    // The first acquisition opens through the read-only fallback,
    // takes the flock, and repairs the mode through its descriptor.
    let held = try_reclaim_guard(&file, Duration::from_millis(200));
    assert!(
        held.is_some(),
        "the umask-tightened sidecar opens through the read-only fallback"
    );
    // A second acquisition contends while the first holds the flock.
    let contended = try_reclaim_guard(&file, Duration::from_millis(200));
    assert!(
        contended.is_none(),
        "a held guard serializes the second acquisition"
    );
    drop(held);
    // The repair landed: the next open is an ordinary read-write one
    // on a 0600 regular file.
    assert_eq!(
        std::fs::metadata(&sidecar).unwrap().permissions().mode() & 0o777,
        0o600,
        "the mode was repaired through the descriptor"
    );
    let guard = try_reclaim_guard(&file, Duration::from_millis(200));
    assert!(guard.is_some(), "the repaired sidecar serializes normally");
}

#[cfg(target_os = "linux")]
#[test]
fn umask_created_write_only_sidecar_recovers_after_restart() {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    // A prior umask-0477 creation left mode 0200 (write-only): every
    // read open fails EACCES, and the plain read-write recovery
    // cannot get there either. The guard must still acquire.
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("state.json");
    let sidecar = reclaim_guard_path(&file);
    std::fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .mode(0o200)
        .open(&sidecar)
        .unwrap();
    if !permission_denial_reproducible() {
        return;
    }
    let guard = try_reclaim_guard(&file, Duration::from_millis(200));
    assert!(
        guard.is_some(),
        "a write-only sidecar recovers through the O_WRONLY fallback"
    );
    drop(guard);
    assert_eq!(
        std::fs::metadata(&sidecar).unwrap().permissions().mode() & 0o777,
        0o600,
        "the mode was repaired for future acquisitions"
    );
}

#[cfg(target_os = "linux")]
#[test]
fn planted_fifo_or_symlink_marker_outranks_nothing() {
    // A hostile `released` entry (FIFO or symlink) must read as NO
    // marker: the dance's released-first branch would otherwise
    // consume a live holder's directory, and the judge's stale
    // check would reclaim a live-owned lock.
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("state.json");
    let path = LockDir::path_for(&file);
    std::fs::create_dir(&path).unwrap();
    // A live owner record with THIS process's pid: the judge must
    // refuse reclaim regardless of the hostile marker.
    std::fs::write(
        path.join("owner"),
        format!("{} live-token\n", std::process::id()),
    )
    .unwrap();
    std::fs::write(path.join("released"), b"").unwrap();
    // A real regular marker reads TRUE first, then plant the FIFO.
    assert!(released_marker(&path));
    std::fs::remove_file(path.join("released")).unwrap();
    let fifo_name = std::ffi::CString::new(
        path.join("released")
            .as_os_str()
            .to_string_lossy()
            .into_owned()
            .as_bytes(),
    )
    .unwrap();
    assert_eq!(
        unsafe { libc::mkfifo(fifo_name.as_ptr(), 0o600) },
        0,
        "the FIFO fixture must exist"
    );
    assert!(
        !released_marker(&path),
        "a planted FIFO marker reads as no marker"
    );
    // A symlink to a regular file also reads FALSE.
    std::fs::remove_file(path.join("released")).unwrap();
    std::os::unix::fs::symlink("owner", path.join("released")).unwrap();
    assert!(
        !released_marker(&path),
        "a planted symlink marker reads as no marker"
    );
}

#[cfg(target_os = "linux")]
#[test]
fn restrictive_mode_hardlink_at_the_sidecar_fails_closed() {
    use std::os::unix::fs::PermissionsExt;
    // A foreign owner-owned config hardlinked to the sidecar path
    // with a restrictive mode (the reviewer's plant): O_EXCL yields
    // EEXIST, O_RDWR EACCES, and the fallback must NOT repair the
    // foreign inode - the guard fails closed instead.
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("state.json");
    let sidecar = reclaim_guard_path(&file);
    let config = dir.path().join("owner-config.json");
    std::fs::write(&config, b"{}").unwrap();
    std::fs::set_permissions(&config, std::fs::Permissions::from_mode(0o400)).unwrap();
    std::fs::hard_link(&config, &sidecar).unwrap();
    if !permission_denial_reproducible() {
        return;
    }
    let guard = try_reclaim_guard(&file, Duration::from_millis(200));
    assert!(guard.is_none(), "a restrictive-mode hardlink fails closed");
    assert_eq!(
        std::fs::metadata(&config).unwrap().permissions().mode() & 0o777,
        0o400,
        "the foreign inode was never chmod'ed"
    );
}

#[cfg(target_os = "linux")]
#[test]
fn guard_sidecar_matches_for_bare_relative_locks() {
    // A bare relative lock name and the absolute spelling of the same
    // lock must derive the SAME sidecar: the empty parent normalizes
    // to "." and canonicalizes against the process's working
    // directory. No chdir needed - the absolute spelling is derived
    // from the current one.
    let cwd = std::env::current_dir().unwrap();
    let bare = reclaim_guard_path(Path::new("state.json"));
    let absolute = reclaim_guard_path(&cwd.join("state.json"));
    assert_eq!(bare, absolute, "one lock, one guard, any spelling");
}

#[cfg(target_os = "linux")]
#[test]
fn restrictive_umask_never_blocks_owned_lock_lifecycles() {
    // The umask is process-global and tests run in parallel threads:
    // the scenario runs in a CHILD PROCESS (this test binary re-run
    // with the umask probe filter) so no other test ever observes the
    // restrictive mask.
    for mask in ["277", "477"] {
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "platform::lock_dir::tests::restrictive_umask_owned_lock_child",
            ])
            .env("PA_UMASK_PROBE", mask)
            .status()
            .expect("run the umask probe child");
        assert!(status.success(), "the umask {mask} probe child failed");
    }
}

#[cfg(target_os = "linux")]
#[test]
fn restrictive_umask_owned_lock_child() {
    let Ok(mask) = std::env::var("PA_UMASK_PROBE") else {
        // The direct entry (no env): this body only runs under the
        // parent's restricted child invocation.
        return;
    };
    // A restrictive umask (0277: owner-write stripped from fresh dirs;
    // 0477: owner-read stripped from fresh FILES - the owner record
    // becomes unreadable without the fchmod repair) must never block
    // the owned-lock lifecycle: every fresh-dir/fresh-file write lands
    // (the 0700/0600 restorations) or the lock leaks behind a working
    // lifecycle.
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("state.json");
    let mask_bits: libc::mode_t = mask.parse().unwrap();
    let original = unsafe { libc::umask(mask_bits) };
    let guard = LockDir::acquire_owned_retrying(&file, Duration::from_secs(10), 1, MIN_STALE);
    unsafe { libc::umask(original) };
    let guard = guard.expect("owned acquisition works under a restrictive umask");
    guard.ensure_owned().expect("the owner record landed");
    drop(guard);
    // The release removed the lock: a fresh acquisition succeeds
    // immediately, never waiting out the stale window.
    let next = LockDir::acquire_owned_retrying(&file, Duration::from_secs(10), 1, MIN_STALE);
    assert!(
        next.is_ok(),
        "the umask-restricted release did not leak the lock"
    );
}

#[cfg(target_os = "linux")]
#[test]
fn guard_sidecar_is_spelling_independent() {
    // Two spellings of one lock path must serialize on the SAME
    // sidecar - or two processes could hold "exclusive" guards for
    // one lock and race the protocol.
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir(dir.path().join("x")).unwrap();
    let plain = reclaim_guard_path(&dir.path().join("state.json"));
    let dotted = reclaim_guard_path(&dir.path().join("x").join("..").join("state.json"));
    assert_eq!(plain, dotted, "one lock, one guard");
}

#[cfg(target_os = "linux")]
#[test]
fn marker_files_all_clear_on_removal() {
    // A directory carrying every protocol note must remove cleanly -
    // the released marker included - or the dance's consume arms
    // fail ENOTEMPTY and wedge the public placeholder.
    let dir = tempfile::tempdir().unwrap();
    let candidate = dir.path().join(".c-probe");
    fs::create_dir(&candidate).unwrap();
    fs::write(candidate.join("owner"), "1 token\n").unwrap();
    fs::write(candidate.join("claimed-at"), "note").unwrap();
    fs::write(candidate.join("released"), "").unwrap();
    remove_candidate_dir(&candidate).unwrap();
    assert!(!candidate.exists());
}

#[cfg(target_os = "linux")]
#[test]
fn marked_stale_lock_is_reclaimed_despite_live_owner() {
    // The release marker outranks a live pid record: a guard that
    // dropped mid-dance must never wedge its directory behind its
    // own process's lifetime.
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("harness_state.json");
    let path = LockDir::path_for(&file);
    fs::create_dir(&path).unwrap();
    fs::write(
        path.join("owner"),
        format!("{} live-token\n", std::process::id()),
    )
    .unwrap();
    fs::write(path.join("released"), "").unwrap();
    set_mtime(&path, 1, 0).unwrap();
    let next =
        LockDir::acquire_owned_retrying(&file, Duration::from_secs(10), 1, MIN_STALE).unwrap();
    next.ensure_owned().unwrap();
}

#[cfg(target_os = "linux")]
#[test]
fn unobtainable_guard_marks_the_release_through_the_fd() {
    use std::os::unix::io::AsRawFd;
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("harness_state.json");
    let guard =
        LockDir::acquire_owned_retrying(&file, Duration::from_secs(10), 1, MIN_STALE).unwrap();
    // Hold the sidecar guard from the test itself: the release must
    // carry through the pinned fd's marker, not race the guard with
    // pathname removals.
    let sidecar = fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(reclaim_guard_path(&guard.path))
        .unwrap();
    assert_eq!(
        unsafe { libc::flock(sidecar.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
        0
    );
    drop(guard);
    drop(sidecar);
    // The marker carried: the directory is reclaimable by age
    // despite this process's live pid.
    let path = LockDir::path_for(&file);
    set_mtime(&path, 1, 0).unwrap();
    let next =
        LockDir::acquire_owned_retrying(&file, Duration::from_secs(10), 1, MIN_STALE).unwrap();
    next.ensure_owned().unwrap();
}

#[cfg(target_os = "linux")]
#[test]
fn contended_owned_acquire_leaves_no_candidate_artifacts() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("harness_state.json");
    // A live incumbent at the public path: every owned acquisition
    // attempt loses the publish (EEXIST) and must clean its private
    // candidate completely - owner file included.
    let _incumbent =
        LockDir::acquire_owned_retrying(&file, Duration::from_secs(10), 1, MIN_STALE).unwrap();
    let error =
        LockDir::acquire_owned_retrying(&file, Duration::from_secs(10), 1, MIN_STALE).unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::WouldBlock);
    let leftovers: Vec<_> = std::fs::read_dir(dir.path())
        .unwrap()
        .filter_map(std::result::Result::ok)
        .filter(|entry| {
            entry.file_name().to_string_lossy().starts_with(".c")
                || entry.file_name().to_string_lossy().contains(".lock.c")
        })
        .collect();
    assert!(
        leftovers.is_empty(),
        "contended owned acquires must not leak candidate artifacts"
    );
}

#[cfg(unix)]
#[test]
fn live_owned_lock_cannot_be_stolen_after_stale_age() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("harness_state.json");
    let guard =
        LockDir::acquire_owned_retrying(&file, Duration::from_secs(10), 1, MIN_STALE).unwrap();
    set_mtime(&guard.path, 1, 0).unwrap();
    let error =
        LockDir::acquire_owned_retrying(&file, Duration::from_secs(10), 1, MIN_STALE).unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::WouldBlock);
    guard.ensure_owned().unwrap();
}

#[cfg(unix)]
#[test]
fn dead_owned_lock_is_reclaimed_and_old_guard_cannot_remove_successor() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("harness_state.json");
    let old =
        LockDir::acquire_owned_retrying(&file, Duration::from_secs(10), 1, MIN_STALE).unwrap();
    let mut child = std::process::Command::new("true").spawn().unwrap();
    let dead_pid = child.id();
    child.wait().unwrap();
    fs::write(old.path.join("owner"), format!("{dead_pid} dead-token\n")).unwrap();
    set_mtime(&old.path, 1, 0).unwrap();
    let next =
        LockDir::acquire_owned_retrying(&file, Duration::from_secs(10), 1, MIN_STALE).unwrap();
    assert!(old.ensure_owned().is_err());
    drop(old);
    next.ensure_owned().unwrap();
    drop(next);
    assert!(!LockDir::path_for(&file).exists());
}

#[cfg(unix)]
#[test]
fn unparseable_owned_lock_is_reclaimed_by_age() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("harness_state.json");
    let path = LockDir::path_for(&file);
    fs::create_dir(&path).unwrap();
    fs::write(path.join("owner"), [0xff]).unwrap();
    set_mtime(&path, 1, 0).unwrap();
    let next =
        LockDir::acquire_owned_retrying(&file, Duration::from_secs(10), 1, MIN_STALE).unwrap();
    next.ensure_owned().unwrap();
}
