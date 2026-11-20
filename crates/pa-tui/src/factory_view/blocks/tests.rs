use super::*;
use crate::theme::ColorMode;
use serde_json::json;

thread_local! {
    static ORDERING_VISITS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

pub(super) fn count_ordering_visit() {
    ORDERING_VISITS.with(|visits| visits.set(visits.get() + 1));
}

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
fn an_empty_machine_has_no_diagram_rows() {
    let diagram = block_diagram(&Theme::builtin("prime", ColorMode::TrueColor), &[], &[]);
    assert!(diagram.lines.is_empty());
    assert!(diagram.node_rows.is_empty());
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
    let diagram = block_diagram(&theme, &states, &transitions);
    let text = plain(&diagram);
    for needle in [
        "▼ start",
        "│ plan",
        "│ review",
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
    let text = plain(&block_diagram(&theme, &states, &transitions));
    assert_eq!(
        text.lines().filter(|line| line.contains(" join")).count(),
        2,
        "{text}"
    );
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
fn self_loop_labels_leave_neighbor_boxes_intact() {
    let mut neighbor = state("neighbor", false);
    neighbor.lifecycle = "resident".to_string();
    let states = vec![state("start", true), state("again", false), neighbor];
    let transitions = vec![
        transition(&["start"], "again", None),
        transition(&["start"], "neighbor", None),
        transition(
            &["again"],
            "again",
            Some(json!({"output": "route", "op": "eq", "value": "repeat after inspection"})),
        ),
    ];
    let diagram = block_diagram(
        &Theme::builtin("prime", ColorMode::TrueColor),
        &states,
        &transitions,
    );
    let text = plain(&diagram);
    assert!(text.contains("↺ repeat after inspection"), "{text}");
    let detail_row = text.lines().nth(diagram.node_rows[2] + 2).unwrap();
    assert!(detail_row.contains("│ resident"), "{text}");
}

#[test]
fn incoming_guards_stay_with_their_source_before_merging() {
    let states = vec![state("a", true), state("b", true), state("c", false)];
    let transitions = vec![
        transition(
            &["a"],
            "c",
            Some(json!({"output": "route", "op": "eq", "value": "approve after inspection"})),
        ),
        transition(
            &["b"],
            "c",
            Some(json!({"output": "route", "op": "eq", "value": "retry"})),
        ),
    ];
    let diagram = block_diagram(
        &Theme::builtin("prime", ColorMode::TrueColor),
        &states,
        &transitions,
    );
    let text = plain(&diagram);
    let title_row = text.lines().nth(diagram.node_rows[0] + 1).unwrap();
    for (source, guard) in [("a", "approve after inspection"), ("b", "retry")] {
        let title = format!("│ {source}");
        let left = title_row.find(&title).unwrap();
        let center = title_row[..left].chars().count() + 4;
        let (row, line) = text
            .lines()
            .enumerate()
            .find(|(_, line)| line.contains(guard))
            .unwrap();
        assert!(
            row > diagram.node_rows[0] + 3 && row < diagram.node_rows[2],
            "{text}"
        );
        let guard_at = line[..line.find(guard).unwrap()].chars().count();
        assert_eq!(
            guard_at,
            center + 2,
            "guard {guard} must leave {source}:\n{text}"
        );
        assert_eq!(line.chars().nth(center), Some('│'), "{text}");
        assert!(
            !line.contains("▼"),
            "guard must precede the merged arrow:\n{text}"
        );
    }
}

#[test]
fn dense_dag_ordering_finishes_without_scanning_unrelated_segments() {
    // Exercise ordering alone: a dense rendered canvas is a different cost.
    let n = 20;
    let mut layers: Vec<Vec<usize>> = (0..n).map(|item| vec![item]).collect();
    let mut segments = Vec::new();
    let mut items = n;
    for from in 0..n {
        for to in from + 1..n {
            let mut previous = from;
            for row in layers.iter_mut().take(to).skip(from + 1) {
                row.push(items);
                segments.push(Segment {
                    from: previous,
                    to: items,
                    label: None,
                });
                previous = items;
                items += 1;
            }
            segments.push(Segment {
                from: previous,
                to,
                label: None,
            });
        }
    }
    let mut incoming = vec![Vec::new(); items];
    let mut outgoing = vec![Vec::new(); items];
    for (edge, segment) in segments.iter().enumerate() {
        incoming[segment.to].push(edge);
        outgoing[segment.from].push(edge);
    }
    ORDERING_VISITS.with(|visits| visits.set(0));
    order_layers(&mut layers, &segments, &incoming, &outgoing);
    // Each down/up sweep visits every segment once. There are two sweeps.
    assert_eq!(
        ORDERING_VISITS.with(std::cell::Cell::get),
        segments.len() * 4
    );
    assert_eq!(layers.iter().map(Vec::len).sum::<usize>(), items);
}
