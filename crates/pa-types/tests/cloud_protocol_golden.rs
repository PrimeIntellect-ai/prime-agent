//! Golden corpus replay: every case recorded from the REAL TypeScript
//! `protocol.ts` (pin in the corpus provenance) must reproduce
//! byte-identically through the Rust port — canonical frames, digests, and
//! exact problem strings.
//!
//! Regenerate the corpus with
//! `CLOUD_PROTOCOL_TS=<protocol.ts at 193d42bf> node harness.mjs` next to
//! it; the recording is deterministic.

use pa_types::daemon::cloud::{
    canonical_json, cloud_event_problem, cloud_id_problem, cloud_message_problem,
    cloud_request_digest, cloud_request_json_problem, cloud_request_problem, parse_cloud_message,
    serialize_cloud_message, CloudCommandRequest, CloudEvent, CloudMessage,
    CLOUD_MAX_INFERENCE_MESSAGES, CLOUD_MAX_MESSAGE_BYTES, CLOUD_MAX_REQUEST_JSON_CHARS,
};
use serde_json::Value;

const CORPUS: &str = include_str!("golden/cloud_protocol/corpus.json");

fn corpus() -> Value {
    serde_json::from_str(CORPUS).expect("corpus JSON")
}

/// SHA-256 of `git show
/// 193d42bf:packages/coding-agent/src/core/cloud/protocol.ts`; the harness
/// hashes the exact source it imports, so a corpus recorded against a
/// drifted source fails here instead of silently claiming the pin.
const PINNED_TS_SOURCE_SHA256: &str =
    "fef54f95c50444c85423d23b8ebcf7cd58aacec53b4dcbe02608bbb6256f81c4";
const PINNED_TS_SOURCE_BYTES: i64 = 61_956;

#[test]
fn provenance_pins_the_ts_source() {
    let provenance = &corpus()["provenance"];
    assert_eq!(
        provenance["commit"],
        "193d42bf (origin/feat/direct-cloud-sandbox)"
    );
    assert_eq!(
        provenance["source"],
        "packages/coding-agent/src/core/cloud/protocol.ts"
    );
    assert_eq!(provenance["sourceSha256"], PINNED_TS_SOURCE_SHA256);
    assert_eq!(provenance["sourceBytes"], PINNED_TS_SOURCE_BYTES);
    assert_eq!(provenance["protocolName"], "prime-agent.cloud");
    assert_eq!(provenance["protocolVersion"], 3);
}

#[test]
fn raw_wire_spellings_parse_and_serialize_identically_to_ts() {
    for case in corpus()["rawParses"].as_array().expect("rawParses") {
        let name = case["name"].as_str().expect("name");
        let raw = case["rawJson"].as_str().expect("rawJson");
        let message = parse_cloud_message(raw).unwrap_or_else(|error| panic!("{name}: {error}"));
        let serialized =
            serialize_cloud_message(&message).unwrap_or_else(|error| panic!("{name}: {error}"));
        assert_eq!(
            serialized,
            case["serialized"].as_str().expect("serialized"),
            "raw parse {name} serialized differently than the TS side"
        );
        let reparsed: CloudMessage = parse_cloud_message(&serialized).expect("reparse");
        assert_eq!(
            reparsed, message,
            "codec round trip changed raw parse {name}"
        );
    }
}

#[test]
fn valid_frames_serialize_byte_identical_to_ts() {
    for case in corpus()["frames"].as_array().expect("frames") {
        let name = case["name"].as_str().expect("name");
        let value = &case["value"];
        assert_eq!(
            cloud_message_problem(value),
            None,
            "Rust rejected the valid TS frame {name}"
        );
        let message: CloudMessage =
            serde_json::from_value(value.clone()).expect("typed parse of a validated frame");
        let serialized =
            serialize_cloud_message(&message).unwrap_or_else(|error| panic!("{name}: {error}"));
        assert_eq!(
            serialized,
            case["serialized"].as_str().expect("serialized"),
            "frame {name} serialized differently than the TS side"
        );
        let reparsed: CloudMessage = parse_cloud_message(&serialized).expect("reparse");
        assert_eq!(reparsed, message, "codec round trip changed {name}");
    }
}

#[test]
fn valid_requests_canonicalize_and_digest_identically_to_ts() {
    for case in corpus()["requests"].as_array().expect("requests") {
        let name = case["name"].as_str().expect("name");
        let value = &case["value"];
        assert_eq!(
            cloud_request_problem(value),
            None,
            "Rust rejected the valid TS request {name}"
        );
        assert_eq!(
            canonical_json(value).expect("canonical"),
            case["canonical"].as_str().expect("canonical"),
            "request {name} canonicalized differently than the TS side"
        );
        if let Some(expected) = case["digest"].as_str() {
            assert_eq!(
                cloud_request_digest(value).expect("digest"),
                expected,
                "request {name} digested differently than the TS side"
            );
        }
        let parsed: CloudCommandRequest =
            serde_json::from_value(value.clone()).expect("typed parse of a validated request");
        let reparsed = serde_json::to_value(&parsed).expect("typed serialize");
        assert_eq!(reparsed, *value, "typed round trip changed request {name}");
    }
}

#[test]
fn number_literals_render_and_digest_like_javascript() {
    for case in corpus()["numbers"].as_array().expect("numbers") {
        let raw = case["rawJson"].as_str().expect("rawJson");
        let value: Value = serde_json::from_str(raw).expect("number case JSON");
        assert_eq!(
            cloud_request_problem(&value),
            None,
            "Rust rejected the valid TS number case: {raw}"
        );
        assert_eq!(
            canonical_json(&value).expect("canonical"),
            case["canonical"].as_str().expect("canonical"),
            "number case digested differently than the TS side: {raw}"
        );
        assert_eq!(
            cloud_request_digest(&value).expect("digest"),
            case["digest"].as_str().expect("digest"),
            "number case canonicalized differently than the TS side: {raw}"
        );
    }
}

#[test]
fn valid_events_canonicalize_identically_to_ts() {
    for case in corpus()["events"].as_array().expect("events") {
        let name = case["name"].as_str().expect("name");
        let value = &case["value"];
        assert_eq!(
            cloud_event_problem(value, "event"),
            None,
            "Rust rejected the valid TS event {name}"
        );
        assert_eq!(
            canonical_json(value).expect("canonical"),
            case["canonical"].as_str().expect("canonical"),
            "event {name} canonicalized differently than the TS side"
        );
        let parsed: CloudEvent =
            serde_json::from_value(value.clone()).expect("typed parse of a validated event");
        let reparsed = serde_json::to_value(&parsed).expect("typed serialize");
        assert_eq!(reparsed, *value, "typed round trip changed event {name}");
    }
}

#[test]
fn invalid_cases_reproduce_the_ts_problem_strings() {
    for case in corpus()["invalid"].as_array().expect("invalid") {
        let validator = case["validator"].as_str().expect("validator");
        let expected = case["problem"].as_str().expect("problem");
        match validator {
            "message" => {
                let value = &case["value"];
                assert_eq!(cloud_message_problem(value), Some(expected.to_string()));
            }
            "event" => {
                let value = &case["value"];
                assert_eq!(
                    cloud_event_problem(value, "event"),
                    Some(expected.to_string())
                );
            }
            "request" => {
                let value = &case["value"];
                assert_eq!(cloud_request_problem(value), Some(expected.to_string()));
            }
            "requestJson" => {
                let value = &case["value"];
                assert_eq!(
                    cloud_request_json_problem(value),
                    Some(expected.to_string())
                );
            }
            "id" => {
                let value = &case["value"];
                assert_eq!(
                    cloud_id_problem(Some(value), "id"),
                    Some(expected.to_string())
                );
            }
            "parse" => {
                let raw = case["rawJson"].as_str().expect("rawJson");
                let error = parse_cloud_message(raw).expect_err("parse case must fail");
                if expected.starts_with("message is not valid JSON: ") {
                    // The not-valid-JSON reason is engine-specific (V8 vs
                    // serde); only the TS prefix is pinned.
                    assert!(
                        error.starts_with("message is not valid JSON: "),
                        "engine prefix missing: {error}"
                    );
                } else {
                    assert_eq!(error, expected);
                }
            }
            "serialize" => {
                let value = &case["value"];
                let message: CloudMessage =
                    serde_json::from_value(value.clone()).expect("typed parse for serialize case");
                assert_eq!(
                    serialize_cloud_message(&message).expect_err("serialize case must fail"),
                    expected
                );
            }
            other => panic!("unknown corpus validator: {other}"),
        }
    }
}

/// The exact typed-layer rejection for the corpus's `divergentParses`:
/// integral JS numbers above the u64 wire domain. Validators stay
/// byte-exact with TS (the frames ARE valid there), the typed layer
/// refuses instead of saturating or wrapping, and the message is
/// deliberately not a TS problem string.
#[test]
fn ts_valid_numbers_beyond_the_u64_domain_fail_only_the_typed_parse() {
    const TYPED_U64_DOMAIN_PROBLEM: &str = concat!(
        "invalid value: a non-integer or u64-overflowing JavaScript number, ",
        "expected an integer within the u64 wire domain"
    );
    for case in corpus()["divergentParses"]
        .as_array()
        .expect("divergentParses")
    {
        let name = case["name"].as_str().expect("name");
        let raw = case["rawJson"].as_str().expect("rawJson");
        assert_eq!(case["divergence"], "rust-typed-u64-domain", "case {name}");
        let value: Value = serde_json::from_str(raw).expect("divergent case JSON");
        assert_eq!(
            cloud_message_problem(&value),
            None,
            "TS accepts {name}; Rust validation must match"
        );
        assert_eq!(
            parse_cloud_message(raw).expect_err("typed layer must refuse {name}"),
            TYPED_U64_DOMAIN_PROBLEM,
            "typed rejection of {name} is the pinned domain message"
        );
    }
}

#[test]
fn size_boundaries_reproduce_the_ts_strings() {
    // Corpus-coverable boundaries ride the corpus; these construct frames
    // that scale with the bound and assert the exact TS strings.
    let big_prompt = "x".repeat(65_537);
    assert_eq!(
        cloud_request_problem(
            &serde_json::json!({"kind": "compact", "customInstructions": big_prompt})
        ),
        Some(
            "request.customInstructions must be a string of 1-65536 characters when present"
                .to_string()
        )
    );
    let big_entry = serde_json::json!({
        "sequence": 1, "kind": "session_entry", "recordedAt": "t",
        "sessionId": "r", "entryId": "e",
        "entry": {"type": "message", "id": "m", "timestamp": "t", "text": "x".repeat(262_145)},
    });
    assert_eq!(
        cloud_event_problem(&big_entry, "event"),
        Some("event.entry exceeds 262144 bytes; it must travel as artifact refs".to_string())
    );
    let long_request = "x".repeat(CLOUD_MAX_REQUEST_JSON_CHARS + 1);
    let big_request_frame = serde_json::json!({
        "type": "command", "sessionId": "s", "generation": 1,
        "receipt": {"commandId": "cmd_1", "digest": "sha256:e7dfe480c4463263a93755ec83d15829b19df0698e8b764baa4b5e9a3d7bc727", "state": "accepted", "submittedAt": "t", "updatedAt": "t", "uncertain": false},
        "request": long_request,
    });
    assert_eq!(
        cloud_message_problem(&big_request_frame),
        Some(format!(
            "command.request must be a string of 1-{CLOUD_MAX_REQUEST_JSON_CHARS} characters"
        ))
    );
    let oversized = "x".repeat(CLOUD_MAX_MESSAGE_BYTES + 1);
    assert_eq!(
        parse_cloud_message(&oversized).unwrap_err(),
        format!("message exceeds {CLOUD_MAX_MESSAGE_BYTES} bytes")
    );
    let messages: Vec<Value> = (0..=CLOUD_MAX_INFERENCE_MESSAGES)
        .map(|_| Value::Null)
        .collect();
    let big_inference = serde_json::json!({
        "type": "inference_request", "sessionId": "s", "remoteSessionId": "r", "requestId": "q",
        "model": {"provider": "p", "modelId": "m"},
        "payload": {"messages": messages},
    });
    assert_eq!(
        cloud_message_problem(&big_inference),
        Some(format!(
            "payload.messages exceeds {CLOUD_MAX_INFERENCE_MESSAGES} entries"
        ))
    );
}
