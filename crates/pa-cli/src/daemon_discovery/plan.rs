//! Pure action planners for the discovery commands (TS `planReap` /
//! `planShutdownAll` / `planShutdownConfirmation`): no side effects, unit-
//! tested in isolation from the executors.

use std::collections::HashMap;

use super::{DaemonInfo, DaemonStatus};

/// One planned action for a discovered daemon (TS `ReapAction`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ReapActionKind {
    RemoveFile,
    Kill,
    Shutdown,
    Skip,
}

#[derive(Debug, Clone)]
pub(crate) struct ReapAction {
    pub kind: ReapActionKind,
    pub daemon: DaemonInfo,
    pub reason: Option<String>,
}

/// What `doctor --fix` may do with each discovered daemon (pure; TS
/// `planReap`). Only clearly-safe targets are touched: orphaned socket
/// files, and reachable idle daemons on non-default sockets. The default
/// daemon, and any daemon with live sessions, are never touched.
pub(crate) fn plan_reap(daemons: &[DaemonInfo], force: bool) -> Vec<ReapAction> {
    let mut pid_counts: HashMap<u32, usize> = HashMap::new();
    for daemon in daemons {
        if let Some(pid) = daemon.pid {
            *pid_counts.entry(pid).or_default() += 1;
        }
    }
    daemons
        .iter()
        .map(|daemon| {
            // An orphan socket file has no owning process, so removing it is
            // safe even on the default path (a stale daemon.sock left by a
            // crash) — decided before the default guard.
            if daemon.status == DaemonStatus::OrphanFile {
                return ReapAction {
                    kind: ReapActionKind::RemoveFile,
                    daemon: daemon.clone(),
                    reason: None,
                };
            }
            if daemon.is_default {
                return ReapAction {
                    kind: ReapActionKind::Skip,
                    daemon: daemon.clone(),
                    reason: Some("default background service".to_string()),
                };
            }
            if daemon.status == DaemonStatus::Unreachable {
                if !force || daemon.pid.is_none() {
                    return ReapAction {
                        kind: ReapActionKind::Skip,
                        daemon: daemon.clone(),
                        reason: Some(
                            r#"unreachable; use "prime-agent shutdown --force" to stop it"#
                                .to_string(),
                        ),
                    };
                }
                let pid = daemon.pid.unwrap();
                if pid_counts.get(&pid).copied().unwrap_or(0) > 1 {
                    return ReapAction {
                        kind: ReapActionKind::Skip,
                        daemon: daemon.clone(),
                        reason: Some(format!(
                            "unreachable; pid {pid} also backs another daemon, not killing"
                        )),
                    };
                }
                return ReapAction {
                    kind: ReapActionKind::Kill,
                    daemon: daemon.clone(),
                    reason: None,
                };
            }
            if daemon.session_count != Some(0) {
                let count = match daemon.session_count {
                    Some(count) => count.to_string(),
                    None => "unknown".to_string(),
                };
                return ReapAction {
                    kind: ReapActionKind::Skip,
                    daemon: daemon.clone(),
                    reason: Some(format!("has {count} session(s)")),
                };
            }
            ReapAction {
                kind: ReapActionKind::Shutdown,
                daemon: daemon.clone(),
                reason: None,
            }
        })
        .collect()
}

/// What `shutdown` does with each discovered daemon (pure; TS
/// `planShutdownAll`): orphan files go, unreachable ones only with `force`,
/// everything reachable is asked to stop.
pub(crate) fn plan_shutdown_all(daemons: &[DaemonInfo], force: bool) -> Vec<ReapAction> {
    daemons
        .iter()
        .map(|daemon| {
            if daemon.status == DaemonStatus::OrphanFile {
                return ReapAction {
                    kind: ReapActionKind::RemoveFile,
                    daemon: daemon.clone(),
                    reason: None,
                };
            }
            if daemon.status == DaemonStatus::Unreachable {
                if daemon.pid.is_none() {
                    return if force || !daemon.has_tracked_workers.unwrap_or(false) {
                        ReapAction {
                            kind: ReapActionKind::RemoveFile,
                            daemon: daemon.clone(),
                            reason: None,
                        }
                    } else {
                        ReapAction {
                            kind: ReapActionKind::Skip,
                            daemon: daemon.clone(),
                            reason: Some(
                                "has unreachable workers; use --force to kill".to_string(),
                            ),
                        }
                    };
                }
                return if force {
                    ReapAction {
                        kind: ReapActionKind::Kill,
                        daemon: daemon.clone(),
                        reason: None,
                    }
                } else {
                    ReapAction {
                        kind: ReapActionKind::Skip,
                        daemon: daemon.clone(),
                        reason: Some("unreachable; use --force to kill".to_string()),
                    }
                };
            }
            ReapAction {
                kind: ReapActionKind::Shutdown,
                daemon: daemon.clone(),
                reason: None,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn daemon(
        socket: &str,
        status: DaemonStatus,
        is_default: bool,
        pid: Option<u32>,
        sessions: Option<u64>,
    ) -> DaemonInfo {
        DaemonInfo {
            socket_path: PathBuf::from(socket),
            pid,
            uptime_seconds: None,
            version: Some("0.1.0".to_string()),
            protocol_version: Some(7),
            schema_id: Some("schema".to_string()),
            build_id: None,
            executable_path: None,
            pid_source: None,
            session_count: sessions,
            status,
            is_default,
            has_tracked_workers: None,
        }
    }

    fn kinds(actions: &[ReapAction]) -> Vec<ReapActionKind> {
        actions.iter().map(|action| action.kind.clone()).collect()
    }

    #[test]
    fn reap_keeps_the_default_and_busy_daemons() {
        let daemons = vec![
            daemon("/d/default", DaemonStatus::OrphanFile, true, None, None),
            daemon("/d/current", DaemonStatus::Current, false, Some(1), Some(0)),
            daemon("/d/busy", DaemonStatus::Current, false, Some(2), Some(3)),
            daemon("/d/unknown", DaemonStatus::Current, false, None, None),
        ];
        let actions = plan_reap(&daemons, false);
        assert_eq!(
            kinds(&actions),
            vec![
                ReapActionKind::RemoveFile,
                ReapActionKind::Shutdown,
                ReapActionKind::Skip,
                ReapActionKind::Skip,
            ]
        );
        assert_eq!(actions[1].daemon.socket_path, PathBuf::from("/d/current"));
        assert_eq!(actions[2].reason.as_deref(), Some("has 3 session(s)"));
        assert_eq!(actions[3].reason.as_deref(), Some("has unknown session(s)"));
    }

    #[test]
    fn reap_only_kills_unreachable_daemons_with_force() {
        let daemons = vec![daemon(
            "/d/hung",
            DaemonStatus::Unreachable,
            false,
            Some(9),
            None,
        )];
        let without = plan_reap(&daemons, false);
        assert_eq!(kinds(&without), vec![ReapActionKind::Skip]);
        assert_eq!(
            without[0].reason.as_deref(),
            Some(r#"unreachable; use "prime-agent shutdown --force" to stop it"#)
        );
        let with = plan_reap(&daemons, true);
        assert_eq!(kinds(&with), vec![ReapActionKind::Kill]);
    }

    #[test]
    fn reap_never_kills_a_shared_pid() {
        let daemons = vec![
            daemon("/d/a", DaemonStatus::Unreachable, false, Some(9), None),
            daemon("/d/b", DaemonStatus::Unreachable, false, Some(9), None),
        ];
        let actions = plan_reap(&daemons, true);
        assert_eq!(
            kinds(&actions),
            vec![ReapActionKind::Skip, ReapActionKind::Skip]
        );
        assert_eq!(
            actions[0].reason.as_deref(),
            Some("unreachable; pid 9 also backs another daemon, not killing")
        );
    }

    #[test]
    fn shutdown_all_removes_orphans_and_shuts_down_reachable_daemons() {
        let daemons = vec![
            daemon("/d/orphan", DaemonStatus::OrphanFile, true, None, None),
            daemon("/d/live", DaemonStatus::Current, false, Some(1), Some(2)),
            daemon("/d/hung", DaemonStatus::Unreachable, false, Some(3), None),
        ];
        let actions = plan_shutdown_all(&daemons, false);
        assert_eq!(
            kinds(&actions),
            vec![
                ReapActionKind::RemoveFile,
                ReapActionKind::Shutdown,
                ReapActionKind::Skip,
            ]
        );
        assert_eq!(
            actions[2].reason.as_deref(),
            Some("unreachable; use --force to kill")
        );
        let forced = plan_shutdown_all(&daemons, true);
        assert_eq!(
            kinds(&forced),
            vec![
                ReapActionKind::RemoveFile,
                ReapActionKind::Shutdown,
                ReapActionKind::Kill,
            ]
        );
    }

    #[test]
    fn shutdown_all_keeps_unreachable_worker_hosts_without_force() {
        let mut info = daemon("/d/hung", DaemonStatus::Unreachable, false, None, None);
        info.has_tracked_workers = Some(true);
        let actions = plan_shutdown_all(&[info], false);
        assert_eq!(kinds(&actions), vec![ReapActionKind::Skip]);
        assert_eq!(
            actions[0].reason.as_deref(),
            Some("has unreachable workers; use --force to kill")
        );
    }

    #[test]
    fn confirmation_follows_the_daemon_count_flags_and_tty() {
        use ShutdownConfirmationPlan as Plan;
        assert_eq!(
            plan_shutdown_confirmation(0, false, false, false),
            Plan::None
        );
        assert_eq!(
            plan_shutdown_confirmation(2, false, true, false),
            Plan::None
        );
        assert_eq!(
            plan_shutdown_confirmation(2, true, false, true),
            Plan::JsonError
        );
        assert_eq!(
            plan_shutdown_confirmation(2, false, false, false),
            Plan::TtyError
        );
        assert_eq!(
            plan_shutdown_confirmation(2, false, false, true),
            Plan::Prompt
        );
    }
}

/// The confirmation decision for `shutdown` (TS `planShutdownConfirmation`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ShutdownConfirmationPlan {
    None,
    Prompt,
    JsonError,
    TtyError,
}

pub(crate) fn plan_shutdown_confirmation(
    daemon_count: usize,
    json: bool,
    force: bool,
    stdin_is_tty: bool,
) -> ShutdownConfirmationPlan {
    if daemon_count == 0 || force {
        return ShutdownConfirmationPlan::None;
    }
    if json {
        return ShutdownConfirmationPlan::JsonError;
    }
    if stdin_is_tty {
        ShutdownConfirmationPlan::Prompt
    } else {
        ShutdownConfirmationPlan::TtyError
    }
}
