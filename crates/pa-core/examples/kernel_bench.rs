//! Kernel bootstrap / lifecycle benchmark harness (verifier tooling, not a
//! test): measures the cold and warm kernel bootstrap paths, per-execute
//! overhead, and snapshot/restore cost against a real `python -m rlm.repl`
//! child.
//!
//! Usage:
//!   kernel_bench ensure-python      — time `ensure_kernel_python`
//!   kernel_bench boot               — full provisioner boot + N executes
//!   kernel_bench snapshot-restore   — build a ~5 MiB namespace, time
//!                                      snapshot + restore (+ idempotence)
//!
//! Environment:
//!   PA_BENCH_SKILLS_DIR   — skills directory (repo `skills/`); defaults to
//!                           `../skills` relative to the crate
//!   PRIME_AGENT_KERNEL_VENV / PRIME_AGENT_KERNEL_PYTHON / HOME as for the
//!                           product paths themselves.
//!
//! Run cold with a fresh HOME + venv dir, then warm with the same dirs to
//! measure the cross-process cache hit.

use std::path::PathBuf;
use std::time::Instant;

use pa_core::kernel::bootstrap::{
    ensure_kernel_python, EnsureKernelPythonOptions, KernelPythonSkill,
};
use pa_core::kernel::manager::{KernelStartOptions, ReplKernelManager};
use pa_core::kernel::shared::{
    ExecuteOptions, ExecuteStatus, HostRequestHandlers, KernelManagerOptions,
    KernelShutdownOptions, KernelSnapshotConfig,
};
use pa_core::kernel::state_snapshot::{manifest_path_in, snapshot_path_in};

fn skills_dir() -> PathBuf {
    std::env::var("PA_BENCH_SKILLS_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../skills"))
}

fn bench_python_skills() -> Vec<KernelPythonSkill> {
    let dir = skills_dir();
    let mut skills = Vec::new();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return skills;
    };
    for entry in entries.flatten() {
        let package_path = entry.path();
        let pyproject_path = package_path.join("pyproject.toml");
        if !pyproject_path.exists() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let import_name = name.replace('-', "_");
        skills.push(KernelPythonSkill {
            name,
            import_name,
            package_path,
            pyproject_path,
        });
    }
    skills
}

fn ms(t: Instant) -> u64 {
    t.elapsed().as_millis() as u64
}

fn manager_options(
    python: PathBuf,
    snapshot_dir: Option<&std::path::Path>,
) -> KernelManagerOptions {
    KernelManagerOptions {
        python: Some(python),
        cwd: Some(std::env::temp_dir()),
        env: Default::default(),
        session_id: Some("kernel-bench".to_string()),
        host_handlers: HostRequestHandlers::new(),
        python_skills: bench_python_skills(),
        snapshot: snapshot_dir.map(|dir| KernelSnapshotConfig {
            path: snapshot_path_in(dir),
            manifest_path: manifest_path_in(dir),
            max_bytes: None,
            max_variable_bytes: None,
            debounce_ms: Some(60_000),
        }),
        bootstrap_code: Some(pa_core::kernel::bootstrap::build_rlm_bootstrap_code(
            &bench_python_skills(),
        )),
        stderr_log_path: None,
    }
}

async fn boot_manager(options: &KernelManagerOptions) -> ReplKernelManager {
    let manager = ReplKernelManager::new(options.clone());
    manager
        .start(KernelStartOptions::default())
        .await
        .expect("kernel start");
    let bootstrap = options.bootstrap_code.clone().expect("bootstrap present");
    let t = Instant::now();
    let result = manager.execute(&bootstrap, ExecuteOptions::default()).await;
    println!("bootstrap-execute-ms {}", ms(t));
    let result = result.expect("bootstrap execute");
    assert_eq!(result.status, ExecuteStatus::Ok, "bootstrap failed");
    manager
}

#[tokio::main]
async fn main() {
    let mode = std::env::args().nth(1).expect("mode argument");
    match mode.as_str() {
        "ensure-python" => {
            let t = Instant::now();
            let python = ensure_kernel_python(EnsureKernelPythonOptions {
                python_skills: bench_python_skills(),
                on_progress: None,
            })
            .await
            .expect("kernel python");
            println!("ensure-kernel-python-ms {}", ms(t));
            println!("python {}", python.display());
        }
        "boot" => {
            let snapshot_dir = std::env::var("PA_BENCH_SNAPSHOT_DIR")
                .map(PathBuf::from)
                .ok();
            let t = Instant::now();
            let python = ensure_kernel_python(EnsureKernelPythonOptions {
                python_skills: bench_python_skills(),
                on_progress: None,
            })
            .await
            .expect("kernel python");
            println!("ensure-kernel-python-ms {}", ms(t));
            let t = Instant::now();
            let options = manager_options(python, snapshot_dir.as_deref());
            let manager = boot_manager(&options).await;
            println!("kernel-boot-and-bootstrap-ms {}", ms(t));

            // Per-execute overhead: trivial cells on the warmed kernel.
            let rounds: u32 = std::env::var("PA_BENCH_EXEC_ROUNDS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(50);
            let t = Instant::now();
            for i in 0..rounds {
                let result = manager
                    .execute(
                        &format!("x{i} = {i}"),
                        ExecuteOptions {
                            internal: true,
                            ..Default::default()
                        },
                    )
                    .await
                    .expect("exec");
                assert_eq!(result.status, ExecuteStatus::Ok);
            }
            let total = ms(t);
            println!(
                "execute-rounds {rounds} total-ms {total} per-execute-ms {}",
                if rounds > 0 { total / rounds as u64 } else { 0 }
            );
            let _ = manager
                .shutdown(KernelShutdownOptions {
                    snapshot: false,
                    drain_host_requests: false,
                })
                .await;
        }
        "snapshot-restore" => {
            let snapshot_dir =
                std::env::var("PA_BENCH_SNAPSHOT_DIR").expect("PA_BENCH_SNAPSHOT_DIR");
            let python = ensure_kernel_python(EnsureKernelPythonOptions {
                python_skills: bench_python_skills(),
                on_progress: None,
            })
            .await
            .expect("kernel python");
            let options = manager_options(python, Some(std::path::Path::new(&snapshot_dir)));
            let manager = boot_manager(&options).await;
            // ~5 MiB namespace: one large bytes blob plus small scalars.
            manager
                .execute(
                    "big = bytes(5 * 1024 * 1024)\nsmall = [i for i in range(100)]\nname = 'bench'",
                    ExecuteOptions::default(),
                )
                .await
                .expect("seed namespace");

            let t = Instant::now();
            let snap = manager.snapshot_state().await.expect("snapshot");
            println!("snapshot-ms {}", ms(t));
            println!("snapshot-bytes {}", snap.bytes);
            println!("snapshot-saved {}", snap.saved.join(","));
            let _ = manager
                .shutdown(KernelShutdownOptions {
                    snapshot: false,
                    drain_host_requests: false,
                })
                .await;

            // Restore in a fresh kernel: cost + idempotence (restore twice,
            // the second must produce the same namespace state).
            let manager2 = boot_manager(&options).await;
            let t = Instant::now();
            let first = manager2.restore_state().await.expect("restore");
            println!("restore-ms {}", ms(t));
            println!("restore-restored {}", first.restored.join(","));
            let t = Instant::now();
            let second = manager2.restore_state().await.expect("second restore");
            println!("restore-idempotent-ms {}", ms(t));
            assert_eq!(
                first.restored, second.restored,
                "restore must be idempotent"
            );
            let check = manager2
                .execute(
                    "len(big) == 5 * 1024 * 1024 and name == 'bench'",
                    ExecuteOptions::default(),
                )
                .await
                .expect("check");
            assert_eq!(check.status, ExecuteStatus::Ok, "restored namespace usable");
            assert!(check.result.as_deref().is_some_and(|r| r.contains("True")));
            let _ = manager2
                .shutdown(KernelShutdownOptions {
                    snapshot: false,
                    drain_host_requests: false,
                })
                .await;
        }
        other => panic!("unknown mode {other}"),
    }
}
