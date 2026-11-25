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
fn a_self_loop_label_leaves_room_for_the_next_box() {
    let states = vec![state("a", true), state("b", false), state("c", false)];
    let transitions = vec![
        transition(&["a"], "b", None),
        transition(&["a"], "c", None),
        transition(&["b"], "b", None),
    ];
    let diagram = block_diagram(
        &Theme::builtin("prime", ColorMode::TrueColor),
        &states,
        &transitions,
        None,
        None,
    );
    let text = plain(&diagram);
    let row = text
        .lines()
        .find(|row| row.contains("↺ again"))
        .unwrap_or_else(|| panic!("the self-loop label renders:\n{text}"));
    assert_eq!(
        row.matches("│ agent").count(),
        2,
        "the sibling box's detail row stays whole beside the label:\n{text}"
    );
}
