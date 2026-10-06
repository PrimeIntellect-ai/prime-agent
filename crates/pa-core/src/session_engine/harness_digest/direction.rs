//! Digest window-direction oracles: the window is the NEWEST four
//! user/assistant texts, newest first (TS `.slice(-4).reverse()`).

use super::*;
use crate::refinement::HarnessEntry;
use crate::session::manager::SessionManager;
use pa_types::ai::{AssistantContentBlock, AssistantMessage, StopReason, TextContent, Usage};

/// One wire user row (the writer's shape).
fn wire_user(text: &str) -> pa_types::session::AgentMessage {
    pa_types::session::AgentMessage::User(pa_types::ai::UserMessage {
        content: pa_types::ai::UserContent::Text(text.to_string()),
        timestamp: 0,
        rest: serde_json::Map::default(),
    })
}

/// One wire assistant row (the writer's shape).
fn wire_assistant(text: &str) -> pa_types::session::AgentMessage {
    pa_types::session::AgentMessage::Assistant(AssistantMessage {
        content: vec![AssistantContentBlock::Text(TextContent {
            text: text.to_string(),
            text_signature: None,
            rest: serde_json::Map::default(),
        })],
        api: "openai-completions".to_string(),
        provider: "test".to_string(),
        model: "digest-direction-m".to_string(),
        response_model: None,
        response_id: None,
        diagnostics: None,
        usage: Usage {
            input: 100,
            output: 20,
            cache_read: 0,
            cache_write: 0,
            total_tokens: 120,
            cost: pa_types::ai::UsageCost::default(),
        },
        stop_reason: StopReason::Stop,
        stop_reason_raw: None,
        error_message: None,
        timestamp: 0,
        rest: serde_json::Map::default(),
    })
}

/// One keyword-bearing memory on the rig's global harness disk.
fn direction_memory(id: &str, title: &str, content: &str) -> HarnessEntry {
    HarnessEntry {
        id: id.to_string(),
        kind: crate::refinement::RefinementKind::Memory,
        title: title.to_string(),
        content: content.to_string(),
        path: "general".to_string(),
        scope: Some(crate::refinement::HarnessScope::Global),
        reference: serde_json::Map::default(),
        arguments: serde_json::Map::default(),
        metadata: serde_json::Map::default(),
        source: "refine".to_string(),
        created_at: "2026-09-07T00:00:00.000Z".to_string(),
        updated_at: "2026-09-07T00:00:00.000Z".to_string(),
        version: 1,
    }
}

/// Seed the rig's global harness dir with the given `(id, title, content)`
/// memories in one save (each save rewrites the state file).
fn seed_global_memories(dir: &std::path::Path, memories: &[(&str, &str, &str)]) {
    let mut state = crate::refinement::empty_harness_state();
    let records = state
        .entries
        .get_mut(&crate::refinement::RefinementKind::Memory)
        .unwrap();
    for (id, title, content) in memories {
        records.insert(id.to_string(), direction_memory(id, title, content));
    }
    crate::refinement::save_harness_state(dir, &state).unwrap();
}

/// An `AgentSession` whose live context carries `texts` as chronological
/// rows, with no persisted goal — the window's terms come from the texts
/// alone.
async fn direction_rig(
    tmp: &tempfile::TempDir,
    texts: &[&str],
) -> crate::session_engine::AgentSession {
    let rows: Vec<pa_types::session::AgentMessage> = texts
        .iter()
        .enumerate()
        .map(|(index, text)| {
            if index % 2 == 0 {
                wire_user(text)
            } else {
                wire_assistant(text)
            }
        })
        .collect();
    let live: Vec<AgentMessage> = rows
        .iter()
        .map(crate::session_engine::session_message_to_loop)
        .collect::<Option<Vec<_>>>()
        .expect("the rig's wire rows all convert to loop rows");
    let agent = std::sync::Arc::new(pa_agent::agent::Agent::new(pa_agent::agent::AgentOptions {
        initial_state: pa_agent::agent::AgentInitialState {
            messages: Some(live),
            ..Default::default()
        },
        ..Default::default()
    }));
    let session = SessionManager::in_memory(tmp.path());
    crate::session_engine::AgentSession::from_session_arc(
        agent,
        std::sync::Arc::new(tokio::sync::Mutex::new(session)),
        Vec::new(),
        Some(HarnessDigestContext {
            global_dir: tmp.path().join("harness"),
            local_dir: Some(
                tmp.path()
                    .join("session-artifacts")
                    .join("s1")
                    .join("harness"),
            ),
            include_ipython: false,
            include_shell_examples: false,
            include_refine: false,
        }),
    )
    .await
    .unwrap()
}

/// The shipped (base) selection, kept as the differential's A-side only:
/// the chronological `truncate(4)` - the oldest four - then reversed.
fn base_selection_terms(texts: &[&str]) -> HarnessQueryTerms {
    let mut base: Vec<String> = texts.iter().map(ToString::to_string).collect();
    base.truncate(4);
    base.reverse();
    digest_query_terms(None, &base)
}

const DISTINCT6: [&str; 6] = [
    "alpha anchor oldest turn",
    "bravo beacon reply",
    "charlie candle third turn",
    "delta dagger reply",
    "echo ember fifth turn",
    "foxtrot frontier newest reply",
];

/// A >=5-text window where the oldest-4 and newest-4 selections differ:
/// the recency ladder (2.0, 1.5, 1.0, 1.0) walks the NEWEST four first.
#[tokio::test]
async fn digest_terms_rank_the_newest_four_texts() {
    let tmp = tempfile::tempdir().unwrap();
    let engine = direction_rig(&tmp, &DISTINCT6).await;
    let inputs = engine
        .harness_digest_inputs()
        .await
        .expect("the rig wires a harness digest context");
    for (term, weight) in [
        ("foxtrot", 2.0),
        ("echo", 1.5),
        ("delta", 1.0),
        ("charlie", 1.0),
    ] {
        assert_eq!(
            inputs.terms.get(term),
            Some(&weight),
            "TS slice(-4): the newest texts carry the recency ladder"
        );
    }
    for term in ["alpha", "bravo"] {
        assert!(
            !inputs.terms.contains_key(term),
            "the oldest texts fall outside the TS slice(-4) window"
        );
    }
    let selected = engine.recent_message_texts_newest_first().await;
    let expected_newest_first: Vec<String> = DISTINCT6[2..]
        .iter()
        .rev()
        .map(ToString::to_string)
        .collect();
    assert_eq!(selected, expected_newest_first);
}

/// Where the two selections coincide the renders are byte-identical with
/// identical fingerprints (the fingerprint never sees the query terms).
#[tokio::test]
async fn digest_direction_differential_across_window_shapes() {
    let identical6 = ["uniform repeated window text"; 6];
    let coincide_classes: [&[&str]; 4] = [
        &["solo opening turn"],
        &["alpha anchor oldest turn", "bravo beacon reply"],
        &[
            "alpha anchor oldest turn",
            "bravo beacon reply",
            "charlie candle third turn",
            "delta dagger reply",
        ],
        &identical6,
    ];
    for texts in coincide_classes {
        let tmp = tempfile::tempdir().unwrap();
        seed_global_memories(
            &tmp.path().join("harness"),
            &[(
                "aaa_alpha",
                "alpha anchor notes",
                "the alpha anchor checklist",
            )],
        );
        let engine = direction_rig(&tmp, texts).await;
        let inputs = engine
            .harness_digest_inputs()
            .await
            .expect("the rig wires a harness digest context");
        let base_terms = base_selection_terms(texts);
        assert_eq!(
            inputs.terms, base_terms,
            "the selections coincide on this shape"
        );
        let base_render = render_digest_with_fingerprint(&inputs.context, base_terms);
        let fixed_render = inputs.render_with_fingerprint();
        assert_eq!(
            base_render.digest, fixed_render.digest,
            "coinciding selections render byte-identical digests"
        );
        assert_eq!(
            base_render.state_fingerprint, fixed_render.state_fingerprint,
            "the fingerprint never sees the query terms"
        );
    }

    let tmp = tempfile::tempdir().unwrap();
    seed_global_memories(
        &tmp.path().join("harness"),
        &[
            (
                "aaa_alpha",
                "alpha anchor notes",
                "the alpha anchor checklist",
            ),
            (
                "zzz_foxtrot",
                "foxtrot frontier notes",
                "the foxtrot frontier checklist",
            ),
        ],
    );
    let engine = direction_rig(&tmp, &DISTINCT6).await;
    let inputs = engine
        .harness_digest_inputs()
        .await
        .expect("the rig wires a harness digest context");
    let base_terms = base_selection_terms(&DISTINCT6);
    assert_ne!(inputs.terms, base_terms);
    let base_render = render_digest_with_fingerprint(&inputs.context, base_terms);
    let fixed_render = inputs.render_with_fingerprint();
    assert_ne!(base_render.digest, fixed_render.digest);
    // The state fingerprint is direction-invariant: staleness and delivery
    // triggers stay unchanged for unchanged harness state.
    assert_eq!(
        base_render.state_fingerprint,
        fixed_render.state_fingerprint
    );
    let newest_four: Vec<String> = DISTINCT6[2..]
        .iter()
        .rev()
        .map(ToString::to_string)
        .collect();
    assert_eq!(inputs.terms, digest_query_terms(None, &newest_four));
}

/// The digest's relevance ranking must rank the newest texts' memory
/// first.
#[tokio::test]
async fn digest_ranks_the_newest_texts_memory_first() {
    let tmp = tempfile::tempdir().unwrap();
    seed_global_memories(
        &tmp.path().join("harness"),
        &[
            (
                "aaa_alpha",
                "alpha anchor notes",
                "the alpha anchor checklist lives here",
            ),
            (
                "zzz_foxtrot",
                "foxtrot frontier notes",
                "the foxtrot frontier checklist lives here",
            ),
        ],
    );
    let engine = direction_rig(&tmp, &DISTINCT6).await;
    let digest = engine
        .harness_digest_inputs()
        .await
        .expect("the rig wires a harness digest context")
        .render();
    let newest = digest
        .find("foxtrot frontier notes")
        .expect("the newest texts' memory renders");
    let oldest = digest
        .find("alpha anchor notes")
        .expect("the oldest texts' memory renders");
    assert!(
        newest < oldest,
        "the newest texts' memory ranks first (TS direction)"
    );
}
