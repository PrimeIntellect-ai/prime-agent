//! The `pa-tui-replay --frame` step flags over the committed demo session: `--expand-all` (the
//! expand/collapse-all shortcut) and `--expand-entry N` (a click on entry N) drive the view's own
//! expansion state, so the dumped frame shows the opened step exactly as the live surface does;
//! `--color` composes with them.
#![warn(clippy::allow_attributes_without_reason)]

use std::process::Command;

/// The demo session: a prompt, a thought with one python edit cell, and the final answer.
const DEMO: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/compact-steps-demo.jsonl"
);

/// Text only the opened thought shows.
const REASONING: &str = "one targeted edit is safer than rewriting the file";

/// The compact frame `pa-tui-replay` prints for the demo session under `flags`.
fn frame(flags: &[&str]) -> String {
    let output = Command::new(env!("CARGO_BIN_EXE_pa-tui-replay"))
        .arg(DEMO)
        .args(["--frame", "120x40", "--compact-steps"])
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
        compact.contains("\u{25b8} Thought - Checking where the trailing spaces are.")
            && compact.contains("\u{2713} Edited config/sample.toml (+1 -1)"),
        "the thought and the cell dump as their summary lines: {compact}"
    );
    assert!(
        compact.contains(&format!("prime agent v{}", env!("CARGO_PKG_VERSION")))
            && compact.contains("cwd ~/work/sample-project"),
        "the splash names the version and the session header's cwd: {compact}"
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
