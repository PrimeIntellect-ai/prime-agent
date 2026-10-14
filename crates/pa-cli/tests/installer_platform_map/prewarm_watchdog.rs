//! The install-rust.sh pre-warm WATCHDOG drives, split from the
//! installer platform-map file at the advisory size cap: the gate block
//! is extracted from the shipped script and driven under `sh` against a
//! hanging launcher with a detached descendant. The watchdog must stop
//! the whole tree (or report honestly when it cannot), degrade to the
//! offline note's own phrase, validate the bound override, and CONTINUE
//! the install.

use std::process::Command;

use super::repo_root;

/// install-rust.sh's kernel pre-warm WATCHDOG: the gate block is
/// extracted from the shipped script and driven under `sh` against a
/// hanging launcher with a detached descendant. The watchdog must stop
/// the whole tree (or report honestly when it cannot), degrade to the
/// offline note's own phrase, validate the bound override, and CONTINUE
/// the install.
#[test]
fn install_rust_sh_prewarm_watchdog_bounds_a_hung_launcher() {
    let script =
        std::fs::read_to_string(repo_root().join("install-rust.sh")).expect("read install-rust.sh");
    // The pinned bound default rides the shipped text, and the malformed
    // override falls back to it (extracted and driven under `sh`).
    let bound_default = "prewarm_bound_s=\"${prewarm_bound_s:-300}\"";
    assert!(
        script.contains(bound_default),
        "the pre-warm bound default (300s) rides the script"
    );
    let validation_start = script
        .find("case \"$prewarm_bound_s\" in")
        .expect("the bound validation exists");
    let validation_line = "[ \"$prewarm_bound_s\" -gt 0 ] || prewarm_bound_s=300";
    let validation_end = script[validation_start..]
        .find(validation_line)
        .map(|at| validation_start + at + validation_line.len())
        .expect("the bound's positivity check rides the script");
    let validation = &script[validation_start..validation_end];
    for (given, expected) in [("zzz", "300"), ("0", "300"), ("2", "2"), ("", "300")] {
        let harness = format!(
            "#!/bin/sh\nprewarm_bound_s={given}\n{validation}\nprintf '%s\\n' \"$prewarm_bound_s\"\n"
        );
        let dir = tempfile::tempdir().expect("scratch dir");
        let path = dir.path().join("bound.sh");
        std::fs::write(&path, harness).expect("write the bound harness");
        let out = Command::new("sh")
            .arg(&path)
            .output()
            .expect("run the bound harness");
        assert!(
            out.status.success(),
            "the bound validation must not abort: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert_eq!(
            String::from_utf8_lossy(&out.stdout).trim(),
            expected,
            "the bound {given:?} resolves to {expected:?}"
        );
    }
    let gate = script
        .find("# THE PRE-WARM GATE")
        .expect("the pre-warm gate exists");
    let start = script[gate..]
        .find("if uv_on_path")
        .map(|at| gate + at)
        .expect("the gate's guard if opens the block");
    let end = script
        .find("# --- verify: the launcher must answer --version")
        .expect("the verify section follows the pre-warm");
    let block = &script[start..end];
    // The runner wait is skipped after expiry: the runner can itself be
    // stuck on an unkillable launcher, and waiting for it would trade the
    // watchdog for a new hang that never reaches the degradation note.
    assert!(
        block.contains(
            "if [ -z \"$prewarm_timed_out\" ]; then\n    wait \"$prewarm_runner\" 2>/dev/null || true\n  fi"
        ),
        "the runner wait runs only on a normal pre-warm: {block}"
    );

    let drive = drive_sh_prewarm_block(block, "2", None);
    let status = drive.status.unwrap_or_else(|| {
        panic!("the pre-warm block ran past its watchdog - a hung launcher held the whole install")
    });
    assert!(
        status.success(),
        "the install continues past a bounded pre-warm: {status:?}"
    );
    assert!(
        drive.flow.contains("fail Preparing the Python kernel"),
        "the watchdog records the stopped step: {}",
        drive.flow
    );
    assert!(
        drive
            .flow
            .contains("the first session bootstraps the kernel itself and needs the network once"),
        "the honest degradation note (the offline note's own phrase): {}",
        drive.flow
    );
    assert!(
        drive.flow.contains("flow-continued"),
        "the install proceeds after the pre-warm: {}",
        drive.flow
    );
    assert!(
        drive.terminated,
        "the watchdog TERMed the hung launcher before degrading"
    );
    // The whole fixture tree dies with the launcher (where the walk's own
    // pgrep exists): the install must not continue while a pre-warm
    // descendant still runs.
    if Command::new("sh")
        .arg("-c")
        .arg("command -v pgrep >/dev/null 2>&1")
        .status()
        .is_ok_and(|status| status.success())
    {
        for (pid, still_alive, name) in &drive.tree {
            assert!(
                !still_alive,
                "the launcher tree was swept with it (the {name} pid {pid} survives)"
            );
        }
    }

    // The no-walk arm reports honestly: with pgrep absent the tree's
    // state is unknown, and the note must say the pre-warm could not be
    // stopped - never claim an unobserved stop.
    let no_walk_dir = tempfile::tempdir().expect("scratch dir for the hermetic path");
    let no_walk_bin = no_walk_dir.path().join("bin");
    std::fs::create_dir_all(&no_walk_bin).expect("hermetic bin dir");
    for tool in ["mktemp", "cat", "sleep", "rm"] {
        let source = Command::new("sh")
            .arg("-c")
            .arg(format!("command -v {tool}"))
            .output()
            .expect("locate the tool");
        let source = String::from_utf8_lossy(&source.stdout).trim().to_string();
        assert!(
            !source.is_empty(),
            "the host has no {tool} for the hermetic path"
        );
        #[cfg(unix)]
        std::os::unix::fs::symlink(&source, no_walk_bin.join(tool))
            .unwrap_or_else(|error| panic!("symlink {tool}: {error}"));
    }
    let no_walk = drive_sh_prewarm_block(block, "2", Some(&no_walk_bin));
    let status = no_walk
        .status
        .unwrap_or_else(|| panic!("the no-walk pre-warm block ran past its watchdog"));
    assert!(
        status.success(),
        "the install continues past a bounded pre-warm without the walk: {status:?}"
    );
    assert!(
        no_walk.flow.contains("could not be")
            && no_walk.flow.contains("provisioning may still be running"),
        "the no-walk expiry says the tree could not be stopped: {}",
        no_walk.flow
    );
    assert!(
        no_walk.flow.contains("flow-continued"),
        "the install proceeds after the no-warm expiry: {}",
        no_walk.flow
    );
}

/// The pre-warm is best-effort end to end: a machine whose TMPDIR cannot
/// host the scratch directory (unwritable, full) must still finish the
/// install, never abort under `set -e` after the payload is published.
/// The gate block is extracted from the shipped script and driven under
/// `sh` WITH `set -e` (as shipped) and a dead TMPDIR; the launcher must
/// never run.
#[test]
fn install_rust_sh_prewarm_skips_when_the_scratch_cannot_be_made() {
    let script =
        std::fs::read_to_string(repo_root().join("install-rust.sh")).expect("read install-rust.sh");
    let gate = script
        .find("# THE PRE-WARM GATE")
        .expect("the pre-warm gate exists");
    let start = script[gate..]
        .find("if uv_on_path")
        .map(|at| gate + at)
        .expect("the gate's guard if opens the block");
    let end = script
        .find("# --- verify: the launcher must answer --version")
        .expect("the verify section follows the pre-warm");
    let block = &script[start..end];

    let dir = tempfile::tempdir().expect("scratch dir");
    let transcript = dir.path().join("transcript");
    let dead_tmpdir = dir.path().join("no-such-dir");
    let harness = format!(
        "#!/bin/sh\n         set -e\n         step_start() {{ printf 'start %s\\n' \"$1\" >> {transcript}; }}\n         step_ok() {{ printf 'ok %s\\n' \"$1\" >> {transcript}; }}\n         step_fail() {{ printf 'fail %s %s\\n' \"$1\" \"$2\" >> {transcript}; }}\n         say() {{ printf 'say %s\\n' \"$*\" >> {transcript}; }}\n         note() {{ printf 'note %s\\n' \"$*\" >> {transcript}; }}\n         uv_on_path() {{ return 0; }}\n         launcher='never-run'\n\
         install_probe_launcher='never-run'\n\
         TMPDIR={dead_tmpdir}\n         export TMPDIR\n         {block}\
         printf 'flow-continued\\n' >> {transcript}\n         exit 0\n",
        transcript = transcript.display(),
        dead_tmpdir = dead_tmpdir.display(),
        block = block,
    );
    let harness_path = dir.path().join("harness.sh");
    std::fs::write(&harness_path, harness).expect("write the harness");
    let out = Command::new("/bin/sh")
        .arg(&harness_path)
        .output()
        .expect("run the harness");
    let flow = std::fs::read_to_string(&transcript).unwrap_or_default();
    assert!(
        out.status.success(),
        "the install survives a scratch that cannot be made (set -e, as shipped): {out:?} flow: {flow}"
    );
    assert!(
        flow.contains("fail Preparing the Python kernel skipped"),
        "the skip is recorded on the started step: {flow}"
    );
    assert!(
        flow.contains("the first session bootstraps the kernel itself and needs the network once"),
        "the honest degradation note rides the skip: {flow}"
    );
    assert!(
        flow.contains("flow-continued"),
        "the install proceeds after the skipped pre-warm: {flow}"
    );

    // The sweep is best-effort too: a scratch the cleanup cannot remove
    // (a surviving pre-warm descendant holds it busy) warns and the
    // install continues, never aborts after a successful pre-warm.
    let transcript2 = dir.path().join("transcript2");
    let rm_stub = dir.path().join("fail-rm");
    std::fs::create_dir_all(&rm_stub).expect("rm stub dir");
    std::fs::write(rm_stub.join("rm"), "#!/bin/sh\nexit 1\n").expect("write the failing rm");
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(rm_stub.join("rm"), std::fs::Permissions::from_mode(0o755))
            .expect("rm stub permissions");
    }
    let harness2 = format!(
        "#!/bin/sh\n\
         set -e\n\
         step_start() {{ printf 'start %s\\n' \"$1\" >> {transcript}; }}\n\
         step_ok() {{ printf 'ok %s\\n' \"$1\" >> {transcript}; }}\n\
         step_fail() {{ printf 'fail %s %s\\n' \"$1\" \"$2\" >> {transcript}; }}\n\
         say() {{ printf 'say %s\\n' \"$*\" >> {transcript}; }}\n\
         note() {{ printf 'note %s\\n' \"$*\" >> {transcript}; }}\n\
         uv_on_path() {{ return 0; }}\n\
         launcher=true\n\
         install_probe_launcher=true\n\
\
         TMPDIR={tmpdir}\n\
         export TMPDIR\n\
         PATH={rm_stub}:$PATH\n\
         export PATH\n\
         {block}\
         printf 'flow-continued\\n' >> {transcript}\n\
         exit 0\n",
        transcript = transcript2.display(),
        tmpdir = dir.path().join("tmp").display(),
        rm_stub = rm_stub.display(),
        block = block,
    );
    let harness2_path = dir.path().join("harness2.sh");
    std::fs::write(&harness2_path, harness2).expect("write the sweep harness");
    std::fs::create_dir_all(dir.path().join("tmp")).expect("the working TMPDIR exists");
    let out2 = Command::new("/bin/sh")
        .arg(&harness2_path)
        .output()
        .expect("run the sweep harness");
    let flow2 = std::fs::read_to_string(&transcript2).unwrap_or_default();
    assert!(
        out2.status.success(),
        "the install survives a scratch that cannot be swept: {out2:?} flow: {flow2}"
    );
    assert!(
        flow2.contains("ok Kernel ready"),
        "the pre-warm itself succeeded before the sweep: {flow2}"
    );
    assert!(
        flow2.contains("warning: could not remove the kernel pre-warm scratch"),
        "the failed sweep warns by name: {flow2}"
    );
    assert!(
        flow2.contains("flow-continued"),
        "the install proceeds after the failed sweep: {flow2}"
    );
}

/// The runner holds nothing of the caller's captures: the TUI's /update
/// runs this installer through `Command::output()`, which waits for pipe
/// EOF past the shell's own exit - a runner stranded on an unkillable
/// launcher would hold that pipe open past the watchdog. The block is
/// extracted from the shipped script, driven under `sh` with `set -e`,
/// the detail fd 3 open (`exec 3>&1`, the installer's own shape), and a
/// `wait` stub that strands the runner for seconds past the bound; the
/// captured pipe must reach EOF with the shell, not with the runner.
#[test]
fn install_rust_sh_prewarm_runner_releases_the_captured_pipe() {
    let script =
        std::fs::read_to_string(repo_root().join("install-rust.sh")).expect("read install-rust.sh");
    let gate = script
        .find("# THE PRE-WARM GATE")
        .expect("the pre-warm gate exists");
    let start = script[gate..]
        .find("if uv_on_path")
        .map(|at| gate + at)
        .expect("the gate's guard if opens the block");
    let end = script
        .find("# --- verify: the launcher must answer --version")
        .expect("the verify section follows the pre-warm");
    let block = &script[start..end];

    let dir = tempfile::tempdir().expect("scratch dir");
    let transcript = dir.path().join("transcript");
    let harness = format!(
        "#!/bin/sh\n\
         set -e\n\
         exec 3>&1\n\
         wait() {{ sleep 8; }}\n\
         step_start() {{ printf 'start %s\\n' \"$1\" >> {transcript}; }}\n\
         step_ok() {{ printf 'ok %s\\n' \"$1\" >> {transcript}; }}\n\
         step_fail() {{ printf 'fail %s %s\\n' \"$1\" \"$2\" >> {transcript}; }}\n\
         say() {{ printf 'say %s\\n' \"$*\" >> {transcript}; }}\n\
         note() {{ printf 'note %s\\n' \"$*\" >> {transcript}; }}\n\
         uv_on_path() {{ return 0; }}\n\
         launcher=true\n\
         install_probe_launcher=true\n\
\
         prewarm_bound_s=2\n\
         {block}\
         printf 'flow-continued\\n' >> {transcript}\n\
         exit 0\n",
        transcript = transcript.display(),
        block = block,
    );
    let harness_path = dir.path().join("harness.sh");
    std::fs::write(&harness_path, harness).expect("write the harness");
    let started = std::time::Instant::now();
    let out = Command::new("/bin/sh")
        .arg(&harness_path)
        .output()
        .expect("run the harness with captured output");
    let elapsed = started.elapsed();
    let flow = std::fs::read_to_string(&transcript).unwrap_or_default();
    assert!(
        out.status.success(),
        "the install finishes past the watchdog: {out:?} flow: {flow}"
    );
    assert!(
        flow.contains("flow-continued"),
        "the install proceeds after expiry: {flow}"
    );
    assert!(
        elapsed < std::time::Duration::from_secs(7),
        "the captured pipe reaches EOF with the shell, not with the stranded \
         runner (took {elapsed:?}; the runner stub lingers 8s past it): {flow}"
    );
    // The detachment rides the shipped text: the runner subshell closes
    // stdin, stdout, stderr, and fd 3 at the spawn boundary.
    assert!(
        block.contains(") </dev/null >/dev/null 2>&1 3>&- &"),
        "the runner subshell detaches the caller's descriptors at spawn: {block}"
    );
}

/// The kill must contain a RESPAWNING launcher: still running between
/// the walk and the kill, it can start another provisioning that the
/// sampled tree, the kill list, and the stop verdict all miss. The gate
/// block is extracted from the shipped script and driven against a
/// launcher that spawns a fresh persistent child every second; after the
/// watchdog expires, NOTHING it ever spawned may survive.
#[test]
fn install_rust_sh_prewarm_kill_contains_a_respawning_launcher() {
    let script =
        std::fs::read_to_string(repo_root().join("install-rust.sh")).expect("read install-rust.sh");
    let gate = script
        .find("# THE PRE-WARM GATE")
        .expect("the pre-warm gate exists");
    let start = script[gate..]
        .find("if uv_on_path")
        .map(|at| gate + at)
        .expect("the gate's guard if opens the block");
    let end = script
        .find("# --- verify: the launcher must answer --version")
        .expect("the verify section follows the pre-warm");
    let block = &script[start..end];

    let dir = tempfile::tempdir().expect("scratch dir");
    let transcript = dir.path().join("transcript");
    let spawned_log = dir.path().join("spawned");
    let launcher = dir.path().join("launcher");
    std::fs::write(
        &launcher,
        format!(
            "#!/bin/sh\ntrap '' TERM INT\nwhile :; do\n  sleep 300 &\n  printf '%s\\n' \"$!\" >> {log}\n  sleep 0.3\ndone\n",
            log = spawned_log.display(),
        ),
    )
    .expect("write the respawning launcher");
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&launcher, std::fs::Permissions::from_mode(0o755))
            .expect("launcher permissions");
    }
    let harness = format!(
        "#!/bin/sh\n\
         set -e\n\
         step_start() {{ printf 'start %s\\n' \"$1\" >> {transcript}; }}\n\
         step_ok() {{ printf 'ok %s\\n' \"$1\" >> {transcript}; }}\n\
         step_fail() {{ printf 'fail %s %s\\n' \"$1\" \"$2\" >> {transcript}; }}\n\
         say() {{ printf 'say %s\\n' \"$*\" >> {transcript}; }}\n\
         note() {{ printf 'note %s\\n' \"$*\" >> {transcript}; }}\n\
         uv_on_path() {{ return 0; }}\n\
         launcher='{launcher}'\n\
         install_probe_launcher='{launcher}'\n\
         prewarm_bound_s=2\n\
         {block}\
         printf 'flow-continued\\n' >> {transcript}\n\
         exit 0\n",
        transcript = transcript.display(),
        launcher = launcher.display(),
        block = block,
    );
    let harness_path = dir.path().join("harness.sh");
    std::fs::write(&harness_path, harness).expect("write the harness");
    let mut drive = Command::new("/bin/sh")
        .arg(&harness_path)
        .spawn()
        .expect("spawn the harness");
    let started = std::time::Instant::now();
    let status = loop {
        if let Some(done) = drive.try_wait().expect("drive alive") {
            break done;
        }
        if started.elapsed() > std::time::Duration::from_secs(30) {
            let _ = drive.kill();
            panic!("the respawn drive ran past the watchdog");
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    };
    assert!(
        status.success(),
        "the install proceeds past a bounded pre-warm: {status:?}"
    );
    let flow = std::fs::read_to_string(&transcript).unwrap_or_default();
    assert!(
        flow.contains("flow-continued"),
        "the install continues after expiry: {flow}"
    );
    let alive = |pid: u32| {
        Command::new("sh")
            .arg("-c")
            .arg(format!("kill -0 {pid} 2>/dev/null"))
            .status()
            .is_ok_and(|status| status.success())
    };
    let spawned: Vec<u32> = std::fs::read_to_string(&spawned_log)
        .unwrap_or_default()
        .lines()
        .filter_map(|line| line.trim().parse::<u32>().ok())
        .collect();
    assert!(
        !spawned.is_empty(),
        "the launcher published its spawns: the drive asserts something"
    );
    let survivors: Vec<u32> = spawned.into_iter().filter(|pid| alive(*pid)).collect();
    assert!(
        survivors.is_empty(),
        "every launch the respawner ever made died with it: {survivors:?} survive; flow: {flow}"
    );
}

/// A frozen pre-warm tree must not outlive the installer: the expiry
/// path STOPs the tree it kills, so every exit path (an interrupt inside
/// the kill window, or a kill that does not take) releases what the walk
/// collected. Pinned as shipped text - the trap chain is not
/// block-extractable - and the behavioral drives must stay green.
#[test]
fn install_rust_sh_releases_the_frozen_prewarm_tree_on_every_exit() {
    let script =
        std::fs::read_to_string(repo_root().join("install-rust.sh")).expect("read install-rust.sh");
    assert!(
        script.contains("prewarm_tree_release() {"),
        "the release helper exists: it thaws and kills the walked tree"
    );
    for arm in [
        "trap 'ui_stop; prewarm_tree_release; rm -rf \"${dl:-}\" \"${stage:-}\"' EXIT",
        "trap 'ui_stop; prewarm_tree_release; rm -rf \"$dl\"' EXIT",
    ] {
        assert!(
            script.contains(arm),
            "the EXIT trap releases the frozen tree: {arm}"
        );
    }
    assert!(
        script.contains("  prewarm_tree_release\n  publish_window_restore"),
        "the interrupt handler releases the frozen tree before restoring"
    );
    let release_at = script
        .find("prewarm_tree_release() {")
        .expect("the release helper exists");
    let tree_init_at = script
        .find("prewarm_tree=\"\"")
        .expect("the tree initializes empty");
    assert!(
        tree_init_at < release_at,
        "the release tree is initialized empty before the helper that kills it"
    );
    let traps_at = script
        .find("trap 'ui_stop; prewarm_tree_release")
        .expect("the EXIT trap");
    assert!(
        release_at < traps_at,
        "the helper is defined before the trap that calls it is armed"
    );
    // The release KILLS FROZEN, never thaws first: a CONT would hand the
    // launcher a respawn window no re-walk then covers.
    let release_end = release_at + script[release_at..].find("\n}").expect("the helper closes");
    let helper = &script[release_at..release_end];
    assert!(
        !helper.contains("kill -CONT"),
        "the release helper never thaws: {helper}"
    );
    // Each frozen process joins the release tree at its freeze: a signal
    // between the two must find the trap able to kill it.
    let freeze_at = script
        .find("kill -STOP \"-$prewarm_pid\"")
        .expect("the launcher freeze");
    let launcher_tree_at = script
        .find("prewarm_tree=\"$prewarm_pid\"")
        .expect("the launcher tree");
    assert!(
        launcher_tree_at < freeze_at,
        "the launcher joins the release tree before its freeze"
    );
    let rewalk_merge_at = script[release_end..]
        .find("prewarm_tree=\"$prewarm_tree $prewarm_node\"")
        .map(|at| release_end + at)
        .expect("the re-walk merge");
    // The merge rides outside the release helper - one source of truth -
    // and the freeze follows it in the same loop body.
    assert!(
        !helper.contains("prewarm_tree=\"$prewarm_tree"),
        "the release helper never merges into the release tree"
    );
    let rewalk_stop_at = script[rewalk_merge_at..]
        .find("kill -STOP \"-$prewarm_node\"")
        .map(|at| rewalk_merge_at + at)
        .expect("the re-walk freeze");
    assert!(
        rewalk_stop_at < rewalk_merge_at + 400,
        "the re-walk freezes each node right after merging it"
    );
    // The merge rides one place only - at the freeze. A second, trailing
    // merge over the same nodes would be a duplicate check.
    let merges = script
        .matches("prewarm_tree=\"$prewarm_tree $prewarm_node\"")
        .count();
    assert!(
        merges == 1,
        "the re-walk merge happens once, at the freeze: found {merges}"
    );
    // The launcher is registered for release BEFORE the pre-warm runs: an
    // interrupt during the pre-warm takes the whole provisioning down.
    assert!(
        script.contains("prewarm_launch_reads=0"),
        "the launch-window registration poll exists"
    );
    // The poll's fractional sleep is guarded the installer's own way: a
    // sleep that rejects fractions must not abort a published install.
    assert!(
        script.contains("sleep 0.05 2>/dev/null || true"),
        "the launch-window poll never aborts on an unsupported fractional sleep"
    );
    let launch_reads_at = script.find("prewarm_launch_reads=0").expect("the poll");
    let gate_loop_at = script
        .find("while [ ! -f \"$prewarm_done\" ]")
        .expect("the gate loop");
    assert!(
        launch_reads_at < gate_loop_at,
        "the launcher is registered before the gate's watch loop runs"
    );
    assert!(
        helper.contains("prewarm_release_frontier"),
        "the release walk collects descendants, not only the registered pids"
    );
    // The release tree is CLEARED when the gate ends: the exit trap's
    // release exists for the gate's freeze windows, never for stale pids
    // a finished pre-warm long recycled.
    assert!(
        script.contains("  prewarm_tree=\"\"\nelse"),
        "the gate clears the release tree before the verify section"
    );
}

/// Drives the pre-warm block under `sh` with a three-level hanging
/// fixture, bounded by a kill guard (`None` on the guard). Liveness is
/// measured before the cleanup kill; `hermetic_path` replaces PATH for
/// the no-pgrep drive.
#[derive(Default)]
struct PrewarmDrive {
    status: Option<std::process::ExitStatus>,
    flow: String,
    terminated: bool,
    tree: Vec<(u32, bool, &'static str)>,
}

fn drive_sh_prewarm_block(
    block: &str,
    bound: &str,
    hermetic_path: Option<&std::path::Path>,
) -> PrewarmDrive {
    let dir = tempfile::tempdir().expect("scratch dir");
    let transcript = dir.path().join("transcript");
    let sentinel = dir.path().join("terminated");
    let launcher_pid = dir.path().join("launcher.pid");
    let child_pid_file = dir.path().join("child.pid");
    let grandchild_pid_file = dir.path().join("grandchild.pid");
    let launcher = dir.path().join("launcher");
    let child = dir.path().join("prewarm-child");
    std::fs::write(
        &child,
        format!(
            "#!/bin/sh\nprintf '%s\\n' \"$$\" > {pid_file}\n\
             if command -v setsid >/dev/null 2>&1; then setsid sleep 60 &\n\
             else sleep 60 &\nfi\n\
             printf '%s\\n' \"$!\" > {grandchild}\n\
             while :; do sleep 1; done\n",
            pid_file = child_pid_file.display(),
            grandchild = grandchild_pid_file.display()
        ),
    )
    .expect("write the launcher's child");
    std::fs::write(
        &launcher,
        format!(
            "#!/bin/sh\nprintf '%s\\n' \"$$\" > {pid}\n\"{child}\" &\ntrap 'printf terminated > {sentinel}; exit 9' TERM INT\nwhile :; do sleep 1; done\n",
            pid = launcher_pid.display(),
            sentinel = sentinel.display(),
            child = child.display(),
        ),
    )
    .expect("write the fake launcher");
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&launcher, std::fs::Permissions::from_mode(0o755))
            .expect("launcher permissions");
        std::fs::set_permissions(&child, std::fs::Permissions::from_mode(0o755))
            .expect("child permissions");
    }

    let harness = format!(
        "#!/bin/sh\n\
         step_start() {{ printf 'start %s\\n' \"$1\" >> {transcript}; }}\n\
         step_ok() {{ printf 'ok %s\\n' \"$1\" >> {transcript}; }}\n\
         step_fail() {{ printf 'fail %s %s\\n' \"$1\" \"$2\" >> {transcript}; }}\n\
         say() {{ printf 'say %s\\n' \"$*\" >> {transcript}; }}\n\
         note() {{ printf 'note %s\\n' \"$*\" >> {transcript}; }}\n\
         todo() {{ printf 'todo %s\\n' \"$*\" >> {transcript}; }}\n\
         uv_on_path() {{ return 0; }}\n\
         launcher='{launcher}'\n\
         install_probe_launcher='{launcher}'\n\
         prewarm_bound_s={bound}\n\
         {block}\
         printf 'flow-continued\\n' >> {transcript}\n\
         exit 0\n",
        transcript = transcript.display(),
        launcher = launcher.display(),
        block = block,
        bound = bound,
    );
    let harness_path = dir.path().join("harness.sh");
    std::fs::write(&harness_path, harness).expect("write the harness");

    // The harness runs BOUNDED: the red shape hangs past this guard and
    // hands `None` back so the caller fails instead of hanging.
    // The absolute interpreter: the hermetic-path drive replaces PATH,
    // and a bare "sh" would resolve against it.
    let mut harness_command = Command::new("/bin/sh");
    harness_command.arg(&harness_path);
    if let Some(path) = hermetic_path {
        harness_command.env("PATH", path);
    }
    let mut child = harness_command.spawn().expect("spawn the harness");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    let status = loop {
        if let Ok(Some(done)) = child.try_wait() {
            break Some(done);
        }
        if std::time::Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    };
    // Liveness is measured BEFORE the cleanup kill, or the caller's
    // tree assertions would be vacuous.
    let read_pid = |path: &std::path::Path| {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|text| text.trim().parse::<u32>().ok())
    };
    let alive = |pid: u32| {
        Command::new("sh")
            .arg("-c")
            .arg(format!("kill -0 {pid} 2>/dev/null"))
            .status()
            .is_ok_and(|status| status.success())
    };
    let fixture_pids = [
        ("launcher", &launcher_pid),
        ("child", &child_pid_file),
        ("grandchild", &grandchild_pid_file),
    ]
    .into_iter()
    .map(|(name, path)| {
        (
            name,
            read_pid(path).unwrap_or_else(|| panic!("the fixture published no {name} pid")),
        )
    })
    .collect::<Vec<_>>();
    let tree = fixture_pids
        .into_iter()
        .map(|(name, pid)| (pid, alive(pid), name))
        .collect::<Vec<_>>();
    // Best-effort cleanup: the red shape leaves the fixture looping.
    for (pid, still_alive, _) in &tree {
        if *still_alive {
            let _ = Command::new("sh")
                .arg("-c")
                .arg(format!("kill -9 {pid} 2>/dev/null"))
                .status();
        }
    }
    PrewarmDrive {
        status,
        flow: std::fs::read_to_string(&transcript).unwrap_or_default(),
        terminated: std::fs::read_to_string(&sentinel)
            .is_ok_and(|text| text.trim() == "terminated"),
        tree,
    }
}
