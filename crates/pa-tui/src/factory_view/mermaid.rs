//! Mermaid diagram text drawn in the terminal: the subset the machine
//! library actually carries — the `stateDiagram-v2` and `flowchart TB`
//! graphs `rlm.factory`'s `spec_to_mermaid` writes for every machine, and
//! the same shapes inside a `` ```mermaid `` fence in a node's Markdown. The
//! parse feeds the block-diagram renderer's own graph, so mermaid is just
//! another source for the one diagram renderer; diagram types it cannot
//! draw (sequence, gantt, …) collapse to a one-line placeholder, and a
//! block that carries no graph renders nothing. Mermaid source text never
//! reaches the page.

use super::blocks::block_diagram;
use super::diagram::{FactoryState, FactoryTransition};
use crate::theme::{Theme, ThemeColor};
use crate::{Line, Span};

/// One mermaid block: a graph the block-diagram renderer can draw, or a
/// diagram type it cannot.
#[derive(Debug, Clone, PartialEq)]
pub(super) enum Mermaid {
    Diagram {
        states: Vec<FactoryState>,
        transitions: Vec<FactoryTransition>,
    },
    /// A type the renderer does not draw, by its type word
    /// (`sequenceDiagram`, `gantt`, …).
    Unsupported(String),
}

/// The diagram's type word: the first word of the first line that is not
/// blank or a `%%` comment (`stateDiagram-v2`'s `stateDiagram`,
/// `flowchart TB`'s `flowchart`).
fn kind_word(text: &str) -> Option<&str> {
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with("%%"))
        .and_then(|line| line.split_whitespace().next())
}

/// Parse one mermaid block. `stateDiagram` (v2 included) and
/// `flowchart`/`graph` answer the graph the renderer draws; every other
/// type answers [`Mermaid::Unsupported`] by its type word, and text with
/// no type word answers `None` (an empty fence renders nothing).
pub(super) fn parse_mermaid(text: &str) -> Option<Mermaid> {
    let kind = kind_word(text)?;
    if kind.starts_with("stateDiagram") {
        return Some(parse_state_diagram(text));
    }
    if kind == "flowchart" || kind == "graph" {
        return Some(parse_flowchart(text));
    }
    Some(Mermaid::Unsupported(kind.to_string()))
}

/// Node ids in first-seen order, entry ids, and edges as read.
#[derive(Default)]
struct Graph {
    ids: Vec<String>,
    entry: std::collections::HashSet<String>,
    edges: Vec<FactoryTransition>,
}

impl Graph {
    fn node(&mut self, id: &str) {
        if !self.ids.iter().any(|known| known == id) {
            self.ids.push(id.to_string());
        }
    }

    fn edge(&mut self, from: &str, to: &str, label: Option<String>) {
        self.node(from);
        self.node(to);
        self.edges.push(FactoryTransition {
            from: vec![from.to_string()],
            to: to.to_string(),
            when: label.clone(),
            label,
        });
    }

    /// Keep Mermaid ids for lookup and put display text on the second box line.
    fn finish(self, labels: &std::collections::HashMap<String, String>) -> Mermaid {
        let states = self
            .ids
            .iter()
            .map(|id| FactoryState {
                id: id.clone(),
                entry: self.entry.contains(id),
                lifecycle: "task".to_string(),
                max_entries: 1,
                subagent: None,
                python: None,
                model: None,
                label: Some(labels.get(id).cloned().unwrap_or_default()),
            })
            .collect();
        Mermaid::Diagram {
            states,
            transitions: self.edges,
        }
    }
}

/// `stateDiagram-v2`: `state "label" as id` gives an id its display name,
/// `[*] --> id` marks the entry states, `a --> b` is an edge, and
/// `a --> b: label` names it. `--> [*]` is the terminal marker (it draws
/// no box); lines the subset does not know (composite states, notes)
/// drop, the way mermaid's own grammar drops what it cannot place.
fn parse_state_diagram(text: &str) -> Mermaid {
    let mut graph = Graph::default();
    let mut labels = std::collections::HashMap::new();
    let mut past_header = false;
    for line in text
        .lines()
        .map(str::trim)
        .filter(|line| !line.starts_with("%%"))
    {
        if !past_header {
            past_header = line.starts_with("stateDiagram");
            continue;
        }
        if let Some((label, id)) = line
            .strip_prefix("state ")
            .and_then(split_state_declaration)
        {
            graph.node(&id);
            labels.insert(id, label);
            continue;
        }
        let Some((from, rest)) = line.split_once("-->") else {
            continue;
        };
        let (to, label) = split_edge_label(rest);
        if from.trim() == "[*]" {
            if let Some(to) = to {
                graph.node(&to);
                graph.entry.insert(to);
            }
            continue;
        }
        let Some(from) = bare_id(from) else {
            continue;
        };
        graph.node(&from);
        let Some(to) = to else {
            continue;
        };
        graph.edge(&from, &to, label);
    }
    graph.finish(&labels)
}

/// `state "label" as id`: the quoted form `spec_to_mermaid` writes, and
/// the bare `state label as id` reading of the same shape.
fn split_state_declaration(rest: &str) -> Option<(String, String)> {
    let rest = rest.trim();
    let (label, tail) = if let Some(rest) = rest.strip_prefix('"') {
        let (label, tail) = rest.split_once("\" ")?;
        (label.to_string(), tail)
    } else {
        let (label, tail) = rest.split_once(' ')?;
        (label.to_string(), tail)
    };
    let id = tail.strip_prefix("as ")?.trim();
    (!id.is_empty() && !label.is_empty()).then(|| (label, id.to_string()))
}

/// A state-diagram node id: the first bare token (`[*` markers answer
/// `None`, so a terminal edge drops).
fn bare_id(token: &str) -> Option<String> {
    let id = token.split_whitespace().next()?;
    (id != "[*]").then(|| id.to_string())
}

/// An edge's right side: the target id and the `: label` that names the
/// edge, when it carries one.
fn split_edge_label(rest: &str) -> (Option<String>, Option<String>) {
    let (to, label) = rest.split_once(':').map_or((rest, None), |(to, label)| {
        (to, Some(label.trim().to_string()))
    });
    (bare_id(to), label)
}

/// `flowchart TB` (or `graph`): node lines (`id`, `id[label]`,
/// `id(label)`, `id{label}`, `id([...)]`, quotes inside) and `-->` edges,
/// chained across one line, with a `|label|` prefix naming the edge that
/// ends at the token. The direction token is read but the block-diagram
/// layout is top-down.
fn parse_flowchart(text: &str) -> Mermaid {
    let mut graph = Graph::default();
    let mut labels = std::collections::HashMap::new();
    let mut past_header = false;
    for line in text
        .lines()
        .map(str::trim)
        .filter(|line| !line.starts_with("%%"))
    {
        if !past_header {
            past_header = line.starts_with("flowchart") || line.starts_with("graph");
            continue;
        }
        let parts = split_flow_arrows(line);
        if parts.len() < 2 {
            if let Some((id, label)) = parse_flow_node(line) {
                graph.node(&id);
                if let Some(label) = label {
                    labels.insert(id, label);
                }
            }
            continue;
        }
        for pair in parts.windows(2) {
            // The left token's own `|label|` prefix belongs to the edge
            // before it, which already read it as its right token.
            let (_, left) = split_pipe_label(pair[0]);
            let Some((from, from_label)) = parse_flow_node(left) else {
                continue;
            };
            let (edge_label, right) = split_pipe_label(pair[1]);
            let Some((to, to_label)) = parse_flow_node(right) else {
                continue;
            };
            for (id, label) in [(&from, from_label), (&to, to_label)] {
                if let Some(label) = label {
                    labels.insert(id.clone(), label);
                }
            }
            graph.edge(&from, &to, edge_label);
        }
    }
    graph.finish(&labels)
}

/// Split arrows outside node shapes, quoted text, and pipe-delimited edge labels.
fn split_flow_arrows(line: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut start = 0;
    let mut depth = 0usize;
    let mut quoted = false;
    let mut pipe_label = false;
    let mut chars = line.char_indices();
    while let Some((at, ch)) = chars.next() {
        if quoted {
            if ch == '\\' {
                chars.next();
            } else if ch == '"' {
                quoted = false;
            }
            continue;
        }
        if ch == '"' {
            quoted = true;
            continue;
        }
        if depth == 0 && ch == '|' {
            pipe_label = !pipe_label;
            continue;
        }
        if pipe_label {
            continue;
        }
        if depth == 0 && line[at..].starts_with("-->") {
            parts.push(&line[start..at]);
            start = at + 3;
            chars.next();
            chars.next();
            continue;
        }
        match ch {
            '[' | '(' | '{' => depth += 1,
            '>' if depth == 0 => depth += 1,
            ']' | ')' | '}' => depth = depth.saturating_sub(1),
            _ => {}
        }
    }
    parts.push(&line[start..]);
    parts
}

/// One flowchart node token: its id and the label its shape carries
/// (`notes["foreach: over outline (max 8)"]` is `notes` plus the quoted
/// label; a bare token has no label). Junk after the token drops.
fn parse_flow_node(token: &str) -> Option<(String, Option<String>)> {
    let token = token.trim();
    let mut id_end = token.len();
    for (at, ch) in token.char_indices() {
        if ch.is_whitespace() || matches!(ch, '[' | '(' | '{' | '>') {
            id_end = at;
            break;
        }
    }
    let id = token[..id_end].trim();
    if id.is_empty() || id == "[*]" {
        return None;
    }
    let shape = token[id_end..].trim();
    if shape.is_empty() {
        return Some((id.to_string(), None));
    }
    let opener = shape.chars().next()?;
    let closer = match opener {
        '[' | '>' => ']',
        '(' => ')',
        '{' => '}',
        _ => return None,
    };
    let rest = shape[opener.len_utf8()..].trim();
    let mut label = rest.rfind(closer).map_or(rest, |end| &rest[..end]);
    loop {
        let inner = [("(", ")"), ("[", "]"), ("{", "}")]
            .iter()
            .find_map(|(open, close)| {
                label
                    .strip_prefix(open)
                    .and_then(|inner| inner.strip_suffix(close))
            });
        let Some(inner) = inner else {
            break;
        };
        label = inner.trim();
    }
    if label.len() >= 2 && label.starts_with('"') && label.ends_with('"') {
        label = &label[1..label.len() - 1];
    }
    Some((id.to_string(), Some(label.trim().to_string())))
}

/// One edge endpoint's leading `|label|` (it names the edge that ends at
/// this token) and the token without it.
fn split_pipe_label(token: &str) -> (Option<String>, &str) {
    let token = token.trim();
    if let Some(rest) = token.strip_prefix('|') {
        if let Some(end) = rest.find('|') {
            let label = rest[..end].trim();
            if !label.is_empty() {
                return (Some(label.to_string()), rest[end + 1..].trim());
            }
        }
    }
    (None, token)
}

/// One mermaid block's rows: the parsed graph drawn through the block
/// diagram renderer (mermaid text reaches here already scrubbed — the
/// detail parse and the file view scrub at their seams), the one-line
/// placeholder for a type the renderer cannot draw, and nothing for a
/// block with no graph. Mermaid source text never reaches the rows.
pub(super) fn mermaid_block_lines(theme: &Theme, text: &str) -> Vec<Line> {
    match parse_mermaid(text) {
        Some(Mermaid::Diagram {
            states,
            transitions,
        }) => block_diagram(theme, &states, &transitions).lines,
        Some(Mermaid::Unsupported(kind)) => vec![vec![
            Span::raw("  "),
            theme.fg_span(ThemeColor::Muted, format!("[mermaid {kind} not rendered]")),
        ]],
        None => Vec::new(),
    }
}

/// One rendered piece of a Markdown file: prose, or a `` ```mermaid `` fence.
pub(super) enum FileSegment {
    Text(String),
    Mermaid(String),
}

/// Split live Mermaid fences from Markdown, preserving examples inside other fences.
pub(super) fn split_mermaid_fences(text: &str) -> Vec<FileSegment> {
    let mut segments = Vec::new();
    let mut prose = String::new();
    let mut fence = String::new();
    let mut active = None;
    for line in text.lines() {
        let marker = markdown_fence(line);
        if let Some((delimiter, length, mermaid)) = active {
            let closes = marker.is_some_and(|(ch, count, info)| {
                ch == delimiter && count >= length && info.trim().is_empty()
            });
            if mermaid {
                if closes {
                    segments.push(FileSegment::Mermaid(std::mem::take(&mut fence)));
                } else {
                    fence.push_str(line);
                    fence.push('\n');
                }
            } else {
                prose.push_str(line);
                prose.push('\n');
            }
            if closes {
                active = None;
            }
            continue;
        }
        if let Some((delimiter, length, info)) = marker {
            let mermaid = info.split_whitespace().next() == Some("mermaid");
            active = Some((delimiter, length, mermaid));
            if mermaid {
                if prose.trim().is_empty() {
                    prose.clear();
                } else {
                    segments.push(FileSegment::Text(std::mem::take(&mut prose)));
                }
                continue;
            }
        }
        prose.push_str(line);
        prose.push('\n');
    }
    if active.is_some_and(|(_, _, mermaid)| mermaid) {
        segments.push(FileSegment::Mermaid(fence));
    } else if !prose.trim().is_empty() {
        segments.push(FileSegment::Text(prose));
    }
    segments
}

fn markdown_fence(line: &str) -> Option<(char, usize, &str)> {
    let line = line.trim_start();
    let delimiter = line.chars().next()?;
    if !matches!(delimiter, '`' | '~') {
        return None;
    }
    let length = line.chars().take_while(|ch| *ch == delimiter).count();
    (length >= 3).then(|| (delimiter, length, &line[length..]))
}

#[cfg(test)]
mod tests {
    use super::parse_mermaid;

    #[test]
    fn terminal_transition_keeps_its_source_node() {
        let super::Mermaid::Diagram {
            states,
            transitions,
        } = parse_mermaid("stateDiagram-v2\nDone --> [*]").unwrap()
        else {
            panic!("expected diagram");
        };
        assert_eq!(states.len(), 1);
        assert_eq!(states[0].id, "Done");
        assert!(transitions.is_empty());
    }

    #[test]
    fn state_labels_do_not_depend_on_declaration_order() {
        let declarations_first = parse_mermaid(
            r#"stateDiagram-v2
state "Start work" as start
state "Finished work" as finish
[*] --> start
start --> finish: done
finish --> start: retry
"#,
        );
        let edges_first = parse_mermaid(
            r#"stateDiagram-v2
[*] --> start
start --> finish: done
state "Start work" as start
state "Finished work" as finish
finish --> start: retry
"#,
        );
        assert_eq!(edges_first, declarations_first);
    }

    #[test]
    fn comments_do_not_add_nodes_or_edges() {
        for kind in ["stateDiagram-v2", "flowchart TB"] {
            let plain = format!("{kind}\na --> b\n");
            let commented = format!(
                "%% before the header\n{kind}\na --> b\n    %%\n    %% ghost --> phantom\n"
            );
            assert_eq!(parse_mermaid(&commented), parse_mermaid(&plain), "{kind}");
        }
    }

    #[test]
    fn flowchart_arrows_inside_labels_do_not_split_nodes_or_edges() {
        let super::Mermaid::Diagram {
            states,
            transitions,
        } = parse_mermaid(
            r#"flowchart TB
A["before --> after"] -->|then --> continue| B(["Review --> now"]) --> C[finish --> stop] --> D
"#,
        )
        .unwrap()
        else {
            panic!("expected graph")
        };
        assert_eq!(
            states
                .iter()
                .map(|state| state.id.as_str())
                .collect::<Vec<_>>(),
            ["A", "B", "C", "D"]
        );
        assert_eq!(states[0].label.as_deref(), Some("before --> after"));
        assert_eq!(states[2].label.as_deref(), Some("finish --> stop"));
        assert_eq!(transitions.len(), 3);
        assert_eq!(transitions[0].from, ["A"]);
        assert_eq!(transitions[0].to, "B");
        assert_eq!(transitions[0].when.as_deref(), Some("then --> continue"));
        assert_eq!(transitions[1].from, ["B"]);
        assert_eq!(transitions[1].to, "C");
        assert_eq!(transitions[2].from, ["C"]);
        assert_eq!(transitions[2].to, "D");
    }

    #[test]
    fn duplicate_state_display_names_keep_distinct_edge_endpoints() {
        let super::Mermaid::Diagram {
            states,
            transitions,
        } = parse_mermaid(
            "stateDiagram-v2\nstate \"Review\" as a\nstate \"Review\" as b\na --> b\n",
        )
        .unwrap()
        else {
            panic!("expected graph")
        };
        assert_eq!(
            states
                .iter()
                .map(|state| state.id.as_str())
                .collect::<Vec<_>>(),
            ["a", "b"]
        );
        assert!(states
            .iter()
            .all(|state| state.label.as_deref() == Some("Review")));
        assert_eq!(transitions[0].from, ["a"]);
        assert_eq!(transitions[0].to, "b");
        let diagram = super::block_diagram(
            &crate::theme::Theme::builtin("prime", crate::theme::ColorMode::TrueColor),
            &states,
            &transitions,
        );
        assert!(diagram.node_rows[0] < diagram.node_rows[1]);
    }

    #[test]
    fn bare_flowchart_reference_keeps_declared_label() {
        let super::Mermaid::Diagram {
            states,
            transitions,
        } = parse_mermaid("flowchart TB\nA[Review]\nA\nA --> B\n").unwrap()
        else {
            panic!("expected graph")
        };
        assert_eq!(states[0].id, "A");
        assert_eq!(states[0].label.as_deref(), Some("Review"));
        assert_eq!(transitions.len(), 1);
    }

    #[test]
    fn nested_flowchart_shapes_keep_only_label_text() {
        for shape in [
            r#"A(["Review"])"#,
            r#"A(("Review"))"#,
            r#"A[("Review")]"#,
            r#"A{{"Review"}}"#,
        ] {
            assert_eq!(
                super::parse_flow_node(shape),
                Some(("A".to_string(), Some("Review".to_string()))),
                "{shape}"
            );
        }
    }

    #[test]
    fn mermaid_examples_inside_markdown_fences_remain_text() {
        for delimiter in ["````", "~~~~"] {
            let example = format!(
                "{delimiter}markdown\n```mermaid\nflowchart TB\nA --> B\n```\n{delimiter}\n"
            );
            let text =
                format!("{example}\n````mermaid\nflowchart TB\nC --> D\n```\nE --> F\n````\n");
            let segments = super::split_mermaid_fences(&text);
            assert_eq!(segments.len(), 2);
            let super::FileSegment::Text(prose) = &segments[0] else {
                panic!("expected prose")
            };
            assert_eq!(prose, &format!("{example}\n"));
            let super::FileSegment::Mermaid(graph) = &segments[1] else {
                panic!("expected graph")
            };
            assert_eq!(graph, "flowchart TB\nC --> D\n```\nE --> F\n");
        }
        let segments = super::split_mermaid_fences("~~~mermaid\nflowchart TB\nA --> B\n~~~\n");
        assert!(
            matches!(&segments[..], [super::FileSegment::Mermaid(graph)] if graph == "flowchart TB\nA --> B\n")
        );
    }
}
