//! The `pa-tui-replay --frame` step flags: `--expand-all` (the expand/collapse-all shortcut) and
//! `--expand-entry N` (a click on entry N) drive the view's own expansion state, so the dumped
//! frame shows the opened step exactly as the live surface does; `--color` composes with them.
#![warn(clippy::allow_attributes_without_reason)]

use std::process::Command;

const SESSION: &str = concat!(
    r#"{"type":"message","message":{"role":"user","content":[{"type":"text","text":"tidy the config"}],"timestamp":1}}"#,
    "\n",
    r#"{"type":"message","message":{"role":"assistant","content":[{"type":"thinking","thinking":"Checking the config first. The loader reads the file twice."},{"type":"text","text":"The config is tidy now."}],"api":"faux:1","provider":"faux","model":"faux-1","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"stop","timestamp":2}}"#,
    "\n",
);

/// Text only the opened thought shows.
const REASONING: &str = "The loader reads the file twice.";

/// The compact frame `pa-tui-replay` prints for the session under `flags`.
fn frame(flags: &[&str]) -> String {
    let dir = tempfile::tempdir().expect("temp dir");
    let session = dir.path().join("session.jsonl");
    std::fs::write(&session, SESSION).expect("write the session");
    let output = Command::new(env!("CARGO_BIN_EXE_pa-tui-replay"))
        .arg(&session)
        .args(["--frame", "100x30", "--compact-steps"])
        .args(flags)
        .output()
        .expect("run pa-tui-replay");
    assert!(
        output.status.success(),
        "pa-tui-replay failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).expect("a UTF-8 frame")
}

#[test]
fn the_step_flags_open_the_thought_in_the_dumped_frame() {
    let compact = frame(&[]);
    assert!(
        compact.contains("\u{25b8} Thought - Checking the config first."),
        "the thought dumps as its summary line: {compact}"
    );
    assert!(
        !compact.contains(REASONING),
        "the reasoning stays folded: {compact}"
    );
    let expanded = frame(&["--expand-all"]);
    assert!(
        expanded.contains(REASONING) && expanded.contains("\u{25be} Thought"),
        "--expand-all opens the thought: {expanded}"
    );
    let clicked = frame(&["--expand-entry", "1"]);
    assert!(
        clicked.contains(REASONING),
        "--expand-entry opens the thought (entry 1) as a click does: {clicked}"
    );
    let colored = frame(&["--color", "--expand-all"]);
    assert!(
        colored.contains("\u{1b}[") && colored.contains(REASONING),
        "--color prints the opened frame styled: {colored}"
    );
}
