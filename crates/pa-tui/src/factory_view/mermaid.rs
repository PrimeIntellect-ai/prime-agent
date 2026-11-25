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

/// The parse's working shape: node ids in first-seen order, each id's
/// display name, the entry ids, and the edges as read.
#[derive(Default)]
struct Graph {
    ids: Vec<String>,
    display: std::collections::HashMap<String, String>,
    entry: std::collections::HashSet<String>,
    edges: Vec<FactoryTransition>,
}

impl Graph {
    /// One node sighting, in order: a new id joins the roster with its
    /// display name (an earlier sighting keeps its own).
    fn node(&mut self, id: &str, display: &str) {
        if !self.ids.iter().any(|known| known == id) {
            self.ids.push(id.to_string());
            self.display.insert(id.to_string(), display.to_string());
        }
    }

    /// One edge sighting: both ends join the roster, and the edge records
    /// the ids as read (`finish` maps them to display names).
    fn edge(&mut self, from: &str, to: &str, label: Option<String>) {
        self.node(from, from);
        self.node(to, to);
        self.edges.push(FactoryTransition {
            from: vec![from.to_string()],
            to: to.to_string(),
            when: label,
        });
    }

    /// The graph as the block-diagram renderer reads it: states in
    /// sighting order with their display names (a mermaid node's second
    /// line is its shape label, or empty — mermaid carries no model or
    /// python detail), and edges with both ends displayed.
    fn finish(self, labels: &std::collections::HashMap<String, String>) -> Mermaid {
        let name = |id: &str| {
            self.display
                .get(id)
                .cloned()
                .unwrap_or_else(|| id.to_string())
        };
        let states = self
            .ids
            .iter()
            .map(|id| FactoryState {
                id: name(id),
                entry: self.entry.contains(id),
                lifecycle: "task".to_string(),
                max_entries: 1,
                subagent: None,
                python: None,
                model: None,
                label: Some(labels.get(id).cloned().unwrap_or_default()),
            })
            .collect();
        let transitions = self
            .edges
            .iter()
            .map(|edge| FactoryTransition {
                from: edge.from.iter().map(|id| name(id)).collect(),
                to: name(&edge.to),
                when: edge.when.clone(),
            })
            .collect();
        Mermaid::Diagram {
            states,
            transitions,
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
    for line in text.lines().map(str::trim) {
        if !past_header {
            past_header = line.starts_with("stateDiagram");
            continue;
        }
        if let Some((label, id)) = line
            .strip_prefix("state ")
            .and_then(split_state_declaration)
        {
            graph.node(&id, &label);
            labels.insert(id.clone(), String::new());
            continue;
        }
        let Some((from, rest)) = line.split_once("-->") else {
            continue;
        };
        let (to, label) = split_edge_label(rest);
        if from.trim() == "[*]" {
            if let Some(to) = to {
                graph.node(&to, &to);
                graph.entry.insert(to);
            }
            continue;
        }
        let Some(from) = bare_id(from) else {
            continue;
        };
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
    for line in text.lines().map(str::trim) {
        if !past_header {
            past_header = line.starts_with("flowchart") || line.starts_with("graph");
            continue;
        }
        let parts: Vec<&str> = line.split("-->").collect();
        if parts.len() < 2 {
            if let Some((id, label)) = parse_flow_node(line) {
                graph.node(&id, &id);
                labels.insert(id.clone(), label.unwrap_or_default());
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
    // Compound shapes (`((circle))`, `([stadium])`, `[(cylinder)]`, `{{hexagon}}`) open with two
    // characters; every other shape opens with one.
    let (open, close) = [("((", "))"), ("([", "])"), ("[(", ")]"), ("{{", "}}")]
        .into_iter()
        .find(|(open, _)| shape.starts_with(open))
        .or_else(|| match shape.chars().next()? {
            '[' => Some(("[", "]")),
            '>' => Some((">", "]")),
            '(' => Some(("(", ")")),
            '{' => Some(("{", "}")),
            _ => None,
        })?;
    let rest = shape[open.len()..].trim();
    let mut label = rest.rfind(close).map_or(rest, |end| &rest[..end]).trim();
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
        }) => block_diagram(theme, &states, &transitions, None, None).lines,
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

/// Split a Markdown file on its `` ```mermaid `` fences: everything between a
/// `` ```mermaid `` opening line and the next fence line (or the end of the
/// file, the way Markdown reads an unterminated fence) is one diagram
/// block; everything around them is prose.
pub(super) fn split_mermaid_fences(text: &str) -> Vec<FileSegment> {
    let mut segments = Vec::new();
    let mut prose = String::new();
    let mut fence = String::new();
    let mut in_fence = false;
    for line in text.lines() {
        if in_fence {
            if line.trim().starts_with("```") {
                segments.push(FileSegment::Mermaid(std::mem::take(&mut fence)));
                in_fence = false;
            } else {
                fence.push_str(line);
                fence.push('\n');
            }
            continue;
        }
        if line.trim().starts_with("```mermaid") {
            if !prose.trim().is_empty() {
                segments.push(FileSegment::Text(std::mem::take(&mut prose)));
            }
            in_fence = true;
            continue;
        }
        prose.push_str(line);
        prose.push('\n');
    }
    if in_fence {
        segments.push(FileSegment::Mermaid(std::mem::take(&mut fence)));
    } else if !prose.trim().is_empty() {
        segments.push(FileSegment::Text(prose));
    }
    segments
}
