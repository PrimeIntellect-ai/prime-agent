//! Side questions end to end: `start_side_question`/`abort_side_question`
//! over the scripted engine, events routed back to the owner client.

use super::*;

// TS daemon-mode handlers + `core/side-question.ts` parity, over the
// scripted engine.
#[test]
fn side_questions_start_abort_and_events_scripted() {
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("daemon.sock");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).expect("agent dir");
    let _daemon = spawn_daemon(&socket, &agent_dir);
    let (mut client, _hello) = Client::connect(&socket);

    // The side-question script fails once transiently (retried with fast
    // delays), then answers after a delay long enough to observe the
    // in-flight guards and the abort.
    let script_path = dir.path().join("script.json");
    std::fs::write(
        &script_path,
        serde_json::json!({
            "responses": [],
            "sideQuestion": {
                "responses": [
                    { "error": "stream failed once", "kind": "server_error", "status": 500 },
                    { "text": "the side answer", "delayMs": 1500 },
                ],
                "retry": {
                    "enabled": true, "maxRetries": 2,
                    "baseDelayMs": 5, "maxRetryDelayMs": 1000,
                },
            },
        })
        .to_string(),
    )
    .expect("write script");
    client.send_command(
        "c1",
        &serde_json::json!({
            "type": "create",
            "config": {
                "cwd": dir.path().to_string_lossy(),
                "sessionDir": agent_dir.join("sessions").to_string_lossy(),
                "script": script_path.to_string_lossy(),
            },
        }),
    );
    let created = client.read_response("c1");
    assert_eq!(created["success"], true, "create failed: {created}");
    let session_id = created["data"]["id"]
        .as_str()
        .or_else(|| created["data"]["sessionId"].as_str())
        .expect("session id")
        .to_string();

    // The supervisor fans worker frames (including `side_question_event`)
    // out to clients attached to the session.
    client.send_command(
        "a1",
        &serde_json::json!({ "type": "attach", "activeSessionId": session_id }),
    );
    let attached = client.read_response("a1");
    assert_eq!(attached["success"], true, "attach failed: {attached}");

    client.send_command(
        "sq-missing",
        &serde_json::json!({
            "type": "start_side_question",
            "activeSessionId": "no-such-session",
            "sideQuestionId": "q0",
            "question": "hi?",
        }),
    );
    let missing = client.read_response("sq-missing");
    assert_eq!(missing["success"], false);
    assert_eq!(missing["error"], "Unknown active session: no-such-session");

    client.send_command(
        "sq1",
        &serde_json::json!({
            "type": "start_side_question",
            "activeSessionId": session_id,
            "sideQuestionId": "q1",
            "question": "what is the answer?",
            "previousTurns": [],
        }),
    );
    let (started, mut sq1_lines) = client.read_response_and_lines("sq1");
    assert_eq!(started["success"], true, "start failed: {started}");

    // The retry played out before the partial answer: the second provider
    // attempt answers.
    let mut running_answers: Vec<String> = Vec::new();
    let partial_answer = loop {
        let line = client.next_line_of_type(&mut sq1_lines, "side_question_event");
        let event = &line["event"];
        assert_eq!(line["activeSessionId"], serde_json::json!(session_id));
        assert_eq!(event["id"], serde_json::json!("q1"));
        assert_eq!(event["question"], serde_json::json!("what is the answer?"));
        assert_eq!(event["status"], serde_json::json!("running"));
        running_answers.push(event["answer"].as_str().expect("answer").to_string());
        if event["answer"] == serde_json::json!("the side answer") {
            break event["answer"].clone();
        }
    };
    assert_eq!(running_answers[0], "", "first running event is empty");

    // While the run is in flight (inside the scripted delay), the TS guards
    // hold: duplicate ids are rejected, and one run per client per session.
    client.send_command(
        "sq-dup",
        &serde_json::json!({
            "type": "start_side_question",
            "activeSessionId": session_id,
            "sideQuestionId": "q1",
            "question": "same id?",
        }),
    );
    let duplicate = client.read_response("sq-dup");
    assert_eq!(duplicate["success"], false);
    assert_eq!(
        duplicate["error"], "Side question already exists: q1",
        "duplicate: {duplicate}"
    );
    client.send_command(
        "sq-busy",
        &serde_json::json!({
            "type": "start_side_question",
            "activeSessionId": session_id,
            "sideQuestionId": "q2",
            "question": "second?",
        }),
    );
    let busy = client.read_response("sq-busy");
    assert_eq!(busy["success"], false);
    assert_eq!(
        busy["error"],
        "A side question is already running for this client and session"
    );

    client.send_command(
        "ab-unknown",
        &serde_json::json!({
            "type": "abort_side_question",
            "activeSessionId": session_id,
            "sideQuestionId": "never-started",
        }),
    );
    let aborted = client.read_response("ab-unknown");
    assert_eq!(aborted["success"], true, "abort failed: {aborted}");
    assert_eq!(aborted["data"], serde_json::json!({ "aborted": false }));

    // Abort the live run: the cancelled event carries the partial answer.
    client.send_command(
        "ab1",
        &serde_json::json!({
            "type": "abort_side_question",
            "activeSessionId": session_id,
            "sideQuestionId": "q1",
        }),
    );
    let (aborted, mut ab1_lines) = client.read_response_and_lines("ab1");
    assert_eq!(aborted["success"], true, "abort failed: {aborted}");
    assert_eq!(aborted["data"], serde_json::json!({ "aborted": true }));
    let cancelled = loop {
        let line = client.next_line_of_type(&mut ab1_lines, "side_question_event");
        if line["event"]["id"] == serde_json::json!("q1")
            && line["event"]["status"] == serde_json::json!("cancelled")
        {
            break line["event"].clone();
        }
    };
    assert_eq!(cancelled["answer"], partial_answer);

    // The same id starts again and completes (the script replays from the
    // top).
    client.send_command(
        "sq2",
        &serde_json::json!({
            "type": "start_side_question",
            "activeSessionId": session_id,
            "sideQuestionId": "q1",
            "question": "what is the answer?",
        }),
    );
    let (restarted, mut sq2_lines) = client.read_response_and_lines("sq2");
    assert_eq!(restarted["success"], true, "restart failed: {restarted}");
    let completed = loop {
        let line = client.next_line_of_type(&mut sq2_lines, "side_question_event");
        if line["event"]["id"] == serde_json::json!("q1")
            && line["event"]["status"] == serde_json::json!("complete")
        {
            break line["event"].clone();
        }
    };
    assert_eq!(completed["answer"], serde_json::json!("the side answer"));
    assert!(completed.get("errorMessage").is_none());
}
