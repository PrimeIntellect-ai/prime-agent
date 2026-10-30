use super::*;

#[tokio::test]
async fn refinement_row_cannot_broadcast_into_a_replacement_session() {
    let dir = tempfile::tempdir().unwrap();
    let worker = Worker::new(
        WorkerConfig {
            socket_path: dir.path().join("worker.sock"),
            supervisor_socket_path: std::path::PathBuf::new(),
            token: "token".to_string(),
            worker_instance_id: String::new(),
            active_session_id: "original-active".to_string(),
            agent_dir: dir.path().join("agent"),
            recovery_journal_path: dir.path().join("recovery.jsonl"),
            telemetry_disabled: None,
            script: Some(json!({ "responses": [] })),
        },
        None,
    );
    let original = SessionFile::create("/tmp", None, 0);
    let original_id = original.session_id().to_string();
    let generation = {
        let mut core = worker.core.lock().unwrap();
        core.store = Some(original);
        core.generation.clone()
    };
    let mut subscription = worker.events.subscribe();
    let replacement_blocked = std::rc::Rc::new(std::cell::Cell::new(false));
    let observed = replacement_blocked.clone();
    let core = Arc::clone(&worker.core);
    // Interleave navigation at the precise persistence-to-broadcast boundary.
    // Before the fix, this acquires the released lock and both frames land on
    // replacement-active. With the fix, navigation must wait for the pair.
    BEFORE_REFINEMENT_ROW_BROADCAST.with(|hook| {
        *hook.borrow_mut() = Some(Box::new(move || match core.try_lock() {
            Ok(mut core) => {
                core.store = Some(SessionFile::create("/tmp", None, 0));
                core.active_session_id = "replacement-active".to_string();
                core.generation = "replacement-generation".to_string();
            }
            Err(std::sync::TryLockError::WouldBlock) => observed.set(true),
            Err(std::sync::TryLockError::Poisoned(_)) => panic!("core lock poisoned"),
        }));
    });
    let message = json!({
        "role": "custom",
        "customType": "refinement_outcome",
        "content": "Refinement complete",
        "display": true,
        "details": { "refinementId": "refine-test" },
    });
    assert!(emit_refinement_row(
        &worker.core,
        &worker.events,
        &original_id,
        &message,
    ));
    let mut actual = Vec::new();
    while let Ok(frame) = subscription.try_recv() {
        let outbound: Value = serde_json::from_slice(&frame.payload).unwrap();
        actual.push(json!({
            "activeSessionId": outbound["activeSessionId"],
            "event": outbound["event"],
            "metaSession": outbound["meta"]["activeSessionId"],
            "cursor": outbound["meta"]["cursor"],
        }));
    }
    let expected: Vec<_> = ["message_start", "message_end"]
        .into_iter()
        .enumerate()
        .map(|(index, kind)| {
            json!({
                "activeSessionId": "original-active",
                "event": { "type": kind, "message": message },
                "metaSession": "original-active",
                "cursor": { "generation": generation, "sequence": index + 1 },
            })
        })
        .collect();
    assert_eq!(actual, expected);
    assert!(replacement_blocked.get());
    // Returning to the same session file creates a new generation. A completed
    // old callback must not append its rows a second time after that return.
    worker.core.lock().unwrap().generation = "reattached-generation".to_string();
    assert!(!emit_refinement_row_for_generation(
        &worker.core,
        &worker.events,
        &original_id,
        Some(&generation),
        &message,
    ));
    assert!(!emit_refinement_event_for_generation(
        &worker.core,
        &worker.events,
        &original_id,
        Some(&generation),
        json!({ "type": "refine_complete" }),
    ));
    assert!(subscription.try_recv().is_err());
    {
        let mut core = worker.core.lock().unwrap();
        assert_eq!(core.store.as_ref().unwrap().entries().len(), 1);
        core.store = Some(SessionFile::create("/tmp", None, 0));
        core.active_session_id = "replacement-active".to_string();
    }
    assert!(!emit_refinement_row(
        &worker.core,
        &worker.events,
        &original_id,
        &message,
    ));
    assert!(subscription.try_recv().is_err());
    assert!(worker
        .core
        .lock()
        .unwrap()
        .store
        .as_ref()
        .unwrap()
        .entries()
        .is_empty());
}
