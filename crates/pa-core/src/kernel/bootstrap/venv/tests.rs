//! The venv module's unit battery: Windows executable candidates, the
//! skill-manifest parsing, the version-file round trip, the two-layer
//! probe memo oracles, and the skill-sync batching.
#[test]
fn windows_executable_candidates_default_order() {
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
    assert_eq!(
        windows_executable_candidates("uv", Some(".FOO;.EXE;.BAT")),
        vec!["uv".to_string(), "uv.exe".into(), "uv.bat".into()]
    );
}

#[test]
fn windows_executable_candidates_skips_suffix_and_duplicates() {
    assert_eq!(
        windows_executable_candidates("uv.exe", Some(".EXE;.BAT")),
        vec!["uv.exe".to_string()]
    );
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
    // The default path lives under $HOME. The read joins the env-test
    // lock: concurrent override tests set `PRIME_AGENT_KERNEL_VENV`, and
    // this read must not race them.
    let _guard = PRIME_AGENT_ENV_LOCK.blocking_lock();
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
/// The probe-memo state is process-global: every test that touches it
/// serializes so one test's invalidation cannot clear another's verdicts.
static MEMO_STATE_LOCK: Mutex<()> = Mutex::new(());

/// Collect every `.runtime-probe-memo.json` under `root` (the override
/// boundary pin: the override path must create none).
#[cfg(unix)]
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
    assert!(bootstrap_version_current(Some(&version), "sha256:abc", &[]));
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

/// The out-of-band-detection trio: the memo must hit on an unchanged venv, miss when the installed
/// `rlm` tree or the interpreter changes, and miss after invalidation.
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

    std::fs::write(rlm.join("core.py"), "y = 2\n").unwrap();
    assert!(kernel_ready(&python_str, &venv, "sha256:runtime", &[]));
    assert_eq!(
        probe_count(),
        4,
        "installed-rlm mutation probes runtime and dill instead of masking"
    );

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

    // Fingerprint-invisible damage (the fake's verdict file): the memo still hits — the masked
    // class, detected at kernel-START failure time.
    std::fs::write(&control, "broken\n").unwrap();
    assert!(kernel_ready(&python_str, &venv, "sha256:runtime", &[]));
    assert_eq!(probe_count(), 6, "invisible damage alone does not re-probe");

    invalidate_runtime_probe_cache();
    assert!(!kernel_ready(&python_str, &venv, "sha256:runtime", &[]));
    assert_eq!(probe_count(), 7, "a failing probe is never memoized");

    std::fs::remove_file(&control).unwrap();
    invalidate_runtime_probe_cache();
    assert!(kernel_ready(&python_str, &venv, "sha256:runtime", &[]));
    assert_eq!(probe_count(), 9, "invalidation probes runtime and dill");

    // An uninstalled runtime re-probes rather than masks: the installed-rlm
    // witness disappears (the real probe fails; this fake one passes).
    std::fs::remove_dir_all(&rlm).unwrap();
    assert!(kernel_ready(&python_str, &venv, "sha256:runtime", &[]));
    assert_eq!(
        probe_count(),
        11,
        "an uninstalled rlm probes runtime and dill"
    );

    std::fs::remove_file(&python).unwrap();
    assert!(!kernel_ready(&python_str, &venv, "sha256:runtime", &[]));
    assert_eq!(
        probe_count(),
        11,
        "a deleted interpreter misses on stat without running"
    );
}

/// The cross-process layer, pinned: a fresh process (empty in-process map)
/// hits the on-disk memo under the same identity key and runs ZERO probes.
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
    clear_in_process_probe_memo_for_tests();
    assert!(kernel_ready(&python_str, &venv, "sha256:runtime", &[]));
    assert_eq!(
        probe_count(),
        2,
        "a fresh process hits the disk memo with zero interpreter invocations"
    );
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
/// out of band, and a FRESH process must miss both layers and re-probe.
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

    clear_in_process_probe_memo_for_tests();
    std::fs::write(rlm.join("core.py"), "y = 2\n").unwrap();
    assert!(kernel_ready(&python_str, &venv, "sha256:runtime", &[]));
    assert_eq!(
        probe_count(),
        4,
        "process B re-probes after the out-of-band rlm mutation"
    );

    // The out-of-band uninstall class: the real probe fails and the
    // provisioner rebuilds (this fake one still passes).
    clear_in_process_probe_memo_for_tests();
    std::fs::remove_dir_all(&rlm).unwrap();
    assert!(kernel_ready(&python_str, &venv, "sha256:runtime", &[]));
    assert_eq!(
        probe_count(),
        6,
        "process B re-probes after the rlm uninstall"
    );

    // A repair to the EXACT already-verified content: a fresh process HITS
    // the disk memo with zero probes — the memo working as designed.
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
    // venv) fails the cheap version check before any probe or memo lookup.
    clear_in_process_probe_memo_for_tests();
    write_bootstrap_version(&venv, "sha256:other-runtime", &[]).unwrap();
    assert!(!kernel_ready(&python_str, &venv, "sha256:runtime", &[]));
    assert_eq!(
        probe_count(),
        6,
        "a version-file rewrite fails the cheap check before any probe"
    );

    std::fs::remove_file(&python).unwrap();
    assert!(!kernel_ready(&python_str, &venv, "sha256:runtime", &[]));
    assert_eq!(
        probe_count(),
        6,
        "a deleted interpreter misses without running"
    );
}

/// The masked class, pinned against the DISK layer: fingerprint-invisible damage is masked by a
/// cross-process hit until the first failed kernel start drops BOTH layers and.
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

/// The write-vs-invalidate race: a late atomic write landing after an invalidation resurrects a
/// key-valid entry. That is BENIGN — the entry's key matches the current environment — and the next
/// failed start re-invalidates.
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

    assert!(kernel_ready(&python_str, &venv, "sha256:runtime", &[]));
    assert_eq!(
        probe_count(),
        2,
        "the late write's key-valid entry serves the retry without a probe"
    );
    invalidate_runtime_probe_cache();
    assert!(!super::super::disk_memo::disk_memo_path(&venv).exists());
}

/// Env-mutating tests serialize on this lock: the process env is global.
/// (The env-override tests are Unix-only; env-reading tests on other
/// platforms take it too so the serialization is one lock everywhere.)
static PRIME_AGENT_ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// The bound override resolves to a usable bound or the default - a
/// non-positive value would tree-kill every child on its first poll.
#[test]
fn bootstrap_child_timeout_rejects_non_positive_overrides() {
    let _guard = PRIME_AGENT_ENV_LOCK.blocking_lock();
    let previous = std::env::var("PRIME_AGENT_BOOTSTRAP_CHILD_TIMEOUT_MS").ok();
    let resolve = super::resolve_bootstrap_child_timeout_ms;
    for (given, expected) in [
        ("0", 600_000u64),
        ("-5", 600_000),
        ("abc", 600_000),
        ("", 600_000),
        ("2500", 2_500),
        // The day-topping clamp: a huge override is representable, never a
        // clock-overflow panic after the child is running.
        ("99999999999999999", 86_400_000),
        ("86400000", 86_400_000),
    ] {
        std::env::set_var("PRIME_AGENT_BOOTSTRAP_CHILD_TIMEOUT_MS", given);
        assert_eq!(
            resolve(),
            expected,
            "the override {given:?} resolves to {expected:?}"
        );
    }
    match previous {
        Some(value) => std::env::set_var("PRIME_AGENT_BOOTSTRAP_CHILD_TIMEOUT_MS", value),
        None => std::env::remove_var("PRIME_AGENT_BOOTSTRAP_CHILD_TIMEOUT_MS"),
    }
}

/// A caller-owned `PRIME_AGENT_KERNEL_PYTHON` override resolves through
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

/// The Windows venv layout (`<venv>/Lib/site-packages/rlm`, no python-version layer) is a
/// fingerprint input: mutations under it change the memo key.
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

/// Live (ignored by default; run with `--ignored` on a machine with a kernel venv under `HOME`):
/// the memo behavior against a REAL interpreter and a REAL `rlm` import.
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

    // EXTENDED SEQUENCE: restore dill, re-probe through a real verdict, then simulate a fresh
    // process and pin that the disk hit runs ZERO real interpreter probes.
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

/// Live-gated closure freeze (run with `--ignored` on a machine with a real kernel venv): the
/// runtime-ready probe's import closure must stay stdlib-or- rlm-relative at MODULE level. Pins the
/// shipped artifact.
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
    assert!(recorded_skills_cover(recorded.as_deref(), &current));
    assert!(!recorded_skills_cover(
        recorded.as_deref(),
        &[
            skill("edit", "/skills/edit", "h1"),
            skill("goal", "/skills/goal", "h3")
        ],
    ));
    assert!(!recorded_skills_cover(
        recorded.as_deref(),
        &[skill("edit", "/skills/edit", "changed")],
    ));
    assert!(!recorded_skills_cover(None, &current));
    assert!(recorded_skills_cover(None, &[]));
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
    // A batch covering several skills fails; the fallback retries each missing skill alone.
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

/// Saves the caller's `PATH`, prepends `dir`, and returns the restore
/// closure (the fake-uv tests put their stub on PATH because `ensure_uv`
/// searches PATH before its `~/.local/bin` fallback - a real uv on the
/// box's PATH would otherwise win).
#[cfg(unix)]
fn prepend_path(dir: &Path) -> impl FnOnce() {
    let previous = std::env::var("PATH").ok();
    let with_stub = std::env::join_paths(std::iter::once(dir.to_path_buf()).chain(
        std::env::split_paths(&std::env::var("PATH").unwrap_or_default()),
    ))
    .unwrap_or_default();
    std::env::set_var("PATH", &with_stub);
    move || match previous {
        Some(value) => std::env::set_var("PATH", value),
        None => std::env::remove_var("PATH"),
    }
}

#[cfg(unix)]
fn report_collector() -> (
    std::sync::Arc<std::sync::Mutex<Vec<String>>>,
    EnsureKernelPythonOptions,
) {
    let lines = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let sink = lines.clone();
    let options = EnsureKernelPythonOptions {
        on_progress: Some(std::sync::Arc::new(move |message: &str| {
            sink.lock().unwrap().push(message.to_string());
        })),
        ..Default::default()
    };
    (lines, options)
}

/// The drain pin: every bootstrap uv child writes through piped stdio
/// that the parent drains and forwards through the progress reporter.
/// The bulk is past the pipe capacity on both streams, so a spawn nobody
/// drains would block the child before it can exit.
#[cfg(unix)]
#[tokio::test]
async fn bootstrap_children_forward_piped_output_through_the_reporter() {
    let _guard = PRIME_AGENT_ENV_LOCK.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let _uv = fake_uv(
        dir.path(),
        "#!/bin/sh\n\
         echo UV_STDOUT_MARKER\n\
         echo UV_STDERR_MARKER >&2\n\
         seq 1 20000\n\
         seq 1 20000 >&2\n\
         exit 0\n",
    );
    let (reports, options) = report_collector();
    let venv = dir.path().join("venv");
    std::fs::create_dir_all(&venv).unwrap();
    let restore_path = prepend_path(dir.path());
    let outcome = bootstrap_venv(&venv, &[], &options).await;
    restore_path();
    assert!(outcome.is_ok(), "the bootstrap completes: {outcome:?}");
    let drained = reports.lock().unwrap().join("\n");
    assert!(
        drained.contains("UV_STDOUT_MARKER"),
        "the drained stdout reaches the reporter: {drained:?}"
    );
    assert!(
        drained.contains("UV_STDERR_MARKER"),
        "the drained stderr reaches the reporter: {drained:?}"
    );
}

/// A stream without newlines is drained in bounded pieces: one line may
/// not buffer without bound while the child bound is still minutes away.
#[cfg(unix)]
#[tokio::test]
async fn a_newline_free_stream_is_drained_in_bounded_pieces() {
    let _guard = PRIME_AGENT_ENV_LOCK.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let _uv = fake_uv(
        dir.path(),
        "#!/bin/sh\n\
         echo BEGIN_MARKER\n\
         head -c 2097152 /dev/zero | tr '\\0' x\n\
         echo END_MARKER\n\
         exit 0\n",
    );
    let (reports, options) = report_collector();
    let venv = dir.path().join("venv");
    std::fs::create_dir_all(&venv).unwrap();
    let restore_path = prepend_path(dir.path());
    let outcome = bootstrap_venv(&venv, &[], &options).await;
    restore_path();
    assert!(outcome.is_ok(), "the bootstrap completes: {outcome:?}");
    let collected = reports.lock().unwrap();
    assert!(
        collected.len() > 10,
        "the cap-free stream reaches the reporter in pieces: {:?}",
        collected.len()
    );
    let longest = collected.iter().map(String::len).max().unwrap_or(0);
    assert!(
        longest <= super::MAX_DRAIN_LINE_BYTES,
        "no forwarded piece may exceed the cap: longest is {longest}, cap is {}",
        super::MAX_DRAIN_LINE_BYTES
    );
    let pieces = collected
        .iter()
        .filter(|line| line.contains('x') && !line.contains("MARKER"))
        .map(String::len)
        .collect::<Vec<_>>();
    let filled = pieces.iter().any(|length| *length >= 32_000);
    assert!(
        filled,
        "the over-long line is forwarded in cap-sized pieces, not in every          reader-sized chunk (pieces: {pieces:?})"
    );
    assert!(
        collected.iter().any(|line| line.contains("BEGIN_MARKER")),
        "the stream's head reaches the reporter"
    );
    assert!(
        collected.iter().any(|line| line.contains("END_MARKER")),
        "the stream's tail reaches the reporter"
    );
}

/// A line shorter than the cap that spans several reader fills stays
/// whole: only the cap splits a line, never the reader's chunk size.
#[cfg(unix)]
#[tokio::test]
async fn a_short_line_spanning_fills_is_forwarded_whole() {
    let _guard = PRIME_AGENT_ENV_LOCK.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let _uv = fake_uv(
        dir.path(),
        "#!/bin/sh\n\
         head -c 20480 /dev/zero | tr '\\0' x\n\
         echo\n\
         echo END_MARKER\n\
         exit 0\n",
    );
    let (reports, options) = report_collector();
    let venv = dir.path().join("venv");
    std::fs::create_dir_all(&venv).unwrap();
    let restore_path = prepend_path(dir.path());
    let outcome = bootstrap_venv(&venv, &[], &options).await;
    restore_path();
    assert!(outcome.is_ok(), "the bootstrap completes: {outcome:?}");
    let collected = reports.lock().unwrap();
    let whole = collected
        .iter()
        .find(|line| line.starts_with('x'))
        .expect("the over-cap-free line reached the reporter");
    assert_eq!(
        whole.len(),
        20480,
        "a line under the cap arrives in one piece, spanning fills: {whole:?}"
    );
    assert!(
        collected.iter().any(|line| line.contains("END_MARKER")),
        "the tail reaches the reporter"
    );
}

/// A parent's death takes its bootstrap children down: they run in
/// their own process group (the bound's group kill needs it), which also
/// shields them from a terminal's interrupt - so the guard stack itself
/// must arm the parent-death signal that reaches them when the parent
/// exits. The signal follows the spawning thread, and the bootstrap
/// keeps that thread waiting for as long as the child runs - so here
/// the child survives until the spawning thread's exit, then it must
/// die by the stack's own kill.
#[cfg(target_os = "linux")]
#[test]
fn a_parent_death_kills_the_bootstrap_child() {
    use std::os::unix::process::ExitStatusExt;
    use std::sync::{Arc, Mutex};
    let child_slot: Arc<Mutex<Option<std::process::Child>>> = Arc::new(Mutex::new(None));
    let slot_for_thread = child_slot.clone();
    let handle = std::thread::spawn(move || {
        let mut command = std::process::Command::new("sleep");
        // Five seconds out, well inside the ten-second deadline: the
        // child's own exit must lose the race to the parent-death kill,
        // so only the kill can end it while the stack is intact - and a
        // stack that lost its kill still dies (and gets reaped below)
        // rather than leaking.
        command.arg("5");
        // The stack the real bootstrap children spawn under: if the
        // parent-death signal is dropped from it, this test goes red.
        configure_bootstrap_child_spawn(&mut command);
        let child = command.spawn().expect("spawn the child");
        *slot_for_thread.lock().unwrap() = Some(child);
    });
    handle.join().expect("the spawning thread ran");
    // A blocking wait turns the child's death into a message, and the
    // deadline bounds only the failure path: no polling, and the reaping
    // happens in the waiter as part of the wait.
    let (status_tx, status_rx) = std::sync::mpsc::channel();
    let waiter = std::thread::spawn(move || {
        let status = match child_slot.lock().unwrap().take() {
            Some(mut child) => child.wait(),
            None => Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "the child was never stored",
            )),
        };
        let _ = status_tx.send(status);
    });
    let deadline = std::time::Duration::from_secs(10);
    match status_rx.recv_timeout(deadline) {
        Ok(Ok(status)) => {
            // The child self-exits only after five seconds, the verdict
            // lands inside milliseconds: only the parent-death kill can
            // end it with the kill wired.
            assert_eq!(
                status.signal(),
                Some(libc::SIGKILL),
                "the child must die by the parent-death SIGKILL"
            );
            waiter.join().expect("the waiter thread ran");
        }
        Ok(Err(err)) => {
            waiter.join().expect("the waiter thread ran");
            panic!("the child's wait failed: {err}");
        }
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            // The child cannot outlive the deadline on its own, so this
            // arm is the wiring lost AND the natural exit unscheduled -
            // the join below still reaps it before the verdict fails the
            // test, and no kill is ever sent to a pid that might have
            // been recycled.
            waiter.join().expect("the waiter thread ran");
            panic!("the child outlived its spawning thread");
        }
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
            panic!("the waiter thread never reported the child's exit");
        }
    }
}

/// A child that emits non-UTF-8 bytes mid-stream is forwarded mangled,
/// never allowed to end the drain: the lines after the bad bytes still
/// reach the reporter and the bootstrap still completes.
#[cfg(unix)]
#[tokio::test]
async fn a_non_utf8_child_line_never_stops_the_drain() {
    let _guard = PRIME_AGENT_ENV_LOCK.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let _uv = fake_uv(
        dir.path(),
        "#!/bin/sh\n         echo BEFORE_MARKER\n         printf '\\377\\376BAD\\n'\n         echo AFTER_MARKER\n         exit 0\n",
    );
    let (reports, options) = report_collector();
    let venv = dir.path().join("venv");
    std::fs::create_dir_all(&venv).unwrap();
    let restore_path = prepend_path(dir.path());
    let outcome = bootstrap_venv(&venv, &[], &options).await;
    restore_path();
    assert!(outcome.is_ok(), "the bootstrap completes: {outcome:?}");
    let drained = reports.lock().unwrap().join("\n");
    assert!(
        drained.contains("AFTER_MARKER"),
        "the drain survives the non-UTF-8 line: {drained:?}"
    );
    assert!(
        drained.contains("BEFORE_MARKER"),
        "the drain forwards the lines before it too: {drained:?}"
    );
}

/// The bound pin: a child that never exits is tree-killed at the bound -
/// the child AND its descendants (the fake uv leaves a sleeping one) -
/// and the bootstrap reports the honest failure instead of waiting.
#[cfg(unix)]
#[tokio::test]
async fn a_hung_bootstrap_child_is_bounded_and_killed() {
    let _guard = PRIME_AGENT_ENV_LOCK.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let pid_file = dir.path().join("hung-uv.pid");
    let descendant_file = dir.path().join("hung-uv.descendant.pid");
    let _uv = fake_uv(
        dir.path(),
        &format!(
            "#!/bin/sh\nprintf '%s\\n' \"$$\" > {}\nsleep 600 &\nprintf '%s\\n' \"$!\" > {}\nwait\n",
            pid_file.display(),
            descendant_file.display()
        ),
    );
    // `ensure_kernel_python` resolves the venv dir itself: the override
    // must pin it to this test's scratch, never a real machine venv.
    let venv = dir.path().join("venv");
    let previous_venv = std::env::var("PRIME_AGENT_KERNEL_VENV").ok();
    let previous_timeout = std::env::var("PRIME_AGENT_BOOTSTRAP_CHILD_TIMEOUT_MS").ok();
    std::env::set_var("PRIME_AGENT_KERNEL_VENV", &venv);
    std::env::set_var("PRIME_AGENT_BOOTSTRAP_CHILD_TIMEOUT_MS", "1200");
    let restore_path = prepend_path(dir.path());
    let outcome = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        super::super::ensure_kernel_python(EnsureKernelPythonOptions::default()),
    )
    .await;
    restore_path();
    match previous_timeout {
        Some(value) => std::env::set_var("PRIME_AGENT_BOOTSTRAP_CHILD_TIMEOUT_MS", value),
        None => std::env::remove_var("PRIME_AGENT_BOOTSTRAP_CHILD_TIMEOUT_MS"),
    }
    match previous_venv {
        Some(value) => std::env::set_var("PRIME_AGENT_KERNEL_VENV", value),
        None => std::env::remove_var("PRIME_AGENT_KERNEL_VENV"),
    }
    // Red-shape cleanup first: a boundless wait leaves the hung child
    // alive behind a leaked blocked thread - kill it so the test process
    // stays clean whatever the assertion below finds.
    let hung_pid = std::fs::read_to_string(&pid_file)
        .ok()
        .and_then(|text| text.trim().parse::<u32>().ok());
    let descendant_pid = std::fs::read_to_string(&descendant_file)
        .ok()
        .and_then(|text| text.trim().parse::<u32>().ok());
    for pid in [hung_pid, descendant_pid].into_iter().flatten() {
        let _ =
            crate::platform::process::kill_pid(pid as i32, crate::platform::process::Signal::Kill);
    }
    let result = outcome.expect(
        "the bootstrap wait must be bounded - the hung child held it for the whole 30s guard",
    );
    let error = result.expect_err("a hung child must fail the bootstrap");
    let text = format!("{error:#}");
    assert!(
        text.contains("did not finish within"),
        "the bounded failure names the wait: {text}"
    );
    assert!(text.contains("1200ms"), "the bound is the override: {text}");
    let pid = hung_pid.expect("the fake uv published its pid");
    assert!(
        !crate::platform::process::pid_exists(pid),
        "the hung uv child is killed, not left running"
    );
    let descendant = descendant_pid.expect("the fake uv published its descendant");
    assert!(
        !crate::platform::process::pid_exists(descendant),
        "the kill reaches the child tree, not just the child"
    );
}

/// The exit-path grace: a child that exits while a descendant holds its
/// pipes must not turn the drained join into a new unbounded wait - the
/// bootstrap completes within the grace and the descendant is left to
/// die on its own.
#[cfg(unix)]
#[tokio::test]
async fn a_descendant_holding_the_pipes_does_not_hang_a_completed_bootstrap() {
    let _guard = PRIME_AGENT_ENV_LOCK.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let descendant_file = dir.path().join("holder.pid");
    let _uv = fake_uv(
        dir.path(),
        &format!(
            "#!/bin/sh\nsleep 60 &\nprintf '%s\\n' \"$!\" > {}\nexit 0\n",
            descendant_file.display()
        ),
    );
    let venv = dir.path().join("venv");
    std::fs::create_dir_all(&venv).unwrap();
    let restore_path = prepend_path(dir.path());
    let outcome = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        bootstrap_venv(&venv, &[], &EnsureKernelPythonOptions::default()),
    )
    .await;
    restore_path();
    let descendant = std::fs::read_to_string(&descendant_file)
        .ok()
        .and_then(|text| text.trim().parse::<u32>().ok());
    if let Some(pid) = descendant {
        let _ =
            crate::platform::process::kill_pid(pid as i32, crate::platform::process::Signal::Kill);
    }
    let result = outcome.expect("a completed bootstrap must not wait on a pipe-holding descendant");
    assert!(result.is_ok(), "the bootstrap completes: {result:?}");
}

/// The non-interactive pin: stdin stays null (never inherited - an
/// unattended bootstrap must not wait on stdio it does not own), and
/// every uv call carries `--no-progress`.
#[cfg(unix)]
#[tokio::test]
async fn bootstrap_venv_runs_uv_quietly_with_no_stdin() {
    let _guard = PRIME_AGENT_ENV_LOCK.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let uv_log = dir.path().join("uv.log");
    let _uv = fake_uv(
        dir.path(),
        &format!(
            "#!/bin/sh\n\
             printf '%s\\n' \"$*\" >> {uv_log}\n\
             if read -r leaked; then printf 'stdin-leaked: %s\\n' \"$leaked\" >> {uv_log}; fi\n\
             exit 0\n",
            uv_log = uv_log.display()
        ),
    );
    let venv = dir.path().join("venv");
    std::fs::create_dir_all(&venv).unwrap();
    let restore_path = prepend_path(dir.path());
    let outcome = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        bootstrap_venv(&venv, &[], &EnsureKernelPythonOptions::default()),
    )
    .await;
    restore_path();
    let result = outcome.expect("the bootstrap must be bounded even against a stdin-blocked child");
    assert!(result.is_ok(), "the bootstrap completes: {result:?}");
    let calls = uv_invocations(dir.path());
    assert_eq!(
        calls.len(),
        3,
        "python, venv, then the runtime install: {calls:?}"
    );
    for call in &calls {
        assert!(
            call.starts_with("--no-progress"),
            "every uv call is non-interactive: {call}"
        );
    }
    assert_eq!(calls[0], "--no-progress python install 3.11");
    assert!(
        calls[1].starts_with("--no-progress venv ") && calls[1].contains("--python 3.11 --seed"),
        "the venv call keeps its shape: {}",
        calls[1]
    );
    assert!(
        calls[2].starts_with("--no-progress pip install "),
        "the runtime call keeps its shape: {}",
        calls[2]
    );
    assert!(
        calls[2].contains("requests") && calls[2].contains("tyro"),
        "the default extras ride: {}",
        calls[2]
    );
    assert!(
        !calls.join("\n").contains("stdin-leaked"),
        "the child's stdin is null, never inherited: {calls:?}"
    );
}
