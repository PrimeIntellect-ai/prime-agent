//! The venv module's unit battery (moved with its concern): the Windows
//! executable candidates, the skill-manifest parsing, the version-file round
//! trip, the two-layer probe memo oracles, the live-probe closure, and the
//! skill-sync batching.
#[test]
fn windows_executable_candidates_default_order() {
    // No PATHEXT: the TS default extension order, deduped against the
    // bare name.
    assert_eq!(
        windows_executable_candidates("uv", None),
        vec![
            "uv".to_string(),
            "uv.COM".into(),
            "uv.EXE".into(),
            "uv.BAT".into(),
            "uv.CMD".into()
        ]
    );
}

#[test]
fn windows_executable_candidates_follows_pathext_order() {
    // Supported extensions keep PATHEXT's order; unsupported ones drop.
    assert_eq!(
        windows_executable_candidates("uv", Some(".FOO;.EXE;.BAT")),
        vec!["uv".to_string(), "uv.exe".into(), "uv.bat".into()]
    );
}

#[test]
fn windows_executable_candidates_skips_suffix_and_duplicates() {
    // A name that already ends in a default extension is used bare.
    assert_eq!(
        windows_executable_candidates("uv.exe", Some(".EXE;.BAT")),
        vec!["uv.exe".to_string()]
    );
    // A candidate equal to the bare name (case-insensitively) never
    // repeats.
    assert_eq!(
        windows_executable_candidates("node", Some("")),
        vec![
            "node".to_string(),
            "node.COM".into(),
            "node.EXE".into(),
            "node.BAT".into(),
            "node.CMD".into()
        ]
    );
}

use super::*;

#[test]
fn venv_dir_honors_override() {
    // The default path lives under $HOME.
    let base = kernel_venv_dir();
    assert!(base.ends_with("kernel-venv"));
}

#[test]
fn dependency_names_parse() {
    let dir = tempfile::tempdir().unwrap();
    let pyproject = dir.path().join("pyproject.toml");
    std::fs::write(
        &pyproject,
        "[project]\nname = 'edit'\ndependencies = [\n  \"agent-message>=1\",\n  'yaml; python_version > \"3\"',\n]\n[other]\nkey = 1\n",
    )
    .unwrap();
    let skill = BootstrapPythonSkill {
        import_name: "edit".into(),
        package_path: dir.path().join("pkg").to_string_lossy().to_string(),
        pyproject_path: pyproject.to_string_lossy().to_string(),
        pyproject_hash: file_content_hash(&pyproject),
    };
    assert_eq!(read_python_skill_project_name(&skill), "edit");
    assert_eq!(
        read_python_skill_dependency_names(&skill),
        vec!["agent-message", "yaml"]
    );
}

fn skill(import_name: &str, path: &str, hash: &str) -> BootstrapPythonSkill {
    BootstrapPythonSkill {
        import_name: import_name.to_string(),
        package_path: path.to_string(),
        pyproject_path: format!("{path}/pyproject.toml"),
        pyproject_hash: hash.to_string(),
    }
}
/// The probe-memo state (in-process map + the shared disk files) is
/// process-global: every test that touches it serializes on this lock
/// so a concurrent test's invalidation cannot clear another test's
/// verdicts mid-run.
static MEMO_STATE_LOCK: Mutex<()> = Mutex::new(());

/// Collect every `.runtime-probe-memo.json` under `root` (the override
/// boundary pin: the override path must create none).
fn collect_memo_files(root: &Path, found: &mut Vec<std::path::PathBuf>) {
    if let Ok(entries) = std::fs::read_dir(root) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                collect_memo_files(&path, found);
            } else if path
                .file_name()
                .is_some_and(|n| n == super::super::disk_memo::DISK_MEMO_FILE)
            {
                found.push(path);
            }
        }
    }
}

#[test]
fn version_file_round_trips() {
    let dir = tempfile::tempdir().unwrap();
    write_bootstrap_version(dir.path(), "sha256:abc", &[]).unwrap();
    let version = read_bootstrap_version(dir.path()).expect("version written");
    assert_eq!(version.schema, BOOTSTRAP_SCHEMA);
    assert_eq!(version.runtime.as_deref(), Some("sha256:abc"));
    assert!(bootstrap_version_current(Some(version), "sha256:abc", &[]));
    assert!(!bootstrap_base_version_current(
        read_bootstrap_version(dir.path()),
        "sha256:other"
    ));
}

#[test]
fn probe_memo_key_distinguishes_every_input_and_drops_on_invalidate() {
    let _memo_state = MEMO_STATE_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let key = runtime_probe_key("/py", "sha256:runtime", "raw", "sha256:installed");
    assert_eq!(
        key,
        runtime_probe_key("/py", "sha256:runtime", "raw", "sha256:installed")
    );
    assert_ne!(
        key,
        runtime_probe_key("/other-py", "sha256:runtime", "raw", "sha256:installed")
    );
    assert_ne!(
        key,
        runtime_probe_key("/py", "sha256:other", "raw", "sha256:installed")
    );
    assert_ne!(
        key,
        runtime_probe_key("/py", "sha256:runtime", "raw2", "sha256:installed")
    );
    assert_ne!(
        key,
        runtime_probe_key("/py", "sha256:runtime", "raw", "sha256:installed2")
    );

    lock_probe_memo()
        .get_or_insert_with(HashMap::new)
        .insert(key.clone(), PathBuf::new());
    assert!(lock_probe_memo()
        .as_ref()
        .is_some_and(|memo| memo.contains_key(&key)));
    invalidate_runtime_probe_cache();
    assert!(lock_probe_memo()
        .as_ref()
        .is_none_or(|memo| !memo.contains_key(&key)));
}

/// The out-of-band-detection trio, on a fake venv whose interpreter is
/// a shell script that counts its own invocations: the memo must hit on
/// an unchanged venv (the perf point), miss when the installed `rlm`
/// tree is mutated or the interpreter is replaced (the parity point:
/// the probe re-runs and detects the damage), and miss after
/// invalidation.
#[cfg(unix)]
#[test]
fn probe_memo_misses_on_out_of_band_venv_mutation() {
    let _memo_state = MEMO_STATE_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = tempfile::tempdir().unwrap();
    let venv = dir.path().join("venv");
    let rlm = venv.join("lib/python3.11/site-packages/rlm");
    std::fs::create_dir_all(&rlm).unwrap();
    std::fs::write(rlm.join("__init__.py"), "x = 1\n").unwrap();

    // The fake interpreter: records each invocation, then runs the probe
    // verdict the control file asks for (empty = success).
    let control = dir.path().join("verdict");
    let counter = dir.path().join("count");
    let python = dir.path().join("python");
    std::fs::write(
        &python,
        format!(
            "#!/bin/sh\necho x >> {}\nif [ -s {} ]; then exit 1; fi\nexit 0\n",
            counter.display(),
            control.display()
        ),
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&python, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    write_bootstrap_version(&venv, "sha256:runtime", &[]).unwrap();
    let python_str = python.to_string_lossy().to_string();
    let probe_count = || {
        std::fs::read_to_string(&counter).map_or(0, |text| {
            text.lines().filter(|l| !l.trim().is_empty()).count()
        })
    };

    invalidate_runtime_probe_cache();
    assert!(kernel_ready(&python_str, &venv, "sha256:runtime", &[]));
    assert_eq!(probe_count(), 2, "cold call probes runtime and dill");

    assert!(kernel_ready(&python_str, &venv, "sha256:runtime", &[]));
    assert_eq!(probe_count(), 2, "unchanged venv hits the memo");

    // Out-of-band mutation of the installed rlm: the memo must miss and
    // the probe must re-run (the detection the parity review demands).
    std::fs::write(rlm.join("core.py"), "y = 2\n").unwrap();
    assert!(kernel_ready(&python_str, &venv, "sha256:runtime", &[]));
    assert_eq!(
        probe_count(),
        4,
        "installed-rlm mutation probes runtime and dill instead of masking"
    );

    // Out-of-band interpreter replacement: same detection.
    std::fs::write(
        &python,
        format!(
            "#!/bin/sh\necho x >> {}\nif [ -s {} ]; then exit 1; fi\nexit 0\n# replaced\n",
            counter.display(),
            control.display()
        ),
    )
    .unwrap();
    assert!(kernel_ready(&python_str, &venv, "sha256:runtime", &[]));
    assert_eq!(
        probe_count(),
        6,
        "interpreter replacement probes runtime and dill"
    );

    // Fingerprint-invisible damage (the fake's verdict file, standing in
    // for interpreter-internal breakage the witnesses cannot see): the
    // memo still hits — the masked class, whose detection happens at
    // kernel-START failure time (the manager invalidates the memo and
    // the provisioner retry re-probes).
    std::fs::write(&control, "broken\n").unwrap();
    assert!(kernel_ready(&python_str, &venv, "sha256:runtime", &[]));
    assert_eq!(probe_count(), 6, "invisible damage alone does not re-probe");

    // After a failed start (the invalidation it performs), the next
    // readiness check re-probes and DETECTS the damage.
    invalidate_runtime_probe_cache();
    assert!(!kernel_ready(&python_str, &venv, "sha256:runtime", &[]));
    assert_eq!(probe_count(), 7, "a failing probe is never memoized");

    // Healing plus another invalidation restores readiness through a
    // real probe, never a stale memo.
    std::fs::remove_file(&control).unwrap();
    invalidate_runtime_probe_cache();
    assert!(kernel_ready(&python_str, &venv, "sha256:runtime", &[]));
    assert_eq!(probe_count(), 9, "invalidation probes runtime and dill");

    // An uninstalled runtime (the out-of-band uninstall class) must
    // re-probe rather than mask: the installed-rlm witness disappears,
    // so the real probe runs again (this fake one still passes).
    std::fs::remove_dir_all(&rlm).unwrap();
    assert!(kernel_ready(&python_str, &venv, "sha256:runtime", &[]));
    assert_eq!(
        probe_count(),
        11,
        "an uninstalled rlm probes runtime and dill"
    );

    // A deleted interpreter must miss the memo without a probe
    // invocation (the interpreter stat witness fails): readiness flips
    // false because the probe cannot even run.
    std::fs::remove_file(&python).unwrap();
    assert!(!kernel_ready(&python_str, &venv, "sha256:runtime", &[]));
    assert_eq!(
        probe_count(),
        11,
        "a deleted interpreter misses on stat without running"
    );
}

/// The cross-process layer, pinned: a fresh process (empty in-process
/// map — every cold open's worker and every spawned child boots as
/// one) hits the on-disk memo under the same identity key and runs
/// ZERO interpreter probes. The key recomputation (the content walk)
/// is the damage detector; only the probes are skipped.
#[cfg(unix)]
#[test]
fn disk_memo_hits_across_a_fresh_process_with_zero_probes() {
    let _memo_state = MEMO_STATE_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = tempfile::tempdir().unwrap();
    let venv = dir.path().join("venv");
    let rlm = venv.join("lib/python3.11/site-packages/rlm");
    std::fs::create_dir_all(&rlm).unwrap();
    std::fs::write(rlm.join("__init__.py"), "x = 1\n").unwrap();
    let counter = dir.path().join("count");
    let python = dir.path().join("python");
    std::fs::write(
        &python,
        format!("#!/bin/sh\necho x >> {}\nexit 0\n", counter.display()),
    )
    .unwrap();
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&python, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    write_bootstrap_version(&venv, "sha256:runtime", &[]).unwrap();
    let python_str = python.to_string_lossy().to_string();
    let probe_count = || {
        std::fs::read_to_string(&counter).map_or(0, |text| {
            text.lines().filter(|l| !l.trim().is_empty()).count()
        })
    };

    invalidate_runtime_probe_cache();
    assert!(kernel_ready(&python_str, &venv, "sha256:runtime", &[]));
    assert_eq!(
        probe_count(),
        2,
        "the cold call probes runtime and dill and publishes the disk memo"
    );
    // A fresh process: the in-process map is empty, the verdict lives
    // on disk under the same key.
    clear_in_process_probe_memo_for_tests();
    assert!(kernel_ready(&python_str, &venv, "sha256:runtime", &[]));
    assert_eq!(
        probe_count(),
        2,
        "a fresh process hits the disk memo with zero interpreter invocations"
    );
    // Invalidation drops both layers.
    invalidate_runtime_probe_cache();
    assert!(
        !super::super::disk_memo::disk_memo_path(&venv).exists(),
        "invalidation dropped the on-disk layer too"
    );
    assert!(kernel_ready(&python_str, &venv, "sha256:runtime", &[]));
    assert_eq!(
        probe_count(),
        4,
        "the next start after invalidation re-probes"
    );
}

/// Damage across processes: process A memoizes, the venv is damaged
/// out of band, and a FRESH process must miss both layers through the
/// freshly recomputed key and re-probe — never a stale cross-process
/// verdict.
#[cfg(unix)]
#[test]
fn disk_memo_damage_across_processes_misses_and_reprobes() {
    let _memo_state = MEMO_STATE_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = tempfile::tempdir().unwrap();
    let venv = dir.path().join("venv");
    let rlm = venv.join("lib/python3.11/site-packages/rlm");
    std::fs::create_dir_all(&rlm).unwrap();
    std::fs::write(rlm.join("__init__.py"), "x = 1\n").unwrap();
    let counter = dir.path().join("count");
    let python = dir.path().join("python");
    std::fs::write(
        &python,
        format!("#!/bin/sh\necho x >> {}\nexit 0\n", counter.display()),
    )
    .unwrap();
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&python, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    write_bootstrap_version(&venv, "sha256:runtime", &[]).unwrap();
    let python_str = python.to_string_lossy().to_string();
    let probe_count = || {
        std::fs::read_to_string(&counter).map_or(0, |text| {
            text.lines().filter(|l| !l.trim().is_empty()).count()
        })
    };

    invalidate_runtime_probe_cache();
    assert!(kernel_ready(&python_str, &venv, "sha256:runtime", &[]));
    assert_eq!(probe_count(), 2);

    // An out-of-band rlm mutation: process B misses and re-probes.
    clear_in_process_probe_memo_for_tests();
    std::fs::write(rlm.join("core.py"), "y = 2\n").unwrap();
    assert!(kernel_ready(&python_str, &venv, "sha256:runtime", &[]));
    assert_eq!(
        probe_count(),
        4,
        "process B re-probes after the out-of-band rlm mutation"
    );

    // The out-of-band uninstall class: same detection in the fresh
    // process (this fake probe still passes; the real one fails and
    // the provisioner rebuilds).
    clear_in_process_probe_memo_for_tests();
    std::fs::remove_dir_all(&rlm).unwrap();
    assert!(kernel_ready(&python_str, &venv, "sha256:runtime", &[]));
    assert_eq!(
        probe_count(),
        6,
        "process B re-probes after the rlm uninstall"
    );

    // A repair to the EXACT already-verified content: the restored
    // state matches the verdict the cold call published, so a fresh
    // process HITS the disk memo with zero probes — restoring to a
    // known-good verified state is the memo working as designed.
    std::fs::create_dir_all(&rlm).unwrap();
    std::fs::write(rlm.join("__init__.py"), "x = 1\n").unwrap();
    clear_in_process_probe_memo_for_tests();
    assert!(kernel_ready(&python_str, &venv, "sha256:runtime", &[]));
    assert_eq!(
        probe_count(),
        6,
        "a repair to the already-published content hits the disk memo without re-probing"
    );

    // A rewritten version file (a newer concurrent daemon rebuilt the
    // venv) fails the cheap version check before any probe or memo
    // lookup: the rebuild path, not a stale-verdict path.
    clear_in_process_probe_memo_for_tests();
    write_bootstrap_version(&venv, "sha256:other-runtime", &[]).unwrap();
    assert!(!kernel_ready(&python_str, &venv, "sha256:runtime", &[]));
    assert_eq!(
        probe_count(),
        6,
        "a version-file rewrite fails the cheap check before any probe"
    );

    // A deleted interpreter misses on the stat witness without a probe
    // invocation, in the fresh process too.
    std::fs::remove_file(&python).unwrap();
    assert!(!kernel_ready(&python_str, &venv, "sha256:runtime", &[]));
    assert_eq!(
        probe_count(),
        6,
        "a deleted interpreter misses without running"
    );
}

/// The masked class, pinned against the DISK layer: fingerprint-
/// invisible damage is masked by a cross-process hit until the first
/// failed kernel start drops BOTH layers and the retry re-probes and
/// detects. This is the widened window the disclosure describes —
/// in #2857 the in-process memo died with the process; here the
/// window runs until the first failed start, with the same
/// single-failure-then-heal end state.
#[cfg(unix)]
#[test]
fn disk_memo_masked_class_hits_across_processes_until_invalidation() {
    let _memo_state = MEMO_STATE_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = tempfile::tempdir().unwrap();
    let venv = dir.path().join("venv");
    let rlm = venv.join("lib/python3.11/site-packages/rlm");
    std::fs::create_dir_all(&rlm).unwrap();
    std::fs::write(rlm.join("__init__.py"), "x = 1\n").unwrap();
    let control = dir.path().join("verdict");
    let counter = dir.path().join("count");
    let python = dir.path().join("python");
    std::fs::write(
        &python,
        format!(
            "#!/bin/sh\necho x >> {}\nif [ -s {} ]; then exit 1; fi\nexit 0\n",
            counter.display(),
            control.display()
        ),
    )
    .unwrap();
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&python, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    write_bootstrap_version(&venv, "sha256:runtime", &[]).unwrap();
    let python_str = python.to_string_lossy().to_string();
    let probe_count = || {
        std::fs::read_to_string(&counter).map_or(0, |text| {
            text.lines().filter(|l| !l.trim().is_empty()).count()
        })
    };

    invalidate_runtime_probe_cache();
    assert!(kernel_ready(&python_str, &venv, "sha256:runtime", &[]));
    assert_eq!(probe_count(), 2);

    // Fingerprint-invisible damage: the verdict file stands in for
    // interpreter-internal breakage the witnesses cannot see.
    std::fs::write(&control, "broken\n").unwrap();
    clear_in_process_probe_memo_for_tests();
    assert!(kernel_ready(&python_str, &venv, "sha256:runtime", &[]));
    assert_eq!(
        probe_count(),
        2,
        "the disk hit masks the invisible damage — the widened window"
    );

    // The failed kernel start invalidates BOTH layers; the retry
    // re-probes and DETECTS.
    invalidate_runtime_probe_cache();
    assert!(
        !super::super::disk_memo::disk_memo_path(&venv).exists(),
        "the disk layer dropped with the in-process one"
    );
    assert!(!kernel_ready(&python_str, &venv, "sha256:runtime", &[]));
    assert_eq!(
        probe_count(),
        3,
        "the retry re-probes (runtime fails, dill short-circuits) and detects"
    );

    // Healing republishes through a real probe, never a stale memo.
    std::fs::remove_file(&control).unwrap();
    clear_in_process_probe_memo_for_tests();
    assert!(kernel_ready(&python_str, &venv, "sha256:runtime", &[]));
    assert_eq!(probe_count(), 5);
}

/// The write-vs-invalidate race: a late atomic write landing after an
/// invalidation resurrects a key-valid entry. That is BENIGN — the
/// entry's key matches the current environment, so the verdict was
/// honestly earned — and the next failed start re-invalidates. No
/// locking: the race's cost equals base's own behavior under the
/// same breakage.
#[cfg(unix)]
#[test]
fn disk_memo_late_write_after_invalidate_is_benign() {
    let _memo_state = MEMO_STATE_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = tempfile::tempdir().unwrap();
    let venv = dir.path().join("venv");
    let rlm = venv.join("lib/python3.11/site-packages/rlm");
    std::fs::create_dir_all(&rlm).unwrap();
    std::fs::write(rlm.join("__init__.py"), "x = 1\n").unwrap();
    let counter = dir.path().join("count");
    let python = dir.path().join("python");
    std::fs::write(
        &python,
        format!("#!/bin/sh\necho x >> {}\nexit 0\n", counter.display()),
    )
    .unwrap();
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&python, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    write_bootstrap_version(&venv, "sha256:runtime", &[]).unwrap();
    let python_str = python.to_string_lossy().to_string();
    let probe_count = || {
        std::fs::read_to_string(&counter).map_or(0, |text| {
            text.lines().filter(|l| !l.trim().is_empty()).count()
        })
    };

    invalidate_runtime_probe_cache();
    assert!(kernel_ready(&python_str, &venv, "sha256:runtime", &[]));
    assert_eq!(probe_count(), 2);

    // The failed start invalidates both layers...
    invalidate_runtime_probe_cache();
    assert!(!super::super::disk_memo::disk_memo_path(&venv).exists());
    // ...while a concurrent process whose probe just passed publishes
    // its verdict between the clear and the retry.
    let (_, raw) = read_bootstrap_version_raw(&venv);
    let key = runtime_probe_key(
        &python_str,
        "sha256:runtime",
        &raw,
        &installed_runtime_identity(Path::new(&python_str), &venv),
    );
    super::super::disk_memo::disk_memo_write(&super::super::disk_memo::disk_memo_path(&venv), &key);

    // The retry hits the late entry: benign, honestly earned.
    assert!(kernel_ready(&python_str, &venv, "sha256:runtime", &[]));
    assert_eq!(
        probe_count(),
        2,
        "the late write's key-valid entry serves the retry without a probe"
    );
    // The next failed start re-invalidates.
    invalidate_runtime_probe_cache();
    assert!(!super::super::disk_memo::disk_memo_path(&venv).exists());
}

/// Env-mutating tests serialize on this lock: the process env is
/// global (same pattern as the request-timing env lock).
static PRIME_AGENT_ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// The d14 boundary pinned at the observable-facts level: a
/// caller-owned `PRIME_AGENT_KERNEL_PYTHON` override resolves through
/// the DIRECT probe and never reads or writes any memo file.
#[cfg(unix)]
#[tokio::test]
async fn custom_override_never_touches_the_disk_memo() {
    let _guard = PRIME_AGENT_ENV_LOCK.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    std::fs::create_dir_all(&home).unwrap();
    let python = dir.path().join("python");
    std::fs::write(&python, "#!/bin/sh\nexit 0\n").unwrap();
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&python, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let previous_home = std::env::var("HOME").ok();
    let previous_override = std::env::var("PRIME_AGENT_KERNEL_PYTHON").ok();
    let previous_venv = std::env::var("PRIME_AGENT_KERNEL_VENV").ok();
    std::env::set_var("HOME", &home);
    std::env::set_var("PRIME_AGENT_KERNEL_PYTHON", &python);
    std::env::remove_var("PRIME_AGENT_KERNEL_VENV");
    let resolved =
        super::super::ensure_kernel_python(super::super::EnsureKernelPythonOptions::default())
            .await;
    match previous_venv {
        Some(value) => std::env::set_var("PRIME_AGENT_KERNEL_VENV", value),
        None => std::env::remove_var("PRIME_AGENT_KERNEL_VENV"),
    }
    match previous_override {
        Some(value) => std::env::set_var("PRIME_AGENT_KERNEL_PYTHON", value),
        None => std::env::remove_var("PRIME_AGENT_KERNEL_PYTHON"),
    }
    match previous_home {
        Some(value) => std::env::set_var("HOME", value),
        None => std::env::remove_var("HOME"),
    }
    assert!(resolved.is_ok(), "the override resolves: {resolved:?}");
    assert_eq!(
        resolved.unwrap(),
        python,
        "the override python is returned as-is"
    );
    let mut found: Vec<std::path::PathBuf> = Vec::new();
    collect_memo_files(dir.path(), &mut found);
    assert!(
        found.is_empty(),
        "the override path created no memo file: {found:?}"
    );
}

/// The Windows venv layout (`<venv>/Lib/site-packages/rlm`, no
/// python-version layer) is a fingerprint input: mutations under it
/// change the memo key, and removal drops to the missing marker.
#[test]
fn windows_layout_venv_rlm_is_witnessed() {
    let dir = tempfile::tempdir().unwrap();
    let venv = dir.path().join("venv");
    let rlm = venv.join("lib/site-packages/rlm");
    std::fs::create_dir_all(&rlm).unwrap();
    std::fs::write(rlm.join("__init__.py"), "x = 1\n").unwrap();

    assert_eq!(installed_rlm_dir(&venv), Some(rlm.clone()));
    let python = dir.path().join("python");
    let id_before = installed_runtime_identity(&python, &venv);
    std::fs::write(rlm.join("__init__.py"), "x = 2\n").unwrap();
    let id_after_mutation = installed_runtime_identity(&python, &venv);
    assert_ne!(
        id_before, id_after_mutation,
        "a mutation under the Windows layout changes the fingerprint"
    );
    std::fs::remove_dir_all(&rlm).unwrap();
    let id_after_removal = installed_runtime_identity(&python, &venv);
    assert_ne!(
        id_after_removal, id_before,
        "the out-of-band uninstall changes the fingerprint"
    );
}

/// Live (ignored by default; run with `--ignored` on a machine with a
/// kernel venv under `HOME`): the memo behavior against a REAL
/// interpreter and a REAL `rlm` import — the probe result on the
/// counting-wrapper venv must come from the memo while the installed
/// tree is unchanged, and must re-run (and fail) when the installed
/// `rlm` tree is removed out of band.
#[cfg(unix)]
#[test]
#[ignore = "live: needs a real kernel venv under HOME (bench VMs)"]
fn live_probe_memo_reprobes_when_installed_rlm_is_removed() {
    let _memo_state = MEMO_STATE_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let real_venv = kernel_venv_dir();
    let real_python = kernel_venv_python(&real_venv);
    if !real_python.is_file() {
        eprintln!("kernel python {real_python:?} not found; skipping live probe test");
        return;
    }
    let Some(real_rlm) = installed_rlm_dir(&real_venv) else {
        eprintln!("installed rlm not found; skipping live probe test");
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let fake = dir.path().join("venv");
    let site = fake.join("lib/python3.11/site-packages");
    let rlm = site.join("rlm");
    let dill = site.join("dill");
    let real_dill = installed_package_dir(&real_venv, "dill")
        .expect("installed dill is required for the live runtime probe");
    for (source, target_dir) in [(&real_rlm, &rlm), (&real_dill, &dill)] {
        std::fs::create_dir_all(target_dir).unwrap();
        let mut files = Vec::new();
        collect_python_files(source, &mut files).unwrap();
        for file in &files {
            let target = target_dir.join(file.strip_prefix(source).unwrap());
            std::fs::create_dir_all(target.parent().unwrap()).unwrap();
            std::fs::copy(file, &target).unwrap();
        }
    }

    let counter = dir.path().join("count");
    let python = fake.join("bin/python");
    std::fs::create_dir_all(python.parent().unwrap()).unwrap();
    std::fs::write(
        &python,
        format!(
            "#!/bin/sh\necho x >> \"{}\"\nPYTHONPATH={:?} exec \"{}\" -S \"$@\"\n",
            counter.display(),
            site,
            real_python.display()
        ),
    )
    .unwrap();
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&python, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    let identity = resolve_runtime_identity();
    write_bootstrap_version(&fake, &identity, &[]).unwrap();

    let probe_count = || {
        std::fs::read_to_string(&counter).map_or(0, |text| {
            text.lines().filter(|l| !l.trim().is_empty()).count()
        })
    };

    invalidate_runtime_probe_cache();
    assert!(kernel_ready(
        &python.to_string_lossy(),
        &fake,
        &identity,
        &[]
    ));
    assert_eq!(probe_count(), 2, "cold call probes runtime and dill");

    assert!(kernel_ready(
        &python.to_string_lossy(),
        &fake,
        &identity,
        &[]
    ));
    assert_eq!(probe_count(), 2, "unchanged venv hits the memo");

    std::fs::remove_dir_all(&rlm).unwrap();
    assert!(
        !kernel_ready(&python.to_string_lossy(), &fake, &identity, &[]),
        "an uninstalled rlm must be detected, not masked"
    );
    assert_eq!(
        probe_count(),
        3,
        "the out-of-band rlm uninstall re-probed the runtime (the dill probe short-circuits)"
    );

    let mut files = Vec::new();
    collect_python_files(&real_rlm, &mut files).unwrap();
    for file in &files {
        let target = rlm.join(file.strip_prefix(&real_rlm).unwrap());
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::copy(file, &target).unwrap();
    }
    invalidate_runtime_probe_cache();
    assert!(kernel_ready(
        &python.to_string_lossy(),
        &fake,
        &identity,
        &[]
    ));
    assert_eq!(
        probe_count(),
        5,
        "the restored runtime re-probed runtime and dill after invalidation"
    );

    std::fs::remove_dir_all(&dill).unwrap();
    assert!(
        !kernel_ready(&python.to_string_lossy(), &fake, &identity, &[]),
        "a removed dill import must not be hidden by the memo"
    );
    assert_eq!(
        probe_count(),
        7,
        "the removed dill re-probed runtime and dill"
    );

    // EXTENDED SEQUENCE (the cross-process layer): restore dill,
    // re-probe through a real verdict, then simulate a fresh process
    // and pin that the disk hit runs ZERO real interpreter probes.
    // The counts above stay the pre-extension sequence the #2857
    // record carries; the extension below is labeled as such.
    let mut files = Vec::new();
    collect_python_files(&real_dill, &mut files).unwrap();
    for file in &files {
        let target = dill.join(file.strip_prefix(&real_dill).unwrap());
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::copy(file, &target).unwrap();
    }
    invalidate_runtime_probe_cache();
    assert!(kernel_ready(
        &python.to_string_lossy(),
        &fake,
        &identity,
        &[]
    ));
    assert_eq!(
        probe_count(),
        9,
        "the restored dill re-probes runtime and dill after invalidation"
    );
    // The fresh-process leg: the in-process map is empty, the verdict
    // lives on disk under the real content-walk key.
    clear_in_process_probe_memo_for_tests();
    assert!(kernel_ready(
        &python.to_string_lossy(),
        &fake,
        &identity,
        &[]
    ));
    assert_eq!(
        probe_count(),
        9,
        "a fresh process hits the disk memo with ZERO real interpreter invocations"
    );
}

/// Live-gated closure freeze (run with `--ignored` on a machine with a
/// real kernel venv): the runtime-ready probe's import closure must
/// stay stdlib-or-rlm-relative at MODULE level, because the memo
/// fingerprints exactly the interpreter + `rlm` + `dill` trees — a
/// module-level third-party import inside the closure would widen the
/// probe's observable surface beyond what the key covers. The test
/// AST-parses the INSTALLED runtime sources with the real python, so
/// it pins the shipped artifact, not the repo checkout.
#[test]
#[ignore = "live: needs a real kernel venv under HOME (bench VMs)"]
fn live_probe_closure_is_stdlib_or_rlm_relative() {
    #[derive(Debug, serde::Deserialize)]
    struct ClosureReport {
        closure: Vec<String>,
        violations: Vec<String>,
    }

    let real_venv = kernel_venv_dir();
    let real_python = kernel_venv_python(&real_venv);
    if !real_python.is_file() {
        eprintln!("kernel python {real_python:?} not found; skipping live closure test");
        return;
    }
    let Some(real_rlm) = installed_rlm_dir(&real_venv) else {
        eprintln!("installed rlm not found; skipping live closure test");
        return;
    };
    let script = r#"import ast, json, sys

stdlib = {
    "inspect", "__future__", "typing", "dataclasses", "enum", "functools",
    "collections", "contextlib", "copy", "datetime", "itertools", "json",
    "os", "pathlib", "re", "shutil", "subprocess", "sys", "time", "uuid",
    "hashlib", "base64", "signal", "threading", "abc", "io", "textwrap",
    "warnings", "asyncio", "types", "stat", "unicodedata", "atexit",
    "secrets", "selectors", "socket", "struct", "fcntl", "termios", "ast",
    "codecs", "contextvars", "ctypes", "linecache", "platform",
    "tempfile", "traceback",
}

def collect(nodes, found):
    for node in nodes:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            continue
        if isinstance(node, ast.Import):
            for alias in node.names:
                found.append((node.lineno, alias.name))
        elif isinstance(node, ast.ImportFrom):
            if not (node.level and node.level > 0):
                found.append((node.lineno, node.module or ""))
        body = getattr(node, "body", None)
        if body:
            collect(body, found)

def path_of(module, root):
    if module in ("rlm",):
        return root + "/__init__.py"
    if module.startswith("rlm."):
        return root + "/" + module.split(".", 1)[1].replace(".", "/") + ".py"
    return None

root = sys.argv[1]
seed = ["rlm", "rlm.mcp", "rlm.harness", "rlm.bash", "rlm.repl"]
closure = []
pending = list(seed)
violations = []
while pending:
    module = pending.pop(0)
    if module in closure:
        continue
    closure.append(module)
    path = path_of(module, root)
    if path is None:
        continue
    try:
        tree = ast.parse(open(path, encoding="utf-8").read(), filename=path)
    except FileNotFoundError:
        violations.append(module + ": closure file missing")
        continue
    found = []
    collect(tree.body, found)
    for lineno, target in found:
        head = target.split(".")[0]
        if head == "rlm":
            pending.append(target)
        elif head not in stdlib:
            violations.append(module + ":" + str(lineno) + ": " + target)

print(json.dumps({"closure": sorted(closure), "violations": violations}))
"#;
    let output = std::process::Command::new(&real_python)
        .arg("-c")
        .arg(script)
        .arg(&real_rlm)
        .output()
        .expect("the real python must run the closure parse");
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    assert!(output.status.success(), "closure parse failed: {stderr}");
    let report: ClosureReport = serde_json::from_str(&stdout)
        .unwrap_or_else(|error| panic!("unparseable closure report {stdout:?}: {error}"));
    // The seed set mirrors the RUNTIME_READY_CHECK's imports; if either
    // changes, this test is the tripwire.
    assert!(
        report.closure.contains(&"rlm.mcp".to_string())
            && report.closure.contains(&"rlm.harness".to_string())
            && report.closure.contains(&"rlm.bash".to_string())
            && report.closure.contains(&"rlm.repl".to_string()),
        "the frozen closure seed is wrong: {report:?}"
    );
    assert!(
        report.violations.is_empty(),
        "the probe import closure grew beyond rlm+stdlib (closure {:?}): {:?}",
        report.closure,
        report.violations
    );
}

#[test]
fn extra_recorded_skills_do_not_force_reinstall() {
    // A session's set ([edit]) must be served by a venv that also carries
    // records from other sessions ([websearch]): the file is a cache.
    let recorded = Some(vec![
        skill("edit", "/skills/edit", "h1"),
        skill("websearch", "/skills/websearch", "h2"),
    ]);
    let current = [skill("edit", "/skills/edit", "h1")];
    assert!(recorded_skills_cover(&recorded, &current));
    // A missing record (new session skill) does force a sync.
    assert!(!recorded_skills_cover(
        &recorded,
        &[
            skill("edit", "/skills/edit", "h1"),
            skill("goal", "/skills/goal", "h3")
        ],
    ));
    // A changed pyproject hash does force a sync.
    assert!(!recorded_skills_cover(
        &recorded,
        &[skill("edit", "/skills/edit", "changed")],
    ));
    // No records at all: nothing is covered.
    assert!(!recorded_skills_cover(&None, &current));
    assert!(recorded_skills_cover(&None, &[]));
}

#[cfg(unix)]
fn fake_uv(dir: &Path, script: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let uv = dir.join("uv");
    std::fs::write(&uv, script).unwrap();
    std::fs::set_permissions(&uv, std::fs::Permissions::from_mode(0o755)).unwrap();
    uv
}

#[cfg(unix)]
fn uv_invocations(dir: &Path) -> Vec<String> {
    std::fs::read_to_string(dir.join("uv.log"))
        .unwrap_or_default()
        .lines()
        .map(String::from)
        .collect()
}

#[cfg(unix)]
#[tokio::test]
async fn skill_sync_batches_missing_installs_into_one_uv_call() {
    // A fake uv records its args: every missing skill must land in ONE
    // invocation, and already-installed skills must stay out of it.
    let dir = tempfile::tempdir().unwrap();
    let uv = fake_uv(
        dir.path(),
        &format!(
            "#!/bin/sh\nprintf '%s\\n' \"$*\" >> {}\nexit 0\n",
            dir.path().join("uv.log").display()
        ),
    );
    let venv = dir.path().join("venv");
    std::fs::create_dir_all(&venv).unwrap();
    std::fs::create_dir_all(dir.path().join("skills/edit")).unwrap();
    std::fs::create_dir_all(dir.path().join("skills/goal")).unwrap();
    write_bootstrap_version(
        &venv,
        "sha256:rt",
        &[skill(
            "edit",
            dir.path().join("skills/edit").to_str().unwrap(),
            "h1",
        )],
    )
    .unwrap();
    let skills = vec![
        skill(
            "edit",
            dir.path().join("skills/edit").to_str().unwrap(),
            "h1",
        ),
        skill(
            "goal",
            dir.path().join("skills/goal").to_str().unwrap(),
            "h2",
        ),
    ];
    sync_python_skills(
        uv.to_str().unwrap(),
        &venv,
        dir.path().join("python").as_path(),
        "sha256:rt",
        &skills,
        &EnsureKernelPythonOptions::default(),
    )
    .await
    .unwrap();
    let calls = uv_invocations(dir.path());
    assert_eq!(calls.len(), 1, "one batched uv invocation: {calls:?}");
    assert!(
        calls[0].contains("goal"),
        "the missing skill installs: {calls:?}"
    );
    assert!(
        !calls[0].contains("skills/edit"),
        "the installed skill is not reinstalled: {calls:?}"
    );
    assert_eq!(calls[0].matches("--editable").count(), 1);
    let version = read_bootstrap_version(&venv).expect("version written");
    assert_eq!(
        version.python_skills.as_ref().map(Vec::len),
        Some(2),
        "both skills recorded"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn skill_sync_falls_back_to_per_skill_installs_on_batch_failure() {
    // A batch covering several skills fails; the fallback retries each
    // missing skill alone, so one broken skill still costs only its own
    // warning and the healthy skills still install.
    let dir = tempfile::tempdir().unwrap();
    let uv = fake_uv(
        dir.path(),
        &format!(
            "#!/bin/sh\nprintf '%s\\n' \"$*\" >> {}\ncase \"$*\" in *broken*) exit 1;; esac\nexit 0\n",
            dir.path().join("uv.log").display()
        ),
    );
    let venv = dir.path().join("venv");
    std::fs::create_dir_all(&venv).unwrap();
    let skills = vec![
        skill("edit", "/skills/edit", "h1"),
        skill("broken", "/skills/broken", "h2"),
    ];
    let warnings = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let mut options = EnsureKernelPythonOptions::default();
    let sink = warnings.clone();
    options.on_progress = Some(std::sync::Arc::new(move |message: &str| {
        sink.lock().unwrap().push(message.to_string());
    }));
    sync_python_skills(
        uv.to_str().unwrap(),
        &venv,
        dir.path().join("python").as_path(),
        "sha256:rt",
        &skills,
        &options,
    )
    .await
    .unwrap();
    let calls = uv_invocations(dir.path());
    assert_eq!(
        calls.len(),
        3,
        "one failed batch then one call per skill: {calls:?}"
    );
    assert!(
        calls[0].contains("edit") && calls[0].contains("broken"),
        "the batch covers both skills: {calls:?}"
    );
    let warnings = warnings.lock().unwrap();
    assert!(
        warnings.len() == 1 && warnings[0].contains("broken"),
        "one warning naming the broken skill: {warnings:?}"
    );
    let version = read_bootstrap_version(&venv).expect("version written");
    let recorded = version
        .python_skills
        .as_ref()
        .expect("skills recorded")
        .iter()
        .map(|s| s.import_name.clone())
        .collect::<Vec<_>>();
    assert_eq!(recorded, vec!["edit"], "only the healthy skill is recorded");
}
