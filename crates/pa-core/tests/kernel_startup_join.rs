//! TS provisioner parity: all first-touch callers join one in-flight boot.
// Unix-only: the permission bits the provisioner stamps are unix mode
// bits (std::os::unix::fs::PermissionsExt).
#![cfg(unix)]

use pa_core::kernel::cancellation::AbortSignal;
use pa_core::kernel::provisioner::{IpythonKernelProvisioner, IpythonKernelProvisionerOptions};
use std::os::unix::fs::PermissionsExt;
use std::time::Duration;

fn failing_kernel() -> (
    tempfile::TempDir,
    IpythonKernelProvisioner,
    std::path::PathBuf,
) {
    let dir = tempfile::TempDir::new().unwrap();
    let count = dir.path().join("starts");
    let python = dir.path().join("slow-python");
    std::fs::write(
        &python,
        format!(
            "#!/bin/sh\nprintf x >> '{}'\nsleep 0.3\nexit 37\n",
            count.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&python, std::fs::Permissions::from_mode(0o700)).unwrap();
    let provisioner = IpythonKernelProvisioner::new(
        dir.path(),
        IpythonKernelProvisionerOptions {
            python: Some(python),
            ..Default::default()
        },
    );
    (dir, provisioner, count)
}

async fn wait_for_start(count: &std::path::Path) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while !count.exists() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("the fixture interpreter was spawned");
}

fn starts(count: &std::path::Path) -> u64 {
    count.metadata().map_or(0, |m| m.len())
}

#[tokio::test]
async fn first_touch_joins_prewarm_and_preserves_true_failure() {
    let (_dir, provisioner, count) = failing_kernel();
    provisioner.prewarm();
    wait_for_start(&count).await;
    let first = provisioner
        .ensure(None, None)
        .await
        .expect_err("failing interpreter");
    assert!(
        format!("{first:#}").contains("unexpected exit code=37"),
        "{first:#}"
    );
    assert_eq!(
        starts(&count),
        2,
        "one startup and its one retry, not two boots"
    );
}

#[tokio::test]
async fn aborted_waiter_leaves_boot_for_other_callers() {
    let (_dir, provisioner, count) = failing_kernel();
    provisioner.prewarm();
    wait_for_start(&count).await;
    let abort = AbortSignal::new();
    let p = provisioner.clone();
    let signal = abort.clone();
    let waiter = tokio::spawn(async move { p.ensure(None, Some(signal)).await });
    abort.abort();
    let error = waiter.await.unwrap().expect_err("aborted waiter");
    assert!(format!("{error:#}").contains("aborted"));
    let first = provisioner
        .ensure(None, None)
        .await
        .expect_err("failing interpreter");
    assert!(format!("{first:#}").contains("unexpected exit code=37"));
    assert_eq!(
        starts(&count),
        2,
        "cancelling a waiter must not restart the boot"
    );
}

#[tokio::test]
async fn stop_during_boot_joins_startup() {
    let (_dir, provisioner, count) = failing_kernel();
    provisioner.prewarm();
    wait_for_start(&count).await;
    provisioner.stop_kernel(None).await;
    assert_eq!(starts(&count), 2, "stop waited through the boot's retry");
    assert!(!provisioner.has_running_kernel());
}

#[tokio::test]
async fn panicking_progress_callback_does_not_poison_next_startup() {
    let (_dir, provisioner, count) = failing_kernel();
    let progress: pa_core::kernel::bootstrap::KernelBootstrapProgressHandler =
        std::sync::Arc::new(|_| panic!("progress callback panic"));
    let error = tokio::time::timeout(
        Duration::from_secs(5),
        provisioner.ensure(Some(progress), None),
    )
    .await
    .expect("panicked startup settled")
    .expect_err("panicked callback must not report success");
    assert!(format!("{error:#}").contains("kernel startup task failed"));
    let retry = tokio::time::timeout(Duration::from_secs(5), provisioner.ensure(None, None))
        .await
        .expect("next ensure started a new boot")
        .expect_err("fixture interpreter fails after spawning");
    assert!(format!("{retry:#}").contains("unexpected exit code=37"));
    assert_eq!(
        starts(&count),
        2,
        "the retry had one boot and one interpreter retry"
    );
}

#[tokio::test]
async fn dispose_during_boot_waits_and_releases_it() {
    let (_dir, provisioner, count) = failing_kernel();
    provisioner.prewarm();
    wait_for_start(&count).await;
    provisioner.dispose(None).await;
    let after = starts(&count);
    // Pin the absolute count, not just stasis: exactly one interpreter spawn
    // (the boot's first attempt) ran before dispose returned, and the
    // dispose's abort keeps its retry from ever spawning.
    assert_eq!(
        after, 1,
        "dispose returned only after the in-flight boot settled; its retry never spawned"
    );
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert_eq!(
        starts(&count),
        after,
        "no kernel may start after dispose returns"
    );
    assert!(!provisioner.has_running_kernel());
    assert!(
        format!("{:#}", provisioner.ensure(None, None).await.unwrap_err()).contains("disposed")
    );
}
