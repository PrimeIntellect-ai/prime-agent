//! The harness-digest unit battery: the digest delivery placements, the
//! deferred first-turn row, and the compaction-boundary captures.
use super::*;
use crate::session::manager::SessionManager;
use pa_agent::types::UserMessage;
use serde_json::Value;

use super::super::messages::COMPACTION_SUMMARY_SUFFIX;

#[test]
fn empty_state_digest_renders_placeholder() {
    let tmp = tempfile::tempdir().unwrap();
    let context = HarnessDigestContext {
        global_dir: tmp.path().join("harness"),
        local_dir: None,
        include_ipython: true,
        include_shell_examples: false,
        include_refine: true,
    };
    let digest = harness_digest_text(&context, HarnessQueryTerms::default());
    assert!(digest.starts_with("# Continual Harness State"));
    assert!(digest.contains("No saved harness entries yet."));
    assert!(digest.contains("recent refinements: 0"));
    assert!(digest.contains("When to call `await refine.run()`"));
    let message = harness_digest_message_text(&digest);
    assert!(message.starts_with("[harness-digest]"));
    assert!(message.ends_with("</harness_state>"));
}

#[test]
fn query_terms_weight_goal_and_recency() {
    let terms = digest_query_terms(
        Some("fix the worktree parity battery"),
        &["continue the parity work".to_string()],
    );
    assert_eq!(terms.get("worktree"), Some(&3.0));
    assert_eq!(terms.get("parity"), Some(&3.0));
    assert_eq!(terms.get("continue"), Some(&2.0));
}

#[test]
fn persisted_digest_round_trips() {
    let tmp = tempfile::tempdir().unwrap();
    let mut session = SessionManager::persisted(tmp.path(), &tmp.path().join("sessions"));
    let id = persist_digest(&mut session, "digest body", "fingerprint-1").unwrap();
    let _ = id;
    let entries = session.get_all_entries().to_vec();
    let FileEntry::CustomMessage { payload, .. } = &entries[1] else {
        panic!("expected digest entry");
    };
    assert_eq!(
        payload
            .details
            .as_ref()
            .and_then(|details| details.get("digest"))
            .and_then(serde_json::Value::as_str),
        Some("digest body")
    );
    assert_eq!(
        payload
            .details
            .as_ref()
            .and_then(|details| details.get("stateFingerprint"))
            .and_then(serde_json::Value::as_str),
        Some("fingerprint-1")
    );
    let message = digest_session_message(&entries[1]).expect("digest entry");
    let SessionAgentMessage::Custom(custom) = &message else {
        panic!("expected custom message");
    };
    assert_eq!(custom.custom_type, "harness_digest");
    assert!(!custom.display);
    assert!(matches!(custom.content, pa_types::ai::UserContent::Text(_)));
    let loop_row = harness_digest_prompt_row("digest body", 0, "fingerprint-1");
    let AgentMessage::Custom(custom) = &loop_row else {
        panic!("expected custom row");
    };
    assert_eq!(custom.role, "custom");
    assert_eq!(
        custom.payload.get("customType").and_then(Value::as_str),
        Some("harness_digest")
    );
    assert_eq!(
        custom.payload.get("content").and_then(Value::as_str),
        Some(harness_digest_message_text("digest body").as_str())
    );
    assert_eq!(
        custom.payload.get("display").and_then(Value::as_bool),
        Some(false)
    );
    assert_eq!(
        custom
            .payload
            .pointer("/details/digest")
            .and_then(Value::as_str),
        Some("digest body")
    );
    assert_eq!(
        custom
            .payload
            .pointer("/details/stateFingerprint")
            .and_then(Value::as_str),
        Some("fingerprint-1")
    );
    let session_view: SessionAgentMessage =
        serde_json::from_value(serde_json::to_value(&loop_row).unwrap()).unwrap();
    assert!(matches!(session_view, SessionAgentMessage::Custom(_)));
    // The staleness view reads the digest and its fingerprint out of
    // the row: the newest delivered row suppresses re-delivery.
    let mut context = vec![loop_row.clone()];
    assert_eq!(
        latest_context_digest_details(&context)
            .map(|details| (details.digest, details.state_fingerprint)),
        Some(("digest body".to_string(), Some("fingerprint-1".to_string())))
    );
    context.push(harness_digest_prompt_row(
        "newer digest",
        2,
        "fingerprint-2",
    ));
    assert_eq!(
        latest_context_digest_details(&context)
            .map(|details| (details.digest, details.state_fingerprint)),
        Some((
            "newer digest".to_string(),
            Some("fingerprint-2".to_string())
        ))
    );
    assert_eq!(latest_context_digest_details(&[]), None);
    let typed = latest_typed_digest_details(&[message]);
    assert_eq!(
        typed.map(|details| (details.digest, details.state_fingerprint)),
        Some(("digest body".to_string(), Some("fingerprint-1".to_string())))
    );
}

#[test]
fn append_replaces_older_digest_rows_and_strips_snapshot_blocks() {
    // A delivered custom digest row and its converted user-turn form are
    // both digest rows — the converted form matches the frame byte-exactly.
    let custom = harness_digest_prompt_row("older digest", 1, "fp-1");
    assert!(is_digest_row(&custom, None));
    let converted = AgentMessage::Standard(Message::User(UserMessage {
        content: UserContent::Text(harness_digest_message_text("older digest")),
        timestamp: 1,
    }));
    assert!(is_digest_row(&converted, Some("older digest")));
    // A user turn that quotes the digest never matches, so
    // submissions survive the refresh.
    let quoted = AgentMessage::Standard(Message::User(UserMessage {
        content: UserContent::Text(format!(
            "{} what is this block?",
            harness_digest_message_text("older digest")
        )),
        timestamp: 2,
    }));
    assert!(!is_digest_row(&quoted, Some("older digest")));
    assert!(!is_digest_row(&converted, Some("another digest")));
    assert!(!is_digest_row(&converted, None));
    let plain = AgentMessage::Standard(Message::User(UserMessage {
        content: UserContent::Text("a question".to_string()),
        timestamp: 2,
    }));
    assert!(!is_digest_row(&plain, Some("older digest")));
    let unrelated = AgentMessage::Custom(pa_agent::types::CustomAgentMessage {
        role: "custom".to_string(),
        payload: serde_json::json!({"customType": "arbitrary_note"}),
    });
    assert!(!is_digest_row(&unrelated, Some("older digest")));

    // A live compaction-summary row yields its superseded digest block.
    let summary_text =
        format!("{COMPACTION_SUMMARY_PREFIX}the story so far{COMPACTION_SUMMARY_SUFFIX}");
    let block_with = |summary_text: String| {
        AgentMessage::Standard(Message::User(UserMessage {
            content: UserContent::Text(format!(
                "{HARNESS_DIGEST_PREFIX}stale snapshot{HARNESS_DIGEST_SUFFIX}\n\n{summary_text}"
            )),
            timestamp: 3,
        }))
    };
    let summary_with_block = block_with(summary_text.clone());
    let stripped = strip_compaction_digest_block(summary_with_block, Some("stale snapshot"));
    let AgentMessage::Standard(Message::User(user)) = &stripped else {
        panic!("expected the compaction row to stay");
    };
    assert_eq!(loop_user_text(&user.content), summary_text);
    assert!(!is_digest_row(&stripped, Some("stale snapshot")));
    let plain_summary = AgentMessage::Standard(Message::User(UserMessage {
        content: UserContent::Text(summary_text),
        timestamp: 4,
    }));
    let untouched = strip_compaction_digest_block(plain_summary.clone(), Some("stale snapshot"));
    assert_eq!(untouched, plain_summary);
    let block_again = block_with(format!(
        "{COMPACTION_SUMMARY_PREFIX}the story so far{COMPACTION_SUMMARY_SUFFIX}"
    ));
    assert_eq!(
        strip_compaction_digest_block(block_again.clone(), None),
        block_again
    );
}

#[test]
fn out_of_context_file_entries_never_count_as_context_digests() {
    let wrapped = AgentMessage::Standard(Message::User(UserMessage {
        content: UserContent::Text(format!(
            "{HARNESS_DIGEST_PREFIX}compaction head digest{HARNESS_DIGEST_SUFFIX}\n\n[compaction] summary text"
        )),
        timestamp: 5,
    }));
    assert_eq!(
        latest_context_digest_details(&[wrapped]).map(|details| details.digest),
        Some("compaction head digest".to_string())
    );
    let no_digest = AgentMessage::Standard(Message::User(UserMessage {
        content: UserContent::Text("[compaction] summary text".to_string()),
        timestamp: 6,
    }));
    assert_eq!(latest_context_digest_details(&[no_digest]), None);
}

// The compact digest-capture placement oracles: TS computes the digest at the
// compaction commit, inside a window its input pump freezes (`isCompacting`);
// this port captures the digest INPUTS at compact ENTER, which is strictly
// earlier — matching TS's frozen content, where a commit-time capture here
// would observe mid-window admissions. The oracles pin both halves.

/// One keyword-distinct harness memory for the placement fixtures.
fn placement_memory(
    id: &str,
    title: &str,
    content: &str,
    scope: crate::refinement::HarnessScope,
) -> crate::refinement::HarnessEntry {
    crate::refinement::HarnessEntry {
        id: id.to_string(),
        kind: crate::refinement::RefinementKind::Memory,
        title: title.to_string(),
        content: content.to_string(),
        path: "general".to_string(),
        scope: Some(scope),
        reference: serde_json::Map::default(),
        arguments: serde_json::Map::default(),
        metadata: serde_json::Map::default(),
        source: "refine".to_string(),
        created_at: "2026-09-07T00:00:00.000Z".to_string(),
        updated_at: "2026-09-07T00:00:00.000Z".to_string(),
        version: 1,
    }
}

/// The placement-oracle rig: a live context and durable entries that agree,
/// with an active goal and two keyword-distinct memories on disk (zero query
/// terms render in entry-key order, wombat before zebra, so a ranking flip is
/// observable). The faux summarizer holds `delay_ms`, keeping ENTER→commit open.
async fn placement_rig(
    tmp: &tempfile::TempDir,
    delay_ms: u64,
) -> (
    crate::session_engine::AgentSession,
    pa_ai::faux::FauxProviderRegistration,
    Option<String>,
) {
    let registration =
        pa_ai::faux::register_faux_provider(pa_ai::faux::RegisterFauxProviderOptions {
            models: Some(vec![pa_ai::faux::FauxModelDefinition {
                id: "digest-placement-m".to_string(),
                name: Some("Digest Placement Model".to_string()),
                reasoning: Some(false),
                input: Some(vec![pa_types::ai::ModelInput::Text]),
                cost: None,
                context_window: Some(1_000),
                max_tokens: Some(256),
            }]),
            ..Default::default()
        });
    registration.set_responses(vec![pa_ai::faux::FauxResponseStep::Delayed {
        message: pa_ai::faux::faux_assistant_text_message(
            "## Goal\nsummarized goal",
            pa_ai::faux::FauxAssistantMessageOptions::default(),
        ),
        delay_ms,
    }]);
    let global_dir = tmp.path().join("agent").join("harness");
    let local_dir = tmp
        .path()
        .join("session-artifacts")
        .join("s1")
        .join("harness");
    let mut global = crate::refinement::empty_harness_state();
    global
        .entries
        .get_mut(&crate::refinement::RefinementKind::Memory)
        .unwrap()
        .insert(
            "aaa_wombat".to_string(),
            placement_memory(
                "aaa_wombat",
                "wombat widget notes",
                "the wombat widget checklist lives here",
                crate::refinement::HarnessScope::Global,
            ),
        );
    crate::refinement::save_harness_state(&global_dir, &global).unwrap();
    let mut local = crate::refinement::empty_harness_state();
    local
        .entries
        .get_mut(&crate::refinement::RefinementKind::Memory)
        .unwrap()
        .insert(
            "bbb_zebra".to_string(),
            placement_memory(
                "bbb_zebra",
                "zebra gadget notes",
                "the zebra gadget checklist lives here",
                crate::refinement::HarnessScope::Local,
            ),
        );
    crate::refinement::save_harness_state(&local_dir, &local).unwrap();

    let mut session = SessionManager::in_memory(tmp.path());
    let session_user = |text: &str| {
        pa_types::session::AgentMessage::User(pa_types::ai::UserMessage {
            content: pa_types::ai::UserContent::Text(text.to_string()),
            timestamp: 0,
            rest: serde_json::Map::default(),
        })
    };
    let assistant_row = pa_types::ai::AssistantMessage {
        content: vec![pa_types::ai::AssistantContentBlock::Text(
            pa_types::ai::TextContent {
                text: "reply zero words".to_string(),
                text_signature: None,
                rest: serde_json::Map::default(),
            },
        )],
        api: "openai-completions".to_string(),
        provider: "test".to_string(),
        model: "digest-placement-m".to_string(),
        response_model: None,
        response_id: None,
        diagnostics: None,
        usage: pa_types::ai::Usage {
            input: 100,
            output: 20,
            cache_read: 0,
            cache_write: 0,
            total_tokens: 120,
            cost: pa_types::ai::UsageCost::default(),
        },
        stop_reason: pa_types::ai::StopReason::Stop,
        stop_reason_raw: None,
        error_message: None,
        timestamp: 0,
        rest: serde_json::Map::default(),
    };
    let user0 = session_user("turn zero words");
    let reply0 = pa_types::session::AgentMessage::Assistant(assistant_row.clone());
    let user1 = session_user("unfinished turn three words");
    session.append_message(user0.clone()).unwrap();
    session.append_message(reply0.clone()).unwrap();
    session.append_message(user1.clone()).unwrap();
    let goal = pa_types::goal::GoalState {
        active: true,
        status: pa_types::goal::GoalStatus::Active,
        goal_id: Some("placement-goal".to_string()),
        objective: Some("launch checklist work".to_string()),
        ..Default::default()
    };
    session
        .append_custom_entry(
            crate::goals::GOAL_STATE_CUSTOM_TYPE,
            Some(serde_json::to_value(&goal).unwrap()),
        )
        .unwrap();

    // Built through the product's own wire->loop converter so the
    // fixture's shapes are the writer's.
    let live: Vec<AgentMessage> = [user0, reply0, user1]
        .iter()
        .map(|row| {
            crate::session_engine::session_message_to_loop(row)
                .expect("the rig's wire rows convert to loop rows")
        })
        .collect();
    let agent = std::sync::Arc::new(pa_agent::agent::Agent::new(pa_agent::agent::AgentOptions {
        initial_state: pa_agent::agent::AgentInitialState {
            messages: Some(live),
            ..Default::default()
        },
        ..Default::default()
    }));
    let engine = crate::session_engine::AgentSession::from_session_arc(
        agent,
        std::sync::Arc::new(tokio::sync::Mutex::new(session)),
        Vec::new(),
        Some(HarnessDigestContext {
            global_dir,
            local_dir: Some(local_dir),
            include_ipython: false,
            include_shell_examples: false,
            include_refine: false,
        }),
    )
    .await
    .unwrap();
    engine.set_compaction_settings(crate::session_engine::compaction::CompactionSettings {
        keep_recent_tokens: 2,
        ..Default::default()
    });
    let objective = {
        let session = engine.session.lock().await;
        crate::session_engine::goal_driver::GoalDriver::load_persisted(&session)
            .state()
            .objective
            .clone()
    };
    (engine, registration, objective)
}

/// Spawn the rig's compaction and wait for the served-path signal: the
/// request is in flight and the compact task unfinished — the window is open.
async fn spawn_compact(
    engine: std::sync::Arc<crate::session_engine::AgentSession>,
    model: &pa_types::ai::Model,
    registration: &pa_ai::faux::FauxProviderRegistration,
) -> tokio::task::JoinHandle<anyhow::Result<crate::session_engine::compact_session::CompactOutcome>>
{
    let model = model.clone();
    let handle = tokio::spawn(async move { engine.compact(None, &model, None, None).await });
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while registration.call_count() == 0 {
        assert!(
            std::time::Instant::now() < deadline,
            "the summarizer request never arrived"
        );
        tokio::time::sleep(std::time::Duration::from_millis(2)).await;
    }
    assert!(
        !handle.is_finished(),
        "the compaction must still be in flight when the window is sampled"
    );
    handle
}

/// The commit-time placement's capture, sampled mid-window without the
/// session lock (the compaction holds it for the whole window, so the
/// pre-window read equals the commit-moment value).
async fn commit_moment_inputs(
    engine: &crate::session_engine::AgentSession,
    goal_objective: Option<&str>,
) -> Option<HarnessDigestInputs> {
    let context = engine.harness_digest.clone()?;
    let texts = engine.recent_message_texts_newest_first().await;
    let terms = digest_query_terms(goal_objective, &texts);
    Some(HarnessDigestInputs { context, terms })
}

/// Oracle A — the frozen classes: nothing mutates the live context inside
/// the window, so the ENTER and commit-time captures render byte-identical.
#[tokio::test]
async fn compact_digest_capture_placements_match_byte_for_byte_in_frozen_windows() {
    let tmp = tempfile::tempdir().unwrap();
    let (engine, registration, goal) = placement_rig(&tmp, 300).await;
    let model = registration.get_model();

    // The ENTER-side capture: the same call `AgentSession::compact`
    // makes at ENTER, taken here for the cross-check.
    let enter_inputs = engine
        .harness_digest_inputs()
        .await
        .expect("the rig wires a harness digest context");
    let enter_digest = enter_inputs.render();

    let engine = std::sync::Arc::new(engine);
    let handle = spawn_compact(engine.clone(), &model, &registration).await;

    // The commit-time capture, sampled while the summarizer holds.
    let commit_inputs = commit_moment_inputs(&engine, goal.as_deref())
        .await
        .expect("the rig wires a harness digest context");
    // Anti-vacuity: the sample observed the open window's term source,
    // not post-hoc state.
    assert_eq!(commit_inputs.terms, enter_inputs.terms);
    let commit_digest = commit_inputs.render();

    let outcome = handle.await.unwrap().unwrap();
    let crate::session_engine::compact_session::CompactOutcome::Ran(run) = outcome else {
        panic!("expected the compaction to run");
    };
    let committed = run
        .entry
        .harness_digest
        .as_deref()
        .expect("digest on the durable row");
    assert_eq!(
        committed, enter_digest,
        "the durable row carries the ENTER capture's render"
    );
    assert_eq!(
        commit_digest.as_str(),
        committed,
        "the two placements must be byte-identical in a frozen window"
    );
    assert_eq!(
        run.entry.harness_state_fingerprint.as_deref(),
        Some(
            commit_inputs
                .render_with_fingerprint()
                .state_fingerprint
                .as_str()
        ),
        "the state fingerprint is placement-independent (one state read per render)"
    );
    // The goal term is frozen across the window.
    let post_goal = {
        let session = engine.session.lock().await;
        crate::session_engine::goal_driver::GoalDriver::load_persisted(&session)
            .state()
            .objective
            .clone()
    };
    assert_eq!(post_goal, goal);
    registration.unregister();
}

/// Oracle B — the racing class: a resume-site admission mid-compaction
/// shows the placements apart — the commit-time capture ranks the racing
/// row's terms, the ENTER capture and durable row keep pre-race content.
#[tokio::test]
async fn compact_digest_capture_commit_time_placement_sees_racing_rows_enter_never_does() {
    let tmp = tempfile::tempdir().unwrap();
    let (engine, registration, goal) = placement_rig(&tmp, 300).await;
    let model = registration.get_model();

    let enter_inputs = engine
        .harness_digest_inputs()
        .await
        .expect("the rig wires a harness digest context");
    let enter_digest = enter_inputs.render();
    assert!(
        !enter_inputs.terms.contains_key("zebra"),
        "the pre-race terms must not carry the racing keyword"
    );

    let engine = std::sync::Arc::new(engine);
    let handle = spawn_compact(engine.clone(), &model, &registration).await;

    // The racing admission's effect: a user row lands on the live
    // context mid-compaction.
    let racing_row = AgentMessage::user("urgent zebra gadget steer");
    let mut raced = engine.agent.state().await.messages;
    raced.push(racing_row);
    engine.agent.set_messages(raced).await;
    assert!(
        !handle.is_finished(),
        "the compaction must still be in flight after the racing row lands"
    );

    let commit_inputs = commit_moment_inputs(&engine, goal.as_deref())
        .await
        .expect("the rig wires a harness digest context");
    assert!(
        commit_inputs.terms.contains_key("zebra"),
        "the racing row must reach the commit-time capture"
    );
    let commit_digest = commit_inputs.render();

    assert_ne!(
        commit_digest, enter_digest,
        "the racing class must diverge the two placements"
    );
    let enter_wombat = enter_digest
        .find("wombat widget notes")
        .expect("the wombat memory renders at ENTER");
    let enter_zebra = enter_digest
        .find("zebra gadget notes")
        .expect("the zebra memory renders at ENTER");
    assert!(enter_wombat < enter_zebra);
    let commit_zebra = commit_digest
        .find("zebra gadget notes")
        .expect("the zebra memory renders at the commit");
    let commit_wombat = commit_digest
        .find("wombat widget notes")
        .expect("the wombat memory renders at the commit");
    assert!(commit_zebra < commit_wombat);

    // THE SHIELD: the durable row keeps the ENTER (TS-frozen)
    // content; the divergence is ranking only — the state fingerprint
    // matches across placements.
    let outcome = handle.await.unwrap().unwrap();
    let crate::session_engine::compact_session::CompactOutcome::Ran(run) = outcome else {
        panic!("expected the compaction to run");
    };
    let committed = run
        .entry
        .harness_digest
        .as_deref()
        .expect("digest on the durable row");
    assert_eq!(
        committed, enter_digest,
        "the ENTER capture shields the durable row from the racing admission"
    );
    let commit_fingerprint = commit_inputs.render_with_fingerprint().state_fingerprint;
    assert_eq!(
        run.entry.harness_state_fingerprint.as_deref(),
        Some(commit_fingerprint.as_str()),
        "the state fingerprint matches across placements in every class"
    );
    registration.unregister();
}
