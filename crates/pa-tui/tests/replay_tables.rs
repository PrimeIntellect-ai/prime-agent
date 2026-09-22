//! Replay-path markdown rendering: a session with a table and links renders
//! the same box/table rows and the legacy `label (url)` link form the live
//! path shows (the TS product under a plain tmux pane renders links the
//! same way: the terminal-capability gate forces the legacy form there).

use pa_tui::session::{parse_jsonl, JsonlSessionStream, SessionStream};
use pa_tui::theme::{ColorMode, Theme};
use pa_tui::view::AgentView;

const TABLE_SESSION: &str = concat!(
    r#"{"type":"message","message":{"role":"user","content":[{"type":"text","text":"show the table"}],"timestamp":1}}"#,
    "\n",
    r#"{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Status board:\n\n| Task | State | Notes |\n| --- | --- | --- |\n| alpha | done | shipped |\n| beta 数据 | running | wraps when narrow |\n\nSee the [docs](https://example.com/docs) and the [changelog](https://example.com/log)."}],"api":"faux:1","provider":"faux","model":"faux-1","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"stop","timestamp":2}}"#,
    "\n",
);

fn frame_text(session: &str, width: u16, height: u16) -> Vec<String> {
    let entries = parse_jsonl(session).expect("session parses");
    let mut stream = JsonlSessionStream::from_entries(entries);
    let mut view = AgentView::new(Theme::builtin("prime", ColorMode::TrueColor));
    while let pa_tui::session::SessionEvent::Item(item) = stream.poll().expect("poll") {
        view.push(item);
    }
    // Pin the terminal-capability gate: the fixture asserts the legacy link
    // form regardless of the host terminal the test run happens to use.
    pa_tui::hyperlinks::set_hyperlinks_override(Some(false));
    let rows = pa_tui::app::render_frame_text(&mut view, width, height);
    pa_tui::hyperlinks::set_hyperlinks_override(None);
    rows
}

#[test]
fn replayed_table_renders_boxed_aligned_rows() {
    let rows = frame_text(TABLE_SESSION, 100, 30);
    let flat = rows.join("\n");
    // The header and the CJK data cell drive the column widths: the first
    // column fits `beta 数据` (9 display columns: 5 + two double-width
    // glyphs), the third `wraps when narrow`.
    assert!(
        flat.contains("┌───────────┬─────────┬───────────────────┐"),
        "top border: {flat}"
    );
    assert!(
        flat.contains("│ Task      │ State   │ Notes             │"),
        "header row: {flat}"
    );
    assert!(
        flat.contains("│ beta 数据 │ running │ wraps when narrow │"),
        "mixed-width row: {flat}"
    );
    assert!(
        flat.contains("└───────────┴─────────┴───────────────────┘"),
        "bottom border: {flat}"
    );
    // Links render the legacy form under the gate (tmux parity).
    assert!(
        flat.contains("docs (https://example.com/docs)"),
        "link row: {flat}"
    );
    // The second link wraps mid-row at this width, so only its URL tail
    // stays contiguous.
    assert!(flat.contains("example.com/log)"), "link row 2: {flat}");
}

#[test]
fn replayed_table_narrow_terminal_falls_back_to_raw() {
    let rows = frame_text(TABLE_SESSION, 12, 60);
    let flat = rows.join("\n");
    // 3 columns need 10 border columns; at 12 terminal columns the block
    // cannot fit a stable box, so it renders the raw markdown (wrapped),
    // never a broken one.
    assert!(!flat.contains('┌'), "no box at 12 columns: {flat}");
    assert!(
        flat.contains("State"),
        "raw fallback keeps the source: {flat}"
    );
}
