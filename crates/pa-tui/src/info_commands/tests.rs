use super::*;

fn plain(rows: &[ClientLine]) -> Vec<String> {
    rows.iter()
        .map(|row| row.iter().map(|span| span.text.as_str()).collect())
        .collect()
}

fn json(text: &str) -> Value {
    serde_json::from_str(text).expect("fixture json")
}

/// The info rows the panel windows over: every rendered row pads to
/// exactly the render width (wide glyphs never overflow a row) and
/// wraps tighter at a narrow terminal instead of truncating content.
#[test]
fn client_text_rows_wrap_and_pad_to_the_width() {
    let theme = Theme::builtin("prime", crate::theme::ColorMode::TrueColor);
    let rows = vec![
        vec![],
        vec![raw_span("  ")],
        vec![dim("prefix "), raw_span("wide 界 words words")],
    ];
    // Sane terminal widths (at a degenerate width-1 terminal a wide
    // glyph cannot fit a row, so exact-width padding is a width-2+
    // property).
    for width in [7, 23, 80] {
        let rendered = render_client_text(&rows, &theme, width);
        // The TS `Spacer(1)` leading blank rides first, unpadded;
        // every CONTENT row below it pads to exactly the width.
        assert!(!rendered.is_empty(), "the leading spacer always renders");
        assert!(rendered[0].is_empty(), "the leading spacer is the TS blank");
        for row in &rendered[1..] {
            assert_eq!(
                crate::width::spans_width(row),
                width,
                "rows pad to the width: {row:?}"
            );
        }
    }
    let rendered = render_client_text(&rows, &theme, 7);
    let text: Vec<String> = rendered
        .iter()
        .map(|row| row.iter().map(|span| span.content.as_str()).collect())
        .collect();
    assert!(
        text.iter().any(|row| row.contains("界")),
        "the wide glyph survives the wrap"
    );
}

#[test]
fn session_info_matches_ts_shape() {
    let stats = json(
        r#"{
                "sessionFile": "/tmp/session.jsonl",
                "sessionId": "abc123def456",
                "userMessages": 2,
                "assistantMessages": 1,
                "toolCalls": 3,
                "toolResults": 4,
                "totalMessages": 10
            }"#,
    );
    assert_eq!(
        plain(&session_info_rows(&stats, None)),
        vec![
            "Session Info",
            "",
            "File: /tmp/session.jsonl",
            "ID: abc123def456",
            "",
            "Messages",
            "User: 2",
            "Assistant: 1",
            "Tool Calls: 3",
            "Tool Results: 4",
            "Total: 10",
            "",
            "Use /context for token, cost, and context usage.",
        ]
    );
    // A session name adds the Name row; a missing file is in-memory.
    let mut with_name = stats;
    with_name["sessionFile"] = Value::Null;
    let rows = plain(&session_info_rows(&with_name, Some("lane work")));
    assert_eq!(rows[2], "Name: lane work");
    assert_eq!(rows[3], "File: In-memory");
}

#[test]
fn logs_rows_match_ts_shape() {
    let dir = tempfile::tempdir().expect("tempdir");
    let logs = dir.path().join("logs");
    std::fs::create_dir_all(&logs).expect("create logs dir");
    std::fs::write(logs.join("client-errors.log"), vec![0u8; 2048]).expect("write");
    std::fs::write(logs.join("a-second.log"), "x").expect("write");
    std::fs::create_dir(logs.join(".hidden")).expect("create hidden");
    let rows = plain(&logs_rows(&logs));
    assert_eq!(
        rows,
        vec![
            "Logs".to_string(),
            String::new(),
            format!("Directory: {}", logs.display()),
            String::new(),
            // 2048/1024 = 2.0 KB; the 1-byte file rounds to 0.0 KB;
            // rows sort by name; dot-entries stay hidden.
            "• a-second.log (0.0 KB)".to_string(),
            "• client-errors.log (2.0 KB)".to_string(),
            String::new(),
            "Daemon crashes log to <socket>.log; agent-open failures log to client-errors.log."
                .to_string(),
        ]
    );
    // A missing directory renders the empty state (TS catch).
    let missing = dir.path().join("no-such-logs");
    assert_eq!(plain(&logs_rows(&missing))[4], "No logs written yet.");
}

#[test]
fn system_prompt_header_counts_utf16_units() {
    let rows = plain(&system_prompt_header_rows("héllo \u{1f44d}"));
    // 5 chars + space + the surrogate-pair thumbs-up = 8 UTF-16 units.
    assert_eq!(rows, vec!["System Prompt (8 chars)"]);
}

#[test]
fn system_prompt_body_splits_source_lines() {
    assert_eq!(
        plain(&system_prompt_body_rows("a\n\nb")),
        vec!["a", "", "b"]
    );
}

#[test]
fn changelog_missing_file_is_the_empty_state() {
    assert_eq!(
        changelog_markdown(std::path::Path::new("/no/such/CHANGELOG.md")),
        "No changelog entries found."
    );
}

#[test]
fn changelog_parses_and_orders_newest_first() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("CHANGELOG.md");
    std::fs::write(
        &path,
        "# Changelog\n\nintro before any version is dropped\n\n## [0.9.4] - 2026-09-01\n\n- Older entry.\n\n## Unreleased\n\ndropped: no version\n\n## [0.9.5] - 2026-09-15\n\n- Newer entry.\n- Second line.\n",
    )
    .expect("write changelog");
    assert_eq!(
        changelog_markdown(&path),
        "## [0.9.5] - 2026-09-15\n\n- Newer entry.\n- Second line.\n\n## [0.9.4] - 2026-09-01\n\n- Older entry."
    );
}

#[test]
fn context_tree_root_only_matches_ts() {
    let tree = json(
        r#"{
                "id": "root", "label": "main agent", "status": "active",
                "ownUsage": {"input": 900, "output": 90, "cacheRead": 0,
                             "cacheWrite": 10, "cost": {"total": 0.0312}},
                "totalUsage": {"input": 900, "output": 90, "cacheRead": 0,
                               "cacheWrite": 10, "cost": {"total": 0.0312}},
                "contextUsage": {"tokens": 1000, "contextWindow": 200000,
                                 "percent": 0.5},
                "children": []
            }"#,
    );
    assert_eq!(
        plain(&context_tree_rows(&tree, 120, ContextTreeScope::Collapsed)),
        vec![
            "Context",
            "",
            "  agent             tokens   cost  context",
            "\u{25cf} main agent          1.0k  $0.03  \u{2591}\u{2591}\u{2591}\u{2591}\u{2591}\u{2591}\u{2591}\u{2591}\u{2591}\u{2591} 1% (1.0k/200k)",
            "",
            "Total: 1.0k tokens \u{b7} $0.03",
            "",
            "Tokens",
            "Input: 900",
            "Output: 90",
            "Cache Write: 10",
            "Total: 1,000",
            "",
            "Cost",
            "Total: $0.0312",
            "",
            "Context",
            "Current: 1,000 / 200,000 (0.5%)",
        ]
    );
}

#[test]
fn context_tree_full_shape_matches_ts() {
    let tree = json(
        r#"{
                "id": "root", "label": "my session", "status": "active",
                "model": {"provider": "prime-inference", "id": "z-ai/glm-5.3"},
                "ownUsage": {"input": 1234567, "output": 2345, "cacheRead": 12345,
                             "cacheWrite": 678, "cost": {"total": 1.2345}},
                "totalUsage": {"input": 1234567, "output": 2345, "cacheRead": 12345,
                               "cacheWrite": 678, "cost": {"total": 1.2345}},
                "contextUsage": {"tokens": 1250000, "contextWindow": 131072,
                                 "percent": 95.42},
                "ownUsageByModel": [
                    {"provider": "prime-inference", "id": "z-ai/glm-5.3",
                     "ownUsage": {"input": 1234567, "output": 2345, "cacheRead": 12345,
                                  "cacheWrite": 678, "cost": {"total": 1.2345}}}
                ],
                "children": [
                    {"id": "sub-1", "label": "run the verifier suite for parity",
                     "status": "done",
                     "model": {"provider": "anthropic", "id": "claude-opus-4-6"},
                     "ownUsage": {"input": 500, "output": 60, "cacheRead": 0,
                                  "cacheWrite": 100, "cost": {"total": 0.009}},
                     "ownUsageByModel": [
                        {"provider": "anthropic", "id": "claude-opus-4-6",
                         "ownUsage": {"input": 500, "output": 60, "cacheRead": 0,
                                      "cacheWrite": 100, "cost": {"total": 0.009}}}
                     ],
                     "totalUsage": {"input": 500, "output": 60, "cacheRead": 0,
                                    "cacheWrite": 100, "cost": {"total": 0.009}},
                     "contextUsage": {"tokens": 600, "contextWindow": 131072,
                                      "percent": 0.4578},
                     "children": []},
                    {"id": "sub-2",
                     "label": "a very long child label that must truncate when the label column runs out of room",
                     "status": "running",
                     "ownUsage": {"input": 1200, "output": 300, "cacheRead": 0,
                                  "cacheWrite": 0, "cost": {"total": 0.02}},
                     "totalUsage": {"input": 1200, "output": 300, "cacheRead": 0,
                                    "cacheWrite": 0, "cost": {"total": 0.02}},
                     "children": [
                        {"id": "sub-3", "label": "grandkid", "status": "error",
                         "ownUsage": {"input": 5, "output": 6, "cacheRead": 0,
                                      "cacheWrite": 0, "cost": {"total": 0.0001}},
                         "totalUsage": {"input": 5, "output": 6, "cacheRead": 0,
                                        "cacheWrite": 0, "cost": {"total": 0.0001}},
                         "contextUsage": {"tokens": null, "contextWindow": 131072,
                                          "percent": null},
                         "children": []}
                     ]}
                ]
            }"#,
    );
    assert_eq!(
        plain(&context_tree_rows(&tree, 100, ContextTreeScope::Collapsed)),
        vec![
            "Context",
            "",
            "Model: prime-inference/z-ai/glm-5.3",
            "",
            "  agent                                         model            tokens   cost  context",
            "\u{25cf} my session                                    glm-5.3            1.2M  $1.23  \u{2593}\u{2593}\u{2593}\u{2593}\u{2593}\u{2593}\u{2593}\u{2593}\u{2593}\u{2593} 95% (1.2M/131k)",
            "\u{251c}\u{2500} \u{2713} run the verifier suite for parity          claude-opus-4-6     660  $0.01  0% (600/131k)",
            "\u{2514}\u{2500} \u{25c6} a very long child label that must tr...    -                  1.5k  $0.02  -",
            "   \u{2514}\u{2500} \u{2717} grandkid                                -                    11  $0.00  unknown after compaction",
            "",
            "Total: 1.3M tokens \u{b7} $1.26 across 4 agents",
            "",
            "Tokens",
            "Input: 1,236,272",
            "Output: 2,711",
            "Cache Read: 12,345",
            "Cache Write: 778",
            "Total: 1,252,106",
            "",
            "Cost",
            "Total: $1.2636",
            "",
            "Context",
            "Current: 1,250,000 / 131,072 (95.4%)",
        ]
    );
    // The per-model breakdown STAYS OFF here: the root and sub-1
    // carry buckets, but the two billed children without them would
    // leave lines that do not add up to the displayed total — a
    // partial breakdown degrades to the plain TS totals.
}

/// The operator's cost question end to end: a session that switches
/// models mid-conversation (sol -> opus, the switch's first request
/// re-caching the whole history) plus a subagent on a third model.
/// Every node's row carries its model, and the Cost section breaks
/// the total down per model, most expensive first. The fixture's
/// cost blocks are the provider-computed records (sol turn:
/// 100k\u{d7}$4/M + 2k\u{d7}$20/M = $0.44; the opus switch burst:
/// 5k\u{d7}$5/M + 1k\u{d7}$25/M + 104k cache-write\u{d7}$6.25/M =
/// $0.70; the opus cache-hit turn: 500\u{d7}$5/M + 800\u{d7}$25/M +
/// 110k cache-read\u{d7}$0.5/M = $0.0775; the glm subagent:
/// $0.023).
#[test]
fn context_tree_shows_per_model_costs_across_a_switch() {
    let tree = json(
        r#"{
                "id": "root", "label": "switched session", "status": "active",
                "model": {"provider": "anthropic", "id": "claude-opus-4-6"},
                "ownUsage": {"input": 105500, "output": 3800, "cacheRead": 110000,
                             "cacheWrite": 104000, "totalTokens": 221700,
                             "cost": {"total": 1.2175}},
                "ownUsageByModel": [
                    {"provider": "openai", "id": "gpt-5.6-sol",
                     "ownUsage": {"input": 100000, "output": 2000, "cacheRead": 0,
                                  "cacheWrite": 0, "totalTokens": 1200,
                                  "cost": {"total": 0.44}}},
                    {"provider": "anthropic", "id": "claude-opus-4-6",
                     "ownUsage": {"input": 5500, "output": 1800, "cacheRead": 110000,
                                  "cacheWrite": 104000, "totalTokens": 220500,
                                  "cost": {"total": 0.7775}}}
                ],
                "contextUsage": {"tokens": 221000, "contextWindow": 1000000,
                                 "percent": 22.1},
                "children": [
                    {"id": "sub-1", "label": "scan the pricing tables", "status": "done",
                     "model": {"provider": "prime-inference", "id": "internal/glm-5.3-fast"},
                     "ownUsage": {"input": 1000, "output": 400, "cacheRead": 0,
                                  "cacheWrite": 0, "totalTokens": 1400,
                                  "cost": {"total": 0.023}},
                     "ownUsageByModel": [
                        {"provider": "prime-inference", "id": "internal/glm-5.3-fast",
                         "ownUsage": {"input": 1000, "output": 400, "cacheRead": 0,
                                      "cacheWrite": 0, "totalTokens": 1400,
                                      "cost": {"total": 0.023}}}
                     ],
                     "children": []}
                ]
            }"#,
    );
    assert_eq!(
        plain(&context_tree_rows(&tree, 120, ContextTreeScope::Collapsed)),
        vec![
            "Context",
            "",
            "Model: anthropic/claude-opus-4-6",
            "",
            "  agent                         model            tokens   cost  context",
            "\u{25cf} switched session              claude-opus-4-6    323k  $1.22  \u{2593}\u{2593}\u{2591}\u{2591}\u{2591}\u{2591}\u{2591}\u{2591}\u{2591}\u{2591} 22% (221k/1.0M)",
            "\u{2514}\u{2500} \u{2713} scan the pricing tables    glm-5.3-fast       1.4k  $0.02  -",
            "",
            "Total: 325k tokens \u{b7} $1.24 across 2 agents",
            "",
            "Tokens",
            "Input: 106,500",
            "Output: 4,200",
            "Cache Read: 110,000",
            "Cache Write: 104,000",
            "Total: 324,700",
            "",
            "Cost",
            "Total: $1.2405",
            "anthropic/claude-opus-4-6: $0.7775",
            "openai/gpt-5.6-sol: $0.4400",
            "prime-inference/internal/glm-5.3-fast: $0.0230",
            "",
            "Context",
            "Current: 221,000 / 1,000,000 (22.1%)",
        ]
    );
}

#[test]
fn context_bar_color_follows_the_percent() {
    let tree = json(
        r#"{
                "id": "root", "label": "main", "status": "active",
                "ownUsage": {"input": 1, "output": 0, "cacheRead": 0,
                             "cacheWrite": 0, "cost": {"total": 0}},
                "contextUsage": {"tokens": 90, "contextWindow": 100, "percent": 85.0},
                "children": []
            }"#,
    );
    let rows = context_tree_rows(&tree, 120, ContextTreeScope::Collapsed);
    // The root row carries the bar: warning at >= 80 percent.
    let bar = rows[3]
        .iter()
        .find(|span| span.text.contains("\u{2593}"))
        .expect("the bar cell");
    assert_eq!(bar.color, Some(ThemeColor::Warning));
    // Under 80 the bar is the accent color (fixture A covers it at
    // 0.5 percent); the token cells are default-foreground.
}

/// The collapse boundary: a tree of exactly the row budget (root + 9
/// runners) renders the full TS shape — every row in tree order, no
/// summary row, no expand hint. The runner usages are deliberately
/// unsorted, so a leaked ranking would reorder the rows.
#[test]
fn context_tree_ten_rows_render_the_full_shape() {
    let tree = json(
        r#"{
                "id": "root", "label": "fleet lead", "status": "active",
                "model": {"provider": "prime-inference", "id": "z-ai/glm-5.3"},
                "ownUsage": {"input": 9000, "output": 900, "cacheRead": 0,
                             "cacheWrite": 100, "cost": {"total": 0.5}},
                "totalUsage": {"input": 13500, "output": 900, "cacheRead": 0,
                               "cacheWrite": 100, "cost": {"total": 0.5}},
                "contextUsage": {"tokens": 12000, "contextWindow": 200000,
                                 "percent": 6.0},
                "children": [
                    {"id": "runner-1", "label": "runner-1", "status": "done",
                     "ownUsage": {"input": 300, "output": 0, "cacheRead": 0,
                                  "cacheWrite": 0, "cost": {"total": 0.0}},
                     "totalUsage": {"input": 300, "output": 0, "cacheRead": 0,
                                    "cacheWrite": 0, "cost": {"total": 0.0}},
                     "children": []},
                    {"id": "runner-2", "label": "runner-2", "status": "done",
                     "ownUsage": {"input": 100, "output": 0, "cacheRead": 0,
                                  "cacheWrite": 0, "cost": {"total": 0.0}},
                     "totalUsage": {"input": 100, "output": 0, "cacheRead": 0,
                                    "cacheWrite": 0, "cost": {"total": 0.0}},
                     "children": []},
                    {"id": "runner-3", "label": "runner-3", "status": "done",
                     "ownUsage": {"input": 500, "output": 0, "cacheRead": 0,
                                  "cacheWrite": 0, "cost": {"total": 0.0}},
                     "totalUsage": {"input": 500, "output": 0, "cacheRead": 0,
                                    "cacheWrite": 0, "cost": {"total": 0.0}},
                     "children": []},
                    {"id": "runner-4", "label": "runner-4", "status": "done",
                     "ownUsage": {"input": 200, "output": 0, "cacheRead": 0,
                                  "cacheWrite": 0, "cost": {"total": 0.0}},
                     "totalUsage": {"input": 200, "output": 0, "cacheRead": 0,
                                    "cacheWrite": 0, "cost": {"total": 0.0}},
                     "children": []},
                    {"id": "runner-5", "label": "runner-5", "status": "done",
                     "ownUsage": {"input": 900, "output": 0, "cacheRead": 0,
                                  "cacheWrite": 0, "cost": {"total": 0.0}},
                     "totalUsage": {"input": 900, "output": 0, "cacheRead": 0,
                                    "cacheWrite": 0, "cost": {"total": 0.0}},
                     "children": []},
                    {"id": "runner-6", "label": "runner-6", "status": "done",
                     "ownUsage": {"input": 400, "output": 0, "cacheRead": 0,
                                  "cacheWrite": 0, "cost": {"total": 0.0}},
                     "totalUsage": {"input": 400, "output": 0, "cacheRead": 0,
                                    "cacheWrite": 0, "cost": {"total": 0.0}},
                     "children": []},
                    {"id": "runner-7", "label": "runner-7", "status": "done",
                     "ownUsage": {"input": 700, "output": 0, "cacheRead": 0,
                                  "cacheWrite": 0, "cost": {"total": 0.0}},
                     "totalUsage": {"input": 700, "output": 0, "cacheRead": 0,
                                    "cacheWrite": 0, "cost": {"total": 0.0}},
                     "children": []},
                    {"id": "runner-8", "label": "runner-8", "status": "done",
                     "ownUsage": {"input": 600, "output": 0, "cacheRead": 0,
                                  "cacheWrite": 0, "cost": {"total": 0.0}},
                     "totalUsage": {"input": 600, "output": 0, "cacheRead": 0,
                                    "cacheWrite": 0, "cost": {"total": 0.0}},
                     "children": []},
                    {"id": "runner-9", "label": "runner-9", "status": "done",
                     "ownUsage": {"input": 800, "output": 0, "cacheRead": 0,
                                  "cacheWrite": 0, "cost": {"total": 0.0}},
                     "totalUsage": {"input": 800, "output": 0, "cacheRead": 0,
                                    "cacheWrite": 0, "cost": {"total": 0.0}},
                     "children": []}
                ]
            }"#,
    );
    assert_eq!(
        plain(&context_tree_rows(&tree, 120, ContextTreeScope::Collapsed)),
        vec![
            "Context",
            "",
            "Model: prime-inference/z-ai/glm-5.3",
            "",
            "  agent             model    tokens   cost  context",
            "\u{25cf} fleet lead        glm-5.3     10k  $0.50  \u{2593}\u{2591}\u{2591}\u{2591}\u{2591}\u{2591}\u{2591}\u{2591}\u{2591}\u{2591} 6% (12k/200k)",
            "\u{251c}\u{2500} \u{2713} runner-1       -           300  $0.00  -",
            "\u{251c}\u{2500} \u{2713} runner-2       -           100  $0.00  -",
            "\u{251c}\u{2500} \u{2713} runner-3       -           500  $0.00  -",
            "\u{251c}\u{2500} \u{2713} runner-4       -           200  $0.00  -",
            "\u{251c}\u{2500} \u{2713} runner-5       -           900  $0.00  -",
            "\u{251c}\u{2500} \u{2713} runner-6       -           400  $0.00  -",
            "\u{251c}\u{2500} \u{2713} runner-7       -           700  $0.00  -",
            "\u{251c}\u{2500} \u{2713} runner-8       -           600  $0.00  -",
            "\u{2514}\u{2500} \u{2713} runner-9       -           800  $0.00  -",
            "",
            "Total: 15k tokens \u{b7} $0.50 across 10 agents",
            "",
            "Tokens",
            "Input: 13,500",
            "Output: 900",
            "Cache Write: 100",
            "Total: 14,500",
            "",
            "Cost",
            "Total: $0.5000",
            "",
            "Context",
            "Current: 12,000 / 200,000 (6%)"
        ]
    );
}

/// The collapsed shape: a fleet tree of 13 agent rows (root + 12
/// workers) renders its ten highest-usage rows — the root first, then
/// the workers by own spend — folds the three cheapest into the `...`
/// summary row (their spend fills the token and cost cells, so the
/// table still adds up), and names the `/context all` command that
/// renders the whole tree. The trailing totals still cover all 13
/// agents.
#[test]
fn context_tree_collapses_over_the_budget_to_top_usage_rows() {
    let tree = json(
        r#"{
                "id": "root", "label": "fleet lead", "status": "active",
                "model": {"provider": "prime-inference", "id": "z-ai/glm-5.3"},
                "ownUsage": {"input": 90000, "output": 9000, "cacheRead": 0,
                             "cacheWrite": 1000, "cost": {"total": 0.9}},
                "totalUsage": {"input": 131300, "output": 9000, "cacheRead": 0,
                               "cacheWrite": 1000, "cost": {"total": 1.313}},
                "contextUsage": {"tokens": 100000, "contextWindow": 200000,
                                 "percent": 50.0},
                "children": [
                    {"id": "worker-01", "label": "worker-01", "status": "done",
                     "ownUsage": {"input": 1200, "output": 0, "cacheRead": 0,
                                  "cacheWrite": 0, "cost": {"total": 0.012}},
                     "totalUsage": {"input": 1200, "output": 0, "cacheRead": 0,
                                   "cacheWrite": 0, "cost": {"total": 0.012}},
                     "children": []},
                    {"id": "worker-02", "label": "worker-02", "status": "done",
                     "ownUsage": {"input": 3000, "output": 0, "cacheRead": 0,
                                  "cacheWrite": 0, "cost": {"total": 0.03}},
                     "totalUsage": {"input": 3000, "output": 0, "cacheRead": 0,
                                   "cacheWrite": 0, "cost": {"total": 0.03}},
                     "children": []},
                    {"id": "worker-03", "label": "worker-03", "status": "done",
                     "ownUsage": {"input": 500, "output": 0, "cacheRead": 0,
                                  "cacheWrite": 0, "cost": {"total": 0.005}},
                     "totalUsage": {"input": 500, "output": 0, "cacheRead": 0,
                                   "cacheWrite": 0, "cost": {"total": 0.005}},
                     "children": []},
                    {"id": "worker-04", "label": "worker-04", "status": "done",
                     "ownUsage": {"input": 2400, "output": 0, "cacheRead": 0,
                                  "cacheWrite": 0, "cost": {"total": 0.024}},
                     "totalUsage": {"input": 2400, "output": 0, "cacheRead": 0,
                                   "cacheWrite": 0, "cost": {"total": 0.024}},
                     "children": []},
                    {"id": "worker-05", "label": "worker-05", "status": "done",
                     "ownUsage": {"input": 900, "output": 0, "cacheRead": 0,
                                  "cacheWrite": 0, "cost": {"total": 0.009}},
                     "totalUsage": {"input": 900, "output": 0, "cacheRead": 0,
                                   "cacheWrite": 0, "cost": {"total": 0.009}},
                     "children": []},
                    {"id": "worker-06", "label": "worker-06", "status": "running",
                     "ownUsage": {"input": 6000, "output": 0, "cacheRead": 0,
                                  "cacheWrite": 0, "cost": {"total": 0.06}},
                     "totalUsage": {"input": 6000, "output": 0, "cacheRead": 0,
                                   "cacheWrite": 0, "cost": {"total": 0.06}},
                     "children": []},
                    {"id": "worker-07", "label": "worker-07", "status": "done",
                     "ownUsage": {"input": 100, "output": 0, "cacheRead": 0,
                                  "cacheWrite": 0, "cost": {"total": 0.001}},
                     "totalUsage": {"input": 100, "output": 0, "cacheRead": 0,
                                   "cacheWrite": 0, "cost": {"total": 0.001}},
                     "children": []},
                    {"id": "worker-08", "label": "worker-08", "status": "done",
                     "ownUsage": {"input": 4200, "output": 0, "cacheRead": 0,
                                  "cacheWrite": 0, "cost": {"total": 0.042}},
                     "totalUsage": {"input": 4200, "output": 0, "cacheRead": 0,
                                   "cacheWrite": 0, "cost": {"total": 0.042}},
                     "children": []},
                    {"id": "worker-09", "label": "worker-09", "status": "done",
                     "ownUsage": {"input": 800, "output": 0, "cacheRead": 0,
                                  "cacheWrite": 0, "cost": {"total": 0.008}},
                     "totalUsage": {"input": 800, "output": 0, "cacheRead": 0,
                                   "cacheWrite": 0, "cost": {"total": 0.008}},
                     "children": []},
                    {"id": "worker-10", "label": "worker-10", "status": "done",
                     "ownUsage": {"input": 1500, "output": 0, "cacheRead": 0,
                                  "cacheWrite": 0, "cost": {"total": 0.015}},
                     "totalUsage": {"input": 1500, "output": 0, "cacheRead": 0,
                                   "cacheWrite": 0, "cost": {"total": 0.015}},
                     "children": []},
                    {"id": "worker-11", "label": "worker-11", "status": "done",
                     "ownUsage": {"input": 700, "output": 0, "cacheRead": 0,
                                  "cacheWrite": 0, "cost": {"total": 0.007}},
                     "totalUsage": {"input": 700, "output": 0, "cacheRead": 0,
                                   "cacheWrite": 0, "cost": {"total": 0.007}},
                     "children": []},
                    {"id": "worker-12", "label": "worker-12", "status": "done",
                     "model": {"provider": "prime-inference", "id": "glm-5.3-fast"},
                     "ownUsage": {"input": 20000, "output": 0, "cacheRead": 0,
                                  "cacheWrite": 0, "cost": {"total": 0.2}},
                     "totalUsage": {"input": 20000, "output": 0, "cacheRead": 0,
                                   "cacheWrite": 0, "cost": {"total": 0.2}},
                     "children": []}
                ]
            }"#,
    );
    assert_eq!(
        plain(&context_tree_rows(&tree, 120, ContextTreeScope::Collapsed)),
        vec![
            "Context",
            "",
            "Model: prime-inference/z-ai/glm-5.3",
            "",
            "  agent             model         tokens   cost  context",
            "\u{25cf} fleet lead        glm-5.3         100k  $0.90  \u{2593}\u{2593}\u{2593}\u{2593}\u{2593}\u{2591}\u{2591}\u{2591}\u{2591}\u{2591} 50% (100k/200k)",
            "\u{2514}\u{2500} \u{2713} worker-12      glm-5.3-fast     20k  $0.20  -",
            "\u{251c}\u{2500} \u{25c6} worker-06      -               6.0k  $0.06  -",
            "\u{251c}\u{2500} \u{2713} worker-08      -               4.2k  $0.04  -",
            "\u{251c}\u{2500} \u{2713} worker-02      -               3.0k  $0.03  -",
            "\u{251c}\u{2500} \u{2713} worker-04      -               2.4k  $0.02  -",
            "\u{251c}\u{2500} \u{2713} worker-10      -               1.5k  $0.01  -",
            "\u{251c}\u{2500} \u{2713} worker-01      -               1.2k  $0.01  -",
            "\u{251c}\u{2500} \u{2713} worker-05      -                900  $0.01  -",
            "\u{251c}\u{2500} \u{2713} worker-09      -                800  $0.01  -",
            "... 3 more agents   -               1.3k  $0.01  -",
            "Use /context all to show every agent.",
            "",
            "Total: 141k tokens \u{b7} $1.31 across 13 agents",
            "",
            "Tokens",
            "Input: 131,300",
            "Output: 9,000",
            "Cache Write: 1,000",
            "Total: 141,300",
            "",
            "Cost",
            "Total: $1.3130",
            "",
            "Context",
            "Current: 100,000 / 200,000 (50%)"
        ]
    );
}

/// The expanded shape (`/context all`): the same 13-agent tree renders
/// every row in tree order — no ranking, no summary row, no hint.
#[test]
fn context_tree_all_renders_every_row() {
    let tree = json(
        r#"{
                "id": "root", "label": "fleet lead", "status": "active",
                "model": {"provider": "prime-inference", "id": "z-ai/glm-5.3"},
                "ownUsage": {"input": 90000, "output": 9000, "cacheRead": 0,
                             "cacheWrite": 1000, "cost": {"total": 0.9}},
                "totalUsage": {"input": 131300, "output": 9000, "cacheRead": 0,
                               "cacheWrite": 1000, "cost": {"total": 1.313}},
                "contextUsage": {"tokens": 100000, "contextWindow": 200000,
                                 "percent": 50.0},
                "children": [
                    {"id": "worker-01", "label": "worker-01", "status": "done",
                     "ownUsage": {"input": 1200, "output": 0, "cacheRead": 0,
                                  "cacheWrite": 0, "cost": {"total": 0.012}},
                     "totalUsage": {"input": 1200, "output": 0, "cacheRead": 0,
                                   "cacheWrite": 0, "cost": {"total": 0.012}},
                     "children": []},
                    {"id": "worker-02", "label": "worker-02", "status": "done",
                     "ownUsage": {"input": 3000, "output": 0, "cacheRead": 0,
                                  "cacheWrite": 0, "cost": {"total": 0.03}},
                     "totalUsage": {"input": 3000, "output": 0, "cacheRead": 0,
                                   "cacheWrite": 0, "cost": {"total": 0.03}},
                     "children": []},
                    {"id": "worker-03", "label": "worker-03", "status": "done",
                     "ownUsage": {"input": 500, "output": 0, "cacheRead": 0,
                                  "cacheWrite": 0, "cost": {"total": 0.005}},
                     "totalUsage": {"input": 500, "output": 0, "cacheRead": 0,
                                   "cacheWrite": 0, "cost": {"total": 0.005}},
                     "children": []},
                    {"id": "worker-04", "label": "worker-04", "status": "done",
                     "ownUsage": {"input": 2400, "output": 0, "cacheRead": 0,
                                  "cacheWrite": 0, "cost": {"total": 0.024}},
                     "totalUsage": {"input": 2400, "output": 0, "cacheRead": 0,
                                   "cacheWrite": 0, "cost": {"total": 0.024}},
                     "children": []},
                    {"id": "worker-05", "label": "worker-05", "status": "done",
                     "ownUsage": {"input": 900, "output": 0, "cacheRead": 0,
                                  "cacheWrite": 0, "cost": {"total": 0.009}},
                     "totalUsage": {"input": 900, "output": 0, "cacheRead": 0,
                                   "cacheWrite": 0, "cost": {"total": 0.009}},
                     "children": []},
                    {"id": "worker-06", "label": "worker-06", "status": "running",
                     "ownUsage": {"input": 6000, "output": 0, "cacheRead": 0,
                                  "cacheWrite": 0, "cost": {"total": 0.06}},
                     "totalUsage": {"input": 6000, "output": 0, "cacheRead": 0,
                                   "cacheWrite": 0, "cost": {"total": 0.06}},
                     "children": []},
                    {"id": "worker-07", "label": "worker-07", "status": "done",
                     "ownUsage": {"input": 100, "output": 0, "cacheRead": 0,
                                  "cacheWrite": 0, "cost": {"total": 0.001}},
                     "totalUsage": {"input": 100, "output": 0, "cacheRead": 0,
                                   "cacheWrite": 0, "cost": {"total": 0.001}},
                     "children": []},
                    {"id": "worker-08", "label": "worker-08", "status": "done",
                     "ownUsage": {"input": 4200, "output": 0, "cacheRead": 0,
                                  "cacheWrite": 0, "cost": {"total": 0.042}},
                     "totalUsage": {"input": 4200, "output": 0, "cacheRead": 0,
                                   "cacheWrite": 0, "cost": {"total": 0.042}},
                     "children": []},
                    {"id": "worker-09", "label": "worker-09", "status": "done",
                     "ownUsage": {"input": 800, "output": 0, "cacheRead": 0,
                                  "cacheWrite": 0, "cost": {"total": 0.008}},
                     "totalUsage": {"input": 800, "output": 0, "cacheRead": 0,
                                   "cacheWrite": 0, "cost": {"total": 0.008}},
                     "children": []},
                    {"id": "worker-10", "label": "worker-10", "status": "done",
                     "ownUsage": {"input": 1500, "output": 0, "cacheRead": 0,
                                  "cacheWrite": 0, "cost": {"total": 0.015}},
                     "totalUsage": {"input": 1500, "output": 0, "cacheRead": 0,
                                   "cacheWrite": 0, "cost": {"total": 0.015}},
                     "children": []},
                    {"id": "worker-11", "label": "worker-11", "status": "done",
                     "ownUsage": {"input": 700, "output": 0, "cacheRead": 0,
                                  "cacheWrite": 0, "cost": {"total": 0.007}},
                     "totalUsage": {"input": 700, "output": 0, "cacheRead": 0,
                                   "cacheWrite": 0, "cost": {"total": 0.007}},
                     "children": []},
                    {"id": "worker-12", "label": "worker-12", "status": "done",
                     "model": {"provider": "prime-inference", "id": "glm-5.3-fast"},
                     "ownUsage": {"input": 20000, "output": 0, "cacheRead": 0,
                                  "cacheWrite": 0, "cost": {"total": 0.2}},
                     "totalUsage": {"input": 20000, "output": 0, "cacheRead": 0,
                                   "cacheWrite": 0, "cost": {"total": 0.2}},
                     "children": []}
                ]
            }"#,
    );
    assert_eq!(
        plain(&context_tree_rows(&tree, 120, ContextTreeScope::EveryAgent)),
        vec![
            "Context",
            "",
            "Model: prime-inference/z-ai/glm-5.3",
            "",
            "  agent             model         tokens   cost  context",
            "\u{25cf} fleet lead        glm-5.3         100k  $0.90  \u{2593}\u{2593}\u{2593}\u{2593}\u{2593}\u{2591}\u{2591}\u{2591}\u{2591}\u{2591} 50% (100k/200k)",
            "\u{251c}\u{2500} \u{2713} worker-01      -               1.2k  $0.01  -",
            "\u{251c}\u{2500} \u{2713} worker-02      -               3.0k  $0.03  -",
            "\u{251c}\u{2500} \u{2713} worker-03      -                500  $0.01  -",
            "\u{251c}\u{2500} \u{2713} worker-04      -               2.4k  $0.02  -",
            "\u{251c}\u{2500} \u{2713} worker-05      -                900  $0.01  -",
            "\u{251c}\u{2500} \u{25c6} worker-06      -               6.0k  $0.06  -",
            "\u{251c}\u{2500} \u{2713} worker-07      -                100  $0.00  -",
            "\u{251c}\u{2500} \u{2713} worker-08      -               4.2k  $0.04  -",
            "\u{251c}\u{2500} \u{2713} worker-09      -                800  $0.01  -",
            "\u{251c}\u{2500} \u{2713} worker-10      -               1.5k  $0.01  -",
            "\u{251c}\u{2500} \u{2713} worker-11      -                700  $0.01  -",
            "\u{2514}\u{2500} \u{2713} worker-12      glm-5.3-fast     20k  $0.20  -",
            "",
            "Total: 141k tokens \u{b7} $1.31 across 13 agents",
            "",
            "Tokens",
            "Input: 131,300",
            "Output: 9,000",
            "Cache Write: 1,000",
            "Total: 141,300",
            "",
            "Cost",
            "Total: $1.3130",
            "",
            "Context",
            "Current: 100,000 / 200,000 (50%)"
        ]
    );
}

/// The ranking is pure spend: an orchestrator that offloaded everything
/// to 10 scouts falls out of its own top rows. The summary row folds the
/// root in ("1 more agent"), the utilization bar leaves the table with
/// it, and the trailing `Context` section still reports the root's
/// window.
#[test]
fn context_tree_collapse_can_fold_the_root_into_the_summary() {
    let tree = json(
        r#"{
                "id": "root", "label": "orchestrator", "status": "active",
                "ownUsage": {"input": 50, "output": 0, "cacheRead": 0,
                             "cacheWrite": 0, "cost": {"total": 0.0}},
                "totalUsage": {"input": 15550, "output": 0, "cacheRead": 0,
                               "cacheWrite": 0, "cost": {"total": 0.0}},
                "contextUsage": {"tokens": 5000, "contextWindow": 200000,
                                 "percent": 2.5},
                "children": [
                    {"id": "scout-01", "label": "scout-01", "status": "done",
                     "ownUsage": {"input": 2000, "output": 0, "cacheRead": 0,
                                  "cacheWrite": 0, "cost": {"total": 0.0}},
                     "totalUsage": {"input": 2000, "output": 0, "cacheRead": 0,
                                   "cacheWrite": 0, "cost": {"total": 0.0}},
                     "children": []},
                    {"id": "scout-02", "label": "scout-02", "status": "done",
                     "ownUsage": {"input": 1900, "output": 0, "cacheRead": 0,
                                  "cacheWrite": 0, "cost": {"total": 0.0}},
                     "totalUsage": {"input": 1900, "output": 0, "cacheRead": 0,
                                   "cacheWrite": 0, "cost": {"total": 0.0}},
                     "children": []},
                    {"id": "scout-03", "label": "scout-03", "status": "done",
                     "ownUsage": {"input": 1800, "output": 0, "cacheRead": 0,
                                  "cacheWrite": 0, "cost": {"total": 0.0}},
                     "totalUsage": {"input": 1800, "output": 0, "cacheRead": 0,
                                   "cacheWrite": 0, "cost": {"total": 0.0}},
                     "children": []},
                    {"id": "scout-04", "label": "scout-04", "status": "done",
                     "ownUsage": {"input": 1700, "output": 0, "cacheRead": 0,
                                  "cacheWrite": 0, "cost": {"total": 0.0}},
                     "totalUsage": {"input": 1700, "output": 0, "cacheRead": 0,
                                   "cacheWrite": 0, "cost": {"total": 0.0}},
                     "children": []},
                    {"id": "scout-05", "label": "scout-05", "status": "done",
                     "ownUsage": {"input": 1600, "output": 0, "cacheRead": 0,
                                  "cacheWrite": 0, "cost": {"total": 0.0}},
                     "totalUsage": {"input": 1600, "output": 0, "cacheRead": 0,
                                   "cacheWrite": 0, "cost": {"total": 0.0}},
                     "children": []},
                    {"id": "scout-06", "label": "scout-06", "status": "done",
                     "ownUsage": {"input": 1500, "output": 0, "cacheRead": 0,
                                  "cacheWrite": 0, "cost": {"total": 0.0}},
                     "totalUsage": {"input": 1500, "output": 0, "cacheRead": 0,
                                   "cacheWrite": 0, "cost": {"total": 0.0}},
                     "children": []},
                    {"id": "scout-07", "label": "scout-07", "status": "done",
                     "ownUsage": {"input": 1400, "output": 0, "cacheRead": 0,
                                  "cacheWrite": 0, "cost": {"total": 0.0}},
                     "totalUsage": {"input": 1400, "output": 0, "cacheRead": 0,
                                   "cacheWrite": 0, "cost": {"total": 0.0}},
                     "children": []},
                    {"id": "scout-08", "label": "scout-08", "status": "done",
                     "ownUsage": {"input": 1300, "output": 0, "cacheRead": 0,
                                  "cacheWrite": 0, "cost": {"total": 0.0}},
                     "totalUsage": {"input": 1300, "output": 0, "cacheRead": 0,
                                   "cacheWrite": 0, "cost": {"total": 0.0}},
                     "children": []},
                    {"id": "scout-09", "label": "scout-09", "status": "done",
                     "ownUsage": {"input": 1200, "output": 0, "cacheRead": 0,
                                  "cacheWrite": 0, "cost": {"total": 0.0}},
                     "totalUsage": {"input": 1200, "output": 0, "cacheRead": 0,
                                   "cacheWrite": 0, "cost": {"total": 0.0}},
                     "children": []},
                    {"id": "scout-10", "label": "scout-10", "status": "done",
                     "ownUsage": {"input": 1100, "output": 0, "cacheRead": 0,
                                  "cacheWrite": 0, "cost": {"total": 0.0}},
                     "totalUsage": {"input": 1100, "output": 0, "cacheRead": 0,
                                   "cacheWrite": 0, "cost": {"total": 0.0}},
                     "children": []}
                ]
            }"#,
    );
    assert_eq!(
        plain(&context_tree_rows(&tree, 120, ContextTreeScope::Collapsed)),
        vec![
            "Context",
            "",
            "  agent             tokens   cost  context",
            "\u{251c}\u{2500} \u{2713} scout-01         2.0k  $0.00  -",
            "\u{251c}\u{2500} \u{2713} scout-02         1.9k  $0.00  -",
            "\u{251c}\u{2500} \u{2713} scout-03         1.8k  $0.00  -",
            "\u{251c}\u{2500} \u{2713} scout-04         1.7k  $0.00  -",
            "\u{251c}\u{2500} \u{2713} scout-05         1.6k  $0.00  -",
            "\u{251c}\u{2500} \u{2713} scout-06         1.5k  $0.00  -",
            "\u{251c}\u{2500} \u{2713} scout-07         1.4k  $0.00  -",
            "\u{251c}\u{2500} \u{2713} scout-08         1.3k  $0.00  -",
            "\u{251c}\u{2500} \u{2713} scout-09         1.2k  $0.00  -",
            "\u{2514}\u{2500} \u{2713} scout-10         1.1k  $0.00  -",
            "... 1 more agent        50  $0.00  -",
            "Use /context all to show every agent.",
            "",
            "Total: 16k tokens \u{b7} $0.00 across 11 agents",
            "",
            "Tokens",
            "Input: 15,550",
            "Output: 0",
            "Total: 15,550",
            "",
            "Context",
            "Current: 5,000 / 200,000 (2.5%)"
        ]
    );
}

#[test]
fn client_text_renders_spacer_then_margined_rows() {
    let theme = crate::theme::Theme::builtin("prime", crate::theme::ColorMode::TrueColor);
    let rows = render_client_text(
        &[
            vec![raw_span("one"), dim(" two")],
            vec![],
            vec![raw_span("three")],
        ],
        &theme,
        10,
    );
    // Spacer(1), then Text(1, 0): one leading margin column, padded to
    // the full width; a blank source line is a full-width blank row.
    let text: Vec<String> = rows
        .iter()
        .map(|row| row.iter().map(|span| span.content.as_str()).collect())
        .collect();
    assert_eq!(text, vec!["", " one two  ", "          ", " three    "]);
}

#[test]
fn client_text_wraps_long_rows_at_the_content_width() {
    let theme = crate::theme::Theme::builtin("prime", crate::theme::ColorMode::TrueColor);
    let rows = render_client_text(&[vec![raw_span("aaaa bb cc")]], &theme, 8);
    let text: Vec<String> = rows
        .iter()
        .map(|row| row.iter().map(|span| span.content.as_str()).collect())
        .collect();
    // Content width 6: the wrapped rows keep the one-column margins
    // and pad to the full width.
    assert_eq!(text, vec!["", " aaaa   ", " bb cc  "]);
}

#[test]
fn js_to_fixed_matches_the_js_rounding() {
    // Half-away-from-zero on the decimal expansion (Rust's {:.1} would
    // round 0.25 to 0.2; JS toFixed gives 0.3).
    assert_eq!(js_to_fixed(0.25, 1), "0.3");
    assert_eq!(js_to_fixed(0.5, 1), "0.5");
    assert_eq!(js_to_fixed(1.005, 2), "1.00");
    assert_eq!(js_to_fixed(2.675, 2), "2.67");
    assert_eq!(js_to_fixed(1.2345, 4), "1.2345");
    assert_eq!(js_to_fixed(1.0, 2), "1.00");
}

#[test]
fn grouped_matches_to_locale_string() {
    assert_eq!(grouped(0), "0");
    assert_eq!(grouped(999), "999");
    assert_eq!(grouped(1234), "1,234");
    assert_eq!(grouped(12_345_678), "12,345,678");
}

#[test]
fn truncate_plain_matches_truncate_to_width() {
    assert_eq!(truncate_plain("short", 10), "short");
    assert_eq!(truncate_plain("truncate me", 8), "trunc...");
    // The ellipsis clips when the width cannot hold it.
    assert_eq!(truncate_plain("abcdef", 2), "..");
    assert_eq!(truncate_plain("abcdef", 1), ".");
}
