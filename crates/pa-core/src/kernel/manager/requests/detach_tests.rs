//! The request path's detach, stop, and residency tests: cells that
//! auto-background on a wake or their wait budget, the stops and
//! retirements that reach them, and the residency hold their terminal
//! outcome releases. Every case drives a fake POSIX kernel script.

/// Wait until `ready` holds; fail with `what` past `within`.
async fn wait_until(within: std::time::Duration, what: &str, mut ready: impl FnMut() -> bool) {
    let deadline = tokio::time::Instant::now() + within;
    while !ready() {
        assert!(tokio::time::Instant::now() < deadline, "{what}");
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
}

/// A manager on a kernel that records every snapshot request as a line
/// in `snapshot-frames` beside it, with an 800 ms snapshot debounce. A
/// `slow-error` cell settles in error at 7 s, a `slow-ok` cell settles ok
/// at 2 s, any other cell at once.
fn snapshot_counting_manager(dir: &std::path::Path) -> super::ReplKernelManager {
    use std::os::unix::fs::PermissionsExt;

    const SNAPSHOT_COUNTING_KERNEL: &str = r#"#!/usr/bin/env python3
import json, os, sys, time
here = os.path.dirname(os.path.abspath(__file__))
print(json.dumps({"event": "ready", "protocol": 3, "python": "3.13.0"}), flush=True)
for line in sys.stdin:
    try:
        req = json.loads(line)
    except Exception:
        continue
    rid = req.get("id")
    kind = req.get("type")
    if kind == "execute":
        if "slow-error" in line:
            time.sleep(7.0)
            print(json.dumps({"event": "done", "id": rid, "status": "error", "reason": "boom"}), flush=True)
        elif "slow-ok" in line:
            time.sleep(2.0)
            print(json.dumps({"event": "done", "id": rid, "status": "ok"}), flush=True)
        else:
            print(json.dumps({"event": "done", "id": rid, "status": "ok"}), flush=True)
    elif kind == "snapshot":
        with open(os.path.join(here, "snapshot-frames"), "a") as f:
            f.write("frame\n")
        print(json.dumps({"event": "done", "id": rid, "status": "ok", "saved": [], "skipped": [], "bytes": 0}), flush=True)
"#;
    let python = dir.join("snapshot-counting-kernel");
    std::fs::write(&python, SNAPSHOT_COUNTING_KERNEL).expect("write fake kernel");
    std::fs::set_permissions(&python, std::fs::Permissions::from_mode(0o755))
        .expect("chmod fake kernel");
    super::ReplKernelManager::new(crate::kernel::shared::KernelManagerOptions {
        python: Some(python),
        snapshot: Some(crate::kernel::shared::KernelSnapshotConfig {
            path: dir.join("ns.dill"),
            manifest_path: dir.join("ns.json"),
            max_bytes: None,
            max_variable_bytes: None,
            debounce_ms: Some(800),
        }),
        ..Default::default()
    })
}

/// The debounced snapshot behind a detached cell stays owed and runs
/// at the cell's settle, at any status: a successful cell A's capture
/// must not stay dropped behind a detached cell B that ends in an
/// error. B's 200 ms budget detaches it before A's 800 ms debounce
/// fires; B's 1.5 s budget lets the capture queue behind the attached B
/// and meet it only after the detach.
#[tokio::test]
async fn an_owed_snapshot_runs_when_a_detached_cell_settles_in_error() {
    for budget_ms in [200, 1_500] {
        owed_snapshot_runs_after_an_error_settle(budget_ms).await;
    }
}

async fn owed_snapshot_runs_after_an_error_settle(budget_ms: u64) {
    use super::*;

    let dir = tempfile::TempDir::new().expect("temp dir");
    let manager = snapshot_counting_manager(dir.path());
    manager
        .start(KernelStartOptions::default())
        .await
        .expect("ready handshake");
    // Cell A settles ok and schedules the debounced capture (800 ms).
    let a = manager
        .execute("fast", ExecuteOptions::default())
        .await
        .expect("cell A");
    assert_eq!(a.status, ExecuteStatus::Ok);
    // Cell B detaches at its budget and settles in error at 7 s.
    let (outcomes, callback) = background_cell_outcomes();
    let b = manager
        .execute(
            "slow-error",
            ExecuteOptions {
                cell_timeout_ms: Some(budget_ms),
                on_background_cell: Some(callback),
                ..Default::default()
            },
        )
        .await
        .expect("cell B");
    assert!(b.detached.is_some(), "cell B must detach at its budget");
    // B's terminal outcome lands at its settle; the owed capture runs one
    // debounce later.
    wait_until(
        Duration::from_secs(20),
        "cell B's terminal outcome must deliver",
        || !outcomes.lock().unwrap().is_empty(),
    )
    .await;
    let frames_path = dir.path().join("snapshot-frames");
    wait_until(
        Duration::from_secs(10),
        &format!("budget {budget_ms}: the owed snapshot must run at the detached cell's settle"),
        || {
            std::fs::read_to_string(&frames_path)
                .unwrap_or_default()
                .lines()
                .next()
                .is_some()
        },
    )
    .await;
    let outcomes = outcomes.lock().unwrap();
    let [outcome] = outcomes.as_slice() else {
        panic!("cell B's terminal outcome must deliver: {outcomes:?}");
    };
    assert_eq!(outcome.result.status, ExecuteStatus::Error);
    assert!(
        !manager
            .kernel_stderr()
            .contains(crate::kernel::shared::KERNEL_BUSY_BACKGROUND_CELL_MESSAGE),
        "the owed capture must not burn the busy window behind the cell"
    );
    manager.kill();
}

/// An ok settle consumes the capture its detached cell kept owed (the
/// settle schedules its own): a stale owed flag would hand a later,
/// unrelated detached cell's error settle a capture nothing owes.
#[tokio::test]
async fn an_ok_settle_consumes_the_owed_snapshot() {
    use super::*;

    let dir = tempfile::TempDir::new().expect("temp dir");
    let manager = snapshot_counting_manager(dir.path());
    manager
        .start(KernelStartOptions::default())
        .await
        .expect("ready handshake");
    let a = manager
        .execute("fast", ExecuteOptions::default())
        .await
        .expect("cell A");
    assert_eq!(a.status, ExecuteStatus::Ok);
    let (outcomes, callback) = background_cell_outcomes();
    let b = manager
        .execute(
            "slow-ok",
            ExecuteOptions {
                cell_timeout_ms: Some(200),
                on_background_cell: Some(callback),
                ..Default::default()
            },
        )
        .await
        .expect("cell B");
    assert!(b.detached.is_some(), "cell B must detach at its budget");
    // A's debounce fires behind the detached cell B and keeps its
    // capture owed.
    wait_until(
        Duration::from_secs(10),
        "A's capture must stay owed behind the detached cell",
        || {
            manager
                .inner
                .snapshot_owed
                .load(std::sync::atomic::Ordering::SeqCst)
        },
    )
    .await;
    wait_until(
        Duration::from_secs(10),
        "cell B's terminal outcome must deliver",
        || !outcomes.lock().unwrap().is_empty(),
    )
    .await;
    assert_eq!(outcomes.lock().unwrap()[0].result.status, ExecuteStatus::Ok);
    assert!(
        !manager
            .inner
            .snapshot_owed
            .load(std::sync::atomic::Ordering::SeqCst),
        "the ok settle must consume the owed capture"
    );
    manager.kill();
}

/// A cooperative kernel: an interrupt settles the running cell at once
/// (the real runtime's `KeyboardInterrupt`), and a plain cell runs
/// `3s` — past the stop watcher's `1s` grace window.
fn cooperative_kernel(dir: &std::path::Path) -> std::path::PathBuf {
    const COOPERATIVE_KERNEL: &str = r#"#!/usr/bin/env python3
import json, os, queue, sys, threading, time
print(json.dumps({"event": "ready", "protocol": 3, "python": "3.13.0"}), flush=True)
cells = queue.Queue()
def reader():
    # The real runtime's shape: stdin parses on a daemon thread, so the
    # interrupt lands MID-CELL and settles it (a caught KeyboardInterrupt).
    for line in sys.stdin:
        try:
            req = json.loads(line)
        except Exception:
            continue
        if req.get("type") == "interrupt":
            if running and running[0]:
                rid = running[0]
                running[0] = None
                print(json.dumps({"event": "stdout", "id": rid, "text": "interrupted\n"}), flush=True)
                print(json.dumps({"event": "done", "id": rid, "status": "ok"}), flush=True)
        elif req.get("type") == "execute":
            cells.put(req)
    cells.put(None)
running = []
threading.Thread(target=reader, daemon=True).start()
while True:
    req = cells.get()
    if req is None:
        break
    rid = req.get("id")
    running.append(rid)
    print(json.dumps({"event": "stdout", "id": rid, "text": "starting\n"}), flush=True)
    time.sleep(3.0)
    if running.pop() == rid:
        print(json.dumps({"event": "stdout", "id": rid, "text": "finished\n"}), flush=True)
        print(json.dumps({"event": "done", "id": rid, "status": "ok"}), flush=True)
"#;
    let python = dir.join("cooperative-kernel");
    std::fs::write(&python, COOPERATIVE_KERNEL).expect("write fake kernel");
    std::fs::set_permissions(&python, std::os::unix::fs::PermissionsExt::from_mode(0o755))
        .expect("chmod fake kernel");
    python
}

/// A kernel whose cells answer at once: the settle-window pin's quick
/// cell (a result well inside [`KERNEL_LEVEL_WAKE_SETTLE_MS`]).
fn quick_cell_kernel(dir: &std::path::Path) -> std::path::PathBuf {
    let python = dir.join("quick-cell-kernel");
    std::fs::write(
        &python,
        r#"#!/usr/bin/env python3
import json, sys
print(json.dumps({"event": "ready", "protocol": 3, "python": "3.13.0"}), flush=True)
for line in sys.stdin:
    try:
        req = json.loads(line)
    except Exception:
        continue
    if req.get("type") == "execute":
        rid = req.get("id")
        print(json.dumps({"event": "stdout", "id": rid, "text": "quick answer\n"}), flush=True)
        print(json.dumps({"event": "done", "id": rid, "status": "ok"}), flush=True)
"#,
    )
    .expect("write fake kernel");
    std::fs::set_permissions(&python, std::os::unix::fs::PermissionsExt::from_mode(0o755))
        .expect("chmod fake kernel");
    python
}

/// The fake kernel behind the detach tests: ready, then every execute
/// streams a start line, sleeps a second, streams its finish line, and
/// settles. Interrupt frames are counted in a sidecar file so a test can
/// prove a detached cell was never signalled.
fn background_cell_kernel(dir: &std::path::Path) -> std::path::PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let python = dir.join("background-cell-kernel");
    std::fs::write(
        &python,
        r#"#!/usr/bin/env python3
import json, os, sys, time
print(json.dumps({"event": "ready", "protocol": 3, "python": "3.13.0"}), flush=True)
for line in sys.stdin:
    try:
        req = json.loads(line)
    except Exception:
        continue
    if req.get("type") == "interrupt":
        with open(os.path.abspath(__file__) + ".interrupts", "a") as fh:
            fh.write("x")
        continue
    if req.get("type") == "execute":
        rid = req.get("id")
        print(json.dumps({"event": "stdout", "id": rid, "text": "starting\n"}), flush=True)
        time.sleep(1.0)
        print(json.dumps({"event": "stdout", "id": rid, "text": "finished\n"}), flush=True)
        print(json.dumps({"event": "done", "id": rid, "status": "ok"}), flush=True)
"#,
    )
    .expect("write fake kernel");
    std::fs::set_permissions(&python, std::fs::Permissions::from_mode(0o755))
        .expect("chmod fake kernel");
    python
}

fn background_cell_outcomes() -> (
    std::sync::Arc<std::sync::Mutex<Vec<crate::kernel::shared::BackgroundCellOutcome>>>,
    crate::kernel::shared::BackgroundCellCallback,
) {
    use std::sync::Arc;
    let outcomes: Arc<std::sync::Mutex<Vec<crate::kernel::shared::BackgroundCellOutcome>>> =
        Arc::default();
    let sink = Arc::clone(&outcomes);
    let callback: crate::kernel::shared::BackgroundCellCallback =
        Arc::new(move |outcome| sink.lock().unwrap().push(outcome));
    (outcomes, callback)
}

/// A wake lands mid-cell: the call returns early with the partial output
/// and a detach marker, the cell is never signalled, and its completion
/// arrives through the background sink with the full output.
#[tokio::test]
async fn a_wake_returns_early_and_the_cell_completes_in_background() {
    use super::*;
    let dir = tempfile::TempDir::new().expect("temp dir");
    let python = background_cell_kernel(dir.path());
    let manager = ReplKernelManager::new(crate::kernel::shared::KernelManagerOptions {
        python: Some(python.clone()),
        ..Default::default()
    });
    manager
        .start(KernelStartOptions::default())
        .await
        .expect("ready handshake");
    let wake = Arc::new(crate::kernel::cell_wake::CellWake::new());
    let (outcomes, callback) = background_cell_outcomes();
    let runner = manager.clone();
    let wake_for_call = Arc::clone(&wake);
    let call = tokio::spawn(async move {
        runner
            .execute(
                "cell",
                ExecuteOptions {
                    wake: Some(wake_for_call),
                    on_background_cell: Some(callback),
                    ..Default::default()
                },
            )
            .await
    });
    // The wake lands mid-cell (the fake kernel sleeps a second after its
    // start line).
    tokio::time::sleep(Duration::from_millis(250)).await;
    wake.request();
    let result = tokio::time::timeout(Duration::from_secs(5), call)
        .await
        .expect("the detached call returns early")
        .expect("the call task joins")
        .expect("the execute settles");
    let detached = result.detached.as_ref().expect("detach marker");
    assert_eq!(
        detached.reason,
        crate::kernel::shared::DetachReason::Interrupted
    );
    assert!(
        result.stdout.contains("starting"),
        "the partial output rides the early return: {result:?}"
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(outcome) = outcomes.lock().unwrap().pop() {
            assert_eq!(
                outcome.reason,
                crate::kernel::shared::DetachReason::Interrupted
            );
            assert_eq!(outcome.cell_id, detached.cell_id);
            assert!(
                outcome.result.stdout.contains("finished"),
                "the late completion carries the full output: {outcome:?}"
            );
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the background completion never fired"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(
        !python.with_extension("interrupts").exists(),
        "the detached cell must never be signalled"
    );
    manager.kill();
}

/// The wait budget backgrounds the cell instead of interrupting it: the
/// call returns early with the budget reason, the cell settles ok, and the
/// reuse wait drains quietly without ever signalling it.
#[tokio::test]
async fn the_wait_budget_backgrounds_instead_of_interrupting() {
    use super::*;
    let dir = tempfile::TempDir::new().expect("temp dir");
    let python = background_cell_kernel(dir.path());
    let manager = ReplKernelManager::new(crate::kernel::shared::KernelManagerOptions {
        python: Some(python.clone()),
        ..Default::default()
    });
    manager
        .start(KernelStartOptions::default())
        .await
        .expect("ready handshake");
    let (outcomes, callback) = background_cell_outcomes();
    let result = manager
        .execute(
            "cell",
            ExecuteOptions {
                cell_timeout_ms: Some(200),
                on_background_cell: Some(callback),
                ..Default::default()
            },
        )
        .await
        .expect("the bounded call settles");
    let detached = result.detached.as_ref().expect("detach marker");
    assert_eq!(
        detached.reason,
        crate::kernel::shared::DetachReason::WaitBudget(200)
    );
    assert!(
        result.stdout.contains("starting"),
        "the partial output rides the early return: {result:?}"
    );
    // The reuse wait (a later cell's contention path) drains once the
    // background cell settles, and it never interrupts a detached cell.
    let runner = manager.clone();
    let drained = tokio::time::timeout(
        Duration::from_secs(6),
        runner.wait_for_active_execution_to_clear_for_reuse(
            crate::kernel::manager::Admission::Exclusive,
            None,
        ),
    )
    .await
    .expect("the reuse wait settles");
    drained.expect("a detached cell is waited out, not interrupted");
    let outcome = outcomes.lock().unwrap().pop().expect("completion fired");
    assert!(
        outcome.result.stdout.contains("finished"),
        "the cell completed in the background: {outcome:?}"
    );
    assert!(
        !python.with_extension("interrupts").exists(),
        "no interrupt may be sent to a backgrounded cell"
    );
    manager.kill();
}

/// A cell that settles inside its budget never detaches: the normal
/// result rides the call and the background sink stays empty.
#[tokio::test]
async fn a_cell_inside_its_budget_never_detaches() {
    use super::*;
    let dir = tempfile::TempDir::new().expect("temp dir");
    let python = background_cell_kernel(dir.path());
    let manager = ReplKernelManager::new(crate::kernel::shared::KernelManagerOptions {
        python: Some(python),
        ..Default::default()
    });
    manager
        .start(KernelStartOptions::default())
        .await
        .expect("ready handshake");
    let (outcomes, callback) = background_cell_outcomes();
    let result = manager
        .execute(
            "cell",
            ExecuteOptions {
                cell_timeout_ms: Some(5_000),
                on_background_cell: Some(callback),
                ..Default::default()
            },
        )
        .await
        .expect("the cell settles");
    assert!(
        result.detached.is_none(),
        "no detach inside the budget: {result:?}"
    );
    assert!(result.stdout.contains("finished"));
    assert!(outcomes.lock().unwrap().is_empty(), "no completion fires");
    manager.kill();
}

/// The fake kernel behind the stop tests: an execute cell that hangs
/// forever and IGNORES interrupts (they are only counted), so the
/// stop watcher's grace expires and the kernel must be retired.
fn runaway_cell_kernel(dir: &std::path::Path) -> std::path::PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let python = dir.join("runaway-cell-kernel");
    std::fs::write(
        &python,
        r#"#!/usr/bin/env python3
import json, os, queue, sys, threading, time
print(json.dumps({"event": "ready", "protocol": 3, "python": "3.13.0"}), flush=True)
cells = queue.Queue()
def reader():
    # The real runtime's shape: stdin is parsed on a daemon thread, so an
    # interrupt frame lands MID-CELL. This kernel ignores it (the marks
    # file proves it arrived) and the cell runs on.
    for line in sys.stdin:
        try:
            req = json.loads(line)
        except Exception:
            continue
        if req.get("type") == "interrupt":
            with open(os.path.abspath(__file__) + ".interrupts", "a") as fh:
                fh.write("x")
        elif req.get("type") == "execute":
            cells.put(req)
    cells.put(None)
threading.Thread(target=reader, daemon=True).start()
while True:
    req = cells.get()
    if req is None:
        break
    rid = req.get("id")
    print(json.dumps({"event": "stdout", "id": rid, "text": "starting\n"}), flush=True)
    while True:
        time.sleep(0.1)
"#,
    )
    .expect("write fake kernel");
    std::fs::set_permissions(&python, std::fs::Permissions::from_mode(0o755))
        .expect("chmod fake kernel");
    python
}

/// A user cancel of an ATTACHED cell that ignores its interrupt
/// force-aborts the call after the grace and keeps the kernel: the
/// interrupt was really sent, the result is a plain abort, and the
/// manager stays live (the next cell meets the busy-after-interrupt
/// wait, as before backgrounding existed).
#[tokio::test]
async fn a_user_cancel_force_aborts_an_attached_ignoring_cell_and_keeps_the_kernel() {
    use super::*;
    let dir = tempfile::TempDir::new().expect("temp dir");
    let python = runaway_cell_kernel(dir.path());
    let manager = ReplKernelManager::new(crate::kernel::shared::KernelManagerOptions {
        python: Some(python.clone()),
        ..Default::default()
    });
    manager
        .start(KernelStartOptions::default())
        .await
        .expect("ready handshake");
    let started = Instant::now();
    let executing = manager.execute("hang", ExecuteOptions::default());
    tokio::pin!(executing);
    // The user cancel fires while the attached cell runs (the Esc path).
    let cancel_manager = manager.clone();
    let cancel = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(200)).await;
        cancel_manager.abort_user_execution()
    });
    let result = tokio::time::timeout(Duration::from_secs(6), &mut executing)
        .await
        .expect("the cancelled call settles")
        .expect("the execute returns");
    assert!(cancel.await.unwrap_or(false), "a user execution was live");
    assert_eq!(result.status, ExecuteStatus::Aborted, "{result:?}");
    assert!(result.error.is_none(), "a plain abort: {result:?}");
    assert!(
        std::fs::read_to_string(python.with_extension("interrupts"))
            .is_ok_and(|marks| !marks.is_empty()),
        "the cancelled cell was interrupted"
    );
    assert!(
        !manager.is_defunct(),
        "the attached cancel keeps the kernel"
    );
    assert!(!manager.retired_for_ignored_interrupt());
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "the stop is bounded: {:?}",
        started.elapsed()
    );
    manager.kill();
}

/// `rlm.end_turn()` from a cell that already backgrounded answers an
/// error: the cell's turn returned at the detach, so a success answer
/// would claim a turn end that never happens. The request names its cell,
/// so a newer foreground cell running beside it keeps its turn.
#[tokio::test]
async fn end_turn_in_a_backgrounded_cell_answers_an_error() {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::TempDir::new().expect("temp dir");
    let python = dir.path().join("end-turn-kernel");
    // The first cell stays silent until the second cell arrives; then it
    // calls rlm.end_turn() while the second cell runs.
    std::fs::write(
        &python,
        r#"#!/usr/bin/env python3
import json, sys
print(json.dumps({"event": "ready", "protocol": 3, "python": "3.13.0"}), flush=True)
first = None
while True:
    line = sys.stdin.readline()
    if not line:
        break
    req = json.loads(line)
    if req.get("type") != "execute":
        continue
    if first is None:
        first = req["id"]
        continue
    print(json.dumps({"event": "host_request", "id": "end-1", "data": {"type": "rlm.end_turn", "cell": first}}), flush=True)
    reply = json.loads(sys.stdin.readline())
    print(json.dumps({"event": "stdout", "id": first, "text": json.dumps(reply["data"])}), flush=True)
    print(json.dumps({"event": "done", "id": first, "status": "ok"}), flush=True)
    print(json.dumps({"event": "done", "id": req["id"], "status": "ok"}), flush=True)
"#,
    )
    .expect("write fake kernel");
    std::fs::set_permissions(&python, std::fs::Permissions::from_mode(0o755))
        .expect("chmod fake kernel");
    let manager = ReplKernelManager::new(crate::kernel::shared::KernelManagerOptions {
        python: Some(python),
        ..Default::default()
    });
    manager
        .start(KernelStartOptions::default())
        .await
        .expect("ready handshake");
    let (outcomes, callback) = background_cell_outcomes();
    let backgrounded = manager
        .execute(
            "await rlm.end_turn()",
            ExecuteOptions {
                cell_timeout_ms: Some(200),
                on_background_cell: Some(callback),
                ..Default::default()
            },
        )
        .await
        .expect("the bounded call detaches");
    assert!(backgrounded.detached.is_some(), "{backgrounded:?}");
    let foreground = manager
        .execute("x = 1", ExecuteOptions::default())
        .await
        .expect("the foreground cell runs beside the backgrounded one");
    assert!(!foreground.ended_turn, "{foreground:?}");
    wait_until(
        Duration::from_secs(5),
        "the backgrounded cell never completed",
        || !outcomes.lock().unwrap().is_empty(),
    )
    .await;
    let outcome = outcomes.lock().unwrap().pop().expect("one outcome");
    assert!(!outcome.result.ended_turn, "{outcome:?}");
    assert!(
        outcome.result.stdout.contains("\"status\": \"error\"")
            && outcome.result.stdout.contains("backgrounded cell"),
        "{outcome:?}"
    );
    manager.kill();
}

/// A manager-targeted user cancel reaches a DETACHED cell: the
/// backgrounded execution is interrupted, and its ignored interrupt
/// retires the kernel; the continuation delivers the aborted outcome.
#[tokio::test]
async fn a_user_cancel_stops_a_detached_cell() {
    use super::*;
    let dir = tempfile::TempDir::new().expect("temp dir");
    let python = runaway_cell_kernel(dir.path());
    let manager = ReplKernelManager::new(crate::kernel::shared::KernelManagerOptions {
        python: Some(python.clone()),
        ..Default::default()
    });
    manager
        .start(KernelStartOptions::default())
        .await
        .expect("ready handshake");
    let (outcomes, callback) = background_cell_outcomes();
    let result = manager
        .execute(
            "hang",
            ExecuteOptions {
                cell_timeout_ms: Some(200),
                on_background_cell: Some(callback),
                ..Default::default()
            },
        )
        .await
        .expect("the bounded call detaches");
    let detached = result.detached.as_ref().expect("detach marker");
    assert_eq!(
        detached.reason,
        crate::kernel::shared::DetachReason::WaitBudget(200)
    );
    // The run is gone; only the manager-targeted cancel can reach the cell.
    assert!(manager.abort_user_execution(), "a user execution is live");
    let deadline = Instant::now() + Duration::from_secs(5);
    let outcome = loop {
        if let Some(outcome) = outcomes.lock().unwrap().pop() {
            break outcome;
        }
        assert!(
            Instant::now() < deadline,
            "the cancel never delivered a terminal outcome"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    assert_eq!(outcome.cell_id, detached.cell_id, "{outcome:?}");
    assert_eq!(outcome.reason, detached.reason, "{outcome:?}");
    assert_eq!(outcome.result.status, ExecuteStatus::Aborted, "{outcome:?}");
    assert!(manager.is_defunct(), "the ignoring cell's kernel retired");
    assert!(
        std::fs::read_to_string(python.with_extension("interrupts"))
            .is_ok_and(|marks| !marks.is_empty()),
        "the cancel really interrupted the detached cell"
    );
}

/// The scoped idle cancel targets only a detached execution: an
/// attached cell is untouched by `abort_detached_execution`.
#[tokio::test]
async fn the_scoped_cancel_skips_an_attached_cell() {
    use super::*;
    let dir = tempfile::TempDir::new().expect("temp dir");
    let python = background_cell_kernel(dir.path());
    let manager = ReplKernelManager::new(crate::kernel::shared::KernelManagerOptions {
        python: Some(python.clone()),
        ..Default::default()
    });
    manager
        .start(KernelStartOptions::default())
        .await
        .expect("ready handshake");
    let call = {
        let manager = manager.clone();
        tokio::spawn(async move {
            manager
                .execute(
                    "cell",
                    ExecuteOptions {
                        on_background_cell: Some(background_cell_outcomes().1),
                        ..Default::default()
                    },
                )
                .await
        })
    };
    // The cancel lands while the attached cell runs (the fake cell sleeps
    // a second), so a cancel that reached attached cells would signal it.
    let deadline = Instant::now() + Duration::from_secs(5);
    while lock(&manager.inner.guarded).active_executions.is_empty() {
        assert!(
            Instant::now() < deadline,
            "the cell's execution never became active"
        );
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert!(
        !manager.abort_detached_execution(),
        "no detached execution is running"
    );
    let attached = call
        .await
        .expect("the call task joins")
        .expect("the attached call waits for its cell");
    assert!(attached.detached.is_none());
    assert_eq!(attached.status, ExecuteStatus::Ok);
    assert!(
        !python.with_extension("interrupts").exists(),
        "the scoped cancel never signalled the attached cell"
    );
    assert!(!manager.is_defunct());
    manager.kill();
}

/// Every host-observed exit reports once: a teardown after the detach
/// (kernel killed under the cell) delivers one terminal error outcome
/// with the cell's identity and partial output — never silence.
#[tokio::test]
async fn a_teardown_after_the_detach_reports_the_terminal_error() {
    use super::*;
    let dir = tempfile::TempDir::new().expect("temp dir");
    let python = background_cell_kernel(dir.path());
    let manager = ReplKernelManager::new(crate::kernel::shared::KernelManagerOptions {
        python: Some(python),
        ..Default::default()
    });
    manager
        .start(KernelStartOptions::default())
        .await
        .expect("ready handshake");
    let (outcomes, callback) = background_cell_outcomes();
    let result = manager
        .execute(
            "cell",
            ExecuteOptions {
                cell_timeout_ms: Some(200),
                on_background_cell: Some(callback),
                ..Default::default()
            },
        )
        .await
        .expect("the bounded call detaches");
    let detached = result.detached.as_ref().expect("detach marker");
    manager.kill();
    let deadline = Instant::now() + Duration::from_secs(5);
    let outcome = loop {
        if let Some(outcome) = outcomes.lock().unwrap().pop() {
            break outcome;
        }
        assert!(
            Instant::now() < deadline,
            "the teardown never delivered a terminal outcome"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    assert_eq!(outcome.cell_id, detached.cell_id, "{outcome:?}");
    assert_eq!(outcome.result.status, ExecuteStatus::Error, "{outcome:?}");
    let error = outcome.result.error.as_ref().expect("the terminal error");
    assert!(!error.evalue.is_empty(), "the outcome names its cause");
    assert!(
        outcome.result.stdout.contains("starting"),
        "the partial output rides the terminal outcome: {outcome:?}"
    );
}

/// A stop that outlives its own execution cannot reach the next
/// cell: the user cancel fires a detached cell's watcher, the cell
/// settles cooperatively on the interrupt, a fresh cell starts, and
/// the watcher's post-grace re-check (the execution match) must find
/// its execution gone — the retirement never touches the fresh cell.
#[tokio::test]
async fn a_stale_stop_cannot_reach_the_next_cell() {
    use super::*;
    let dir = tempfile::TempDir::new().expect("temp dir");
    let python = cooperative_kernel(dir.path());
    let manager = ReplKernelManager::new(crate::kernel::shared::KernelManagerOptions {
        python: Some(python),
        ..Default::default()
    });
    manager
        .start(KernelStartOptions::default())
        .await
        .expect("ready handshake");
    // The first cell detaches at its 200 ms wait budget and keeps running.
    let (outcomes, callback) = background_cell_outcomes();
    let result = manager
        .execute(
            "cell",
            ExecuteOptions {
                cell_timeout_ms: Some(200),
                on_background_cell: Some(callback),
                ..Default::default()
            },
        )
        .await
        .expect("the bounded call detaches");
    assert!(result.detached.is_some(), "{result:?}");
    // The user cancel fires the detached cell's stop watcher: the
    // interrupt goes out, and the watcher waits out its grace.
    assert!(manager.abort_user_execution());
    // The detached cell settles cooperatively on the interrupt; its
    // terminal outcome (a user stop aborts) admits quickly.
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(outcome) = outcomes.lock().unwrap().pop() {
            assert_eq!(
                outcome.result.status,
                ExecuteStatus::Aborted,
                "a user stop aborts: {outcome:?}"
            );
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the cancelled cell never settled on its interrupt"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    // A fresh cell starts well inside the old watcher's grace window
    // and runs past its expiry: the stale stop must not reach it.
    let second = tokio::time::timeout(
        Duration::from_secs(8),
        manager.execute(
            "cell",
            ExecuteOptions {
                ..Default::default()
            },
        ),
    )
    .await
    .expect("the second cell settles")
    .expect("the second execute returns");
    assert!(second.detached.is_none(), "{second:?}");
    assert!(
        second.stdout.contains("finished"),
        "the second cell completed on its own generation: {second:?}"
    );
    assert!(!manager.is_defunct(), "a stale stop retired the kernel");
    manager.kill();
}

/// A wake whose level is already pending ends the wait at once: the
/// predicate consults the live queue, so an arrival that landed while
/// the model was still streaming the tool call cannot be lost to the
/// subscription.
#[tokio::test]
async fn a_pending_wake_before_the_wait_detaches_immediately() {
    use super::*;
    let dir = tempfile::TempDir::new().expect("temp dir");
    let python = background_cell_kernel(dir.path());
    let manager = ReplKernelManager::new(crate::kernel::shared::KernelManagerOptions {
        python: Some(python),
        ..Default::default()
    });
    manager
        .start(KernelStartOptions::default())
        .await
        .expect("ready handshake");
    // The arrival lands before the call (the model is still streaming).
    let pending = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let pending_wake = Arc::clone(&pending);
    let wake = Arc::new(crate::kernel::cell_wake::CellWake::with_pending(
        std::sync::Arc::new(move || pending_wake.load(Ordering::SeqCst)),
    ));
    let (outcomes, callback) = background_cell_outcomes();
    let started = Instant::now();
    let result = manager
        .execute(
            "cell",
            ExecuteOptions {
                wake: Some(Arc::clone(&wake)),
                on_background_cell: Some(callback),
                ..Default::default()
            },
        )
        .await
        .expect("the call detaches");
    let detached = result.detached.as_ref().expect("detach marker");
    assert_eq!(
        detached.reason,
        crate::kernel::shared::DetachReason::Interrupted
    );
    assert!(
        started.elapsed() < Duration::from_millis(900),
        "the retained wake detached the wait at once: {:?}",
        started.elapsed()
    );
    // The arrival was consumed while the cell ran: the level is false
    // now, and the completion still arrives through the sink.
    pending.store(false, Ordering::SeqCst);
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if outcomes.lock().unwrap().pop().is_some() {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the background completion never fired"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    manager.kill();
}

/// A wake notification whose input was consumed or cleared does not
/// detach a later cell: the level predicate rechecks the queue after
/// every notification.
#[tokio::test]
async fn a_cleared_wake_does_not_detach_a_later_cell() {
    use super::*;
    let dir = tempfile::TempDir::new().expect("temp dir");
    let python = background_cell_kernel(dir.path());
    let manager = ReplKernelManager::new(crate::kernel::shared::KernelManagerOptions {
        python: Some(python),
        ..Default::default()
    });
    manager
        .start(KernelStartOptions::default())
        .await
        .expect("ready handshake");
    let pending = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let pending_wake = Arc::clone(&pending);
    let wake = Arc::new(crate::kernel::cell_wake::CellWake::with_pending(
        std::sync::Arc::new(move || pending_wake.load(Ordering::SeqCst)),
    ));
    // A stale request fires with the level false: the notification must
    // be rechecked, not obeyed.
    wake.request();
    let result = manager
        .execute(
            "cell",
            ExecuteOptions {
                wake: Some(Arc::clone(&wake)),
                on_background_cell: Some(background_cell_outcomes().1),
                ..Default::default()
            },
        )
        .await
        .expect("the call settles");
    assert!(
        result.detached.is_none(),
        "a cleared wake never detaches a later cell: {result:?}"
    );
    manager.kill();
}

/// A stop watcher whose attached cell settled and whose replacement
/// started before the grace expired touches NOTHING: its force-abort
/// re-checks the active execution, so the replacement cell keeps its
/// kernel and completes on its own generation.
#[tokio::test]
async fn a_stale_retirement_never_touches_the_replacement_cell() {
    use super::*;
    let dir = tempfile::TempDir::new().expect("temp dir");
    let python = cooperative_kernel(dir.path());
    let manager = ReplKernelManager::new(crate::kernel::shared::KernelManagerOptions {
        python: Some(python),
        ..Default::default()
    });
    manager
        .start(KernelStartOptions::default())
        .await
        .expect("ready handshake");
    // The first cell runs; capture ITS execution while it is the
    // active one, then cancel it — it settles on the interrupt, while
    // its watcher keeps running out its grace.
    let _first = {
        let manager = manager.clone();
        tokio::spawn(async move {
            let _ = manager.execute("cell", ExecuteOptions::default()).await;
        })
    };
    let stale = loop {
        let active = lock(&manager.inner.guarded)
            .active_executions
            .last()
            .cloned();
        if let Some(active) = active {
            break active;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    };
    assert!(manager.abort_user_execution(), "the first cell is live");
    // The first cell settled on its interrupt; admit the replacement
    // INSIDE the old watcher's grace window (the watcher is still
    // running out its 1s).
    let (outcomes, callback) = background_cell_outcomes();
    let second = {
        let manager = manager.clone();
        tokio::spawn(async move {
            manager
                .execute(
                    "cell",
                    ExecuteOptions {
                        on_background_cell: Some(callback),
                        ..Default::default()
                    },
                )
                .await
        })
    };
    // Wait for the replacement's admission INSIDE the stale watcher's
    // grace window (the watcher is still running out its 1s).
    loop {
        let active = lock(&manager.inner.guarded)
            .active_executions
            .last()
            .cloned();
        // The first cell's execution may still be draining; the
        // replacement is the fresh one that follows it.
        if active.is_some_and(|active| !std::sync::Arc::ptr_eq(&active, &stale)) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    // The replacement runs 3 s, past the stale watcher's 1 s grace, so
    // its settle is observed after the grace expired: the atomic claim
    // refused, the kernel survived, and the replacement completed on its
    // own generation.
    let second = tokio::time::timeout(Duration::from_secs(6), second)
        .await
        .expect("the replacement settles")
        .expect("the second execute returns")
        .expect("the replacement completed");
    assert!(
        second.stdout.contains("finished"),
        "the replacement cell completed on its own generation: {second:?}"
    );
    assert!(
        !manager.is_defunct(),
        "the stale retirement must not claim the manager terminal"
    );
    assert!(outcomes.lock().unwrap().is_empty());
    manager.kill();
}

/// A quick cell answers its own tool result even when the wake level
/// was already pending at the write: the settle window lets the
/// result win, so the model never pays a completion-notice turn for
/// work that was about to finish.
#[tokio::test]
async fn a_quick_cell_answers_inline_under_a_pending_level() {
    use super::*;
    let dir = tempfile::TempDir::new().expect("temp dir");
    let python = quick_cell_kernel(dir.path());
    let manager = ReplKernelManager::new(crate::kernel::shared::KernelManagerOptions {
        python: Some(python),
        ..Default::default()
    });
    manager
        .start(KernelStartOptions::default())
        .await
        .expect("ready handshake");
    // The level reads pending for the whole wait (a user steer that
    // landed while the tool call streamed).
    let wake = Arc::new(crate::kernel::cell_wake::CellWake::with_pending(Arc::new(
        || true,
    )));
    let (outcomes, callback) = background_cell_outcomes();
    let result = manager
        .execute(
            "cell",
            ExecuteOptions {
                wake: Some(wake),
                on_background_cell: Some(callback),
                ..Default::default()
            },
        )
        .await
        .expect("the quick call returns");
    assert!(
        result.detached.is_none(),
        "the quick cell answered inline under the pending level: {result:?}"
    );
    assert!(
        result.stdout.contains("quick answer"),
        "the inline answer keeps its own output: {result:?}"
    );
    assert!(
        outcomes.lock().unwrap().is_empty(),
        "no completion notice ever fired"
    );
    manager.kill();
}

/// The wait budget's deadline is absolute from the write: a budget
/// that elapses while the frame is still being written detaches the
/// call the moment the complete frame lands, instead of being lost.
#[tokio::test]
async fn the_budget_survives_a_slow_frame_write() {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    // Ready, then idles until the go file appears (the write blocks on a
    // full pipe), then reads and settles every execute in ~0.4s.
    const SLOW_READER: &str = r#"#!/usr/bin/env python3
import json, os, sys, time
print(json.dumps({"event": "ready", "protocol": 3, "python": "3.13.0"}), flush=True)
go = os.path.join(os.path.dirname(os.path.abspath(__file__)), "go")
while not os.path.exists(go):
    time.sleep(0.01)
for line in sys.stdin:
    try:
        req = json.loads(line)
    except Exception:
        continue
    if req.get("type") == "execute":
        rid = req.get("id")
        time.sleep(0.4)
        print(json.dumps({"event": "done", "id": rid, "status": "ok"}), flush=True)
"#;
    let dir = tempfile::TempDir::new().expect("temp dir");
    let python = dir.path().join("slow-reader-kernel");
    std::fs::write(&python, SLOW_READER).expect("write fake kernel");
    std::fs::set_permissions(&python, std::fs::Permissions::from_mode(0o755))
        .expect("chmod fake kernel");
    let manager = ReplKernelManager::new(crate::kernel::shared::KernelManagerOptions {
        python: Some(python),
        ..Default::default()
    });
    manager
        .start(KernelStartOptions::default())
        .await
        .expect("ready handshake");
    let (_outcomes, callback) = background_cell_outcomes();
    let call = {
        let manager = manager.clone();
        let callback = callback;
        tokio::spawn(async move {
            manager
                .execute(
                    &"x".repeat(256 * 1024),
                    ExecuteOptions {
                        cell_timeout_ms: Some(150),
                        on_background_cell: Some(callback),
                        ..Default::default()
                    },
                )
                .await
        })
    };
    // The write blocks on the full pipe past the 150ms budget...
    tokio::time::sleep(Duration::from_millis(400)).await;
    std::fs::write(dir.path().join("go"), b"").expect("write go file");
    let result = tokio::time::timeout(Duration::from_secs(4), call)
        .await
        .expect("the call returns once the frame lands")
        .expect("the call task joins")
        .expect("the execute settles");
    let detached = result.detached.as_ref().expect("detach marker");
    assert_eq!(
        detached.reason,
        crate::kernel::shared::DetachReason::WaitBudget(150),
        "the elapsed budget detached the call after the write: {result:?}"
    );
    manager.kill();
}

/// The residency test's admission latch: the drop guard releases the
/// latch on unwind, so an assertion that fires while the callback parks
/// does not strand the runtime worker at teardown (a red pin stays a
/// clean assertion failure, never a timeout kill).
struct ReleaseAdmission(std::sync::Arc<(std::sync::Mutex<bool>, std::sync::Condvar)>);
impl Drop for ReleaseAdmission {
    fn drop(&mut self) {
        let (go, notified) = &*self.0;
        *go.lock().expect("admission lock") = true;
        notified.notify_all();
    }
}

/// The residency hold: a detached cell counts as live background work
/// until its terminal outcome is admitted (the sink call returns), and
/// the teardown's error arm releases it too.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_detached_cell_holds_residency_until_admission() {
    use super::*;
    let dir = tempfile::TempDir::new().expect("temp dir");
    let python = background_cell_kernel(dir.path());
    let manager = ReplKernelManager::new(crate::kernel::shared::KernelManagerOptions {
        python: Some(python),
        ..Default::default()
    });
    manager
        .start(KernelStartOptions::default())
        .await
        .expect("ready handshake");
    // A sink that blocks inside the callback: physical done arrived, but
    // the terminal admission is held. The callback is synchronous and
    // blocks one runtime worker, so the test waits on std primitives —
    // its own waits never depend on the blocked worker's timers.
    // The admission latch with its panic-safe drop guard (the module
    // level `ReleaseAdmission`): an assertion that fires while the
    // callback parks on the latch would strand that runtime worker and
    // hang the test's teardown, turning a red pin into a timeout
    // kill — the guard releases the latch on unwind, so every failing
    // path stays a clean assertion failure.
    let admission = std::sync::Arc::new((std::sync::Mutex::new(false), std::sync::Condvar::new()));
    let _release = ReleaseAdmission(Arc::clone(&admission));
    let hold_seen = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let callback: crate::kernel::shared::BackgroundCellCallback = {
        let admission = Arc::clone(&admission);
        let hold_seen = Arc::clone(&hold_seen);
        Arc::new(move |_outcome| {
            hold_seen.store(1, Ordering::SeqCst);
            let (go, notified) = &*admission;
            let mut go = go.lock().expect("admission lock");
            while !*go {
                go = notified.wait(go).expect("admission wait");
            }
        })
    };
    let result = manager
        .execute(
            "cell",
            ExecuteOptions {
                cell_timeout_ms: Some(200),
                on_background_cell: Some(callback),
                ..Default::default()
            },
        )
        .await
        .expect("the bounded call detaches");
    assert!(result.detached.is_some());
    // While the admission is held (the physical done already arrived,
    // the sink has not returned), the cell still counts as live work.
    let called = Instant::now() + Duration::from_secs(5);
    while hold_seen.load(Ordering::SeqCst) == 0 {
        assert!(Instant::now() < called, "the sink was never called");
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(
        manager.pending_detached_completions(),
        1,
        "a cell whose outcome is unadmitted stays live background work"
    );
    // Release the admission: the hold releases.
    {
        let (go, notified) = &*admission;
        *go.lock().expect("admission lock") = true;
        notified.notify_all();
    }
    let cleared = Instant::now() + Duration::from_secs(5);
    while manager.pending_detached_completions() > 0 {
        assert!(Instant::now() < cleared, "the hold never released");
        std::thread::sleep(Duration::from_millis(5));
    }
    manager.kill();
}

/// A settled execution releases its stop watchers: the terminal watch
/// ends the watcher task, so the settled execution's channel loses its
/// last receiver (a watcher that never exits is one leaked task per
/// successful cell).
#[tokio::test]
async fn a_settled_execution_releases_its_stop_watcher() {
    use super::*;
    let dir = tempfile::TempDir::new().expect("temp dir");
    let python = background_cell_kernel(dir.path());
    let manager = ReplKernelManager::new(crate::kernel::shared::KernelManagerOptions {
        python: Some(python),
        ..Default::default()
    });
    manager
        .start(KernelStartOptions::default())
        .await
        .expect("ready handshake");
    let call = {
        let manager = manager.clone();
        tokio::spawn(async move { manager.execute("cell", ExecuteOptions::default()).await })
    };
    // Capture the running execution: its watcher holds a terminal-watch
    // receiver while the cell runs.
    let deadline = Instant::now() + Duration::from_secs(5);
    let execution = loop {
        let active = lock(&manager.inner.guarded)
            .active_executions
            .last()
            .cloned();
        if let Some(active) = active {
            break active;
        }
        assert!(
            Instant::now() < deadline,
            "the cell's execution never became active"
        );
        tokio::time::sleep(Duration::from_millis(5)).await;
    };
    loop {
        if execution.settled_tx.receiver_count() > 0 {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the running cell's watcher never subscribed to the terminal watch"
        );
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let settled = tokio::time::timeout(Duration::from_secs(5), call)
        .await
        .expect("the cell settles")
        .expect("the task joins")
        .expect("the execute returns");
    assert!(settled.detached.is_none(), "{settled:?}");
    // The watcher exits on the settle: the terminal watch loses its last
    // receiver. A watcher that awaits the never-fired stop signal instead
    // keeps it forever.
    loop {
        if execution.settled_tx.receiver_count() == 0 {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the settled execution's watcher never exited"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    manager.kill();
}

/// A panic inside the background completion sink still releases the
/// residency hold: the drop guard refunds the session-wide count, so
/// later cells' residency gates are not blocked forever.
#[tokio::test]
async fn a_panicking_sink_still_releases_the_residency_hold() {
    use super::*;
    let dir = tempfile::TempDir::new().expect("temp dir");
    let python = background_cell_kernel(dir.path());
    let manager = ReplKernelManager::new(crate::kernel::shared::KernelManagerOptions {
        python: Some(python),
        ..Default::default()
    });
    manager
        .start(KernelStartOptions::default())
        .await
        .expect("ready handshake");
    let panicking: std::sync::Arc<
        dyn Fn(crate::kernel::shared::BackgroundCellOutcome) + Send + Sync,
    > = std::sync::Arc::new(|_outcome| panic!("the sink breaks"));
    let result = manager
        .execute(
            "cell",
            ExecuteOptions {
                cell_timeout_ms: Some(200),
                on_background_cell: Some(panicking),
                ..Default::default()
            },
        )
        .await
        .expect("the bounded call detaches");
    assert!(result.detached.is_some(), "{result:?}");
    assert_eq!(
        manager.pending_detached_completions(),
        1,
        "the hold is live while the terminal outcome pends"
    );
    // The cell finishes; the spawned continuation panics inside the
    // sink. The unwound task still drops the hold: the count returns to
    // zero, so a later cell's gates read a clean lane.
    let deadline = Instant::now() + Duration::from_secs(6);
    loop {
        if manager.pending_detached_completions() == 0 {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the panicking sink stranded the residency hold"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    manager.kill();
}
