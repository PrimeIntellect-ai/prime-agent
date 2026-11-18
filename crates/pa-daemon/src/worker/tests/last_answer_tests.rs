//! `get_last_assistant_text` after an ended turn: the collect lane's
//! newest-non-empty rule. A turn ended on `rlm.end_turn()` settles on its
//! batch's tool result, and the final assistant row holds only the tool
//! call — the answer text sits in the earlier assistant row, and the read
//! must step back to it.
use super::*;

#[tokio::test]
async fn get_last_assistant_text_steps_back_over_an_ended_turns_textless_row() {
    let worker = created_dispatch_worker().await;
    {
        let mut core = worker.core.lock().unwrap();
        let store = core.store.as_mut().expect("the create opened the store");
        // The ended turn's suffix: the assistant row that carried the
        // batch's answer, then the final assistant row holding only the
        // `rlm.end_turn()` python_repl call.
        store.append_message(&json!({
            "role": "assistant",
            "content": [{ "type": "text", "text": "the answer" }],
            "timestamp": 1,
        }));
        store.append_message(&json!({
            "role": "assistant",
            "content": [
                { "type": "toolCall", "id": "call-1", "name": "python_repl", "arguments": {} },
            ],
            "timestamp": 2,
        }));
    }
    let response = worker.dispatch("get_last_assistant_text", &json!({})).await;
    assert!(response.success, "the read must succeed: {response:?}");
    assert_eq!(
        response.data.expect("response data")["text"],
        "the answer",
        "the read must step back over the ended turn's textless assistant row"
    );
}
