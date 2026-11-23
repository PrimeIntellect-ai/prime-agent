use super::*;
use crate::theme::ColorMode;
use serde_json::json;

fn theme() -> Theme {
    Theme::builtin("prime", ColorMode::TrueColor)
}

fn kb() -> KeybindingsManager {
    KeybindingsManager::new()
}

fn plain(rows: &[Line]) -> String {
    rows.iter()
        .map(|row| {
            row.iter()
                .map(|span| span.content.as_str())
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn machine(name: &str, source: &str, kind: &str) -> LibraryMachine {
    LibraryMachine {
        name: name.to_string(),
        description: format!("The {name} machine."),
        source: source.to_string(),
        kind: kind.to_string(),
    }
}

/// One overview row in the lane's wire shape: the graph snapshot the run
/// parser reads, plus the owner/source wrapper. The daemon's live-cache
/// rows carry the peek lane's `armed` marker (null for an executing
/// run) — the page routes an owned row's Enter by it.
fn overview_row(id: &str, spec: &str, state: &str, owner: &str, owner_name: &str) -> Value {
    json!({"runId": id, "specId": spec, "name": spec, "state": state, "elapsedMs": 90_000,
           "machine": {"states": [], "transitions": [], "order": []}, "nodes": [],
           "ownerId": owner, "ownerName": owner_name, "saved": false, "armed": null})
}

/// The attached session's own rows: `rsi` has one live run, `adhoc` is a
/// stored spec no library machine carries.
fn runs() -> Vec<LibraryRun> {
    parse_overview_runs(&json!({"runs": [
        overview_row("run-1", "rsi", "running", "sess-1", ""),
        overview_row("run-2", "adhoc", "paused", "sess-1", ""),
    ]}))
}

/// The list reply's wire shape, one row malformed; `kind` defaults to a
/// file for an older kernel's rows.
#[test]
fn the_list_parses_machines_kinds_and_warnings() {
    let data = json!({
        "machines": [
            {"name": "rsi", "description": "Take a task to a PR.", "source": "user", "kind": "directory"},
            {"name": "builder", "description": "Builds.", "source": "repo"},
            {"description": "a row with no name"},
        ],
        "warnings": ["/m/broken: machine.toml: format: missing"],
    });
    assert!(library_reply_lists_machines(&data));
    assert_eq!(
        parse_library_machines(&data),
        vec![
            LibraryMachine {
                name: "rsi".to_string(),
                description: "Take a task to a PR.".to_string(),
                source: "user".to_string(),
                kind: "directory".to_string(),
            },
            LibraryMachine {
                name: "builder".to_string(),
                description: "Builds.".to_string(),
                source: "repo".to_string(),
                kind: "file".to_string(),
            },
        ]
    );
    assert_eq!(
        parse_library_warnings(&data),
        ["/m/broken: machine.toml: format: missing"]
    );
    assert!(!library_reply_lists_machines(&json!({"runs": []})));
}

/// Machines list with their runs nested under them, the agents view's
/// shape; runs of specs no machine carries list in their own group.
#[test]
fn runs_nest_under_their_machine_and_stored_specs_group_last() {
    let mut view = LibraryView::new(runs(), vec!["sess-1".to_string()], 30);
    let loading = plain(&view.render(&theme(), 120, &kb()));
    assert!(loading.contains("Loading the machine library"), "{loading}");
    view.apply_machines(
        vec![
            machine("builder", "repo", "file"),
            machine("rsi", "user", "directory"),
        ],
        vec!["/m/broken: bad".to_string()],
    );
    let text = plain(&view.render(&theme(), 120, &kb()));
    let lines: Vec<&str> = text.lines().collect();
    assert_eq!(lines[0], "  machines · 2 · 2 live runs");
    // The live machine paints first (the page opens on it), its runs
    // nested under it; the blank separator, then the quiet machine.
    assert_eq!(lines[2], "  ▸ ◈ rsi [user dir] ● 1 live — The rsi machine.");
    assert_eq!(lines[3], "      ↳ rsi · sess-1 · running · 1m30s");
    assert_eq!(lines[4], "");
    assert_eq!(lines[5], "    • builder [repo] — The builder machine.");
    assert_eq!(lines[6], "");
    assert_eq!(lines[7], "  runs of stored specs");
    assert_eq!(lines[8], "      ↳ adhoc · sess-1 · paused · 1m30s");
    assert!(
        text.contains("1 machine failed to load: /m/broken: bad"),
        "{text}"
    );
}

/// The separator sits BETWEEN the live and the quiet groups, never
/// around one. The nest test above pins the both-groups case; this is
/// the lone-live half — a machine roster whose every machine is live
/// paints no separator trailing it, so exactly one blank line (the
/// stored-specs group's own) comes before that heading. The lone-quiet
/// half — the idle page, the common case — sits in the viewport
/// test's exact-line assert.
#[test]
fn a_lone_live_group_paints_without_the_separator() {
    let mut view = LibraryView::new(runs(), vec!["sess-1".to_string()], 30);
    view.apply_machines(vec![machine("rsi", "user", "directory")], Vec::new());
    let text = plain(&view.render(&theme(), 120, &kb()));
    let lines: Vec<&str> = text.lines().collect();
    assert_eq!(lines[2], "  ▸ ◈ rsi [user dir] ● 1 live — The rsi machine.");
    assert_eq!(lines[3], "      ↳ rsi · sess-1 · running · 1m30s");
    assert_eq!(lines[4], "", "the only blank is the stored-specs group's");
    assert_eq!(lines[5], "  runs of stored specs");
    assert_eq!(lines[6], "      ↳ adhoc · sess-1 · paused · 1m30s");
}

/// The overview's parse seam: the owner wrapper rides every row (identity
/// raw, display name scrubbed), a saved row keeps its marker, malformed
/// rows drop, and the reply's warnings carry through. The unnamed
/// owner's fallback label scrubs the identity's control bytes at the
/// label seam while the raw id stays the row key.
#[test]
fn the_overview_parse_carries_the_owner_wrapper() {
    let hostile_id = concat!(
        "before",
        "\u{1b}]8;;example.test\u{7}",
        "linked",
        "\u{1b}]8;;\u{7}",
        "after"
    );
    let data = json!({
        "runs": [
            overview_row("run-1", "rsi", "running", "owner-a", "nightly builder"),
            {"runId": "run-2", "specId": "rsi", "machine": {}, "ownerId": "owner-b",
             "ownerName": "bad\u{1b}[31mname", "saved": true},
            {"runId": "run-3", "specId": "rsi", "machine": {}, "ownerId": "owner-d"},
            {"runId": "run-4", "specId": "rsi", "machine": {}, "ownerId": hostile_id},
            {"specId": "rsi", "machine": {}},
        ],
        "warnings": ["session owner-c: live factory graph unavailable"],
    });
    assert!(overview_reply_lists_runs(&data));
    assert!(!overview_reply_lists_runs(&json!({"warnings": []})));
    let rows = parse_overview_runs(&data);
    assert_eq!(rows.len(), 4, "malformed rows drop");
    assert_eq!(rows[0].owner_id, "owner-a");
    assert_eq!(rows[0].owner_name, "nightly builder");
    assert!(!rows[0].saved);
    assert!(
        rows[0].live_backing,
        "a row the live cache sourced (its `armed` marker) has live backing"
    );
    assert!(
        !rows[1].live_backing,
        "a durable-only row (no `armed` marker) has no live backing"
    );
    assert_eq!(
        rows[0].owner_label(),
        "nightly builder",
        "the label prefers the display name"
    );
    assert!(
        !rows[1].owner_name.contains('\u{1b}'),
        "the owner name scrubs at the parse seam"
    );
    assert_eq!(
        rows[1].owner_label(),
        rows[1].owner_name.as_str(),
        "a scrubbed name stays the label (scrubbed, never dropped)"
    );
    assert!(rows[1].saved, "the saved marker rides the wrapper");
    assert_eq!(
        rows[2].owner_label(),
        "owner-d",
        "a row without a name falls back to the identity"
    );
    assert_eq!(
        rows[3].owner_id, hostile_id,
        "the identity stays raw for the row key and the ownership checks"
    );
    assert_eq!(
        rows[3].owner_label(),
        "before ]8;;example.test linked ]8;; after",
        "the unnamed owner's fallback label scrubs the identity's control bytes"
    );
    assert_eq!(
        parse_overview_warnings(&data),
        ["session owner-c: live factory graph unavailable"]
    );
}

/// One order rules the arrows' walk and the paint: the reply's own order
/// (the daemon emits each owner's rows together), so the cursor never
/// desyncs from the painted rows — and a saved row paints the saved
/// marker instead of a fabricated age.
#[test]
fn the_walk_and_the_paint_share_the_reply_order() {
    let rows = parse_overview_runs(&json!({"runs": [
        overview_row("run-a", "rsi", "running", "owner-a", "alpha"),
        overview_row("run-c", "rsi", "running", "owner-b", "beta"),
        overview_row("run-b", "rsi", "paused", "owner-a", "alpha"),
        {"runId": "run-s", "specId": "rsi", "state": "running", "machine": {},
         "ownerId": "owner-c", "ownerName": "cache", "saved": true},
    ]}));
    let mut view = LibraryView::new(rows, vec!["sess-1".to_string()], 30);
    view.apply_machines(vec![machine("rsi", "user", "file")], Vec::new());
    let text = plain(&view.render(&theme(), 120, &kb()));
    let lines: Vec<&str> = text.lines().collect();
    assert_eq!(lines[3], "      ↳ rsi · alpha · running · 1m30s");
    assert_eq!(lines[4], "      ↳ rsi · beta · running · 1m30s");
    assert_eq!(lines[5], "      ↳ rsi · alpha · paused · 1m30s");
    assert_eq!(
        lines[6], "      ↳ rsi · cache · running · saved",
        "a disk-only row shows the saved marker, never a fabricated age"
    );
    // The arrows walk the same order the paint shows: each Down step
    // selects the next painted row (a paint-only regroup would desync
    // the cursor from the rows below it).
    let painted: Vec<String> = lines[3..=6]
        .iter()
        .map(|line| line.trim_start().to_string())
        .collect();
    let _ = view.handle_key("down", &kb()); // off the machine row
    for expected in &painted {
        let text = plain(&view.render(&theme(), 120, &kb()));
        assert!(
            text.contains(&format!("▸ {expected}")),
            "the selection follows the painted order:\n{text}"
        );
        let _ = view.handle_key("down", &kb());
    }
}

/// The roster's dressing: a machine with a backed-live run paints
/// FIRST — the page opens on it — with its runs nested under it and the
/// live glyph between the cursor and the name; exactly one blank
/// non-selectable separator row sits between the live and the quiet
/// groups while both paint; a quiet machine renders the dim glyph. The
/// arrows walk the painted order (`rows()` and `list_rows()` share the
/// ONE partition — the file's own invariant); the live runs ride the
/// constructor here, so the anchored cursor lands on rsi the moment
/// the machines fold in (the reply-first quiet-machine ride is the
/// next test's path).
#[test]
fn the_roster_dresses_live_machines_first_with_status_glyphs() {
    let rows = parse_overview_runs(&json!({"runs": [
        overview_row("run-1", "rsi", "running", "sess-1", ""),
        overview_row("run-2", "adhoc", "paused", "sess-1", ""),
    ]}));
    let mut view = LibraryView::new(rows, vec!["sess-1".to_string()], 30);
    // The reply order lists the quiet machine first: the partition must
    // reorder it, and the mount must open on the live machine.
    view.apply_machines(
        vec![
            machine("builder", "repo", "file"),
            machine("rsi", "user", "directory"),
        ],
        Vec::new(),
    );
    assert_eq!(
        view.selected,
        Some(RowKey::Machine("rsi".to_string())),
        "the anchored opening lands on the first live machine"
    );
    // The glyphs ride between the cursor span and the name, colored by
    // the badge's exact rule; the live badge itself stays on the row.
    let span_pairs = |line: &Line| {
        line.iter()
            .map(|span| (span.content.clone(), span.style.fg))
            .collect::<Vec<_>>()
    };
    let frame = view.render(&theme(), 120, &kb());
    let live_row = span_pairs(&frame[2]);
    let quiet_row = span_pairs(&frame[5]);
    assert_eq!(live_row[0].0, "  ▸ ");
    assert_eq!(quiet_row[0].0, "    ");
    let success = theme().fg_style(ThemeColor::Success).fg;
    let dim = theme().fg_style(ThemeColor::Dim).fg;
    assert_eq!(live_row[1], ("◈ ".to_string(), success), "the live glyph");
    assert_eq!(live_row[2].0, "rsi", "the glyph sits before the name");
    assert_eq!(quiet_row[1], ("• ".to_string(), dim), "the quiet glyph");
    assert_eq!(quiet_row[2].0, "builder", "the glyph sits before the name");
    assert!(
        live_row
            .iter()
            .any(|(text, color)| text == " ● 1 live" && *color == success),
        "the live badge stays on the live machine's row: {live_row:?}"
    );
    // The arrows walk the painted order: the separator row never holds
    // the cursor, and the walk reaches the quiet machine's row.
    assert_eq!(
        view.rows(),
        vec![
            RowKey::Machine("rsi".to_string()),
            RowKey::Run {
                owner: "sess-1".to_string(),
                run_id: "run-1".to_string(),
            },
            RowKey::Machine("builder".to_string()),
            RowKey::Run {
                owner: "sess-1".to_string(),
                run_id: "run-2".to_string(),
            },
        ],
        "the walk shares the painted order (stored specs last)"
    );
    let _ = view.handle_key("down", &kb());
    let text = plain(&view.render(&theme(), 120, &kb()));
    assert!(text.contains("▸ ↳ rsi"), "the run row walks next: {text}");
    let _ = view.handle_key("down", &kb());
    let text = plain(&view.render(&theme(), 120, &kb()));
    assert!(
        text.contains("▸ • builder"),
        "the quiet machine walks past the separator: {text}"
    );
}

/// The page opens on the first LIVE machine for EVERY reply order:
/// while the user has not moved the cursor, every fold re-anchors it
/// to the page's first row. The machines may land before the live
/// runs — the cursor rides the reply-first quiet machine until its
/// run folds in — and the anchored re-pick hands it to the live
/// machine anyway; after the user's first arrow key, the refreshes
/// keep their row instead.
#[test]
fn the_cursor_stays_anchored_to_the_first_live_machine_until_the_user_moves_it() {
    // The machines land FIRST: the quiet partition opens the page on
    // builder, the reply's first row.
    let mut view = LibraryView::new(Vec::new(), vec!["sess-1".to_string()], 30);
    view.apply_machines(
        vec![
            machine("builder", "repo", "file"),
            machine("rsi", "user", "directory"),
        ],
        Vec::new(),
    );
    assert_eq!(
        view.selected,
        Some(RowKey::Machine("builder".to_string())),
        "the machines land before the live runs, so the reply's first quiet row holds the anchored cursor"
    );
    // The live run folds in SECOND: the live machine reorders to the
    // top and the anchored cursor follows it — the opening promise
    // holds for the machines-first order too, never only the seeded
    // one.
    view.apply_overview(
        parse_overview_runs(&json!({"runs": [
            overview_row("run-1", "rsi", "running", "sess-1", ""),
        ]})),
        Vec::new(),
    );
    assert_eq!(
        view.selected,
        Some(RowKey::Machine("rsi".to_string())),
        "the anchored cursor follows the first live machine in"
    );
    // The user's first arrow key ends the anchoring: a later refresh
    // keeps their row instead of re-picking the first.
    let _ = view.handle_key("down", &kb());
    let moved = view.selected.clone();
    view.apply_overview(
        parse_overview_runs(&json!({"runs": [
            overview_row("run-1", "rsi", "running", "sess-1", ""),
            overview_row("run-2", "builder", "running", "sess-1", ""),
        ]})),
        Vec::new(),
    );
    assert_eq!(
        view.selected, moved,
        "the first arrow key ends the anchoring; the refresh keeps the user's row"
    );
    // Both machines are live now, so the LIVE group carries the
    // machines' reply order: builder first, rsi second — the partition
    // never re-sorts the live group by count or recency.
    assert_eq!(
        view.rows()[0],
        RowKey::Machine("builder".to_string()),
        "the live group keeps the machines' reply order"
    );
}

/// The anchor ends when the user TAKES the selection: Enter acting on
/// the selected row, or an arrow that actually moves the cursor — never
/// an arrow the list clamps into place. Enter is the load-bearing
/// release: the overview cadence keeps folding behind an open drill-in
/// or run page, and an anchored fold re-picks the first row behind the
/// user's back, so Esc would return to a machine they never opened. The
/// clamp keeps the anchor instead: Up on the top row moves nothing, so
/// the next live fold still hands the cursor to the first LIVE machine.
/// Enter with no selection acts on nothing, so the empty page's anchor
/// survives the key too.
#[test]
fn enter_takes_the_selection_a_clamped_arrow_keeps_the_anchor() {
    // Enter on the empty, still-loading page acts on nothing: the
    // anchor survives the key, so the page still opens on the first
    // LIVE machine when the replies land (the cold-load window).
    let mut view = LibraryView::new(Vec::new(), vec!["sess-1".to_string()], 30);
    assert_eq!(view.handle_key("enter", &kb()), LibraryViewAction::None);
    assert!(
        view.cursor_anchored,
        "Enter with no selection keeps the anchor"
    );
    // Enter on the machine row drills in — and ends the anchor, so the
    // folds that keep landing while the drill-in is open no longer
    // re-pick the first row behind the open view.
    let rows = parse_overview_runs(&json!({"runs": [
        overview_row("run-1", "alpha", "running", "sess-1", ""),
    ]}));
    let mut view = LibraryView::new(rows, vec!["sess-1".to_string()], 30);
    view.apply_machines(
        vec![
            machine("alpha", "repo", "file"),
            machine("beta", "repo", "file"),
        ],
        Vec::new(),
    );
    assert_eq!(
        view.selected,
        Some(RowKey::Machine("alpha".to_string())),
        "the anchored cursor opens on the first live machine"
    );
    assert_eq!(
        view.handle_key("enter", &kb()),
        LibraryViewAction::DrillIn {
            name: "alpha".to_string(),
        }
    );
    assert!(!view.cursor_anchored, "Enter takes the selection");
    // The detail reply carries the lane's drawable shape — one entry
    // state, the validator's minimum. A machine with no states never
    // leaves the kernel, and its zero-state diagram panics the block
    // renderer, so the frame below renders the open drill-in exactly
    // like a real one.
    view.apply_detail(
        "alpha",
        &json!({"runId": null, "specId": "alpha", "state": null,
                "machine": {"states": [{"id": "intake", "entry": true, "python": "intake.intake"}],
                            "transitions": [], "order": ["intake"]},
                "nodes": []}),
    );
    // The cadence folds while the drill-in is open: alpha's run
    // finished and beta's started, so the fold's first row is now beta.
    view.apply_overview(
        parse_overview_runs(&json!({"runs": [
            overview_row("run-2", "beta", "running", "sess-2", ""),
        ]})),
        Vec::new(),
    );
    // Every real frame paints the open drill-in through the fold, so
    // the fixture above must draw: the frame shows the machine the
    // user opened, never a re-picked row.
    let during = plain(&view.render(&theme(), 120, &kb()));
    assert!(
        during.contains("machine: alpha"),
        "the open drill-in paints the machine the user opened while the fold lands:\n{during}"
    );
    assert_eq!(view.handle_key("escape", &kb()), LibraryViewAction::None);
    assert_eq!(
        view.selected,
        Some(RowKey::Machine("alpha".to_string())),
        "Esc returns to the machine the user opened, never the fold's new first row"
    );
    let text = plain(&view.render(&theme(), 120, &kb()));
    assert!(
        text.contains("▸ • alpha"),
        "the cursor paints on the opened machine (quiet now, its run gone):\n{text}"
    );
    assert!(
        !text.contains("▸ ◈ beta"),
        "the fold moved beta to the top, but the cursor stays on the opened machine:\n{text}"
    );
    // Up on the top row moves nothing (the clamp holds the cursor in
    // place), so the anchor survives the key.
    let mut view = LibraryView::new(Vec::new(), vec!["sess-1".to_string()], 30);
    view.apply_machines(
        vec![
            machine("builder", "repo", "file"),
            machine("rsi", "user", "directory"),
        ],
        Vec::new(),
    );
    assert_eq!(
        view.selected,
        Some(RowKey::Machine("builder".to_string())),
        "the reply's first quiet row holds the anchored cursor"
    );
    assert_eq!(view.handle_key("up", &kb()), LibraryViewAction::None);
    assert_eq!(
        view.selected,
        Some(RowKey::Machine("builder".to_string())),
        "the clamp holds the cursor on the top row"
    );
    assert!(
        view.cursor_anchored,
        "a clamped arrow never ends the anchor"
    );
    // The live run folds in after the clamped key: the anchor survived,
    // so the fold still hands the cursor to the first LIVE machine.
    view.apply_overview(
        parse_overview_runs(&json!({"runs": [
            overview_row("run-1", "rsi", "running", "sess-1", ""),
        ]})),
        Vec::new(),
    );
    assert_eq!(
        view.selected,
        Some(RowKey::Machine("rsi".to_string())),
        "the anchor survived the clamped key, so the fold lands on the live machine"
    );
}

/// A clamped arrow retires the row report exactly like a real move:
/// the key press is the user's ack of the notice, so Up on the top
/// row or Down on the bottom row clears it while the cursor holds.
/// The report can only exist after Enter released the anchor, so this
/// pins the release-side rule alone; the clamp's anchor half is the
/// test above.
#[test]
fn a_clamped_arrow_retires_the_row_report() {
    // The list's lone row is a foreign run row: Enter takes the
    // selection and reports its owner (the session-UI half sets the
    // notice).
    let rows = parse_overview_runs(&json!({"runs": [
        overview_row("run-1", "rsi", "running", "owner-a", "nightly builder"),
    ]}));
    let mut view = LibraryView::new(rows, vec!["sess-1".to_string()], 30);
    assert!(matches!(
        view.handle_key("enter", &kb()),
        LibraryViewAction::ForeignRun { .. }
    ));
    view.set_row_notice(Some(
        "run belongs to session nightly builder — open that session to stop or resume it"
            .to_string(),
    ));
    let before = plain(&view.render(&theme(), 120, &kb()));
    assert!(
        before.contains("run belongs to session nightly builder"),
        "{before}"
    );
    // Down on the list's last row clamps: the cursor holds, the
    // report still retires — the key retires it, not the move.
    assert_eq!(view.handle_key("down", &kb()), LibraryViewAction::None);
    assert_eq!(
        view.selected,
        Some(RowKey::Run {
            owner: "owner-a".to_string(),
            run_id: "run-1".to_string()
        }),
        "the clamp holds the cursor on the list's only row"
    );
    let after = plain(&view.render(&theme(), 120, &kb()));
    assert!(
        !after.contains("run belongs to session nightly builder"),
        "a clamped arrow retires the row report like a real move:\n{after}"
    );
}

/// The saved marker survives an ordinary terminal width: it rides
/// directly after the state, BEFORE the variable-width fields, so a
/// stale row that carries an active state id and progress counters
/// still shows its qualification at 80 columns. A trailing marker
/// clipped off exactly these rows at that width — the row's own
/// content runs past 90 cells.
#[test]
fn the_saved_marker_stays_visible_at_eighty_columns_on_a_row_with_progress() {
    let rows = parse_overview_runs(&json!({"runs": [{
        "runId": "run-stale", "specId": "rsi", "name": "held-display",
        "state": "running", "elapsedMs": 90_000,
        "machine": {"states": [{"id": "work", "entry": true}], "transitions": [], "order": []},
        "nodes": [{"id": "work", "status": "running", "entries": [{"status": "running"}], "instances": []}],
        "usage": {"spawns": 0, "settled": 0, "running": 1, "transitionsFired": 0},
        "ownerId": "owner-b", "ownerName": "cache owner", "saved": true, "armed": null},
    ]}));
    let mut view = LibraryView::new(rows, vec!["sess-1".to_string()], 30);
    view.apply_machines(vec![machine("rsi", "user", "file")], Vec::new());
    let frame = view.render(&theme(), 80, &kb());
    let text = plain(&frame);
    assert!(
        text.contains("running · saved"),
        "the marker rides before the variable-width fields at 80 columns:\n{text}"
    );
    assert!(
        text.contains("held-display"),
        "the row itself still paints:\n{text}"
    );
}

/// The saved marker survives long labels too: the run's name and the
/// owner's label truncate to the space the frame leaves after the state
/// and the qualifier, so a stale row behind a 30-character name and a
/// 27-character owner label still shows its qualification at 80
/// columns — and never paints identical to its live twin (a marker the
/// trailing truncation clipped off left the stale row indistinguishable
/// from a live one whose age clipped).
#[test]
fn the_saved_marker_stays_visible_at_eighty_columns_behind_long_labels() {
    let long_name = format!("{}{}", "held factory task", "x".repeat(13));
    let long_owner = format!("{}{}", "long factory owner", "y".repeat(9));
    assert_eq!(long_name.chars().count(), 30);
    assert_eq!(long_owner.chars().count(), 27);
    let rows = |saved: bool| {
        parse_overview_runs(&json!({"runs": [{
            "runId": "run-state", "specId": "rsi", "name": long_name.clone(),
            "state": "running", "elapsedMs": 90_000,
            "machine": {"states": [], "transitions": [], "order": []}, "nodes": [],
            "usage": {"spawns": 0, "settled": 0, "running": 1, "transitionsFired": 0},
            "ownerId": "owner-b", "ownerName": long_owner.clone(), "saved": saved,
            "armed": null,
        }]}))
    };
    let mut view = LibraryView::new(rows(true), vec!["sess-1".to_string()], 30);
    view.apply_machines(vec![machine("rsi", "user", "file")], Vec::new());
    let stale_text = plain(&view.render(&theme(), 80, &kb()));
    let stale_row = stale_text
        .lines()
        .find(|line| line.contains('\u{21b3}'))
        .expect("the stale run row");
    let mut view = LibraryView::new(rows(false), vec!["sess-1".to_string()], 30);
    view.apply_machines(vec![machine("rsi", "user", "file")], Vec::new());
    let live_text = plain(&view.render(&theme(), 80, &kb()));
    let live_row = live_text
        .lines()
        .find(|line| line.contains('\u{21b3}'))
        .expect("the live run row");
    assert!(
        stale_row.contains("saved"),
        "the marker rides behind the truncated labels at 80 columns:\n{stale_row}"
    );
    assert!(
        live_row.contains("1m30s"),
        "the live twin keeps its age:\n{live_row}"
    );
    assert_ne!(
        stale_row, live_row,
        "a stale row never paints identical to a live one at 80 columns"
    );
}

/// The 80-column row behind an ordinary long identity — a 21-character
/// run name under a 36-character unnamed owner id — keeps its fixed
/// tail, splits the label budget fairly, and wraps its progress: the
/// owner label keeps the whole half the short name leaves it (30 of
/// the 51 label cells), the saved qualifier rides the identity line
/// where the trailing truncation cannot clip it, and the
/// active-state/progress segment — which the two labels crowd off the
/// line entirely — wraps under the identity instead of disappearing.
/// A foreign row has no drill-in, so the list is the only place its
/// progress paints: a run moving from implement/2 spawns/1 transition
/// to review/12 spawns/11 transitions must not paint an identical row.
#[test]
fn the_long_identity_row_keeps_its_tail_share_and_wraps_its_progress() {
    let long_name = format!("{}{}", "feature-implementer", "-x");
    assert_eq!(long_name.chars().count(), 21);
    let long_owner = "12345678-1234-5678-9abc-def012345678".to_string();
    assert_eq!(long_owner.chars().count(), 36);
    let rows = |saved: bool| {
        parse_overview_runs(&json!({"runs": [{
            "runId": "run-long", "specId": "rsi", "name": long_name.clone(),
            "state": "running", "elapsedMs": 90_000,
            "machine": {"states": [{"id": "implement", "entry": true}],
                        "transitions": [], "order": []},
            "nodes": [{"id": "implement", "status": "running",
                       "entries": [{"status": "running"}], "instances": []}],
            "usage": {"spawns": 2, "settled": 0, "running": 1, "transitionsFired": 1},
            "ownerId": long_owner.clone(), "ownerName": "", "saved": saved, "armed": null,
        }]}))
    };
    let frame = |saved: bool| {
        let mut view = LibraryView::new(rows(saved), vec!["sess-1".to_string()], 30);
        view.apply_machines(vec![machine("rsi", "user", "file")], Vec::new());
        plain(&view.render(&theme(), 80, &kb()))
    };
    let stale = frame(true);
    let live = frame(false);
    let stale_row = stale
        .lines()
        .find(|line| line.contains('\u{21b3}'))
        .expect("the stale run row");
    let live_row = live
        .lines()
        .find(|line| line.contains('\u{21b3}'))
        .expect("the live run row");
    // The fixed tail rides the identity line at 80 columns.
    assert!(
        stale_row.contains("running · saved"),
        "the saved qualifier paints behind the long labels:\n{stale_row}"
    );
    assert!(
        live_row.contains("running · 1m30s"),
        "the live twin keeps its age:\n{live_row}"
    );
    assert_ne!(stale_row, live_row, "the twins never paint identical");
    // The label budget splits fairly: the 21-cell name paints whole,
    // and the owner label takes the half the short name leaves it — 30
    // of the 51 label cells, never a flat half-cap cut to 25.
    assert!(
        stale_row.contains(&long_name),
        "the 21-cell name paints whole:\n{stale_row}"
    );
    assert!(
        stale_row.contains("12345678-1234-5678-9abc-def01\u{2026}"),
        "the owner label keeps the short name's unused half (30 cells):\n{stale_row}"
    );
    // The progress the labels crowd off the identity line wraps under
    // it — the row's live state and progress stay readable.
    assert!(
        stale.contains("implement · 2 spawns · 1 running · 1 transitions"),
        "the progress wraps under the identity at 80 columns:\n{stale}"
    );
    assert!(
        live.contains("implement · 2 spawns · 1 running · 1 transitions"),
        "the live twin's progress wraps too:\n{live}"
    );
}

/// The wrapped progress segment packs its units per continuation line,
/// so the counters never clip behind the active state ids at 80
/// columns: this machine's review-phase row — three parallel states in
/// flight — paints every counter whole, where a single clipped
/// continuation line would cut `transitions` to a bare number that
/// reads like another counter. A valid 64-character state id wraps onto
/// its own line instead of eating the counters.
#[test]
fn the_wrapped_progress_packs_its_units_so_the_counters_never_clip() {
    let frame = |state_ids: &[&str], name: &str, usage: Value| {
        let states: Vec<Value> = state_ids
            .iter()
            .map(|id| json!({"id": id, "entry": true}))
            .collect();
        let nodes: Vec<Value> = state_ids
            .iter()
            .map(|id| {
                json!({"id": id, "status": "running",
                       "entries": [{"status": "running"}], "instances": []})
            })
            .collect();
        let runs = parse_overview_runs(&json!({"runs": [{
            "runId": "run-par", "specId": "feature-implementer", "name": name,
            "state": "running", "elapsedMs": 90_000,
            "machine": {"states": states, "transitions": [], "order": []},
            "nodes": nodes, "usage": usage,
            "ownerId": "owner-par", "ownerName": "", "saved": true, "armed": null,
        }]}));
        let mut view = LibraryView::new(runs, vec!["sess-1".to_string()], 30);
        view.apply_machines(
            vec![machine("feature-implementer", "user", "file")],
            Vec::new(),
        );
        plain(&view.render(&theme(), 80, &kb()))
    };
    // The review phase's real fan-out: three parallel state ids and the
    // counters they crowd off the identity line.
    let parallel = frame(
        &["teammate-review", "bugbot-review", "robust-review"],
        "the feature implementer",
        json!({"spawns": 12, "settled": 0, "running": 3, "transitionsFired": 14}),
    );
    assert!(
        parallel.contains("teammate-review+bugbot-review+robust-review · 12 spawns · 3 running"),
        "the packed ids share their line with the counters that fit:
{parallel}"
    );
    assert!(
        parallel.contains("14 transitions"),
        "the transition counter paints whole at 80 columns:
{parallel}"
    );
    // A valid 64-character state id takes its own continuation line and
    // the counters wrap under it.
    let long_id = "x".repeat(64);
    let long = frame(
        &[long_id.as_str()],
        "run-long",
        json!({"spawns": 5, "settled": 0, "running": 1, "transitionsFired": 4}),
    );
    assert!(
        long.contains(&long_id),
        "the long id paints on its line:
{long}"
    );
    assert!(
        long.contains("5 spawns · 1 running · 4 transitions"),
        "the counters paint under a long id instead of clipping behind it:
{long}"
    );
}

/// The list window keeps the selected run's whole rendered block in
/// view: at 80 columns on a 24-row terminal, the LAST run of a long
/// list — selected, its identity line plus its wrapped progress —
/// paints its state and progress on the frame. A window anchored on
/// the identity line alone parks it on the body's last line and cuts
/// the continuation, and no further key reveals it: the run is foreign
/// (no drill-in), so the list is the only place its progress paints.
#[test]
fn the_scrolled_window_keeps_the_selected_runs_wrapped_progress_visible() {
    let runs = || {
        let rows: Vec<Value> = (1..=20)
            .map(|run| {
                json!({
                    "runId": format!("run-{run:02}"), "specId": "rsi",
                    "name": format!("run-{run:02}"), "state": "running",
                    "elapsedMs": 90_000,
                    "machine": {"states": [{"id": "review", "entry": true}],
                                "transitions": [], "order": []},
                    "nodes": [{"id": "review", "status": "running",
                               "entries": [{"status": "running"}], "instances": []}],
                    "usage": {"spawns": run, "settled": 0, "running": run,
                              "transitionsFired": run},
                    "ownerId": "owner-a", "ownerName": "", "saved": false, "armed": null,
                })
            })
            .collect();
        parse_overview_runs(&json!({"runs": rows}))
    };
    let mut view = LibraryView::new(runs(), vec!["sess-1".to_string()], 24);
    view.apply_machines(vec![machine("rsi", "user", "file")], Vec::new());
    // Walk to the LAST run: the machine row, then run-01 through run-20.
    for _ in 0..20 {
        let _ = view.handle_key("down", &kb());
    }
    let frame = plain(&view.render(&theme(), 80, &kb()));
    assert!(
        frame.contains("\u{25b8} \u{21b3} run-20"),
        "the selected identity paints with its cursor:\n{frame}"
    );
    assert!(
        frame.contains("review · 20 spawns · 20 running · 20 transitions"),
        "the selected run's progress paints under its identity:\n{frame}"
    );
}

/// Enter drills into a machine and opens a run; the walk skips the group
/// heading; Esc closes.
#[test]
fn enter_drills_into_machines_and_opens_runs() {
    let mut view = LibraryView::new(runs(), vec!["sess-1".to_string()], 30);
    view.apply_machines(vec![machine("rsi", "user", "directory")], Vec::new());
    assert_eq!(
        view.handle_key("enter", &kb()),
        LibraryViewAction::DrillIn {
            name: "rsi".to_string()
        }
    );
    assert_eq!(view.handle_key("down", &kb()), LibraryViewAction::None);
    assert_eq!(
        view.handle_key("enter", &kb()),
        LibraryViewAction::OpenRun {
            run_id: "run-1".to_string()
        }
    );
    assert_eq!(view.handle_key("down", &kb()), LibraryViewAction::None);
    assert_eq!(
        view.handle_key("enter", &kb()),
        LibraryViewAction::OpenRun {
            run_id: "run-2".to_string()
        },
        "the stored-spec heading is not a stop"
    );
    assert_eq!(view.handle_key("down", &kb()), LibraryViewAction::None);
    assert_eq!(
        view.handle_key("enter", &kb()),
        LibraryViewAction::OpenRun {
            run_id: "run-2".to_string()
        },
        "the walk stops at the last row"
    );
    assert_eq!(view.handle_key("escape", &kb()), LibraryViewAction::Close);
}

/// Enter on a foreign owner's run reports the owner instead of opening
/// the local run page: the owner check is the only gate between the row
/// and the owned-run drill-in.
#[test]
fn enter_on_a_foreign_run_reports_the_owner_not_a_local_open() {
    let rows = parse_overview_runs(&json!({"runs": [
        overview_row("run-1", "rsi", "running", "owner-a", "nightly builder"),
        overview_row("run-2", "rsi", "running", "sess-1", ""),
    ]}));
    let mut view = LibraryView::new(rows, vec!["sess-1".to_string()], 30);
    view.apply_machines(vec![machine("rsi", "user", "file")], Vec::new());
    // Walk off the machine row onto its first (foreign) run before Enter.
    let _ = view.handle_key("down", &kb());
    assert_eq!(
        view.handle_key("enter", &kb()),
        LibraryViewAction::ForeignRun {
            owner: "nightly builder".to_string()
        },
        "a foreign row reports its owner, never a local open"
    );
    let _ = view.handle_key("down", &kb());
    assert_eq!(
        view.handle_key("enter", &kb()),
        LibraryViewAction::OpenRun {
            run_id: "run-2".to_string()
        },
        "the session's own row keeps the local run-page drill-in"
    );
}

/// Enter on this session's own row that no live read backs reports the
/// read-only state instead of opening the run page: only a durable
/// record lists the row (no kernel read confirms the run), so the local
/// run page would mount from an empty scoped graph and report a run the
/// list just showed as nonexistent. The owned LIVE row keeps its
/// drill-in.
#[test]
fn enter_on_an_owned_saved_row_reports_the_state_not_a_local_open() {
    let rows = parse_overview_runs(&json!({"runs": [
        {"runId": "run-saved", "specId": "rsi", "name": "rsi", "state": "paused",
         "machine": {"states": [], "transitions": [], "order": []}, "nodes": [],
         "ownerId": "sess-1", "ownerName": "", "saved": true},
        overview_row("run-live", "rsi", "running", "sess-1", ""),
    ]}));
    let mut view = LibraryView::new(rows, vec!["sess-1".to_string()], 30);
    view.apply_machines(vec![machine("rsi", "user", "file")], Vec::new());
    // The first run row is the owned saved one.
    let _ = view.handle_key("down", &kb());
    assert_eq!(
        view.handle_key("enter", &kb()),
        LibraryViewAction::SavedRun {
            run_id: "run-saved".to_string(),
            rearm_pending: false,
        },
        "an owned saved row reports its state, never a dead-end run page"
    );
    // The owned LIVE row below it keeps the local run-page drill-in.
    let _ = view.handle_key("down", &kb());
    assert_eq!(
        view.handle_key("enter", &kb()),
        LibraryViewAction::OpenRun {
            run_id: "run-live".to_string()
        },
        "the session's own live row keeps the local run-page drill-in"
    );
}

/// Enter routes an owned row by its BACKING, not the saved marker alone:
/// an AGED cache row — saved only because its owner's read is behind —
/// still has its kernel's read behind it, so it keeps the run-page
/// drill-in exactly like a fresh row; a durable-only row (no live read
/// ever listed it) and a still-unarmed rehydrated run report saved.
/// Routing by the marker alone would send every aged row of a busy
/// owner to the read-only report.
#[test]
fn enter_routes_an_owned_row_by_its_live_backing_not_the_saved_marker() {
    let rows = parse_overview_runs(&json!({"runs": [
        // Aged cache row: the daemon's own shape (armed, its read behind).
        {"runId": "run-aged", "specId": "rsi", "name": "rsi", "state": "running",
         "machine": {"states": [], "transitions": [], "order": []}, "nodes": [],
         "usage": {"running": 1},
         "ownerId": "sess-1", "ownerName": "", "saved": true, "armed": null},
        // A still-unarmed rehydrated run: the kernel lists it, no loop
        // drives it yet.
        {"runId": "run-unarmed", "specId": "rsi", "name": "rsi", "state": "paused",
         "machine": {"states": [], "transitions": [], "order": []}, "nodes": [],
         "ownerId": "sess-1", "ownerName": "", "saved": true, "armed": false},
        // Durable-only: no live read ever listed it.
        {"runId": "run-record", "specId": "rsi", "name": "rsi", "state": "paused",
         "machine": {"states": [], "transitions": [], "order": []}, "nodes": [],
         "ownerId": "sess-1", "ownerName": "", "saved": true},
    ]}));
    let mut view = LibraryView::new(rows, vec!["sess-1".to_string()], 30);
    view.apply_machines(vec![machine("rsi", "user", "file")], Vec::new());
    let _ = view.handle_key("down", &kb());
    assert_eq!(
        view.handle_key("enter", &kb()),
        LibraryViewAction::OpenRun {
            run_id: "run-aged".to_string()
        },
        "an aged cache row (its kernel's read behind it) keeps the run page"
    );
    let _ = view.handle_key("down", &kb());
    assert_eq!(
        view.handle_key("enter", &kb()),
        LibraryViewAction::SavedRun {
            run_id: "run-unarmed".to_string(),
            rearm_pending: true,
        },
        "a still-unarmed rehydrated run reports saved, its re-arm alone pending"
    );
    let _ = view.handle_key("down", &kb());
    assert_eq!(
        view.handle_key("enter", &kb()),
        LibraryViewAction::SavedRun {
            run_id: "run-record".to_string(),
            rearm_pending: false,
        },
        "a durable-only row reports saved"
    );
}

/// A selection move retires the ROW REPORT (a foreign owner's notice,
/// an owned saved row's state) — the report belongs to the row it names,
/// never a sticky notice the cursor leaves behind — and touches nothing
/// else: a failed machine-list fetch survives the move that makes the
/// list walkable, and so does the overview's own slot.
#[test]
fn a_selection_move_retires_the_row_report_but_keeps_fetch_errors() {
    let mut view = LibraryView::new(runs(), vec!["sess-1".to_string()], 30);
    view.apply_machines(vec![machine("rsi", "user", "file")], Vec::new());
    // A failed machine-list fetch on the page's error row.
    view.set_error(Some("machine-list request refused".to_string()));
    // The row report in its own slot.
    view.set_row_notice(Some(
        "run belongs to session nightly builder — open that session to stop or resume it"
            .to_string(),
    ));
    let before = plain(&view.render(&theme(), 120, &kb()));
    assert!(
        before.contains("Error: machine-list request refused"),
        "{before}"
    );
    assert!(
        before.contains("run belongs to session nightly builder"),
        "{before}"
    );
    let _ = view.handle_key("down", &kb());
    let moved = plain(&view.render(&theme(), 120, &kb()));
    assert!(
        !moved.contains("run belongs to session nightly builder"),
        "the move retires the row report:\n{moved}"
    );
    assert!(
        moved.contains("Error: machine-list request refused"),
        "the move never erases the machine list's failure:\n{moved}"
    );
    // The overview's own slot survives a move untouched.
    view.set_overview_error(Some("the overview could not be read".to_string()));
    let _ = view.handle_key("down", &kb());
    let after = plain(&view.render(&theme(), 120, &kb()));
    assert!(
        after.contains("Error: the overview could not be read"),
        "{after}"
    );
    assert!(
        after.contains("Error: machine-list request refused"),
        "{after}"
    );
}

/// A refresh that removes the selected row retires its row report with
/// it: the fallback selection is a different row, and the report
/// belongs to the row it names — never a stale notice under another
/// row. A refresh that keeps the selected row keeps the report, and
/// the page's fetch errors survive both.
#[test]
fn a_refresh_that_moves_the_selection_retires_the_row_report() {
    let rows = parse_overview_runs(&json!({"runs": [
        overview_row("run-a", "rsi", "running", "owner-a", "alpha"),
        overview_row("run-b", "rsi", "running", "owner-b", "beta"),
    ]}));
    let mut view = LibraryView::new(rows, vec!["sess-1".to_string()], 30);
    view.apply_machines(vec![machine("rsi", "user", "file")], Vec::new());
    // Select run-a, set its report, and fail a machine-list fetch: the
    // report retires only with its row, the fetch error never.
    let _ = view.handle_key("down", &kb());
    view.set_row_notice(Some(
        "run run-a is saved — no live read backs it".to_string(),
    ));
    view.set_error(Some("machine-list request refused".to_string()));
    // A refresh that keeps run-a keeps its report and the fetch error.
    view.apply_overview(
        parse_overview_runs(&json!({"runs": [
            overview_row("run-a", "rsi", "running", "owner-a", "alpha"),
        ]})),
        Vec::new(),
    );
    let kept = plain(&view.render(&theme(), 120, &kb()));
    assert!(kept.contains("no live read backs it"), "{kept}");
    assert!(
        kept.contains("Error: machine-list request refused"),
        "{kept}"
    );
    // A refresh that drops run-a moves the selection to run-b and
    // retires run-a's report with it.
    view.apply_overview(
        parse_overview_runs(&json!({"runs": [
            overview_row("run-b", "rsi", "running", "owner-b", "beta"),
        ]})),
        Vec::new(),
    );
    let moved = plain(&view.render(&theme(), 120, &kb()));
    assert!(
        !moved.contains("no live read backs it"),
        "the removed row's report retires with it:\n{moved}"
    );
    assert!(
        moved.contains("↳ rsi · beta · running"),
        "the fallback selection is the remaining row:\n{moved}"
    );
    assert!(
        moved.contains("Error: machine-list request refused"),
        "the refresh never erases the fetch error:\n{moved}"
    );
}

/// Enter before the machines land takes the selection: the anchor ends
/// with the act, so the machines arriving — a fold that changes the
/// first row — keeps the cursor on the row the user acted on, and the
/// report keeps naming the row under the cursor. A later real move
/// retires the report with its row, never leaving a stale notice under
/// a row it did not name.
#[test]
fn enter_before_the_machines_land_keeps_the_row_and_its_report() {
    let rows = parse_overview_runs(&json!({"runs": [
        overview_row("run-1", "rsi", "running", "owner-a", "nightly builder"),
    ]}));
    let mut view = LibraryView::new(rows, vec!["sess-1".to_string()], 30);
    // The list has not landed: the foreign run row is the top row, and
    // Enter's report names its owner.
    assert!(matches!(
        view.handle_key("enter", &kb()),
        LibraryViewAction::ForeignRun { .. }
    ));
    view.set_row_notice(Some(
        "run belongs to session nightly builder — open that session to stop or resume it"
            .to_string(),
    ));
    let before = plain(&view.render(&theme(), 120, &kb()));
    assert!(
        before.contains("Loading the machine library"),
        "the list has not landed yet:\n{before}"
    );
    assert!(
        before.contains("run belongs to session nightly builder"),
        "{before}"
    );
    // The machines land: Enter already took the selection, so the load
    // keeps the cursor on the run row the user acted on — the report
    // stays with the row it names.
    view.apply_machines(vec![machine("rsi", "user", "file")], Vec::new());
    let after = plain(&view.render(&theme(), 120, &kb()));
    assert!(
        after.contains("run belongs to session nightly builder"),
        "the report keeps its row while the cursor holds it:\n{after}"
    );
    assert!(
        after.contains("▸ ↳ rsi"),
        "the cursor stays on the row Enter acted on, never the load's new first row:\n{after}"
    );
    assert!(
        !after.contains("▸ ◈ rsi"),
        "the load does not re-pick behind the user's act:\n{after}"
    );
    // A real move off the row retires the report with it.
    let _ = view.handle_key("up", &kb());
    let moved = plain(&view.render(&theme(), 120, &kb()));
    assert!(
        !moved.contains("run belongs to session nightly builder"),
        "the move retires the report with its row:\n{moved}"
    );
    assert!(
        moved.contains("▸ ◈ rsi [user]"),
        "the machine row holds the moved cursor:\n{moved}"
    );
}

/// A same-row refresh that flips the selected OWNED row's backing
/// retires its row report: the saved-row report claims no live read
/// backs the row, and a refresh that restores the backing makes that
/// claim false. A foreign row's report is owner guidance, which a
/// backing flip does not falsify — it survives — and the page's fetch
/// errors survive every case.
#[test]
fn a_refresh_that_restores_the_backing_retires_the_saved_report() {
    let owned_rows = |saved: bool| {
        parse_overview_runs(&json!({"runs": [{
            "runId": "run-d", "specId": "rsi", "name": "rsi",
            "state": "paused", "elapsedMs": 90_000,
            "machine": {"states": [], "transitions": [], "order": []}, "nodes": [],
            "usage": {"spawns": 0, "settled": 0, "running": 0, "transitionsFired": 0},
            "ownerId": "sess-1", "ownerName": "", "saved": saved,
        }]}))
    };
    let live_rows = || {
        parse_overview_runs(&json!({"runs": [{
            "runId": "run-d", "specId": "rsi", "name": "rsi",
            "state": "running", "elapsedMs": 90_000,
            "machine": {"states": [], "transitions": [], "order": []}, "nodes": [],
            "usage": {"spawns": 1, "settled": 0, "running": 1, "transitionsFired": 0},
            "ownerId": "sess-1", "ownerName": "", "saved": false, "armed": null,
        }]}))
    };
    let mut view = LibraryView::new(owned_rows(true), vec!["sess-1".to_string()], 30);
    view.apply_machines(vec![machine("rsi", "user", "file")], Vec::new());
    let _ = view.handle_key("down", &kb());
    assert!(matches!(
        view.handle_key("enter", &kb()),
        LibraryViewAction::SavedRun { .. }
    ));
    view.set_row_notice(Some(
        "run run-d is saved — no live read backs it".to_string(),
    ));
    view.set_error(Some("machine-list request refused".to_string()));
    // The owner's read lands: the same row returns with live backing.
    view.apply_overview(live_rows(), Vec::new());
    let restored = plain(&view.render(&theme(), 120, &kb()));
    assert!(
        !restored.contains("no live read backs it"),
        "the restored backing retires the saved report:\n{restored}"
    );
    assert!(
        restored.contains("Error: machine-list request refused"),
        "the refresh never erases the fetch error:\n{restored}"
    );
    assert!(matches!(
        view.handle_key("enter", &kb()),
        LibraryViewAction::OpenRun { .. }
    ));
    // A foreign row's report names its owner, not its backing: the same
    // flip leaves that guidance in place.
    let foreign_rows = |saved: bool| {
        parse_overview_runs(&json!({"runs": [{
            "runId": "run-f", "specId": "rsi", "name": "rsi",
            "state": "running", "elapsedMs": 90_000,
            "machine": {"states": [], "transitions": [], "order": []}, "nodes": [],
            "usage": {"spawns": 0, "settled": 0, "running": 1, "transitionsFired": 0},
            "ownerId": "owner-f", "ownerName": "forge", "saved": saved, "armed": null,
        }]}))
    };
    let mut foreign = LibraryView::new(foreign_rows(true), vec!["sess-1".to_string()], 30);
    foreign.apply_machines(vec![machine("rsi", "user", "file")], Vec::new());
    let _ = foreign.handle_key("down", &kb());
    foreign.set_row_notice(Some(
        "run belongs to session forge — open that session to stop or resume it".to_string(),
    ));
    foreign.apply_overview(foreign_rows(false), Vec::new());
    let guidance = plain(&foreign.render(&theme(), 120, &kb()));
    assert!(
        guidance.contains("run belongs to session forge"),
        "a foreign row's guidance survives the backing flip:\n{guidance}"
    );
}

/// A same-row refresh that flips the selected OWNED row between the
/// two SAVED backings — a durable-only row (no live read at all) and a
/// kernel-listed run awaiting its re-arm — retires the row report with
/// the flip: the two backings share the saved marker, so only the
/// re-arm marker tells the report's two wordings apart, and a report
/// kept under the new backing would claim a state the row no longer
/// carries. Both directions retire.
#[test]
fn a_refresh_between_the_two_saved_backings_retires_the_row_report() {
    // The daemon's two real saved shapes: the durable projection omits
    // the `armed` key entirely, and a rehydrated run the kernel lists
    // carries `armed: false` while its re-arm alone is pending.
    let durable_row = || {
        parse_overview_runs(&json!({"runs": [{
            "runId": "run-d", "specId": "rsi", "name": "rsi",
            "state": "paused", "elapsedMs": 90_000,
            "machine": {"states": [], "transitions": [], "order": []}, "nodes": [],
            "usage": {"spawns": 0, "settled": 0, "running": 0, "transitionsFired": 0},
            "ownerId": "sess-1", "ownerName": "", "saved": true,
        }]}))
    };
    let unarmed_row = || {
        parse_overview_runs(&json!({"runs": [{
            "runId": "run-d", "specId": "rsi", "name": "rsi",
            "state": "paused", "elapsedMs": 90_000,
            "machine": {"states": [], "transitions": [], "order": []}, "nodes": [],
            "usage": {"spawns": 0, "settled": 0, "running": 0, "transitionsFired": 0},
            "ownerId": "sess-1", "ownerName": "", "saved": true, "armed": false,
        }]}))
    };
    let mut view = LibraryView::new(durable_row(), vec!["sess-1".to_string()], 30);
    view.apply_machines(vec![machine("rsi", "user", "file")], Vec::new());
    let _ = view.handle_key("down", &kb());
    assert_eq!(
        view.handle_key("enter", &kb()),
        LibraryViewAction::SavedRun {
            run_id: "run-d".to_string(),
            rearm_pending: false,
        }
    );
    view.set_row_notice(Some(
        "run run-d is saved — no live read backs it".to_string(),
    ));
    // The kernel boots and lists the rehydrated run: the same row now
    // awaits its re-arm alone. The old wording claims no live read at
    // all, so the flip must retire it.
    view.apply_overview(unarmed_row(), Vec::new());
    let rearmed = plain(&view.render(&theme(), 120, &kb()));
    assert!(
        !rearmed.contains("no live read backs it"),
        "the re-arm flip retires the old wording:\n{rearmed}"
    );
    assert_eq!(
        view.handle_key("enter", &kb()),
        LibraryViewAction::SavedRun {
            run_id: "run-d".to_string(),
            rearm_pending: true,
        }
    );
    view.set_row_notice(Some(
        "run run-d is saved — waiting for its kernel to re-arm it".to_string(),
    ));
    // The owner's kernel goes away and the row falls back to the durable
    // record: the re-arm wording now claims a live read the row lost.
    view.apply_overview(durable_row(), Vec::new());
    let durable = plain(&view.render(&theme(), 120, &kb()));
    assert!(
        !durable.contains("waiting for its kernel to re-arm it"),
        "the lost live read retires the re-arm wording:\n{durable}"
    );
}

/// A refresh that renames the selected row's owner retires the report
/// it named: the guidance names the owner's DISPLAYED label, and a
/// rename keeps the row's identity while changing the label — the old
/// guidance would tell the user to open a label the row no longer
/// carries. A refresh that keeps the label keeps the guidance.
#[test]
fn a_refresh_that_renames_the_owner_retires_the_row_report() {
    let rows = |name: &str| {
        parse_overview_runs(&json!({"runs": [{
            "runId": "run-1", "specId": "rsi", "name": "rsi", "state": "running",
            "elapsedMs": 90_000,
            "machine": {"states": [], "transitions": [], "order": []}, "nodes": [],
            "ownerId": "owner-a", "ownerName": name, "saved": false, "armed": null,
        }]}))
    };
    let mut view = LibraryView::new(rows("before-rename"), vec!["sess-1".to_string()], 30);
    view.apply_machines(vec![machine("rsi", "user", "file")], Vec::new());
    let _ = view.handle_key("down", &kb());
    view.set_row_notice(Some(
        "run belongs to session before-rename — open that session to stop or resume it".to_string(),
    ));
    // A same-label refresh keeps the guidance.
    view.apply_overview(rows("before-rename"), Vec::new());
    let kept = plain(&view.render(&theme(), 120, &kb()));
    assert!(
        kept.contains("run belongs to session before-rename"),
        "a same-label refresh keeps the guidance:\n{kept}"
    );
    // The rename lands on the same row: the old guidance retires with
    // the label it named, and the row paints the new label.
    view.apply_overview(rows("after-rename"), Vec::new());
    let renamed = plain(&view.render(&theme(), 120, &kb()));
    assert!(
        !renamed.contains("run belongs to session before-rename"),
        "the renamed owner's old guidance retires:\n{renamed}"
    );
    assert!(
        renamed.contains("↳ rsi · after-rename · running"),
        "the row paints the new label:\n{renamed}"
    );
}

/// A refresh keeps the selection on the same owner/run identity; a row
/// that left falls back to the first row.
#[test]
fn a_refresh_keeps_the_selection_on_the_same_row() {
    let mut view = LibraryView::new(runs(), vec!["sess-1".to_string()], 30);
    view.apply_machines(vec![machine("rsi", "user", "directory")], Vec::new());
    let _ = view.handle_key("down", &kb());
    view.apply_machines(
        vec![
            machine("builder", "repo", "file"),
            machine("rsi", "user", "directory"),
        ],
        Vec::new(),
    );
    assert_eq!(
        view.handle_key("enter", &kb()),
        LibraryViewAction::OpenRun {
            run_id: "run-1".to_string()
        }
    );
    view.apply_overview(Vec::new(), Vec::new());
    assert_eq!(
        view.selected_machine().map(|machine| machine.name.as_str()),
        Some("builder"),
        "the run left, so the selection falls back to the first row"
    );
}

/// The owner/run pair is the selection identity: a refresh that changes
/// the row's progress but keeps its owner and run id keeps the selection
/// on it.
#[test]
fn an_overview_refresh_keeps_the_selection_on_the_owner_run_pair() {
    let rows = parse_overview_runs(&json!({"runs": [
        overview_row("run-1", "rsi", "running", "owner-a", "alpha"),
    ]}));
    let mut view = LibraryView::new(rows, vec!["sess-1".to_string()], 30);
    view.apply_machines(vec![machine("rsi", "user", "file")], Vec::new());
    let _ = view.handle_key("down", &kb());
    let text = plain(&view.render(&theme(), 120, &kb()));
    assert!(text.contains("▸ ↳ rsi · alpha · running"), "{text}");
    let rows = parse_overview_runs(&json!({"runs": [
        {"runId": "run-1", "specId": "rsi", "name": "rsi", "state": "paused",
         "elapsedMs": 90_000,
         "machine": {"states": [], "transitions": [], "order": []}, "nodes": [],
         "usage": {"spawns": 3, "running": 2, "transitionsFired": 4},
         "ownerId": "owner-a", "ownerName": "alpha", "saved": false, "armed": null},
    ]}));
    view.apply_overview(rows, Vec::new());
    let text = plain(&view.render(&theme(), 120, &kb()));
    assert!(
        text.contains("▸ ↳ rsi · alpha · paused · 1m30s · 3 spawns · 2 running · 4 transitions"),
        "the row updated and kept its selection:\n{text}"
    );
}

/// The overview's partial-failure contract: a reply's warnings paint beside
/// the rows that did read.
#[test]
fn unreadable_owners_warn_while_other_owners_stay_listed() {
    let rows = parse_overview_runs(&json!({"runs": [
        overview_row("run-1", "rsi", "running", "owner-a", "alpha"),
    ]}));
    let mut view = LibraryView::new(rows, vec!["sess-1".to_string()], 30);
    view.apply_machines(vec![machine("rsi", "user", "file")], Vec::new());
    view.apply_overview(
        parse_overview_runs(&json!({"runs": [
            overview_row("run-1", "rsi", "running", "owner-a", "alpha"),
        ]})),
        vec!["session owner-c: live factory graph unavailable".to_string()],
    );
    let text = plain(&view.render(&theme(), 120, &kb()));
    assert!(
        text.contains("1 overview warning: session owner-c"),
        "{text}"
    );
}

/// The overview cadence owns exactly one error slot: a successful
/// refresh clears the overview's OWN failure, never the page's other
/// reports (the machine list's failure, a drill-in failure, the row
/// report) — a page that shared one slot would lose its fetch failures
/// to the cadence's wipe.
#[test]
fn an_overview_refresh_never_wipes_the_pages_own_errors() {
    let mut view = LibraryView::new(runs(), vec!["sess-1".to_string()], 40);
    view.apply_machines(vec![machine("rsi", "user", "file")], Vec::new());
    // A fetch error and a row report land (each its own slot).
    view.set_error(Some("machine-list request refused".to_string()));
    view.set_row_notice(Some(
        "run belongs to session nightly builder — open that session to stop or resume it"
            .to_string(),
    ));
    // The overview's own failure lands beside them.
    view.set_overview_error(Some("the overview could not be read".to_string()));
    let all_three = plain(&view.render(&theme(), 120, &kb()));
    assert!(
        all_three.contains("Error: the overview could not be read"),
        "{all_three}"
    );
    assert!(
        all_three.contains("Error: machine-list request refused"),
        "{all_three}"
    );
    assert!(
        all_three.contains("run belongs to session nightly builder"),
        "{all_three}"
    );
    // A successful refresh clears ONLY the overview's slot.
    view.apply_overview(runs(), Vec::new());
    let refreshed = plain(&view.render(&theme(), 120, &kb()));
    assert!(
        !refreshed.contains("Error: the overview could not be read"),
        "{refreshed}"
    );
    assert!(
        refreshed.contains("Error: machine-list request refused"),
        "the machine list's failure survives the cadence:\n{refreshed}"
    );
    assert!(
        refreshed.contains("run belongs to session nightly builder"),
        "the row report survives the cadence:\n{refreshed}"
    );
    // A failed refresh replaces the overview's own slot, not the page's.
    view.set_overview_error(Some("timed out".to_string()));
    let failed = plain(&view.render(&theme(), 120, &kb()));
    assert!(failed.contains("Error: timed out"), "{failed}");
    assert!(
        failed.contains("Error: machine-list request refused"),
        "{failed}"
    );
    assert!(
        failed.contains("run belongs to session nightly builder"),
        "{failed}"
    );
}

/// The title and each machine's live badge count BACKED-LIVE rows only:
/// a saved snapshot in a live state stays visible but never inflates
/// the live count — `is_live` alone reads only the state and usage, so
/// it would count every durable record and every stale cached row.
#[test]
fn the_title_and_badge_count_only_backed_live_rows() {
    let rows = parse_overview_runs(&json!({"runs": [
        overview_row("run-live", "rsi", "running", "owner-a", "alpha"),
        {"runId": "run-saved", "specId": "rsi", "name": "rsi", "state": "running",
         "machine": {"states": [], "transitions": [], "order": []}, "nodes": [],
         "ownerId": "owner-b", "saved": true},
    ]}));
    let mut view = LibraryView::new(rows, vec!["sess-1".to_string()], 30);
    view.apply_machines(vec![machine("rsi", "user", "file")], Vec::new());
    let text = plain(&view.render(&theme(), 120, &kb()));
    let lines: Vec<&str> = text.lines().collect();
    assert_eq!(
        lines[0], "  machines · 1 · 1 live run",
        "the title counts the backed-live row alone:\n{text}"
    );
    assert!(
        lines[2].contains("rsi [user] ● 1 live"),
        "the badge counts the backed-live row alone:\n{text}"
    );
    // Both rows stay visible: the saved one paints its marker, never a
    // fabricated age.
    assert!(text.contains("↳ rsi · alpha · running · 1m30s"), "{text}");
    assert!(text.contains("↳ rsi · owner-b · running · saved"), "{text}");
}

/// The drill-in draws the machine as labelled boxes with the first node
/// selected; the reply's own mermaid (the `spec_to_mermaid` shape:
/// aliased state declarations, a `[*]` entry edge, and guarded
/// transitions) is not drawn a second time; ↓ walks
/// to the next node, Enter opens its files (Markdown rendered), and Esc
/// steps back to the diagram, then the list, then out.
#[test]
fn the_drill_in_draws_blocks_and_opens_each_nodes_files() {
    let data = json!({
        "runId": null,
        "specId": "rsi",
        "state": null,
        "machine": {
            "states": [
                {"id": "intake", "entry": true, "python": "intake.intake"},
                {"id": "design", "model": "openai-codex/gpt-6-astra", "subagent": "rsi-design"},
            ],
            "transitions": [{"from": "intake", "to": "design"}],
            "order": ["intake", "design"],
            "run": {"maxParallel": 3},
        },
        "nodes": [],
        "description": "Take a task to a reviewed PR.",
        "params": [{"name": "task", "type": "text"}, {"name": "max_loc", "type": "int", "default": 400}],
        "files": [
            {"path": "nodes/intake.py", "text": "def intake(inputs):\n    return {}\n"},
            {"path": "prompts/design.md", "text": "## Design\n\nWrite **DESIGN.md** for {{task}}.\n"},
        ],
        "stateFiles": [
            {"state": "intake", "paths": ["nodes/intake.py"]},
            {"state": "design", "paths": ["prompts/design.md"]},
        ],
        "mermaid": "stateDiagram-v2\n    state \"intake\" as intake\n    state \"design\" as design\n    [*] --> intake\n    intake --> design: work.design exists\n",
    });
    let mut view = LibraryView::new(Vec::new(), Vec::new(), 40);
    view.apply_machines(vec![machine("rsi", "user", "directory")], Vec::new());
    view.apply_detail("rsi", &data);
    let text = plain(&view.render(&theme(), 120, &kb()));
    for needle in [
        "machine: rsi — Take a task to a reviewed PR.",
        "params: task: text (required), max_loc: int = 400",
        "▼ start",
        "┃ intake",
        "python · intake.intake",
        "│ design",
        "agent · gpt-6-astra",
        "Enter files",
    ] {
        assert!(text.contains(needle), "missing {needle:?}:\n{text}");
    }
    // One diagram per graph: the drill-in's duplicate "mermaid diagram"
    // section retired (the design doc §3.2) — the block diagram above IS
    // the machine's one rendering.
    assert!(
        !text.contains("mermaid diagram"),
        "the duplicate mermaid section retired:\n{text}"
    );
    assert!(
        !text.contains("-->") && !text.contains("stateDiagram"),
        "mermaid renders as a diagram, never as source text:\n{text}"
    );
    assert_eq!(
        text.matches("▼ start").count(),
        1,
        "the graph renders exactly once:\n{text}"
    );
    assert_eq!(view.handle_key("down", &kb()), LibraryViewAction::None);
    assert!(
        plain(&view.render(&theme(), 120, &kb())).contains("┃ design"),
        "↓ selects the next node"
    );
    assert_eq!(view.handle_key("enter", &kb()), LibraryViewAction::None);
    let files = plain(&view.render(&theme(), 120, &kb()));
    assert!(files.contains("node: design · rsi · 1 file"), "{files}");
    assert!(files.contains("── prompts/design.md"), "{files}");
    assert!(
        files.contains("Write DESIGN.md for {{task}}."),
        "the Markdown renders:\n{files}"
    );
    assert_eq!(view.handle_key("escape", &kb()), LibraryViewAction::None);
    // Esc from the files returns to the ONE diagram (the duplicate
    // mermaid section retired).
    let back = plain(&view.render(&theme(), 120, &kb()));
    assert!(back.contains("▼ start"), "the diagram renders: {back}");
    assert!(
        !back.contains("mermaid diagram"),
        "no second render: {back}"
    );
    assert_eq!(view.handle_key("escape", &kb()), LibraryViewAction::None);
    assert!(plain(&view.render(&theme(), 120, &kb())).contains("machines · 1"));
    assert_eq!(view.handle_key("escape", &kb()), LibraryViewAction::Close);
}

/// A drill-in fixture whose `design` node carries one Markdown file, so
/// a test drives the file view over exactly the text it pins.
fn detail_with_markdown(markdown: &str) -> serde_json::Value {
    json!({
        "runId": null,
        "specId": "rsi",
        "state": null,
        "machine": {
            "states": [{"id": "design", "model": "openai-codex/gpt-6-astra", "subagent": "rsi-design"}],
            "transitions": [],
            "order": ["design"],
            "run": {"maxParallel": 3},
        },
        "nodes": [],
        "files": [{"path": "prompts/design.md", "text": markdown}],
        "stateFiles": [{"state": "design", "paths": ["prompts/design.md"]}],
        "mermaid": "",
    })
}

/// The file view with the `design` node's Markdown open (Enter on the
/// drill-in), rendered as one text page.
fn files_view(markdown: &str) -> String {
    let mut view = LibraryView::new(Vec::new(), Vec::new(), 40);
    view.apply_machines(vec![machine("rsi", "user", "directory")], Vec::new());
    view.apply_detail("rsi", &detail_with_markdown(markdown));
    let _ = view.handle_key("enter", &kb());
    plain(&view.render(&theme(), 120, &kb()))
}

/// Machine template files keep the Markdown renderer's styles in the shared files view.
#[test]
fn machine_template_markdown_keeps_its_heading_color() {
    let mut view = LibraryView::new(Vec::new(), Vec::new(), 40);
    view.apply_machines(vec![machine("rsi", "user", "directory")], Vec::new());
    view.apply_detail(
        "rsi",
        &detail_with_markdown("## Design\n\nWrite **DESIGN.md**."),
    );
    let _ = view.handle_key("enter", &kb());

    let theme = theme();
    let rows = view.render(&theme, 120, &kb());
    let heading_style = crate::markdown::MarkdownStyle::from_theme(&theme)
        .heading
        .add_modifier(ratatui::style::Modifier::BOLD);
    assert!(
        rows.iter().any(|row| {
            row.iter()
                .any(|span| span.content.contains("Design") && span.style == heading_style)
        }),
        "template Markdown keeps the colored heading style"
    );
}

/// A `` ```mermaid `` fence in a node's Markdown renders as the block diagram
/// it describes — labelled boxes and arrows, never the fence's source —
/// with the prose around it still rendered as Markdown.
#[test]
fn a_mermaid_fence_in_a_nodes_markdown_renders_as_a_diagram() {
    let text = files_view(
        "## Flow\n\n```mermaid\nflowchart TB\n    scope --> notes\n    notes --> collect\n```\n\nAfter the diagram.\n",
    );
    for needle in [
        "node: design",
        "│ scope",
        "│ collect",
        "▼",
        "After the diagram.",
    ] {
        assert!(text.contains(needle), "missing {needle:?}:\n{text}");
    }
    assert!(
        !text.contains("flowchart TB") && !text.contains("-->"),
        "the mermaid source never reaches the page:\n{text}"
    );
}

/// A mermaid type the renderer cannot draw collapses to a one-line
/// placeholder; its source never reaches the page either.
#[test]
fn an_unsupported_mermaid_type_renders_a_placeholder_not_source() {
    let text = files_view("## Notes\n\n```mermaid\nsequenceDiagram\n    Alice->>Bob: hi\n```\n");
    assert!(
        text.contains("[mermaid sequenceDiagram not rendered]"),
        "{text}"
    );
    assert!(
        !text.contains("Alice") && !text.contains("->>"),
        "an unsupported diagram never dumps its source:\n{text}"
    );
}

/// Mermaid edge labels render on their arrows: a state diagram's guarded
/// transition (`a --> b: guard`, the `spec_to_mermaid` form) and a
/// flowchart's `|label|` edge both name the arrow they ride.
#[test]
fn a_mermaid_edge_label_renders_on_its_arrow() {
    let text = files_view(
        "```mermaid\nstateDiagram-v2\n    build --> gate: report.passed eq true\n    gate --> ship\n```\n\n```mermaid\nflowchart TB\n    plan -->|ship| review\n```\n",
    );
    for needle in ["▼ true", "▼ ship", "│ build", "│ review"] {
        assert!(text.contains(needle), "missing {needle:?}:\n{text}");
    }
    assert!(
        !text.contains("-->") && !text.contains("|ship|") && !text.contains("stateDiagram"),
        "labels render on the drawn arrows, never as source:\n{text}"
    );
}

/// The rendered page fills the viewport rows exactly. Its fixture is
/// the idle page's shape — a lone quiet group, the common case — so
/// the first machine row pins where it must sit: right under the
/// title's spacer, with no separator around a lone group.
#[test]
fn the_factory_page_render_fills_the_viewport_rows() {
    let mut view = LibraryView::new(runs(), vec!["sess-1".to_string()], 30);
    view.apply_machines(vec![machine("builder", "repo", "file")], Vec::new());
    let frame = view.render(&theme(), 80, &kb());
    assert_eq!(
        frame.len(),
        30,
        "the rendered factory page fills the viewport rows"
    );
    let rows = plain(&frame);
    let lines: Vec<&str> = rows.lines().collect();
    assert!(lines[0].contains("machines · 1"));
    assert_eq!(
        lines[2], "  ▸ • builder [repo] — The builder machine.",
        "a lone quiet group paints no separator above its first row"
    );
    assert!(
        lines[29].contains("Esc close"),
        "last row pins the key hint: {:?}",
        lines.last()
    );
}

/// The malformed-reply contract: a drill-in reply that cannot parse
/// reports the error on the view's error row, never a half diagram.
#[test]
fn a_malformed_drill_in_reply_reports_the_lane_error() {
    let mut view = LibraryView::new(Vec::new(), Vec::new(), 30);
    view.apply_detail("rsi", &json!({"boom": true}));
    assert!(view.detail.is_none());
    let text = plain(&view.render(&theme(), 100, &kb()));
    assert!(
        text.contains("Error: malformed factory reply for machine rsi"),
        "{text}"
    );
}
