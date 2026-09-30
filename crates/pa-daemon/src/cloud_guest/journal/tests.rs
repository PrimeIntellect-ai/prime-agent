//! Guest command journal unit battery: the admit/claim/settle state
//! machine, the digest-deduped stable id, the uncertain restore, and
//! the compaction rewrite.

use pa_types::daemon::cloud::{cloud_request_digest, CloudCommandState};

use crate::cloud_guest::journal::{parse_claimed_request, GuestAdmission, GuestCommandJournal};

fn prompt_request_value(text: &str) -> serde_json::Value {
    serde_json::json!({"kind": "prompt", "text": text})
}

fn journal() -> (GuestCommandJournal, tempfile::TempDir) {
    let dir = tempfile::TempDir::new().unwrap();
    let path = dir.path().join("command-journal.ndjson");
    (GuestCommandJournal::open(&path).unwrap(), dir)
}

#[test]
fn admit_is_digest_deduped_and_conflicts_never_readmit() {
    let (mut journal, _dir) = journal();
    let (admission, receipt) = journal
        .admit("cmd_one", &prompt_request_value("turn"))
        .unwrap();
    assert_eq!(admission, GuestAdmission::New);
    assert_eq!(receipt.state, CloudCommandState::Accepted);
    // The same id and digest replays the receipt.
    let (admission, duplicate) = journal
        .admit("cmd_one", &prompt_request_value("turn"))
        .unwrap();
    assert_eq!(admission, GuestAdmission::Duplicate);
    assert_eq!(duplicate, receipt);
    // The same id with a different request conflicts.
    let (admission, _conflict) = journal
        .admit("cmd_one", &prompt_request_value("a different turn"))
        .unwrap();
    assert_eq!(admission, GuestAdmission::Conflict);
    // The stored digest is the canonical request digest.
    let receipt = journal.receipt("cmd_one").unwrap();
    assert_eq!(
        receipt.digest,
        cloud_request_digest(&prompt_request_value("turn")).unwrap()
    );
}

#[test]
fn claim_settles_through_running_and_guards_terminal() {
    let (mut journal, _dir) = journal();
    journal
        .admit("cmd_one", &prompt_request_value("turn"))
        .unwrap();
    let claimed = journal.claim_next_pending().unwrap().unwrap();
    assert_eq!(claimed.receipt.state, CloudCommandState::Running);
    assert!(
        parse_claimed_request(&claimed.request).is_ok(),
        "the claimed request parses back"
    );
    // The next claim finds nothing: one claim at a time.
    assert!(journal.claim_next_pending().unwrap().is_none());
    journal
        .complete("cmd_one", Some("{\"answer\":true}"))
        .unwrap();
    assert_eq!(
        journal.receipt("cmd_one").unwrap().state,
        CloudCommandState::Completed
    );
    assert_eq!(
        journal.receipt("cmd_one").unwrap().result,
        Some("{\"answer\":true}".to_string())
    );
    // Terminal states never transition again.
    assert!(journal.complete("cmd_one", None).is_err());
    // Unknown ids are refused.
    assert!(journal.fail("cmd_missing", Some("nope")).is_err());
}

#[test]
fn restart_replays_pending_and_marks_running_uncertain() {
    let dir = tempfile::TempDir::new().unwrap();
    let path = dir.path().join("command-journal.ndjson");
    {
        let mut journal = GuestCommandJournal::open(&path).unwrap();
        journal
            .admit("cmd_running", &prompt_request_value("mid"))
            .unwrap();
        journal
            .admit("cmd_pending", &prompt_request_value("queued"))
            .unwrap();
        journal.claim_next_pending().unwrap().unwrap();
        // The claim fsynced cmd_running's running transition (the oldest
        // accepted command claims first); cmd_pending was never
        // dispatched.
    }
    let mut restored = GuestCommandJournal::open(&path).unwrap();
    let uncertain = restored.list_uncertain();
    assert_eq!(uncertain.len(), 1);
    assert_eq!(uncertain[0].command_id, "cmd_running");
    assert!(uncertain[0].uncertain);
    // The restored pending command claims; the uncertain one never
    // does.
    let claimed = restored.claim_next_pending().unwrap().unwrap();
    assert_eq!(claimed.receipt.command_id, "cmd_pending");
    // The uncertain command is not claimable until the host requeues.
    let next = restored.claim_next_pending().unwrap();
    assert!(next.is_none());
    restored.requeue("cmd_running").unwrap();
    let claimed = restored.claim_next_pending().unwrap().unwrap();
    assert_eq!(claimed.receipt.command_id, "cmd_running");
    assert!(
        !claimed.receipt.uncertain,
        "the requeue settles uncertainty"
    );
    // Requeueing a non-uncertain command is refused.
    assert!(restored.requeue("cmd_pending").is_err());
}

#[test]
fn crash_truncated_tail_folds_to_the_last_complete_record() {
    let dir = tempfile::TempDir::new().unwrap();
    let path = dir.path().join("command-journal.ndjson");
    {
        let mut journal = GuestCommandJournal::open(&path).unwrap();
        journal
            .admit("cmd_kept", &prompt_request_value("kept"))
            .unwrap();
    }
    // Simulate a crash mid-append: a truncated final line.
    let contents = std::fs::read_to_string(&path).unwrap();
    std::fs::write(&path, format!("{contents}{{\"version\":1,\"type\":\"admi")).unwrap();
    let restored = GuestCommandJournal::open(&path).unwrap();
    assert!(restored.receipt("cmd_kept").is_some());
    assert!(restored.receipt("cmd_gone").is_none());
}

#[test]
fn a_version_one_admit_with_a_mismatched_digest_fails_closed() {
    let dir = tempfile::TempDir::new().unwrap();
    let path = dir.path().join("command-journal.ndjson");
    {
        let mut journal = GuestCommandJournal::open(&path).unwrap();
        journal
            .admit("cmd_kept", &prompt_request_value("kept"))
            .unwrap();
    }
    // Hand-forged version-1 admit whose digest does not match its
    // request: it is corruption of a known-schema record, not a
    // skippable future version — the open refuses instead of folding
    // state away.
    let contents = std::fs::read_to_string(&path).unwrap();
    let forged = format!(
        "{contents}{}\n",
        r#"{"version":1,"type":"admit","commandId":"cmd_bad_digest","digest":"sha256:0000000000000000000000000000000000000000000000000000000000000000","request":"{\"kind\":\"abort\"}","recordedAt":"now"}"#
    );
    std::fs::write(&path, forged).unwrap();
    assert!(GuestCommandJournal::open(&path).is_err());
}

#[test]
fn compaction_preserves_state_and_record_bounds() {
    let dir = tempfile::TempDir::new().unwrap();
    let path = dir.path().join("command-journal.ndjson");
    let mut journal = GuestCommandJournal::open(&path).unwrap();
    // Shrink the compaction window so the rewrite path runs in-test.
    journal.compact_after_records_for_tests(4);
    journal.admit("cmd_a", &prompt_request_value("a")).unwrap();
    journal.admit("cmd_b", &prompt_request_value("b")).unwrap();
    let claimed = journal.claim_next_pending().unwrap().unwrap();
    journal.complete(&claimed.receipt.command_id, None).unwrap();
    journal.admit("cmd_c", &prompt_request_value("c")).unwrap();
    assert_eq!(journal.record_count_for_tests(), 4, "the rewrite ran");
    // The compacted journal reloads with the same state.
    let mut restored = GuestCommandJournal::open(&path).unwrap();
    assert_eq!(
        restored.receipt("cmd_a").unwrap().state,
        CloudCommandState::Completed
    );
    assert_eq!(
        restored.receipt("cmd_b").unwrap().state,
        CloudCommandState::Accepted
    );
    assert_eq!(
        restored.receipt("cmd_c").unwrap().state,
        CloudCommandState::Accepted
    );
    let claimed = restored.claim_next_pending().unwrap().unwrap();
    assert_eq!(claimed.receipt.command_id, "cmd_b");
}

#[test]
fn settle_bounds_match_the_wire_limits() {
    let (mut journal, _dir) = journal();
    journal
        .admit("cmd_one", &prompt_request_value("turn"))
        .unwrap();
    assert!(journal.complete("cmd_one", Some("")).is_err());
    assert!(journal
        .complete("cmd_one", Some(&"x".repeat(2049)))
        .is_err());
    assert!(journal.fail("cmd_one", Some("")).is_err());
    assert!(journal.fail("cmd_one", Some(&"x".repeat(2049))).is_err());
    assert!(journal
        .receipt("cmd_one")
        .is_some_and(|receipt| receipt.state == CloudCommandState::Accepted));
}

#[test]
fn restored_admissions_claim_in_order_and_settle() {
    // A regression shape for the fold: many small journals restore the
    // same admission map regardless of the id order.
    let dir = tempfile::TempDir::new().unwrap();
    let path = dir.path().join("command-journal.ndjson");
    let mut ids = Vec::new();
    {
        let mut journal = GuestCommandJournal::open(&path).unwrap();
        for index in 0..10 {
            let id = format!("cmd_{index}");
            journal.admit(&id, &prompt_request_value("turn")).unwrap();
            ids.push(id);
        }
    }
    let mut restored = GuestCommandJournal::open(&path).unwrap();
    let mut seen = std::collections::HashSet::new();
    while let Some(claimed) = restored.claim_next_pending().unwrap() {
        seen.insert(claimed.receipt.command_id.clone());
        restored.cancel(&claimed.receipt.command_id).unwrap();
        assert_eq!(
            restored.receipt(&claimed.receipt.command_id).unwrap().state,
            CloudCommandState::Cancelled
        );
    }
    assert_eq!(seen.len(), 10);
    for id in &ids {
        assert!(seen.contains(id), "every admission claimed in order");
    }
}

#[test]
fn torn_multibyte_tail_never_empties_the_journal() {
    let dir = tempfile::TempDir::new().unwrap();
    let path = dir.path().join("command-journal.ndjson");
    {
        let mut journal = GuestCommandJournal::open(&path).unwrap();
        journal
            .admit("cmd_done", &prompt_request_value("ünïcode turn"))
            .unwrap();
        let claimed = journal.claim_next_pending().unwrap().unwrap();
        assert_eq!(claimed.receipt.command_id, "cmd_done");
        journal.complete("cmd_done", None).unwrap();
    }
    // Simulate a power loss mid-append: a torn final line whose UTF-8
    // sequence is split (invalid bytes the string reader would reject
    // wholesale).
    let mut contents = std::fs::read(&path).unwrap();
    contents.extend_from_slice(b"{\"version\":1,\"type\":\"admit\",\"commandId\":\"cmd_\xF0\x9F");
    std::fs::write(&path, &contents).unwrap();
    // The recovered journal still knows the completed command: a
    // retry of the same id is a duplicate, never a fresh admission.
    let mut restored = GuestCommandJournal::open(&path).unwrap();
    assert_eq!(
        restored.receipt("cmd_done").unwrap().state,
        CloudCommandState::Completed
    );
    let (admission, receipt) = restored
        .admit("cmd_done", &prompt_request_value("ünïcode turn"))
        .unwrap();
    assert_eq!(admission, GuestAdmission::Duplicate);
    assert_eq!(receipt.state, CloudCommandState::Completed);
}

#[test]
fn unreadable_journal_fails_closed_instead_of_loading_empty() {
    let dir = tempfile::TempDir::new().unwrap();
    // A directory where the journal file belongs: every read fails; an
    // empty recovery would re-admit completed commands as new.
    let path = dir.path().join("command-journal.ndjson");
    std::fs::create_dir(&path).unwrap();
    assert!(GuestCommandJournal::open(&path).is_err());
}

#[test]
fn corrupted_midfile_record_fails_closed() {
    let dir = tempfile::TempDir::new().unwrap();
    let path = dir.path().join("command-journal.ndjson");
    {
        let mut journal = GuestCommandJournal::open(&path).unwrap();
        journal.admit("cmd_a", &prompt_request_value("a")).unwrap();
        journal.admit("cmd_b", &prompt_request_value("b")).unwrap();
    }
    // Corrupt a COMPLETE record (not the torn tail): silently folding
    // it away could lose settled state, so the open refuses.
    let contents = std::fs::read_to_string(&path).unwrap();
    let mut lines: Vec<&str> = contents.split('\n').collect();
    lines.insert(1, "{ not json at all");
    let forged = lines.join("\n");
    std::fs::write(&path, forged).unwrap();
    assert!(GuestCommandJournal::open(&path).is_err());
}

#[test]
fn torn_tail_is_repaired_on_disk_so_the_next_append_never_glues() {
    let dir = tempfile::TempDir::new().unwrap();
    let path = dir.path().join("command-journal.ndjson");
    {
        let mut journal = GuestCommandJournal::open(&path).unwrap();
        journal
            .admit("cmd_a", &prompt_request_value("turn"))
            .unwrap();
        let claimed = journal.claim_next_pending().unwrap().unwrap();
        assert_eq!(claimed.receipt.command_id, "cmd_a");
        journal.complete("cmd_a", None).unwrap();
    }
    // Reopen #1 with a torn tail: the recovery must REPAIR the disk, not
    // just skip in memory — otherwise the next append glues onto the
    // malformed line and the next reboot wedges on a corrupt complete
    // record.
    let mut contents = std::fs::read(&path).unwrap();
    contents.extend_from_slice(b"{\"version\":1,\"type\":\"admit\",\"commandId\":\"cmd_to");
    std::fs::write(&path, &contents).unwrap();
    {
        let mut journal = GuestCommandJournal::open(&path).unwrap();
        assert_eq!(
            journal.receipt("cmd_a").unwrap().state,
            CloudCommandState::Completed
        );
        // The repaired file admits fresh work normally.
        journal
            .admit("cmd_b", &prompt_request_value("after the repair"))
            .unwrap();
    }
    // Reopen #2: both the completed command and the post-repair
    // admission survive; nothing glued.
    let mut restored = GuestCommandJournal::open(&path).unwrap();
    assert_eq!(
        restored.receipt("cmd_a").unwrap().state,
        CloudCommandState::Completed
    );
    let (admission, receipt) = restored
        .admit("cmd_b", &prompt_request_value("after the repair"))
        .unwrap();
    assert_eq!(admission, GuestAdmission::Duplicate);
    assert_eq!(receipt.state, CloudCommandState::Accepted);
    let claimed = restored.claim_next_pending().unwrap().unwrap();
    assert_eq!(claimed.receipt.command_id, "cmd_b");
}

#[test]
fn a_complete_line_with_invalid_utf8_fails_closed() {
    let dir = tempfile::TempDir::new().unwrap();
    let path = dir.path().join("command-journal.ndjson");
    {
        let mut journal = GuestCommandJournal::open(&path).unwrap();
        journal
            .admit("cmd_a", &prompt_request_value("turn"))
            .unwrap();
    }
    // A COMPLETE line (newline-terminated) carrying a lone invalid byte:
    // lossy decoding could fold a mutated record; strict decoding
    // refuses the open.
    let mut contents = std::fs::read(&path).unwrap();
    contents.extend_from_slice(b"{\"commandId\":\"cmd_\xFF\xFE\"}\n");
    std::fs::write(&path, &contents).unwrap();
    assert!(GuestCommandJournal::open(&path).is_err());
}

#[test]
fn a_malformed_complete_transition_fails_closed_instead_of_downgrading() {
    let dir = tempfile::TempDir::new().unwrap();
    let path = dir.path().join("command-journal.ndjson");
    {
        let mut journal = GuestCommandJournal::open(&path).unwrap();
        journal
            .admit("cmd_done", &prompt_request_value("turn"))
            .unwrap();
        let claimed = journal.claim_next_pending().unwrap().unwrap();
        assert_eq!(claimed.receipt.command_id, "cmd_done");
        journal.complete("cmd_done", None).unwrap();
    }
    // Corrupt the command's completed transition INTO a complete line
    // with an invalid state: folding it away would restore the settled
    // command as accepted and re-execute it, so the open must refuse.
    let contents = std::fs::read_to_string(&path).unwrap();
    let lines: Vec<&str> = contents.split('\n').collect();
    let mut forged: Vec<String> = Vec::new();
    let mut replaced = false;
    for line in lines {
        if line.contains("\"type\":\"transition\"") && line.contains("cmd_done") && !replaced {
            let mut record: serde_json::Value = serde_json::from_str(line).unwrap();
            record["state"] = serde_json::json!("settled_somehow");
            forged.push(record.to_string());
            replaced = true;
        } else {
            forged.push(line.to_string());
        }
    }
    assert!(replaced, "the completed transition line was found");
    let forged = forged.join("\n");
    std::fs::write(&path, forged).unwrap();
    assert!(
        GuestCommandJournal::open(&path).is_err(),
        "a malformed transition of a known command must fail closed, never downgrade it to accepted"
    );
}

#[test]
fn an_unknown_record_version_stays_skippable() {
    // Forward compatibility (TS parity): a future-version record folds
    // out without corrupting the open.
    let dir = tempfile::TempDir::new().unwrap();
    let path = dir.path().join("command-journal.ndjson");
    {
        let mut journal = GuestCommandJournal::open(&path).unwrap();
        journal
            .admit("cmd_a", &prompt_request_value("turn"))
            .unwrap();
    }
    let contents = std::fs::read_to_string(&path).unwrap();
    let forged = format!(
        "{contents}{{\"version\":2,\"type\":\"admit\",\"commandId\":\"cmd_future\",\"digest\":\"sha256:0\",\"request\":\"{{}}\",\"recordedAt\":\"now\"}}\n"
    );
    std::fs::write(&path, forged).unwrap();
    let restored = GuestCommandJournal::open(&path).unwrap();
    assert!(restored.receipt("cmd_a").is_some());
    assert!(restored.receipt("cmd_future").is_none());
}

#[test]
fn compacted_terminal_id_corruption_fails_closed_before_a_rerun() {
    // The auto-rerun vector is the COMPACTED shape: compaction rewrites
    // the journal to admit + terminal transition only, so a corrupted
    // terminal commandId would otherwise leave the command at its admit
    // state - ACCEPTED - and the restart's claim loop would re-execute
    // it. No legitimate append ever creates an orphan transition, so
    // the open refuses instead.
    let dir = tempfile::TempDir::new().unwrap();
    let path = dir.path().join("command-journal.ndjson");
    {
        let mut journal = GuestCommandJournal::open(&path).unwrap();
        journal.compact_after_records_for_tests(2);
        journal
            .admit("cmd_done", &prompt_request_value("the settled turn"))
            .unwrap();
        let claimed = journal.claim_next_pending().unwrap().unwrap();
        assert_eq!(claimed.receipt.command_id, "cmd_done");
        journal.complete("cmd_done", None).unwrap();
    }
    // The compaction rewrote the journal to admit + terminal only.
    let contents = std::fs::read_to_string(&path).unwrap();
    let records: Vec<&str> = contents
        .split_inclusive('\n')
        .filter(|l| !l.trim().is_empty())
        .collect();
    assert_eq!(
        records.len(),
        2,
        "the compacted journal holds admit + terminal"
    );
    assert!(records[0].contains("\"type\":\"admit\""));
    assert!(records[1].contains("\"type\":\"transition\""));
    assert!(records[1].contains("\"state\":\"completed\""));
    // One valid-ASCII byte flipped in the terminal transition's
    // commandId: an orphan transition, refused closed.
    let forged = records[1].replacen("cmd_done", "cmd_d0ne", 1);
    let corrupted = format!("{}{}", records[0], forged);
    std::fs::write(&path, &corrupted).unwrap();
    assert!(
        GuestCommandJournal::open(&path).is_err(),
        "an orphan terminal transition must fail closed instead of restoring the command accepted for a rerun"
    );
    // The un-corrupted compacted journal still restores completed and
    // a duplicate submit stays a duplicate (the positive control).
    std::fs::write(&path, &contents).unwrap();
    let mut restored = GuestCommandJournal::open(&path).unwrap();
    assert_eq!(
        restored.receipt("cmd_done").unwrap().state,
        CloudCommandState::Completed
    );
    let (admission, receipt) = restored
        .admit("cmd_done", &prompt_request_value("the settled turn"))
        .unwrap();
    assert_eq!(admission, GuestAdmission::Duplicate);
    assert_eq!(receipt.state, CloudCommandState::Completed);
}

#[test]
fn uncompacted_transition_id_corruption_also_fails_closed() {
    // The UN-compacted shape, with the FIRST transition line (the
    // running one) corrupted instead of the terminal: under the old
    // drop-an-orphan semantics the completed terminal would still fold,
    // so even this corruption is no auto-rerun vector — but the
    // fail-closed rule still refuses the open, because an orphan
    // version-1 transition is corruption in every shape. (Corrupting
    // the TERMINAL id in this shape would restore the command running
    // and uncertain — also no auto-rerun; the compacted shape is the
    // auto-rerun vector, proven by the test above.)
    let dir = tempfile::TempDir::new().unwrap();
    let path = dir.path().join("command-journal.ndjson");
    {
        let mut journal = GuestCommandJournal::open(&path).unwrap();
        journal
            .admit("cmd_done", &prompt_request_value("the settled turn"))
            .unwrap();
        let claimed = journal.claim_next_pending().unwrap().unwrap();
        assert_eq!(claimed.receipt.command_id, "cmd_done");
        journal.complete("cmd_done", None).unwrap();
    }
    let contents = std::fs::read_to_string(&path).unwrap();
    let mut forged = String::new();
    let mut corrupted = false;
    for line in contents.split_inclusive('\n') {
        if !corrupted
            && line.contains("\"type\":\"transition\"")
            && line.contains("\"commandId\":\"cmd_done\"")
        {
            forged.push_str(&line.replacen("cmd_done", "cmd_d0ne", 1));
            corrupted = true;
        } else {
            forged.push_str(line);
        }
    }
    assert!(corrupted, "a transition line was found");
    std::fs::write(&path, &forged).unwrap();
    assert!(
        GuestCommandJournal::open(&path).is_err(),
        "an orphan version-1 transition fails closed in every shape"
    );
    // The un-corrupted journal restores completed with uncertainty
    // nowhere in sight (running + completed transitions both fold).
    std::fs::write(&path, &contents).unwrap();
    let restored = GuestCommandJournal::open(&path).unwrap();
    assert_eq!(
        restored.receipt("cmd_done").unwrap().state,
        CloudCommandState::Completed
    );
}
