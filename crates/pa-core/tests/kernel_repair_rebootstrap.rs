#![cfg(unix)]

//! Verifier integration test: a protocol repair whose replacement fails the
//! runtime bootstrap discards the kernel, and the next request reprovisions a
//! fresh one. Every discard must get its own reprovision: a failed run must
//! not stick, and a later discard must not reuse an earlier run's success.

use std::collections::HashMap;
use std::path::PathBuf;

use pa_core::kernel::manager::{KernelStartOptions, ReplKernelManager};
use pa_core::kernel::shared::{
    ExecuteOptions, ExecuteStatus, HostRequestHandlers, KernelManagerOptions, KernelShutdownOptions,
};

#[tokio::test]
async fn every_discarded_repair_reprovisions_the_next_kernel() {
    let dir = tempfile::tempdir().expect("tempdir");
    let fail_boots = dir.path().join("fail-boots");
    std::fs::write(&fail_boots, "0").expect("write counter");
    let manager = ReplKernelManager::new(KernelManagerOptions {
        python: Some(
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/rebootstrap_kernel.py"),
        ),
        cwd: Some(dir.path().to_path_buf()),
        env: HashMap::from([(
            "FAIL_BOOTS_FILE".to_string(),
            fail_boots.display().to_string(),
        )]),
        session_id: Some("rebootstrap-test".to_string()),
        host_handlers: HostRequestHandlers::new(),
        python_skills: Vec::new(),
        snapshot: None,
        bootstrap_code: Some("BOOT".to_string()),
        stderr_log_path: None,
        on_background_work_settled: None,
    });
    manager
        .start(KernelStartOptions::default())
        .await
        .expect("fake kernel must start");
    let check_boot = || manager.execute("check-boot", ExecuteOptions::default());

    // The repair's bootstrap and the first reprovision both fail.
    std::fs::write(&fail_boots, "2").expect("write counter");
    assert!(manager
        .execute("corrupt", ExecuteOptions::default())
        .await
        .is_err());
    assert!(check_boot().await.is_err());
    let recovered = check_boot()
        .await
        .expect("a later request must reprovision again");
    assert_eq!(recovered.status, ExecuteStatus::Ok);

    // A second discard after a successful reprovision.
    std::fs::write(&fail_boots, "1").expect("write counter");
    assert!(manager
        .execute("corrupt", ExecuteOptions::default())
        .await
        .is_err());
    let second = check_boot().await.expect("second reprovision must run");
    assert_eq!(
        second.status,
        ExecuteStatus::Ok,
        "the replacement kernel was not bootstrapped: {:?}",
        second.error
    );

    assert!(manager
        .shutdown(KernelShutdownOptions::default())
        .await
        .is_ok());
}
