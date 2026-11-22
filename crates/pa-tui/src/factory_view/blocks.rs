//! A machine's block diagram: every state as a labelled box, laid out in
//! layers from the entry states down, with every transition drawn and
//! labelled. The layout is a small layered (Sugiyama-style) pass: a
//! depth-first walk finds the back edges (the loops: rework, revise,
//! redesign), layers come from the longest forward path, an edge that
//! skips layers runs through one dummy column per skipped layer, and two
//! barycenter sweeps order each layer. Forward edges run down between
//! the layers and end in `▼ <label>`; back edges leave their source
//! labelled, climb the right-hand gutter, and drop into their target.

use super::diagram::{FactoryState, FactoryTransition};
use crate::theme::{Theme, ThemeColor};
use crate::{Line, Span};

/// A box's widest text, so one long label cannot widen the whole layer.
const TEXT_MAX: usize = 26;
const GAP: usize = 3;
const MARGIN: usize = 2;
const BOX_ROWS: usize = 4;

const UP: u8 = 1;
const DOWN: u8 = 2;
const LEFT: u8 = 4;
const RIGHT: u8 = 8;

/// What one canvas cell paints.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Role {
    Border,
    Selected,
    Title,
    Detail,
    Arrow,
    Label,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Cell {
    Empty,
    Line(u8),
    Char(char, Role),
}

/// The rendered diagram and the first row of each state's box (by the
/// state's index), so a view can scroll a selected state into sight.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct BlockDiagram {
    pub lines: Vec<Line>,
    pub node_rows: Vec<usize>,
}

/// One forward segment between adjacent layers (`to` is a dummy unless
/// it is the edge's last segment, which carries the label).
struct Segment {
    from: usize,
    to: usize,
    label: Option<String>,
}

struct BackEdge {
    from: usize,
    to: usize,
    label: Option<String>,
}

/// The rows between two layers: back-edge departures, forward channels,
/// back-edge arrivals, then the arrow row.
struct Band {
    top: usize,
    departures: Vec<usize>,
    channels: Vec<(usize, usize)>,
    arrivals: Vec<usize>,
    arrow: Option<usize>,
    height: usize,
}

/// The route value of an `eq` guard (`approve`), else the whole guard.
fn short_label(when: &str) -> String {
    when.rsplit_once(" eq ")
        .map_or(when, |(_, value)| value)
        .trim_matches('"')
        .to_string()
}

/// A box's second line: what runs there (a mermaid node's shape label,
/// or empty when it carries none).
fn detail(state: &FactoryState) -> String {
    if let Some(label) = &state.label {
        return label.clone();
    }
    if let Some(python) = &state.python {
        return format!("python · {python}");
    }
    if state.lifecycle == "resident" {
        return "resident".to_string();
    }
    match (&state.model, &state.subagent) {
        (Some(model), _) => format!("agent · {}", model.rsplit('/').next().unwrap_or(model)),
        (None, Some(subagent)) => format!("agent · {subagent}"),
        (None, None) => "agent".to_string(),
    }
}

fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// Lay out and draw the diagram. `selected` (a state index) paints that
/// state's box in the accent.
#[expect(
    clippy::too_many_lines,
    reason = "one layout pass: edges, layers, order, positions, rows, then the drawing; split, each step would only pass the same tables along"
)]
pub(crate) fn block_diagram(
    theme: &Theme,
    states: &[FactoryState],
    transitions: &[FactoryTransition],
    selected: Option<usize>,
) -> BlockDiagram {
    let n = states.len();
    let index_of = |id: &str| states.iter().position(|state| state.id == id);
    // Every transition source is one edge; a join labels its edges "join".
    let mut edges: Vec<(usize, usize, Option<String>)> = Vec::new();
    let mut self_loops: Vec<Vec<String>> = vec![Vec::new(); n];
    for transition in transitions {
        let Some(to) = index_of(&transition.to) else {
            continue;
        };
        let label = if transition.from.len() > 1 {
            Some("join".to_string())
        } else {
            transition.when.as_deref().map(short_label)
        };
        for source in &transition.from {
            let Some(from) = index_of(source) else {
                continue;
            };
            if from == to {
                self_loops[from].push(label.clone().unwrap_or_else(|| "again".to_string()));
            } else {
                edges.push((from, to, label.clone()));
            }
        }
    }

    // Back edges: an edge into a state still on the depth-first stack.
    let mut adjacency: Vec<Vec<usize>> = vec![Vec::new(); n];
    for (index, (from, _, _)) in edges.iter().enumerate() {
        adjacency[*from].push(index);
    }
    let mut mark = vec![0u8; n];
    let mut is_back = vec![false; edges.len()];
    let roots: Vec<usize> = (0..n).filter(|&i| states[i].entry).chain(0..n).collect();
    for root in roots {
        if mark[root] != 0 {
            continue;
        }
        let mut stack: Vec<(usize, usize)> = vec![(root, 0)];
        mark[root] = 1;
        while let Some(&mut (node, ref mut next)) = stack.last_mut() {
            if let Some(&edge) = adjacency[node].get(*next) {
                *next += 1;
                let to = edges[edge].1;
                match mark[to] {
                    0 => {
                        mark[to] = 1;
                        stack.push((to, 0));
                    }
                    1 => is_back[edge] = true,
                    _ => {}
                }
            } else {
                mark[node] = 2;
                stack.pop();
            }
        }
    }

    // Layers by the longest forward path.
    let mut layer = vec![0usize; n];
    let mut indegree = vec![0usize; n];
    for (index, (_, to, _)) in edges.iter().enumerate() {
        if !is_back[index] {
            indegree[*to] += 1;
        }
    }
    let mut ready: Vec<usize> = (0..n).filter(|&i| indegree[i] == 0).collect();
    let mut cursor = 0;
    while cursor < ready.len() {
        let node = ready[cursor];
        cursor += 1;
        for &edge in &adjacency[node] {
            if is_back[edge] {
                continue;
            }
            let to = edges[edge].1;
            layer[to] = layer[to].max(layer[node] + 1);
            indegree[to] -= 1;
            if indegree[to] == 0 {
                ready.push(to);
            }
        }
    }
    let depth = layer.iter().copied().max().map_or(0, |max| max + 1);

    // Items: the states first (item i is state i), then one dummy per
    // skipped layer of a long edge.
    let mut item_layer: Vec<usize> = layer.clone();
    let mut segments: Vec<Segment> = Vec::new();
    let mut backs: Vec<BackEdge> = Vec::new();
    for (index, (from, to, label)) in edges.iter().enumerate() {
        if is_back[index] {
            backs.push(BackEdge {
                from: *from,
                to: *to,
                label: label.clone(),
            });
            continue;
        }
        let mut previous = *from;
        for skipped in (layer[*from] + 1)..layer[*to] {
            item_layer.push(skipped);
            let dummy = item_layer.len() - 1;
            segments.push(Segment {
                from: previous,
                to: dummy,
                label: None,
            });
            previous = dummy;
        }
        segments.push(Segment {
            from: previous,
            to: *to,
            label: label.clone(),
        });
    }
    let items = item_layer.len();
    let mut layers: Vec<Vec<usize>> = vec![Vec::new(); depth.max(1)];
    for item in 0..items {
        layers[item_layer[item]].push(item);
    }

    // Two barycenter sweeps, down then up.
    let mut position = vec![0f64; items];
    let renumber = |layers: &Vec<Vec<usize>>, position: &mut Vec<f64>| {
        for row in layers {
            for (at, &item) in row.iter().enumerate() {
                position[item] = at as f64;
            }
        }
    };
    renumber(&layers, &mut position);
    for _ in 0..2 {
        for current in 1..layers.len() {
            let key: Vec<(usize, f64)> = layers[current]
                .iter()
                .map(|&item| {
                    let sources: Vec<f64> = segments
                        .iter()
                        .filter(|segment| segment.to == item)
                        .map(|segment| position[segment.from])
                        .collect();
                    let average = if sources.is_empty() {
                        position[item]
                    } else {
                        sources.iter().sum::<f64>() / sources.len() as f64
                    };
                    (item, average)
                })
                .collect();
            let mut sorted = key;
            sorted.sort_by(|a, b| a.1.total_cmp(&b.1));
            layers[current] = sorted.into_iter().map(|(item, _)| item).collect();
            renumber(&layers, &mut position);
        }
        for current in (0..layers.len().saturating_sub(1)).rev() {
            let key: Vec<(usize, f64)> = layers[current]
                .iter()
                .map(|&item| {
                    let targets: Vec<f64> = segments
                        .iter()
                        .filter(|segment| segment.from == item)
                        .map(|segment| position[segment.to])
                        .collect();
                    let average = if targets.is_empty() {
                        position[item]
                    } else {
                        targets.iter().sum::<f64>() / targets.len() as f64
                    };
                    (item, average)
                })
                .collect();
            let mut sorted = key;
            sorted.sort_by(|a, b| a.1.total_cmp(&b.1));
            layers[current] = sorted.into_iter().map(|(item, _)| item).collect();
            renumber(&layers, &mut position);
        }
    }

    // Box text and widths; dummies are one column.
    let titles: Vec<String> = states
        .iter()
        .map(|state| clip(&state.id, TEXT_MAX))
        .collect();
    let details: Vec<String> = states
        .iter()
        .map(|state| clip(&detail(state), TEXT_MAX))
        .collect();
    let width: Vec<usize> = (0..items)
        .map(|item| {
            if item < n {
                titles[item]
                    .chars()
                    .count()
                    .max(details[item].chars().count())
                    + 4
            } else {
                1
            }
        })
        .collect();
    let row_width = |row: &Vec<usize>| -> usize {
        row.iter().map(|&item| width[item]).sum::<usize>() + GAP * row.len().saturating_sub(1)
    };
    let widest = layers.iter().map(row_width).max().unwrap_or(0);
    let mut x = vec![0usize; items];
    for row in &layers {
        let mut at = MARGIN + (widest - row_width(row)) / 2;
        for &item in row {
            x[item] = at;
            at += width[item] + GAP;
        }
    }
    let center = |item: usize| x[item] + width[item] / 2;

    // Back edges take gutter columns, the shortest span innermost.
    backs.sort_by_key(|back| layer[back.from] - layer[back.to]);
    let gutter = |k: usize| MARGIN + widest + 2 + 2 * k;

    // Rows: band b sits above layer b (band `depth` below the last).
    let mut bands: Vec<Band> = Vec::with_capacity(depth + 1);
    let mut layer_top = vec![0usize; depth];
    let mut y = 0;
    for b in 0..=depth {
        let departures: Vec<usize> = (0..backs.len())
            .filter(|&k| b > 0 && layer[backs[k].from] == b - 1)
            .collect();
        let arrivals: Vec<usize> = (0..backs.len())
            .filter(|&k| b < depth && layer[backs[k].to] == b)
            .collect();
        let mut needs_channel: Vec<usize> = Vec::new();
        let mut entering = false;
        if b < depth {
            for &item in &layers[b] {
                let sources: Vec<usize> = segments
                    .iter()
                    .filter(|segment| segment.to == item)
                    .map(|segment| segment.from)
                    .collect();
                entering |= !sources.is_empty();
                if sources.len() > 1 || sources.iter().any(|&source| center(source) != center(item))
                {
                    needs_channel.push(item);
                }
            }
        }
        let wants_arrow = b < depth
            && layers[b].iter().any(|&item| {
                item < n
                    && (segments.iter().any(|segment| segment.to == item)
                        || arrivals.iter().any(|&k| backs[k].to == item)
                        || (b == 0 && states[item].entry))
            });
        let mut row = y + departures.len();
        let channels: Vec<(usize, usize)> = needs_channel
            .iter()
            .map(|&item| {
                row += 1;
                (item, row - 1)
            })
            .collect();
        row += arrivals.len();
        let arrow = wants_arrow.then(|| {
            row += 1;
            row - 1
        });
        if row == y && entering {
            row += 1;
        }
        bands.push(Band {
            top: y,
            departures,
            channels,
            arrivals,
            arrow,
            height: row - y,
        });
        y = row;
        if b < depth {
            layer_top[b] = y;
            let real = layers[b].iter().any(|&item| item < n);
            y += if real { BOX_ROWS } else { 1 };
        }
    }
    let height = y;
    let label_room = edges
        .iter()
        .filter_map(|(_, _, label)| label.as_ref().map(|label| label.chars().count()))
        .max()
        .unwrap_or(0);
    let canvas_width = (MARGIN + widest + label_room + 4).max(if backs.is_empty() {
        0
    } else {
        gutter(backs.len() - 1) + 2
    }) + self_loops
        .iter()
        .map(|labels| labels.join(", ").chars().count() + 4)
        .max()
        .unwrap_or(0);
    let mut canvas = Canvas(vec![vec![Cell::Empty; canvas_width]; height]);

    // Boxes and dummy columns.
    for (b, row) in layers.iter().enumerate() {
        let top = layer_top[b];
        for &item in row {
            if item >= n {
                let rows = if row.iter().any(|&other| other < n) {
                    BOX_ROWS
                } else {
                    1
                };
                canvas.vertical(center(item), top, top + rows - 1);
                continue;
            }
            let chosen = selected == Some(item);
            let (role, [top_left, top_right, bottom_left, bottom_right, rule_char, side]) =
                if chosen {
                    (Role::Selected, ['┏', '┓', '┗', '┛', '━', '┃'])
                } else {
                    (Role::Border, ['┌', '┐', '└', '┘', '─', '│'])
                };
            let inner = width[item] - 2;
            let stroke: String = std::iter::repeat_n(rule_char, inner).collect();
            canvas.put(
                x[item],
                top,
                &format!("{top_left}{stroke}{top_right}"),
                role,
            );
            canvas.put(
                x[item],
                top + 3,
                &format!("{bottom_left}{stroke}{bottom_right}"),
                role,
            );
            for (offset, (text, text_role)) in
                [(&titles[item], Role::Title), (&details[item], Role::Detail)]
                    .into_iter()
                    .enumerate()
            {
                let line_y = top + 1 + offset;
                canvas.put(x[item], line_y, &side.to_string(), role);
                canvas.put(x[item] + 2, line_y, text, text_role);
                canvas.put(x[item] + width[item] - 1, line_y, &side.to_string(), role);
            }
            if !self_loops[item].is_empty() {
                canvas.put(
                    x[item] + width[item] + 1,
                    top + 2,
                    &format!("↺ {}", self_loops[item].join(", ")),
                    Role::Label,
                );
            }
        }
    }

    // Forward segments, band by band.
    for b in 1..depth {
        let band = &bands[b];
        let mut arrow_labels: Vec<(usize, Vec<String>)> = Vec::new();
        for segment in segments
            .iter()
            .filter(|segment| item_layer[segment.to] == b)
        {
            let (from, to) = (segment.from, segment.to);
            // Lines run from the source's last row (its bottom border, or a
            // dummy column's end) to the target's arrow row (or a dummy's
            // first row), so every end joins.
            let start = band.top.saturating_sub(1);
            if from < n {
                let tee = if selected == Some(from) { '┳' } else { '┬' };
                let role = if selected == Some(from) {
                    Role::Selected
                } else {
                    Role::Border
                };
                canvas.put(center(from), start, &tee.to_string(), role);
            }
            let end = if to < n {
                band.arrow.unwrap_or(band.top + band.height.max(1) - 1)
            } else {
                layer_top[b]
            };
            match band.channels.iter().find(|(item, _)| *item == to) {
                Some(&(_, channel)) => {
                    canvas.vertical(center(from), start, channel);
                    canvas.horizontal(channel, center(from), center(to));
                    canvas.vertical(center(to), channel, end);
                }
                None => canvas.vertical(center(from), start, end),
            }
            if to < n {
                if !arrow_labels.iter().any(|(item, _)| *item == to) {
                    arrow_labels.push((to, Vec::new()));
                }
                let entry = arrow_labels
                    .iter_mut()
                    .find(|(item, _)| *item == to)
                    .expect("pushed above");
                if let Some(label) = &segment.label {
                    if !entry.1.contains(label) {
                        entry.1.push(label.clone());
                    }
                }
            }
        }
        if let Some(arrow) = band.arrow {
            for (item, labels) in arrow_labels {
                canvas.put(center(item), arrow, "▼", Role::Arrow);
                if !labels.is_empty() {
                    canvas.label(center(item) + 2, arrow, &labels.join(", "));
                }
            }
        }
    }
    // The entry arrows.
    if let Some(arrow) = bands[0].arrow {
        for &item in layers.first().into_iter().flatten() {
            if item < n && states[item].entry {
                canvas.put(center(item), arrow, "▼", Role::Arrow);
                canvas.label(center(item) + 2, arrow, "start");
            }
        }
    }

    // Back edges: down from the source, out to the gutter, up, and in.
    for (k, back) in backs.iter().enumerate() {
        let source_band = &bands[layer[back.from] + 1];
        let target_band = &bands[layer[back.to]];
        let Some(departure) = source_band
            .departures
            .iter()
            .position(|&d| d == k)
            .map(|at| source_band.top + at)
        else {
            continue;
        };
        let Some(arrival) = target_band.arrivals.iter().position(|&a| a == k).map(|at| {
            target_band.top + target_band.departures.len() + target_band.channels.len() + at
        }) else {
            continue;
        };
        let column = gutter(k);
        let bottom = layer_top[layer[back.from]] + BOX_ROWS - 1;
        let tee = if selected == Some(back.from) {
            '┳'
        } else {
            '┬'
        };
        let role = if selected == Some(back.from) {
            Role::Selected
        } else {
            Role::Border
        };
        canvas.put(center(back.from), bottom, &tee.to_string(), role);
        canvas.vertical(center(back.from), bottom, departure);
        canvas.horizontal(departure, center(back.from), column);
        canvas.vertical(column, arrival, departure);
        canvas.horizontal(arrival, center(back.to), column);
        let arrow = target_band.arrow.unwrap_or(arrival + 1);
        canvas.vertical(center(back.to), arrival, arrow);
        canvas.put(center(back.to), arrow, "▼", Role::Arrow);
        if let Some(label) = &back.label {
            canvas.label(center(back.from) + 2, departure, &format!(" {label} "));
        }
    }

    let node_rows = (0..n).map(|item| layer_top[item_layer[item]]).collect();
    let lines = canvas
        .0
        .into_iter()
        .map(|row| {
            let mut line: Line = Vec::new();
            let mut run = String::new();
            let mut run_color: Option<ThemeColor> = None;
            for cell in row {
                let (ch, color) = match cell {
                    Cell::Empty => (' ', ThemeColor::Text),
                    Cell::Line(bits) => (line_char(bits), ThemeColor::Dim),
                    Cell::Char(ch, role) => (
                        ch,
                        match role {
                            Role::Border | Role::Detail => ThemeColor::Muted,
                            Role::Selected => ThemeColor::Accent,
                            Role::Title => ThemeColor::ToolTitle,
                            Role::Arrow => ThemeColor::Text,
                            Role::Label => ThemeColor::Warning,
                        },
                    ),
                };
                if run_color != Some(color) && !run.is_empty() {
                    line.push(theme.fg_span(
                        run_color.unwrap_or(ThemeColor::Text),
                        std::mem::take(&mut run),
                    ));
                }
                run_color = Some(color);
                run.push(ch);
            }
            let trimmed = run.trim_end().to_string();
            if !trimmed.is_empty() {
                line.push(theme.fg_span(run_color.unwrap_or(ThemeColor::Text), trimmed));
            }
            if line.is_empty() {
                line.push(Span::raw(""));
            }
            line
        })
        .collect();
    BlockDiagram { lines, node_rows }
}

/// The character grid the diagram draws on: lines merge into junctions,
/// characters overwrite.
struct Canvas(Vec<Vec<Cell>>);

impl Canvas {
    fn connect(&mut self, x: usize, y: usize, bits: u8) {
        if let Some(cell) = self.0.get_mut(y).and_then(|row| row.get_mut(x)) {
            *cell = match *cell {
                Cell::Line(old) => Cell::Line(old | bits),
                Cell::Empty => Cell::Line(bits),
                Cell::Char(..) => *cell,
            };
        }
    }

    fn vertical(&mut self, x: usize, from: usize, to: usize) {
        let (low, high) = (from.min(to), from.max(to));
        for row in low..=high {
            let up = if row > low { UP } else { 0 };
            let down = if row < high { DOWN } else { 0 };
            self.connect(x, row, up | down);
        }
    }

    fn horizontal(&mut self, y: usize, from: usize, to: usize) {
        let (low, high) = (from.min(to), from.max(to));
        for column in low..=high {
            let left = if column > low { LEFT } else { 0 };
            let right = if column < high { RIGHT } else { 0 };
            self.connect(column, y, left | right);
        }
    }

    fn put(&mut self, x: usize, y: usize, text: &str, role: Role) {
        for (offset, ch) in text.chars().enumerate() {
            if let Some(cell) = self.0.get_mut(y).and_then(|row| row.get_mut(x + offset)) {
                *cell = Cell::Char(ch, role);
            }
        }
    }

    /// A label writes only over empty cells and plain horizontal runs.
    fn label(&mut self, x: usize, y: usize, text: &str) {
        for (offset, ch) in text.chars().enumerate() {
            if let Some(cell) = self.0.get_mut(y).and_then(|row| row.get_mut(x + offset)) {
                if matches!(*cell, Cell::Empty | Cell::Line(4 | 8 | 12)) {
                    *cell = Cell::Char(ch, Role::Label);
                }
            }
        }
    }
}

fn line_char(bits: u8) -> char {
    match bits {
        1..=3 => '│',
        12 | 4 | 8 => '─',
        9 => '└',
        5 => '┘',
        10 => '┌',
        6 => '┐',
        11 => '├',
        7 => '┤',
        14 => '┬',
        13 => '┴',
        15 => '┼',
        _ => ' ',
    }
}

#[cfg(test)]
mod tests;
