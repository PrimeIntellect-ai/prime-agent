use pa_core::session_engine::inbox::InboxMessage;
use serde_json::json;

use super::notice_text;

const SUMMARY_OF_TWO: &str = "[inbox 00:00-00:00 UTC] 2 new bash-done messages; total waiting: 2. \
                              Read them with msgs = await rlm.inbox.read().";

fn bash_done(id: &str, exit_code: i64, tail: &str) -> InboxMessage {
    InboxMessage {
        id: id.to_string(),
        class: "bash-done".to_string(),
        arrived_at_ms: 0,
        sender: Some("make".to_string()),
        text: format!("[bash-done {id} exit:{exit_code}]"),
        meta: json!({
            "command": "make",
            "exitCode": exit_code,
            "outputTail": tail,
        }),
    }
}

#[test]
fn two_items_inline_their_tails_and_three_summarize() {
    let two = [
        bash_done("1", 1, "a\nb\nc\nd\ne\nf\ng\n"),
        bash_done("2", 0, "ok"),
    ];
    assert_eq!(
        notice_text(&two, 2).1,
        format!(
            "{SUMMARY_OF_TWO}\n\n[bash-done 1 exit:1]\nc\nd\ne\nf\ng\n\n[bash-done 2 exit:0]\nok"
        )
    );
    let three = [
        bash_done("1", 1, "tail"),
        bash_done("2", 1, "tail"),
        bash_done("3", 1, "tail"),
    ];
    assert_eq!(
        notice_text(&three, 3).1,
        "[inbox 00:00-00:00 UTC] 3 new bash-done messages; total waiting: 3. \
         Read them with msgs = await rlm.inbox.read()."
    );
}
