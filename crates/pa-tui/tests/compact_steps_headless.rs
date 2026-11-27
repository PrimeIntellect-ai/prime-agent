//! Headless e2e for the compact step summaries: with the `compactSteps` setting on, a chat opens
//! with each thought and tool call as one summary line; a click on a thought line opens the
//! reasoning in place and a second click folds it; the expand/collapse-all shortcut opens and folds
//! every step; a live-streamed thought reports its measured thinking time.
#![cfg(unix)]
#![warn(clippy::allow_attributes_without_reason)]

mod support;

use std::os::unix::net::UnixStream;
use std::sync::{Arc, Mutex, MutexGuard};

use anyhow::Result;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use pa_tui::interactive::{HeadlessPlan, HeadlessStep, InteractiveOptions};
use serde_json::{json, Value};

use support::{
    attach_response, create_response, detach_response, options, run_headless, serve_connection,
    session_stats_response, write_json, write_session_event, MockSupervisor, Request,
};

/// Mouse tracking is process-global state, so the headless runs serialize.
static RUN_LOCK: Mutex<()> = Mutex::new(());

fn run_lock() -> MutexGuard<'static, ()> {
    match RUN_LOCK.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

/// The opening thought's first sentence: the summary line's gist.
const GIST: &str = "Checking the config first.";
/// Text only the expanded reasoning shows.
const REASONING: &str = "the second read is the one to trim";
/// The cell's code row, shown only by the expanded card.
const CODE_ROW: &str = "\u{2570}\u{2500} print(open('cfg.toml').read())";

impl MockSupervisor {
    /// Serve one connection: the attach transcript below, and one streamed turn per prompt.
    fn serve(self) {
        let (stream, _) = self.listener.accept().expect("accept");
        serve_connection(stream, &[], |writer, Request { id, kind, .. }| {
            match kind {
                "create" => write_json(writer, &create_response(id)),
                "attach" => {
                    let mut response = attach_response(id, "steps session");
                    response["data"]["snapshot"]["messages"] = transcript();
                    write_json(writer, &response);
                }
                "get_session_stats" => write_json(writer, &session_stats_response(id)),
                "prompt" => {
                    write_json(
                        writer,
                        &json!({ "type": "response", "id": id, "command": "prompt", "success": true }),
                    );
                    stream_thinking_turn(writer);
                }
                "detach" => write_json(writer, &detach_response(id)),
                _ => return false,
            }
            true
        });
    }
}

/// A finished turn: a prompt, a thought and one python cell, then the final answer.
fn transcript() -> Value {
    json!([
        { "role": "user", "content": "tidy the config", "timestamp": 1u64 },
        {
            "role": "assistant",
            "content": [
                { "type": "thinking", "thinking": format!("**{GIST}** The loader reads the file twice, so {REASONING}.") },
                {
                    "type": "toolCall",
                    "id": "c0",
                    "name": "python_repl",
                    "arguments": { "code": "print(open('cfg.toml').read())" },
                },
            ],
            "timestamp": 2u64,
        },
        {
            "role": "toolResult",
            "toolCallId": "c0",
            "toolName": "python_repl",
            "content": [{ "type": "text", "text": "key = 1" }],
            "details": { "status": "ok", "durationMs": 800, "stdout": "key = 1\n" },
            "isError": false,
            "timestamp": 3u64,
        },
        {
            "role": "assistant",
            "content": [{ "type": "text", "text": "The config is tidy now." }],
            "timestamp": 4u64,
        },
    ])
}

/// One streamed turn whose thinking block opens and closes on the wire.
fn stream_thinking_turn(writer: &mut UnixStream) {
    let thinking =
        json!({ "type": "thinking", "thinking": "Weighing the two loaders. The cached one wins." });
    let answer = json!({ "type": "text", "text": "Use the cached loader." });
    let frame = |event: &str, kind: &str, content: Value| {
        json!({
            "type": event,
            "message": { "role": "assistant", "content": content, "stopReason": "stop" },
            "assistantMessageEvent": { "type": kind, "contentIndex": 0 },
        })
    };
    write_session_event(writer, &json!({ "type": "turn_start" }));
    for event in [
        frame("message_start", "start", json!([])),
        frame(
            "message_update",
            "thinking_start",
            json!([{ "type": "thinking", "thinking": "" }]),
        ),
        frame("message_update", "thinking_delta", json!([thinking])),
        frame("message_update", "thinking_end", json!([thinking])),
        frame("message_update", "text_delta", json!([thinking, answer])),
        frame("message_end", "done", json!([thinking, answer])),
    ] {
        write_session_event(writer, &event);
    }
    write_session_event(writer, &json!({ "type": "turn_end" }));
    write_session_event(writer, &json!({ "type": "agent_end" }));
}

/// The settings seam with `compactSteps` on; every other getter returns its default.
struct StubSettings;

impl pa_tui::client_settings::ClientSettings for StubSettings {
    fn compact_steps(&self) -> bool {
        true
    }
    fn compaction_threshold_percent(&self) -> f64 {
        95.0
    }
    fn set_compaction_threshold_percent(&self, _percent: f64) -> Result<()> {
        Ok(())
    }
    fn theme(&self) -> Option<String> {
        None
    }
    fn set_theme(&self, _theme: &str) -> Result<()> {
        Ok(())
    }
    fn show_images(&self) -> bool {
        true
    }
    fn set_show_images(&self, _enabled: bool) -> Result<()> {
        Ok(())
    }
    fn clear_on_shrink(&self) -> bool {
        false
    }
    fn set_clear_on_shrink(&self, _enabled: bool) -> Result<()> {
        Ok(())
    }
    fn show_terminal_progress(&self) -> bool {
        false
    }
    fn set_show_terminal_progress(&self, _enabled: bool) -> Result<()> {
        Ok(())
    }
    fn image_auto_resize(&self) -> bool {
        true
    }
    fn set_image_auto_resize(&self, _enabled: bool) -> Result<()> {
        Ok(())
    }
    fn block_images(&self) -> bool {
        false
    }
    fn set_block_images(&self, _blocked: bool) -> Result<()> {
        Ok(())
    }
    fn image_model(&self) -> Option<String> {
        None
    }
    fn enable_skill_commands(&self) -> bool {
        true
    }
    fn set_enable_skill_commands(&self, _enabled: bool) -> Result<()> {
        Ok(())
    }
    fn enable_builtin_skills(&self) -> bool {
        true
    }
    fn set_enable_builtin_skills(&self, _enabled: bool) -> Result<()> {
        Ok(())
    }
    fn show_hardware_cursor(&self) -> bool {
        false
    }
    fn set_show_hardware_cursor(&self, _enabled: bool) -> Result<()> {
        Ok(())
    }
    fn editor_padding_x(&self) -> u64 {
        0
    }
    fn set_editor_padding_x(&self, _padding: u64) -> Result<()> {
        Ok(())
    }
    fn autocomplete_max_visible(&self) -> u64 {
        5
    }
    fn set_autocomplete_max_visible(&self, _max_visible: u64) -> Result<()> {
        Ok(())
    }
    fn quiet_startup(&self) -> bool {
        false
    }
    fn set_quiet_startup(&self, _quiet: bool) -> Result<()> {
        Ok(())
    }
    fn idle_eviction_minutes(&self) -> String {
        "90".to_string()
    }
    fn set_idle_eviction_minutes(&self, _value: &str) -> Result<()> {
        Ok(())
    }
    fn mermaid_rendering_mode(&self) -> String {
        "streaming".to_string()
    }
    fn set_mermaid_rendering_mode(&self, _mode: &str) -> Result<()> {
        Ok(())
    }
    fn tree_filter_mode(&self) -> String {
        "user-only".to_string()
    }
    fn set_tree_filter_mode(&self, _mode: &str) -> Result<()> {
        Ok(())
    }
    fn default_service_tier(&self) -> String {
        "default".to_string()
    }
    fn set_default_service_tier(&self, _tier: &str) -> Result<()> {
        Ok(())
    }
    fn factory_enabled(&self) -> bool {
        false
    }
    fn set_factory_enabled(&self, _enabled: bool) -> Result<()> {
        Ok(())
    }
    fn chat_detail(&self) -> String {
        "overview".to_string()
    }
    fn set_chat_detail(&self, _detail: &str) -> Result<()> {
        Ok(())
    }
    fn warnings_anthropic_extra_usage(&self) -> bool {
        true
    }
    fn set_warnings_anthropic_extra_usage(&self, _enabled: bool) -> Result<()> {
        Ok(())
    }
    fn update_channel(&self) -> Option<String> {
        None
    }
    fn set_update_channel(&self, _channel: &str) -> Result<()> {
        Ok(())
    }
    fn effective_update_channel(&self, _version: &str) -> String {
        "stable".to_string()
    }
    fn telemetry_status(&self) -> String {
        String::new()
    }
    fn set_telemetry_enabled(&self, _enabled: bool) -> Result<String> {
        Ok(String::new())
    }
}

/// Run one headless plan against the mock and return its frames.
fn run_plan(steps: Vec<HeadlessStep>) -> Vec<String> {
    let _guard = run_lock();
    run_headless(
        HeadlessPlan {
            steps,
            width: 100,
            height: 34,
        },
        |socket| InteractiveOptions {
            client_settings: Some(Arc::new(StubSettings)),
            ..options(socket)
        },
        |socket| {
            let supervisor = MockSupervisor::bind(socket);
            move || supervisor.serve()
        },
    )
    .frames
}

fn wait_for(needle: &str) -> HeadlessStep {
    HeadlessStep::WaitRender {
        needle: needle.to_string(),
        timeout_ms: 10_000,
    }
}

/// The opening steps every scenario starts from: the attached transcript has painted.
fn opened() -> Vec<HeadlessStep> {
    vec![
        HeadlessStep::WaitIdle { timeout_ms: 30_000 },
        wait_for("\u{25b8} Thought"),
    ]
}

/// The SGR left press and release a terminal sends for a click on one-based `(col, row)`.
fn click(col: usize, row: usize) -> [HeadlessStep; 2] {
    [
        HeadlessStep::Mouse(format!("\x1b[<0;{col};{row}M")),
        HeadlessStep::Mouse(format!("\x1b[<0;{col};{row}m")),
    ]
}

/// The one-based cell of `needle` in the last frame holding it.
fn locate(frames: &[String], needle: &str) -> (usize, usize) {
    frames
        .iter()
        .rev()
        .find_map(|frame| {
            let rows: Vec<&str> = frame.split('\n').collect();
            let row = rows.iter().position(|row| row.contains(needle))?;
            let col = rows[row][..rows[row].find(needle)?].chars().count();
            Some((col + 1, row + 1))
        })
        .unwrap_or_else(|| panic!("no frame shows {needle:?}: {frames:#?}"))
}

fn alt_o() -> HeadlessStep {
    HeadlessStep::Key(KeyEvent::new(KeyCode::Char('o'), KeyModifiers::ALT))
}

/// The setting opens the chat compact; a click on the thought line opens the reasoning in place,
/// and a click on its header folds it back.
#[test]
fn the_setting_opens_compact_and_a_click_toggles_the_thought() {
    let frames = run_plan(opened());
    let opening = frames.last().expect("the opening frame");
    assert!(
        opening.contains(&format!("\u{25b8} Thought - {GIST}")),
        "the thought renders as its summary line: {opening}"
    );
    assert!(
        !opening.contains(REASONING),
        "the reasoning stays folded: {opening}"
    );
    assert!(
        opening.contains("\u{2713} Python: ") && !opening.contains("\u{2713} python \u{b7}"),
        "the cell renders as one step line, not its card: {opening}"
    );
    assert!(
        opening.contains("The config is tidy now."),
        "the final answer renders whole: {opening}"
    );
    let summary = locate(&frames, "\u{25b8} Thought");

    let mut steps = opened();
    steps.extend(click(summary.0, summary.1));
    steps.push(wait_for(REASONING));
    let frames = run_plan(steps);
    let expanded = frames.last().expect("a frame after the click");
    assert!(
        expanded.contains(REASONING) && expanded.contains("\u{25be} Thought"),
        "the click opened the reasoning under its header: {expanded}"
    );
    assert!(
        !expanded.contains(CODE_ROW),
        "the tool step stays folded: {expanded}"
    );
    let header = locate(&frames, "\u{25be} Thought");

    let mut steps = opened();
    steps.extend(click(summary.0, summary.1));
    steps.push(wait_for(REASONING));
    steps.extend(click(header.0, header.1));
    steps.push(wait_for("\u{25b8} Thought"));
    let frames = run_plan(steps);
    let folded = frames.last().expect("a frame after the second click");
    assert!(
        !folded.contains(REASONING),
        "the second click folded the reasoning: {folded}"
    );
    assert!(
        folded.contains(&format!("\u{25b8} Thought - {GIST}")),
        "the summary line is back: {folded}"
    );
}

/// The shortcut opens every step — the thought and the cell's code — and a second press folds
/// them all back.
#[test]
fn the_shortcut_expands_and_collapses_every_step() {
    let mut steps = opened();
    steps.push(alt_o());
    steps.push(wait_for(REASONING));
    steps.push(wait_for(CODE_ROW));
    steps.push(alt_o());
    steps.push(wait_for(&format!("\u{25b8} Thought - {GIST}")));
    let frames = run_plan(steps);
    assert!(
        frames
            .iter()
            .any(|frame| frame.contains(REASONING) && frame.contains(CODE_ROW)),
        "one press opened the thought and the tool step together"
    );
    let folded = frames.last().expect("a frame after the second press");
    assert!(
        !folded.contains(REASONING) && !folded.contains(CODE_ROW),
        "the second press folded every step: {folded}"
    );
}

/// A thought streamed live carries its measured time; the one loaded with the transcript records
/// none.
#[test]
fn a_live_thought_reports_its_thinking_time() {
    let mut steps = opened();
    steps.push(HeadlessStep::Submit("pick a loader".to_string()));
    steps.push(wait_for("Use the cached loader."));
    steps.push(HeadlessStep::WaitIdle { timeout_ms: 10_000 });
    let frames = run_plan(steps);
    let last = frames.last().expect("a frame after the turn");
    let line = last
        .lines()
        .find(|row| row.contains("Weighing the two loaders."))
        .unwrap_or_else(|| panic!("the live thought renders: {last}"));
    assert!(
        line.contains("\u{25b8} Thought for "),
        "the live thought names its time: {line}"
    );
    assert!(
        last.contains(&format!("\u{25b8} Thought - {GIST}")),
        "the loaded thought carries no time: {last}"
    );
}
