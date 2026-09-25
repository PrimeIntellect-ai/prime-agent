//! The resumed-session kernel-state notice (`ipython_state_restored`).
//!
//! A resumed session spawns a fresh Python kernel: without a snapshot, the
//! model would believe it still has access to variables, imports, and
//! helpers it defined in the earlier run. The kernel's namespace snapshot
//! (the dill payload in the session's artifact dir) revives them, and the
//! provisioner's `on_restore` seam reports the outcome here so the model is
//! told what came back BEFORE the first turn instead of discovering the
//! gap a turn later.
//!
//! Relationship to the compaction notice (`ipython_state`, #230): two
//! separate surfaces, one shared snapshot machinery. `ipython_state` fires
//! after a compaction on a kernel that SURVIVED the compaction (same
//! process, live namespace, pruning disclosure); `ipython_state_restored`
//! fires when a NEW kernel booted and revived the namespace from disk (a
//! resume, or a fresh session opened over a snapshot-carrying artifact
//! dir). Both read the same per-session snapshot dir and the same
//! `snapshot`/`list_names` kernel requests, but the compaction notice
//! never restores (the kernel never died) and the restore notice never
//! prunes (the fresh kernel owns nothing to prune).
//!
//! TS reference: `agent-session.ts` `_onIpythonStateRestored` (the
//! `onRestore` callback of `IpythonKernelProvisioner`), delivered through
//! `sendCustomMessage(..., { deliverAs: "nextTurn" })`.

use pa_types::session::CustomMessage;

use crate::kernel::state_snapshot::RestoreResult;

/// The notice's `customType` (TS `IPYTHON_STATE_RESTORED_CUSTOM_TYPE`).
pub const IPYTHON_STATE_RESTORED_CUSTOM_TYPE: &str = "ipython_state_restored";

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

/// The notice text (TS `_onIpythonStateRestored`'s builder): the
/// `[python-state-restored]` header, the revived-or-fresh line, and the
/// failed-names disclosure.
pub fn notice_content(result: &RestoreResult) -> String {
    let mut lines = vec!["[python-state-restored]".to_string(), String::new()];
    if result.restored.is_empty() {
        lines.push(
            "Your previous Python kernel state could not be revived; the kernel is starting fresh, so re-create any variables, imports, or loaded data you need.".to_string(),
        );
    } else {
        lines.push(format!(
            "Your Python kernel state was revived from your previous session. These names are available again: {}.",
            result.restored.join(", ")
        ));
    }
    if !result.failed.is_empty() {
        lines.push(format!(
            "These could not be restored and must be recreated if needed: {}.",
            result
                .failed
                .iter()
                .map(|skip| skip.name.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    lines.join("\n")
}

/// The next-turn notice row: display true, `details.restored` flagging
/// whether anything revived (TS `sendCustomMessage` with
/// `deliverAs: "nextTurn"` — the row rides the next admitted turn ahead of
/// its prompt).
pub fn notice_message(result: &RestoreResult) -> CustomMessage {
    CustomMessage {
        custom_type: IPYTHON_STATE_RESTORED_CUSTOM_TYPE.to_string(),
        content: pa_types::ai::UserContent::Text(notice_content(result)),
        display: true,
        details: Some(serde_json::json!({
            "restored": !result.restored.is_empty(),
        })),
        timestamp: now_millis(),
        rest: Default::default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kernel::state_snapshot::SnapshotSkip;

    fn restore(restored: Vec<&str>, failed: Vec<(&str, &str)>) -> RestoreResult {
        RestoreResult {
            restored: restored.into_iter().map(str::to_string).collect(),
            failed: failed
                .into_iter()
                .map(|(name, reason)| SnapshotSkip {
                    name: name.to_string(),
                    reason: reason.to_string(),
                })
                .collect(),
            path: std::path::PathBuf::from("/tmp/art/kernel-state.dill"),
        }
    }

    #[test]
    fn revived_notice_lists_names() {
        let message = notice_message(&restore(vec!["data", "helper"], vec![]));
        assert_eq!(message.custom_type, "ipython_state_restored");
        assert!(message.display);
        assert_eq!(
            message.details,
            Some(serde_json::json!({ "restored": true }))
        );
        let pa_types::ai::UserContent::Text(content) = &message.content else {
            panic!("text content");
        };
        assert_eq!(
            content,
            "[python-state-restored]\n\nYour Python kernel state was revived from your previous session. These names are available again: data, helper."
        );
    }

    #[test]
    fn empty_restore_notifies_fresh_kernel() {
        let message = notice_message(&restore(vec![], vec![]));
        assert_eq!(
            message.details,
            Some(serde_json::json!({ "restored": false }))
        );
        let pa_types::ai::UserContent::Text(content) = &message.content else {
            panic!("text content");
        };
        assert_eq!(
            content,
            "[python-state-restored]\n\nYour previous Python kernel state could not be revived; the kernel is starting fresh, so re-create any variables, imports, or loaded data you need."
        );
    }

    #[test]
    fn failed_names_get_the_recreate_line() {
        let message = notice_message(&restore(vec!["data"], vec![("sock", "cannot pickle")]));
        let pa_types::ai::UserContent::Text(content) = &message.content else {
            panic!("text content");
        };
        assert!(
            content.ends_with("These could not be restored and must be recreated if needed: sock.")
        );
    }
}
