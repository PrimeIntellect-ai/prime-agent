use super::*;
use crate::theme::ColorMode;
use serde_json::json;

fn plain(diagram: &BlockDiagram) -> String {
    diagram
        .lines
        .iter()
        .map(|line| {
            line.iter()
                .map(|span| span.content.as_str())
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn state(id: &str, entry: bool) -> FactoryState {
    FactoryState::parse(&json!({"id": id, "entry": entry})).unwrap()
}

fn transition(from: &[&str], to: &str, when: Option<serde_json::Value>) -> FactoryTransition {
    let mut value = json!({"from": from, "to": to});
    if from.len() == 1 {
        value["from"] = json!(from[0]);
    }
    if let Some(when) = when {
        value["when"] = when;
    }
    FactoryTransition::parse(&value).unwrap()
}

#[test]
fn draws_boxes_forward_edges_back_edges_and_labels() {
    let mut review = state("review", false);
    review.model = Some("prime-inference/anthropic/claude-opus-5.5".to_string());
    let mut triage = state("triage", false);
    triage.python = Some("triage.decide".to_string());
    let states = vec![state("plan", true), review, triage, state("ship", false)];
    let transitions = vec![
        transition(&["plan"], "review", None),
        transition(&["review"], "triage", None),
        transition(
            &["triage"],
            "ship",
            Some(json!({"output": "action", "op": "eq", "value": "ship"})),
        ),
        transition(
            &["triage"],
            "plan",
            Some(json!({"output": "action", "op": "eq", "value": "rework"})),
        ),
    ];
    let theme = Theme::builtin("prime", ColorMode::TrueColor);
    let diagram = block_diagram(&theme, &states, &transitions, Some(1), None);
    let text = plain(&diagram);
    for needle in [
        "▼ start",
        "│ plan",
        "┃ review",
        "agent · claude-opus-5.5",
        "python · triage.decide",
        "▼ ship",
        " rework ",
    ] {
        assert!(text.contains(needle), "missing {needle:?}:\n{text}");
    }
    // Each state's box starts on its own row, top to bottom.
    assert!(
        diagram.node_rows.windows(2).all(|pair| pair[0] < pair[1]),
        "{:?}",
        diagram.node_rows
    );
}

#[test]
fn a_join_fans_in_and_a_long_edge_runs_through_the_skipped_layers() {
    let states = vec![
        state("a", true),
        state("b", false),
        state("c", false),
        state("d", false),
    ];
    let transitions = vec![
        transition(&["a"], "b", None),
        transition(&["a"], "c", None),
        transition(&["b", "c"], "d", None),
        transition(&["a"], "d", Some(json!({"output": "skip", "op": "exists"}))),
    ];
    let theme = Theme::builtin("prime", ColorMode::TrueColor);
    let text = plain(&block_diagram(&theme, &states, &transitions, None, None));
    assert!(text.contains("▼ join"), "{text}");
    assert!(
        text.contains("skip exists"),
        "the guard labels the long edge:\n{text}"
    );
    // b and c share a layer: their boxes sit on one row.
    let row_of = |id: &str| {
        text.lines()
            .position(|line| line.contains(&format!("│ {id}")))
            .unwrap()
    };
    assert_eq!(row_of("b"), row_of("c"));
}

#[test]
fn dense_diagrams_do_not_allocate_an_unbounded_canvas() {
    let states: Vec<_> = (0..40).map(|i| state(&format!("s{i}"), i == 0)).collect();
    let transitions: Vec<_> = (0..states.len())
        .flat_map(|from| (from + 1..states.len()).map(move |to| (from, to)))
        .map(|(from, to)| transition(&[&states[from].id], &states[to].id, None))
        .collect();
    let diagram = block_diagram(
        &Theme::builtin("prime", ColorMode::TrueColor),
        &states,
        &transitions,
        None,
        None,
    );
    assert_eq!(diagram.lines.len(), 1);
    assert_eq!(diagram.node_rows, vec![0; states.len()]);
    assert!(plain(&diagram).contains("40 states, 780 transitions"));
}

#[test]
fn long_back_edge_guards_stay_complete_before_the_gutter() {
    let theme = Theme::builtin("prime", ColorMode::TrueColor);
    for label in [
        "0123456789abcdefghijklmnopqrstuvwxyz",
        "review all the inputs before trying again",
    ] {
        let transitions = vec![
            transition(&["a"], "b", None),
            transition(
                &["b"],
                "a",
                Some(json!({"output": "route", "op": "eq", "value": label})),
            ),
        ];
        let text = plain(&block_diagram(
            &theme,
            &[state("a", true), state("b", false)],
            &transitions,
            None,
            None,
        ));
        let departure = text
            .lines()
            .find(|row| row.contains(label))
            .unwrap_or_else(|| panic!("missing full label {label:?}:\n{text}"));
        let after_label = departure.split_once(label).unwrap().1;
        assert!(
            after_label.contains('┘'),
            "gutter bend must follow the full label:\n{text}"
        );
    }
}

#[test]
fn back_edge_guards_clear_forward_wires_on_their_departure_row() {
    let states = vec![
        state("a", true),
        state("b", false),
        state("c", false),
        state("e", false),
        state("d", false),
    ];
    let label = "rework after every inspection pass";
    let transitions = vec![
        transition(&["a"], "b", None),
        transition(&["a"], "c", None),
        transition(&["a"], "e", None),
        transition(&["b"], "d", None),
        transition(&["c"], "d", None),
        transition(&["e"], "d", None),
        transition(
            &["c"],
            "a",
            Some(json!({"output": "route", "op": "eq", "value": label})),
        ),
    ];
    let diagram = block_diagram(
        &Theme::builtin("prime", ColorMode::TrueColor),
        &states,
        &transitions,
        None,
        None,
    );
    let text = plain(&diagram);
    let departure = text
        .lines()
        .find(|row| row.contains(&format!(" {label} ")))
        .unwrap_or_else(|| panic!("the full back-edge guard must survive its row:\n{text}"));
    assert!(
        departure.contains(&format!(" {label} ")),
        "a crossing replaced a guard character:\n{text}"
    );
}
