use super::*;
use crate::keybindings::KeybindingsManager;
use crate::theme::{ColorMode, Theme};
use serde_json::json;

fn theme() -> Theme {
    Theme::builtin("prime", ColorMode::TrueColor)
}

fn kb() -> KeybindingsManager {
    KeybindingsManager::new()
}

/// Rendered rows as trimmed plain text (tmux-capture shape).
fn frame_text(view: &mut McpView) -> Vec<String> {
    view.render(&theme(), 110, &kb())
        .iter()
        .map(|line| {
            line.iter()
                .map(|span| span.content.as_str())
                .collect::<String>()
        })
        .map(|row| row.trim_end().to_string())
        .collect()
}

/// A resolved-catalog response (the daemon's `services` array, in the daemon's TS-rank order:
/// connected-first, then label): the connected row's tool count comes from the connection record.
fn catalog_response() -> serde_json::Value {
    json!({
        "connections": [],
        "services": [
            {
                "serviceId": "fixture-echo", "label": "fixture-echo",
                "connectionStatus": "connected", "connectable": false,
                "usesOAuth": false, "source": "user",
                "connectionIds": ["fixture-echo"], "pasteToken": false,
                "aliases": null
            },
            {
                "serviceId": "notion", "label": "Notion",
                "connectionStatus": "connected", "connectable": false,
                "usesOAuth": true, "source": "catalog",
                "connectionIds": ["notion"], "pasteToken": false,
                "description": "Notion workflows.", "toolCount": 12,
                "verifiedAt": 1_790_000_000
            },
            {
                "serviceId": "linear", "label": "Linear",
                "connectionStatus": "not_connected", "connectable": true,
                "usesOAuth": true, "source": "catalog", "connectionIds": [],
                "aliases": ["linear-app"], "pasteToken": false,
                "description": "Search and update Linear issues.",
                "setupHint": null
            },
            {
                "serviceId": "github", "label": "GitHub",
                "connectionStatus": "setup_required", "connectable": false,
                "usesOAuth": false, "source": "catalog", "connectionIds": [],
                "pasteToken": true, "aliases": [],
                "description": "Inspect repositories.",
                "setupHint": "paste a GitHub personal access token"
            }
        ]
    })
}

/// The inline panel shape (TS `updateList` + `render`): ONE blank row plus ONE fixed detail line,
/// the hint — never a growing block.
#[test]
fn renders_the_ts_inline_panel_shape() {
    let mut view = McpView::from_response(&catalog_response(), 19);
    let rows = frame_text(&mut view);
    let border = "\u{2500}".repeat(110);
    assert_eq!(rows[0], border, "top rule");
    assert_eq!(rows[1], " >  Search MCP connections", "search field");
    assert_eq!(rows[2], border, "bottom rule");
    // The connected row leads (the daemon's TS rank); its status reads the honest state, and
    // the record-carried tool count reads `Connected · N tools` (TS) on the notion row.
    let selected = rows
        .iter()
        .find(|row| row.starts_with("\u{203a}"))
        .expect("selected row");
    assert!(
        selected.starts_with("\u{203a} fixture-echo"),
        "row primary: {selected}"
    );
    assert!(
        selected.ends_with("Connected"),
        "status flush right: {selected}"
    );
    assert_eq!(rows.len(), 10, "the fixed frame: {rows:?}");
    // The user stdio row's detail falls back to its status (no description); the hint
    // names the accounts step.
    let detail = rows
        .iter()
        .position(|row| row == " Connected")
        .expect("the detail line");
    assert_eq!(
        rows[detail - 1],
        "",
        "one blank row between the rows and the detail line: {rows:?}"
    );
    assert_eq!(
        rows[detail + 1],
        " \u{2191}/\u{2193} navigate \u{b7} Enter manage accounts \u{b7} Esc close",
        "the hint row"
    );
    // The notion row carries the record's tool count.
    view.handle_key("down", &kb());
    let rows = frame_text(&mut view);
    let selected = rows
        .iter()
        .find(|row| row.starts_with("\u{203a}"))
        .expect("selected row");
    assert!(
        selected.ends_with("Connected \u{b7} 12 tools"),
        "the record tool count: {selected}"
    );
    assert!(
        rows.iter().any(|row| row == " Notion workflows."),
        "the description detail line: {rows:?}"
    );
}

/// The frame never grows with the detail: at 69 catalog rows the window clamps to the viewport's
/// budget, so the dock cannot overflow the terminal.
#[test]
fn the_frame_height_stays_within_the_viewport_budget() {
    let services: Vec<serde_json::Value> = (0..69)
        .map(|index| {
            json!({
                "serviceId": format!("service-{index}"),
                "label": format!("Service {index}"),
                "connectionStatus": "not_connected", "connectable": true,
                "usesOAuth": true, "source": "catalog",
                "connectionIds": [], "pasteToken": false,
                "description": "A catalog service."
            })
        })
        .collect();
    let data = json!({ "connections": [], "services": services });
    let mut view = McpView::from_response(&data, 19);
    let lines = view.render(&theme(), 110, &kb());
    // search field (3) + window (8) + counter (1) + blank (1) + detail (1) + hint (1).
    assert_eq!(lines.len(), 15, "the dock stays inside its budget");
    assert!(
        lines.iter().any(|line| {
            line.iter()
                .map(|span| span.content.as_str())
                .collect::<String>()
                == "  (1/69)"
        }),
        "the scroll counter renders"
    );
    // A short viewport drops the detail line instead of the search field: the frame only shrinks.
    let mut view = McpView::from_response(&data, 7);
    let rows = frame_text(&mut view);
    assert_eq!(rows[0], "\u{2500}".repeat(110), "the search field stays");
    assert!(
        !rows.iter().any(|row| row.contains("A catalog service.")),
        "the detail line dropped in the short viewport: {rows:?}"
    );
    assert!(rows.len() <= 7, "the short frame stays within budget");
    // A viewport the search field and hint alone fill renders the skeleton only: no service row, no
    // scroll indicator, no detail — the empty row window is never raised back to one row.
    let mut view = McpView::from_response(&data, 4);
    let rows = frame_text(&mut view);
    assert!(rows.len() <= 4, "the skeleton owns the frame: {rows:?}");
    assert!(
        !rows.iter().any(|row| row.contains("Service 0")),
        "no service row in the too-short frame: {rows:?}"
    );
    assert!(
        !rows.iter().any(|row| row.contains("(1/69)")),
        "no scroll indicator in the too-short frame: {rows:?}"
    );
    // The selected not-connected catalog row's action names the hint (TS `actionText`):
    // no `Enter select` filler.
    assert_eq!(
        rows.last().map(String::as_str),
        Some(" \u{2191}/\u{2193} navigate \u{b7} Enter connect \u{b7} Esc close"),
        "the hint rides the skeleton's last row"
    );
}

/// The TS row vocabulary: the pasteable row keeps its honest `Requires setup` status while
/// the hint names the paste step, and the setup hint is its detail copy.
#[test]
fn pasteable_rows_keep_the_honest_status() {
    let mut view = McpView::from_response(&catalog_response(), 19);
    for _ in 0..3 {
        view.handle_key("down", &kb());
    }
    assert_eq!(view.selected_server(), Some("github"));
    let rows = frame_text(&mut view);
    assert!(
        rows.iter().any(|row| row.ends_with("Requires setup")),
        "trailing status: {rows:?}"
    );
    assert!(
        rows.iter()
            .any(|row| row
                == " \u{2191}/\u{2193} navigate \u{b7} Enter paste token \u{b7} Esc close"),
        "the paste action hint names the step: {rows:?}"
    );
    assert!(
        rows.iter()
            .any(|row| row == " paste a GitHub personal access token"),
        "the setup hint detail: {rows:?}"
    );
}

/// Enter routes by row kind: a pasteable token service opens the paste
/// flow; every other row runs its login (the re-verify path).
#[test]
fn enter_routes_paste_and_connect() {
    let mut view = McpView::from_response(&catalog_response(), 19);
    assert_eq!(
        view.handle_key("enter", &kb()),
        McpViewAction::Select {
            server: "fixture-echo".to_string(),
            label: "fixture-echo".to_string(),
        }
    );
    view.handle_key("down", &kb());
    assert_eq!(
        view.handle_key("enter", &kb()),
        McpViewAction::Select {
            server: "notion".to_string(),
            label: "Notion".to_string(),
        }
    );
    view.handle_key("down", &kb());
    assert_eq!(
        view.handle_key("enter", &kb()),
        McpViewAction::Select {
            server: "linear".to_string(),
            label: "Linear".to_string(),
        }
    );
    view.handle_key("down", &kb());
    assert_eq!(
        view.handle_key("enter", &kb()),
        McpViewAction::Paste {
            server: "github".to_string(),
            label: "GitHub".to_string(),
        }
    );
}

/// A response with the api-key credential section (the daemon's
/// `credentials` array: the stored keys the view manages alongside the
/// connections).
fn credentials_response() -> serde_json::Value {
    let mut response = catalog_response();
    response["credentials"] = json!([
        {"id": "serper", "label": "Serper (web search)", "configured": false}
    ]);
    response
}

/// The api-key credential rows render alongside the connections: the row
/// rides after the service cards, carries its honest status, and Enter
/// routes to the paste-the-key flow.
#[test]
fn credential_rows_render_and_route() {
    let mut view = McpView::from_response(&credentials_response(), 19);
    // The credential row rides after the service cards.
    assert_eq!(view.selected_server(), Some("fixture-echo"));
    for _ in 0..4 {
        view.handle_key("down", &kb());
    }
    assert_eq!(view.selected_server(), Some("serper"));
    let rows = frame_text(&mut view);
    let selected = rows
        .iter()
        .find(|row| row.starts_with("\u{203a}"))
        .expect("selected row");
    assert!(
        selected.starts_with("\u{203a} Serper (web search)"),
        "the credential row renders its label: {selected}"
    );
    assert!(
        selected.ends_with("Not configured"),
        "the unconfigured credential row keeps the honest status: {selected}"
    );
    // A credential row carries no description: the detail line falls back
    // to its status (TS `secondaryText ?? statusText`).
    assert!(
        rows.iter().any(|row| row == " Not configured"),
        "the detail line: {rows:?}"
    );
    assert_eq!(
        rows.last().map(String::as_str),
        Some(" \u{2191}/\u{2193} navigate \u{b7} Enter add key \u{b7} Esc close"),
        "the hint names the add-key step"
    );
    assert_eq!(
        view.handle_key("enter", &kb()),
        McpViewAction::Key {
            id: "serper".to_string(),
            label: "Serper (web search)".to_string(),
        }
    );
}

/// A configured credential row reads `Configured` and its hint names the
/// replace step (the same prompt replaces the stored key).
#[test]
fn a_configured_credential_names_the_replace_step() {
    let mut response = credentials_response();
    response["credentials"] = json!([
        {"id": "serper", "label": "Serper (web search)", "configured": true}
    ]);
    let mut view = McpView::from_response(&response, 19);
    for _ in 0..4 {
        view.handle_key("down", &kb());
    }
    let rows = frame_text(&mut view);
    let selected = rows
        .iter()
        .find(|row| row.starts_with("\u{203a}"))
        .expect("selected row");
    assert!(
        selected.ends_with("Configured"),
        "the configured status: {selected}"
    );
    assert_eq!(
        rows.last().map(String::as_str),
        Some(" \u{2191}/\u{2193} navigate \u{b7} Enter replace key \u{b7} Esc close"),
        "the hint names the replace-key step"
    );
}

/// The credential rows join the search: the identity fields (label, id)
/// match, and a non-matching query filters them out.
#[test]
fn the_credential_rows_join_the_search() {
    let mut view = McpView::from_response(&credentials_response(), 19);
    view.set_search("serper");
    assert_eq!(view.selected_server(), Some("serper"));
    let rows = frame_text(&mut view);
    assert!(
        rows.iter().any(|row| row.contains("Serper (web search)")),
        "the credential row matches its id: {rows:?}"
    );
    view.set_search("zzz");
    assert_eq!(view.selected_server(), None);
}

/// The TS navigation: arrows clamp at the list's bounds — up at the
/// first row stays there, down at the last row stays there (never the
/// wrap-around the port had).
#[test]
fn navigation_clamps_at_the_list_bounds() {
    let mut view = McpView::from_response(&catalog_response(), 19);
    assert_eq!(
        view.handle_key("up", &kb()),
        McpViewAction::None,
        "up at the first row is inert"
    );
    assert_eq!(view.selected_server(), Some("fixture-echo"));
    for _ in 0..8 {
        view.handle_key("down", &kb());
    }
    assert_eq!(view.selected_server(), Some("github"));
    assert_eq!(
        view.handle_key("down", &kb()),
        McpViewAction::None,
        "down at the last row is inert"
    );
    assert_eq!(view.selected_server(), Some("github"));
}

/// Escape and Ctrl+C close without selecting; the modal back key (the #2730 auth-panel navigation)
/// closes from an EMPTY search, and edits the field once the caret sits inside it.
#[test]
fn escape_cancels() {
    let mut view = McpView::from_response(&catalog_response(), 19);
    assert_eq!(view.handle_key("escape", &kb()), McpViewAction::Cancel);
    assert_eq!(view.handle_key("ctrl+c", &kb()), McpViewAction::Cancel);
    assert_eq!(
        view.handle_key("left", &kb()),
        McpViewAction::Cancel,
        "back closes from the empty search"
    );
    assert_eq!(view.search.value(), "");
    let mut view = McpView::from_response(&catalog_response(), 19);
    for character in "lin".chars() {
        view.handle_key(&character.to_string(), &kb());
    }
    assert_eq!(
        view.handle_key("left", &kb()),
        McpViewAction::None,
        "left edits the search field with a caret inside"
    );
    assert_eq!(view.search.value(), "lin");
}

/// The banded search: identity fields (label, id, aliases) rank before description text; the
/// subsequence fallback finds tight abbreviations; every query token must match.
#[test]
fn search_ranks_identity_fields_before_descriptions() {
    let mut view = McpView::from_response(&catalog_response(), 19);
    // "github" matches the identity field first.
    for character in "github".chars() {
        view.handle_key(&character.to_string(), &kb());
    }
    let rows = frame_text(&mut view);
    let selected = rows
        .iter()
        .find(|row| row.starts_with("\u{203a}"))
        .expect("selected row");
    assert!(
        selected.starts_with("\u{203a} GitHub"),
        "identity ranks first: {selected} (all: {rows:?})"
    );
    // The alias band: "linear-app" finds Linear.
    let mut view = McpView::from_response(&catalog_response(), 19);
    for character in "linear-app".chars() {
        view.handle_key(&character.to_string(), &kb());
    }
    let rows = frame_text(&mut view);
    assert!(
        rows.iter().any(|row| row.contains("Linear")),
        "alias band: {rows:?}"
    );
    // Every token must match: "linear github" matches nothing.
    let mut view = McpView::from_response(&catalog_response(), 19);
    for character in "linear github".chars() {
        view.handle_key(&character.to_string(), &kb());
    }
    let rows = frame_text(&mut view);
    assert!(rows.iter().any(|row| row == "  No matching services"));
}

/// The TS scoring bands exactly: prefix ties break on the remaining length, substring ties on the
/// position, the subsequence fallback carries its run floor and span penalty.
#[test]
fn search_scores_match_the_ts_bands() {
    let data = json!({
        "connections": [],
        "services": [
            {
                "serviceId": "linear", "label": "Linear",
                "connectionStatus": "not_connected", "connectable": true,
                "usesOAuth": true, "source": "catalog", "connectionIds": [],
                "pasteToken": false, "aliases": [], "description": "linear one"
            },
            {
                "serviceId": "linear-support", "label": "linear-support",
                "connectionStatus": "not_connected", "connectable": true,
                "usesOAuth": true, "source": "catalog", "connectionIds": [],
                "pasteToken": false, "aliases": [], "description": "x"
            }
        ]
    });
    let view = McpView::from_response(&data, 19);
    let row = |id: &str| {
        view.rows
            .iter()
            .find(|row| row.target() == id)
            .expect("row")
    };
    // The exact band.
    assert_eq!(row_search_score(row("linear"), "linear"), Some(SCORE_EXACT));
    // The prefix band: "linear" prefixes both; the remaining-length
    // tiebreak scores the longer label.
    assert_eq!(
        row_search_score(row("linear-support"), "linear"),
        Some(SCORE_PREFIX + 8.0 * 0.01)
    );
    // The description band only when no identity field matched: a word-start match
    // there outranks a substring match.
    let github = json!({
        "serviceId": "github", "label": "GitHub", "aliases": [],
        "description": "timelinearity charts"
    });
    let github = McpServiceRow::from_value(&github).expect("row");
    assert_eq!(
        row_search_score(&McpRow::Service(github), "linear"),
        Some(SCORE_DESCRIPTION_SUBSTRING + 4.0 * 0.01)
    );
    // The subsequence fallback with its run floor: "crdb"-style abbreviations match,
    // scattered matches do not.
    let cockroach = json!({
        "serviceId": "cockroachdb", "label": "CockroachDB", "aliases": [],
        "description": "the SQL database"
    });
    let cockroach = McpServiceRow::from_value(&cockroach).expect("row");
    let cockroach = McpRow::Service(cockroach);
    let score = row_search_score(&cockroach, "crdb");
    assert!(score.is_some(), "the tight abbreviation matches");
    assert_eq!(
        row_search_score(&cockroach, "cxxx"),
        None,
        "the scattered match is rejected"
    );
    // The sum: a two-token query sums each token's best field score.
    let notion = json!({
        "serviceId": "notion", "label": "Notion", "aliases": [],
        "description": "Notion workflows."
    });
    let notion = McpServiceRow::from_value(&notion).expect("row");
    assert_eq!(
        row_search_score(&McpRow::Service(notion), "notion workflows"),
        Some(SCORE_EXACT + SCORE_DESCRIPTION_WORD_START)
    );
}

/// The empty roster and the no-match row keep the TS messages, each
/// with its blank row above the hint.
#[test]
fn the_empty_roster_renders_the_empty_message() {
    let mut view = McpView::from_response(&json!({}), 19);
    let rows = frame_text(&mut view);
    let message = rows
        .iter()
        .position(|row| row == "  No external services available")
        .expect("the empty message");
    assert_eq!(rows[message + 1], "", "the blank row before the hint");
    assert_eq!(
        rows[message + 2],
        " \u{2191}/\u{2193} navigate \u{b7} Esc close",
        "no action filler in the hint (TS)"
    );
    // A query with no matches.
    let mut view = McpView::from_response(&catalog_response(), 19);
    for character in "zzz".chars() {
        view.handle_key(&character.to_string(), &kb());
    }
    let rows = frame_text(&mut view);
    assert!(rows.iter().any(|row| row == "  No matching services"));
    assert!(
        rows.iter().any(|row| row.contains("Esc close")),
        "the hint still renders: {rows:?}"
    );
}

/// A query change resets the selection to the first row (TS `filterServices`), typing
/// filters to the surviving rows, and the bracketed paste edits the search field too.
#[test]
fn typing_filters_by_label_and_alias() {
    let mut view = McpView::from_response(&catalog_response(), 19);
    for character in "linear".chars() {
        view.handle_key(&character.to_string(), &kb());
    }
    let rows = frame_text(&mut view);
    assert!(
        rows.iter().any(|row| row.contains("Linear")),
        "filtered row: {rows:?}"
    );
    assert!(
        !rows.iter().any(|row| row.contains("Notion")),
        "non-match filtered out: {rows:?}"
    );
    assert_eq!(
        view.handle_key("enter", &kb()),
        McpViewAction::Select {
            server: "linear".to_string(),
            label: "Linear".to_string(),
        },
        "Enter applies the surviving match"
    );
    view.paste("-app");
    let rows = frame_text(&mut view);
    assert!(
        rows.iter().any(|row| row.starts_with("\u{203a} Linear")),
        "the alias still matches after the paste: {rows:?}"
    );
}

/// TS string operations run on UTF-16 code units: a surrogate pair is TWO units to the
/// subsequence walk, and the substring tiebreak measures unit positions. The emoji query
/// ranks exactly like the TS picker (the review finding).
#[test]
fn scoring_measures_utf16_units_like_ts() {
    // The prefix tiebreak: the rest after the emoji prefix is one more emoji — TWO
    // UTF-16 units, not one char (TS `.length`).
    assert_eq!(
        identity_match_score("\u{1f600}\u{1f600}", "\u{1f600}"),
        Some(SCORE_PREFIX + 2.0 * 0.01),
        "the prefix remainder counts UTF-16 units"
    );
    // The substring tiebreak: inside "xy" (a word the emoji split keeps whole) the token
    // "y" is NOT a word start, so the substring position after the two-unit emoji is 3 —
    // a UTF-16 unit index, not the byte offset 6.
    assert_eq!(
        identity_match_score("\u{1f600}xy", "y"),
        Some(SCORE_SUBSTRING + 3.0 * 0.01),
        "the substring position is a UTF-16 unit index"
    );
    // The subsequence walk matches surrogate halves like TS: the query "\u{1f600}a" (3 units) is a
    // subsequence of "\u{1f600}x a" (5 units) with the emoji's two consecutive units as a run.
    let haystack: Vec<u16> = "\u{1f600}x a".encode_utf16().collect();
    let token: Vec<u16> = "\u{1f600}a".encode_utf16().collect();
    assert_eq!(
        subsequence_match_score(&haystack, &token),
        Some(SCORE_SUBSEQUENCE + 2.0 * 2.0),
        "the subsequence span counts UTF-16 units (last 4 - first 0 + 1 - len 3 = 2)"
    );
}

/// A viewport too short for the empty state's message and its blank row keeps the
/// skeleton alone (the frame never draws past its viewport; the review finding).
#[test]
fn the_empty_state_needs_its_window_budget() {
    let data = json!({ "connections": [], "services": [] });
    let mut view = McpView::from_response(&data, 5);
    let rows = frame_text(&mut view);
    assert!(rows.len() <= 5, "the too-short empty frame fits: {rows:?}");
    assert!(
        !rows.iter().any(|row| row.contains("No external services")),
        "the message stays behind its budget: {rows:?}"
    );
    // Once the viewport budgets the two rows, the message rides.
    let mut view = McpView::from_response(&data, 6);
    let rows = frame_text(&mut view);
    assert!(
        rows.iter().any(|row| row.contains("No external services")),
        "the message renders inside its budget: {rows:?}"
    );
    assert!(rows.len() <= 6, "the empty frame fits: {rows:?}");
}

/// A narrow row keeps a SHORTENED trailing status (TS `getInlineTrailing`: the cluster reduces from
/// the front, then truncates with the ellipsis) instead of dropping it (the review finding).
#[test]
fn narrow_rows_shorten_the_trailing_status() {
    let theme = theme();
    // Width 24: the trailing budget is 17, so the 19-wide status SHORTENS with the
    // ellipsis instead of dropping off the row.
    let row = trailing_menu_row(
        &theme,
        24,
        vec![Span::raw("CockroachDB")],
        &[(ThemeColor::Success, "Connected \u{b7} 12 tools")],
        true,
    );
    let text = row
        .iter()
        .map(|span| span.content.as_str())
        .collect::<String>();
    assert_eq!(
        crate::width::str_width(text.trim_end()),
        24,
        "the row stays exactly the width: {text:?}"
    );
    assert!(
        text.contains('\u{2026}'),
        "the status shortens with the ellipsis: {text:?}"
    );
    assert!(
        text.contains("Connected"),
        "the shortened status stays on the row: {text:?}"
    );
}

/// A prefill from a typed partial (`/mcp lin` + Tab or `/plugins lin`) filters the view,
/// the caret at the partial's end so typing extends it.
#[test]
fn set_search_filters_to_the_typed_partial() {
    let mut view = McpView::from_response(&catalog_response(), 19);
    view.set_search("lin");
    assert_eq!(view.search.cursor(), 3, "the caret sits after lin");
    view.handle_key("e", &kb());
    assert_eq!(view.search.value(), "line");
    let rows = frame_text(&mut view);
    assert!(
        rows.iter().any(|row| row.contains("Linear")),
        "the partial keeps the matching service: {rows:?}"
    );
    assert!(
        !rows.iter().any(|row| row.contains("GitHub")),
        "the non-matching rows drop: {rows:?}"
    );
    assert_eq!(
        view.handle_key("enter", &kb()),
        McpViewAction::Select {
            server: "linear".to_string(),
            label: "Linear".to_string(),
        },
        "Enter applies the surviving match"
    );
}
