//! Client-side info displays: the `/session`, `/context`, `/system-prompt`,
//! `/logs`, and `/changelog` rows (TS interactive-mode `handleSessionCommand`,
//! `handleContextCommand` over `formatContextTree`,
//! `handleSystemPromptCommand`, `handleLogsCommand`, and
//! `handleChangelogCommand` over `parseChangelog`). Row data and render are
//! pure; the session UI owns the daemon fetches that feed the builders, the
//! view owns the paint. Every builder returns the structured form of the TS
//! `theme.fg(...)`-embedded info strings: one [`ClientLine`] per source
//! line, spans carrying their theme color so the view resolves them at
//! render time.

use std::fmt::Write as _;
use std::path::Path;

use serde_json::Value;

use crate::theme::{Theme, ThemeColor};
use crate::width::{char_width, str_width};
use crate::{Line, Span};
use ratatui::style::Style;

/// The context-utilization bar width (TS `CONTEXT_BAR_WIDTH`).
const CONTEXT_BAR_WIDTH: usize = 10;
/// The minimum agent-label column width (TS `MIN_LABEL_WIDTH`).
const MIN_LABEL_WIDTH: usize = 16;

/// One styled segment of a client info row: text plus its theme color
/// (`None` keeps the default foreground).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientSpan {
    pub text: String,
    pub color: Option<ThemeColor>,
}

impl ClientSpan {
    fn raw(text: impl Into<String>) -> Self {
        ClientSpan {
            text: text.into(),
            color: None,
        }
    }

    fn colored(text: impl Into<String>, color: ThemeColor) -> Self {
        ClientSpan {
            text: text.into(),
            color: Some(color),
        }
    }
}

/// One source line of a client info block; the view wraps each line
/// separately (the TS `Text` component wraps each newline-delimited line).
pub type ClientLine = Vec<ClientSpan>;

fn raw_span(text: impl Into<String>) -> ClientSpan {
    ClientSpan::raw(text)
}

fn dim(text: impl Into<String>) -> ClientSpan {
    ClientSpan::colored(text, ThemeColor::Dim)
}

/// Digits grouped with commas (`toLocaleString` for the en-US locale).
pub(crate) fn grouped(value: u64) -> String {
    let digits = value.to_string();
    let mut out = String::new();
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            out.push(',');
        }
        out.push(digit);
    }
    out
}

/// JS `Number.prototype.toFixed(digits)` over a non-negative value: the
/// EXACT decimal expansion of the binary double, rounded half away from
/// zero at the digit. Neither Rust's `{:.n}` (ties half-to-even on the
/// exact expansion) nor a float multiply-then-round (the multiply rounds
/// too: `2.675 * 100` is `267.50000000000003`, so `.round()` gives 268
/// where JS prints `2.67`) matches, so the rounding runs on the double's
/// exact rational value: `value = mantissa / 2^exponent` and
/// `value * 10^digits = mantissa * 5^digits / 2^(exponent - digits)`
/// reduce to one integer divide with a half-away tie on the remainder.
pub(crate) fn js_to_fixed(value: f64, digits: usize) -> String {
    let bits = value.to_bits();
    let biased = ((bits >> 52) & 0x7ff) as i64;
    let (mantissa, exponent) = if biased == 0 {
        (bits & ((1u64 << 52) - 1), -1074i64)
    } else {
        ((bits & ((1u64 << 52) - 1)) | (1u64 << 52), biased - 1075)
    };
    let numerator = mantissa as u128 * 5u128.pow(digits as u32);
    // value * 10^digits = numerator * 2^(exponent + digits): a left
    // shift when the exponent absorbs the scale, else one exact divide
    // with a half-away tie on the remainder.
    let shift = exponent + digits as i64;
    let mut scaled = if shift >= 0 {
        // Spend values stay far inside u128; saturating guards the
        // denormal edge without panicking.
        numerator
            .checked_shl(shift as u32)
            .filter(|_| shift <= 100)
            .unwrap_or(u128::MAX)
    } else {
        let shift = (-shift) as u32;
        if shift > 127 {
            0
        } else {
            let denom = 1u128 << shift;
            let quotient = numerator / denom;
            let remainder = numerator % denom;
            // Ties round away from zero (JS rounds half toward the larger n).
            quotient + u128::from(2 * remainder >= denom)
        }
    };
    if value == 0.0 {
        scaled = 0;
    }
    let unit = 10u128.pow(digits as u32);
    let integer = scaled / unit;
    let fraction = scaled % unit;
    if digits == 0 {
        return format!("{integer}");
    }
    format!("{integer}.{fraction:0digits$}")
}

/// A JS number rendered with at most one decimal: `Math.round(x * 10) / 10`
/// through number-to-string (no trailing `.0`).
fn js_tenth(value: f64) -> String {
    let tenth = (value * 10.0).round() / 10.0;
    if tenth.fract() == 0.0 {
        format!("{}", tenth as u64)
    } else {
        format!("{tenth:.1}")
    }
}

/// The `/session` info rows (TS `handleSessionCommand` over the
/// `get_session_stats` shape). A missing `sessionFile` renders as
/// `In-memory`; an unset session name omits the `Name:` row.
pub fn session_info_rows(stats: &Value, session_name: Option<&str>) -> Vec<ClientLine> {
    let count = |field: &str| stats.get(field).and_then(Value::as_u64).unwrap_or_default();
    let session_id = stats
        .get("sessionId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let session_file = stats
        .get("sessionFile")
        .and_then(Value::as_str)
        .filter(|file| !file.is_empty())
        .unwrap_or("In-memory");
    let mut rows = vec![vec![raw_span("Session Info")], vec![]];
    if let Some(name) = session_name.filter(|name| !name.is_empty()) {
        rows.push(vec![dim("Name:"), raw_span(format!(" {name}"))]);
    }
    rows.push(vec![dim("File:"), raw_span(format!(" {session_file}"))]);
    rows.push(vec![dim("ID:"), raw_span(format!(" {session_id}"))]);
    rows.push(vec![]);
    rows.push(vec![raw_span("Messages")]);
    for (label, value) in [
        ("User:", count("userMessages")),
        ("Assistant:", count("assistantMessages")),
        ("Tool Calls:", count("toolCalls")),
        ("Tool Results:", count("toolResults")),
        ("Total:", count("totalMessages")),
    ] {
        rows.push(vec![dim(label), raw_span(format!(" {value}"))]);
    }
    rows.push(vec![]);
    rows.push(vec![dim(
        "Use /context for token, cost, and context usage.",
    )]);
    rows
}

/// The `/logs` info rows (TS `handleLogsCommand`): the logs directory, its
/// files sorted by name with `(N KB)` sizes, and the trailing note.
pub fn logs_rows(logs_dir: &Path) -> Vec<ClientLine> {
    let mut rows = vec![
        vec![raw_span("Logs")],
        vec![],
        vec![
            dim("Directory:"),
            raw_span(format!(" {}", logs_dir.display())),
        ],
        vec![],
    ];
    // A readdir failure falls through to the empty-state row (the TS catch
    // keeps rendering); dot-prefixed files stay hidden.
    let mut files: Vec<String> = std::fs::read_dir(logs_dir)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .filter(|name| !name.starts_with('.'))
                .collect()
        })
        .unwrap_or_default();
    files.sort();
    if files.is_empty() {
        rows.push(vec![dim("No logs written yet.")]);
    } else {
        for name in files {
            let mut row = vec![dim("\u{2022}"), raw_span(format!(" {name}"))];
            // A file vanishing between readdir and stat loses only its
            // size (the TS catch skips the size, keeps the row).
            if let Ok(metadata) = std::fs::metadata(logs_dir.join(&name)) {
                row.push(raw_span(" "));
                row.push(dim(format!(
                    "({} KB)",
                    js_to_fixed(metadata.len() as f64 / 1024.0, 1)
                )));
            }
            rows.push(row);
        }
    }
    rows.push(vec![]);
    rows.push(vec![dim(
        "Daemon crashes log to <socket>.log; agent-open failures log to client-errors.log.",
    )]);
    rows
}

/// The `/system-prompt` header rows (TS `handleSystemPromptCommand`); the
/// char count is the JS string length (UTF-16 code units).
pub fn system_prompt_header_rows(prompt: &str) -> Vec<ClientLine> {
    let chars = prompt.encode_utf16().count();
    vec![vec![
        raw_span("System Prompt "),
        dim(format!("({chars} chars)")),
    ]]
}

/// The `/system-prompt` body rows: the prompt split into source lines for
/// per-line wrapping (the TS `Text` wraps each newline-delimited line).
pub fn system_prompt_body_rows(prompt: &str) -> Vec<ClientLine> {
    prompt
        .split('\n')
        .map(|line| vec![raw_span(line)])
        .collect()
}

/// The `/changelog` markdown (TS `handleChangelogCommand` over
/// `parseChangelog`): the CHANGELOG.md entries newest-first joined with
/// a blank line, or the empty-state text.
pub fn changelog_markdown(changelog_path: &Path) -> String {
    let entries = parse_changelog(changelog_path);
    if entries.is_empty() {
        return "No changelog entries found.".to_string();
    }
    entries
        .iter()
        .rev()
        .cloned()
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// Parse the shipped CHANGELOG.md (TS `parseChangelog`): sections under
/// `## ` headers, each entry the trimmed section text including its header
/// line. A `## ` header without a parsable `x.y.z` version resets collection;
/// lines before the first version header stay dropped.
fn parse_changelog(changelog_path: &Path) -> Vec<String> {
    let Ok(content) = std::fs::read_to_string(changelog_path) else {
        return Vec::new();
    };
    let mut entries: Vec<String> = Vec::new();
    let mut current: Option<Vec<String>> = None;
    for line in content.split('\n') {
        if let Some(rest) = line.strip_prefix("## ") {
            if let Some(lines) = current.take() {
                push_entry(&mut entries, lines);
            }
            if is_version_header(rest) {
                current = Some(vec![line.to_string()]);
            }
        } else if let Some(lines) = current.as_mut() {
            lines.push(line.to_string());
        }
    }
    if let Some(lines) = current {
        push_entry(&mut entries, lines);
    }
    entries
}

fn push_entry(entries: &mut Vec<String>, lines: Vec<String>) {
    let trimmed = lines.join("\n").trim().to_string();
    if !trimmed.is_empty() {
        entries.push(trimmed);
    }
}

/// Whether a `## ` header rest carries an `x.y.z` version (TS
/// `/##\s+\[?(\d+)\.(\d+)\.(\d+)\]?/`): optional whitespace, an optional
/// `[`, then major.minor.patch.
fn is_version_header(rest: &str) -> bool {
    let mut rest = rest.trim_start();
    rest = rest.strip_prefix('[').unwrap_or(rest);
    for part in 0..3 {
        let digits = rest.chars().take_while(char::is_ascii_digit).count();
        if digits == 0 {
            return false;
        }
        rest = &rest[digits..];
        if part < 2 {
            rest = rest.strip_prefix('.').unwrap_or_default();
        }
    }
    true
}

// ---------------------------------------------------------------------------
// /context (TS formatContextTree)
// ---------------------------------------------------------------------------

/// The spend-relevant usage of one tree node (TS `Usage`, the fields the
/// display reads).
#[derive(Debug, Clone, Copy, Default, PartialEq)]
struct UsageTotals {
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
    cost_total: f64,
}

impl UsageTotals {
    /// `spentTokens`: input + output + cache read + cache write.
    fn spent_tokens(&self) -> u64 {
        self.input + self.output + self.cache_read + self.cache_write
    }

    /// Fold another parsed total into this one (the per-model tree sums).
    fn add_fold(&mut self, other: &UsageTotals) {
        self.input += other.input;
        self.output += other.output;
        self.cache_read += other.cache_read;
        self.cache_write += other.cache_write;
        self.cost_total += other.cost_total;
    }

    fn add(&mut self, other: &Value) {
        let u64_field = |value: &Value, field: &str| {
            value.get(field).and_then(Value::as_u64).unwrap_or_default()
        };
        self.input += u64_field(other, "input");
        self.output += u64_field(other, "output");
        self.cache_read += u64_field(other, "cacheRead");
        self.cache_write += u64_field(other, "cacheWrite");
        self.cost_total += other
            .get("cost")
            .and_then(|cost| cost.get("total"))
            .and_then(Value::as_f64)
            .unwrap_or_default();
    }
}

/// `formatCost`: `$<toFixed(2)>`.
fn format_cost(cost: f64) -> String {
    format!("${}", js_to_fixed(cost, 2))
}

/// One context-usage snapshot (TS `ContextUsage`); `None` tokens or
/// percent is the unknown-right-after-compaction state.
#[derive(Debug, Clone, Copy, PartialEq)]
struct ContextUsageSnapshot {
    tokens: Option<u64>,
    context_window: u64,
    percent: Option<f64>,
}

impl ContextUsageSnapshot {
    /// `null` tokens/percent parse as `None`; absent fields parse the same
    /// way (both fail the TS null check).
    fn parse_field<T>(usage: &Value, field: &str, read: impl Fn(&Value) -> Option<T>) -> Option<T> {
        match usage.get(field) {
            Some(Value::Null) | None => None,
            Some(value) => read(value),
        }
    }
}

/// One model's own-usage bucket from the daemon's per-model fold
/// (`ownUsageByModel`): the spend billed at that model's rates.
#[derive(Debug, Clone, PartialEq)]
struct ModelUsage {
    provider: String,
    id: String,
    totals: UsageTotals,
}

/// One agent row of the context tree (TS `ContextTreeNode`), plus this
/// port's per-model own-usage breakdown (a deliberate TS delta: a
/// session that switches models mid-conversation — or hosts subagents on
/// other models — shows which model billed what).
#[derive(Debug, Clone, PartialEq)]
struct ContextNode {
    id: String,
    label: String,
    status: String,
    model: Option<(String, String)>,
    own_usage: UsageTotals,
    own_usage_by_model: Vec<ModelUsage>,
    context_usage: Option<ContextUsageSnapshot>,
    children: Vec<ContextNode>,
}

fn parse_context_node(value: &Value) -> ContextNode {
    let usage_from = |usage: &Value| {
        let mut totals = UsageTotals::default();
        totals.add(usage);
        totals
    };
    let context_usage = value.get("contextUsage").map(|usage| ContextUsageSnapshot {
        tokens: ContextUsageSnapshot::parse_field(usage, "tokens", Value::as_u64),
        context_window: usage
            .get("contextWindow")
            .and_then(Value::as_u64)
            .unwrap_or_default(),
        percent: ContextUsageSnapshot::parse_field(usage, "percent", Value::as_f64),
    });
    ContextNode {
        id: value
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        label: value
            .get("label")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        status: value
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        model: value.get("model").and_then(|model| {
            let provider = model.get("provider").and_then(Value::as_str)?;
            let id = model.get("id").and_then(Value::as_str)?;
            Some((provider.to_string(), id.to_string()))
        }),
        own_usage: value.get("ownUsage").map(usage_from).unwrap_or_default(),
        own_usage_by_model: value
            .get("ownUsageByModel")
            .and_then(Value::as_array)
            .map(|buckets| {
                buckets
                    .iter()
                    .filter_map(|bucket| {
                        let provider = bucket.get("provider")?.as_str()?.to_string();
                        let id = bucket.get("id")?.as_str()?.to_string();
                        let totals = bucket.get("ownUsage").map(usage_from)?;
                        Some(ModelUsage {
                            provider,
                            id,
                            totals,
                        })
                    })
                    .collect()
            })
            .unwrap_or_default(),
        context_usage,
        children: value
            .get("children")
            .and_then(Value::as_array)
            .map(|children| children.iter().map(parse_context_node).collect())
            .unwrap_or_default(),
    }
}

/// One flattened tree row: the node and its drawing prefix (TS
/// `ContextTreeRow`).
struct TreeRow<'a> {
    node: &'a ContextNode,
    prefix: String,
}

fn flatten_tree(root: &ContextNode) -> Vec<TreeRow<'_>> {
    let mut rows = vec![TreeRow {
        node: root,
        prefix: String::new(),
    }];
    walk_tree(&root.children, "", &mut rows);
    rows
}

fn walk_tree<'a>(children: &'a [ContextNode], ancestors: &str, rows: &mut Vec<TreeRow<'a>>) {
    for (index, child) in children.iter().enumerate() {
        let is_last = index + 1 == children.len();
        let branch = if is_last {
            "\u{2514}\u{2500} "
        } else {
            "\u{251c}\u{2500} "
        };
        rows.push(TreeRow {
            node: child,
            prefix: format!("{ancestors}{branch}"),
        });
        let ancestors = if is_last {
            format!("{ancestors}   ")
        } else {
            format!("{ancestors}\u{2502}  ")
        };
        walk_tree(&child.children, &ancestors, rows);
    }
}

/// The status icon and its color (TS `statusIcon`); statuses outside the
/// TS vocabulary render like `queued` (the TS switch is type-exhaustive and
/// cannot produce one).
fn status_icon(status: &str) -> (&'static str, ThemeColor) {
    match status {
        "active" => ("\u{25cf}", ThemeColor::Accent),
        "running" => ("\u{25c6}", ThemeColor::Accent),
        "done" => ("\u{2713}", ThemeColor::Success),
        "error" | "cancelled" => ("\u{2717}", ThemeColor::Error),
        _ => ("\u{25c7}", ThemeColor::Dim),
    }
}

/// Plain-space padding to a visible width (TS `padEndAnsi` for the
/// default-foreground padding these tables append).
fn pad_end(text: &str, width: usize) -> String {
    let used = str_width(text);
    format!("{text}{}", " ".repeat(width.saturating_sub(used)))
}

fn pad_start(text: &str, width: usize) -> String {
    let used = str_width(text);
    format!("{}{text}", " ".repeat(width.saturating_sub(used)))
}

/// `truncateToWidth(text, max_width, "...")` for plain text: a clipped
/// ellipsis when the width cannot hold it, else a prefix that fits
/// `max_width - 3`.
fn truncate_plain(text: &str, max_width: usize) -> String {
    if max_width == 0 {
        return String::new();
    }
    if str_width(text) <= max_width {
        return text.to_string();
    }
    let ellipsis = "...";
    if str_width(ellipsis) >= max_width {
        let mut out = String::new();
        for c in ellipsis.chars() {
            if str_width(&out) + char_width(c) > max_width {
                break;
            }
            out.push(c);
        }
        return out;
    }
    let mut out = String::new();
    for c in text.chars() {
        if str_width(&out) + char_width(c) + str_width(ellipsis) > max_width {
            break;
        }
        out.push(c);
    }
    format!("{out}{ellipsis}")
}

/// The context column for one row (TS `formatContextColumn`).
fn context_column(usage: Option<&ContextUsageSnapshot>, with_bar: bool) -> Vec<ClientSpan> {
    let Some(usage) = usage else {
        return vec![dim("-")];
    };
    let (Some(tokens), Some(percent)) = (usage.tokens, usage.percent) else {
        return vec![dim("unknown after compaction")];
    };
    let percent = percent.round();
    let detail = format!(
        "{}/{}",
        crate::chrome::format_token_count(tokens),
        crate::chrome::format_token_count(usage.context_window)
    );
    let text = vec![raw_span(format!("{percent}% ")), dim(format!("({detail})"))];
    if !with_bar {
        return text;
    }
    let filled = ((percent / 100.0) * CONTEXT_BAR_WIDTH as f64)
        .round()
        .clamp(0.0, CONTEXT_BAR_WIDTH as f64) as usize;
    let bar_color = if percent >= 80.0 {
        ThemeColor::Warning
    } else {
        ThemeColor::Accent
    };
    let mut row = vec![
        ClientSpan::colored("\u{2593}".repeat(filled), bar_color),
        dim("\u{2591}".repeat(CONTEXT_BAR_WIDTH - filled)),
        raw_span(" "),
    ];
    row.extend(text);
    row
}

fn count_nodes(node: &ContextNode) -> usize {
    1 + node.children.iter().map(count_nodes).sum::<usize>()
}

fn sum_own_usage(node: &ContextNode, total: &mut UsageTotals) {
    total.input += node.own_usage.input;
    total.output += node.own_usage.output;
    total.cache_read += node.own_usage.cache_read;
    total.cache_write += node.own_usage.cache_write;
    total.cost_total += node.own_usage.cost_total;
    for child in &node.children {
        sum_own_usage(child, total);
    }
}

/// The whole tree's own usage summed per model (the `/context` Cost
/// section's breakdown): every node's per-model buckets fold into tree
/// buckets keyed by `provider/id`, so a mid-conversation switch — or
/// subagents on other models — shows each model's share of the total.
/// `None` when a node with billable own usage carries no per-model fold
/// (a foreign file): a partial breakdown would not add up to the
/// displayed total, so the Cost section stays plain.
fn sum_own_usage_by_model(node: &ContextNode, total: &mut Vec<ModelUsage>) {
    for bucket in &node.own_usage_by_model {
        if let Some(existing) = total
            .iter_mut()
            .find(|existing| existing.provider == bucket.provider && existing.id == bucket.id)
        {
            existing.totals.add_fold(&bucket.totals);
        } else {
            total.push(bucket.clone());
        }
    }
    for child in &node.children {
        sum_own_usage_by_model(child, total);
    }
}

/// The tree's per-model buckets when they account for every billed row.
fn tree_own_usage_by_model(root: &ContextNode) -> Option<Vec<ModelUsage>> {
    fn billed(node: &ContextNode) -> bool {
        node.own_usage.spent_tokens() > 0 || node.own_usage.cost_total > 0.0
    }
    fn covers(node: &ContextNode) -> bool {
        (!billed(node) || !node.own_usage_by_model.is_empty()) && node.children.iter().all(covers)
    }
    if !covers(root) {
        return None;
    }
    let mut total = Vec::new();
    sum_own_usage_by_model(root, &mut total);
    Some(total)
}

/// The `/context` rows (TS `formatContextTree`): the agent tree with own
/// token/cost columns and per-agent context utilization, then the grand
/// totals. `width` is the TS render width: `clamp(columns - 2, 60, 120)`.
pub fn context_tree_rows(tree: &Value, width: usize) -> Vec<ClientLine> {
    let root = parse_context_node(tree);
    let rows = flatten_tree(&root);

    let token_cells: Vec<String> = rows
        .iter()
        .map(|row| crate::chrome::format_token_count(row.node.own_usage.spent_tokens()))
        .collect();
    let cost_cells: Vec<String> = rows
        .iter()
        .map(|row| format_cost(row.node.own_usage.cost_total))
        .collect();
    let token_width = token_cells
        .iter()
        .map(String::len)
        .chain(["tokens".len()])
        .max()
        .unwrap_or_default();
    let cost_width = cost_cells
        .iter()
        .map(String::len)
        .chain(["cost".len()])
        .max()
        .unwrap_or_default();
    // The per-row model column — a deliberate TS delta (TS shows only the
    // root's `Model:` line): the model decides the cost, so every agent
    // row carries its bare model id, "-" when the node carries no model.
    // The column appears only when at least one node has a model; a tree
    // without model identity renders exactly the TS layout.
    let model_cells: Vec<String> = rows
        .iter()
        .map(|row| match &row.node.model {
            Some((_, id)) => id.rsplit('/').next().unwrap_or(id).to_string(),
            None => "-".to_string(),
        })
        .collect();
    let show_models = rows.iter().any(|row| row.node.model.is_some());
    let model_width = if show_models {
        model_cells
            .iter()
            .map(|cell| str_width(cell))
            .chain(["model".len()])
            .max()
            .unwrap_or_default()
    } else {
        0
    };
    let max_label = rows
        .iter()
        .map(|row| row.prefix.chars().count() + 2 + str_width(&row.node.label))
        .max()
        .unwrap_or_default();
    let label_width = MIN_LABEL_WIDTH.max(
        max_label.min(
            width
                .saturating_sub(token_width)
                .saturating_sub(cost_width)
                .saturating_sub(model_width + if show_models { 2 } else { 0 })
                .saturating_sub(28),
        ),
    );

    let mut lines: Vec<ClientLine> = vec![vec![raw_span("Context")], vec![]];
    if let Some((provider, model)) = &root.model {
        lines.push(vec![
            dim("Model:"),
            raw_span(format!(" {provider}/{model}")),
        ]);
        lines.push(vec![]);
    }
    let mut header = format!("  {}", pad_end("agent", label_width),);
    if show_models {
        let _ = write!(header, "  {}", pad_end("model", model_width));
    }
    let _ = write!(
        header,
        "  {}  {}  context",
        pad_start("tokens", token_width),
        pad_start("cost", cost_width)
    );
    lines.push(vec![dim(header)]);
    for (index, row) in rows.iter().enumerate() {
        let label_space = label_width
            .saturating_sub(row.prefix.chars().count())
            .saturating_sub(2)
            .max(1);
        let label = truncate_plain(&row.node.label, label_space);
        let (icon, icon_color) = status_icon(&row.node.status);
        // TS padEndAnsi/padStartAnsi pad with plain spaces OUTSIDE the
        // color codes, so the padding renders with the default foreground.
        let mut spans = vec![
            dim(row.prefix.clone()),
            ClientSpan::colored(icon, icon_color),
            raw_span(format!(" {label}")),
        ];
        let label_used: usize = spans.iter().map(|span| str_width(&span.text)).sum();
        spans.push(raw_span(format!(
            "{}  ",
            " ".repeat((label_width + 2).saturating_sub(label_used))
        )));
        if show_models {
            spans.push(dim(pad_end(&model_cells[index], model_width)));
            spans.push(raw_span("  "));
        }
        spans.push(raw_span(pad_start(&token_cells[index], token_width)));
        spans.push(raw_span("  "));
        spans.push(raw_span(
            " ".repeat(cost_width.saturating_sub(str_width(&cost_cells[index]))),
        ));
        spans.push(dim(&cost_cells[index]));
        spans.push(raw_span("  "));
        spans.extend(context_column(
            row.node.context_usage.as_ref(),
            row.node.id == "root",
        ));
        lines.push(spans);
    }

    let mut totals = UsageTotals::default();
    sum_own_usage(&root, &mut totals);
    let agent_count = count_nodes(&root);
    let mut total_line = vec![
        dim("Total:"),
        raw_span(format!(
            " {} tokens ",
            crate::chrome::format_token_count(totals.spent_tokens())
        )),
        dim("\u{b7}"),
        raw_span(format!(" {}", format_cost(totals.cost_total))),
    ];
    if agent_count > 1 {
        total_line.push(dim(format!(" across {agent_count} agents")));
    }
    lines.push(vec![]);
    lines.push(total_line);

    lines.push(vec![]);
    lines.push(vec![raw_span("Tokens")]);
    for (label, value) in [("Input:", totals.input), ("Output:", totals.output)] {
        lines.push(vec![dim(label), raw_span(format!(" {}", grouped(value)))]);
    }
    if totals.cache_read > 0 {
        lines.push(vec![
            dim("Cache Read:"),
            raw_span(format!(" {}", grouped(totals.cache_read))),
        ]);
    }
    if totals.cache_write > 0 {
        lines.push(vec![
            dim("Cache Write:"),
            raw_span(format!(" {}", grouped(totals.cache_write))),
        ]);
    }
    lines.push(vec![
        dim("Total:"),
        raw_span(format!(" {}", grouped(totals.spent_tokens()))),
    ]);

    if totals.cost_total > 0.0 {
        lines.push(vec![]);
        lines.push(vec![raw_span("Cost")]);
        lines.push(vec![
            dim("Total:"),
            raw_span(format!(" ${}", js_to_fixed(totals.cost_total, 4))),
        ]);
        // The per-model breakdown (the model mix decides the cost): the
        // whole tree's per-model buckets, most expensive model first.
        // Rendered only when the daemon sent buckets and the tree used
        // more than one model — a single-model tree already names its
        // model in the `Model:` line and renders exactly TS.
        let by_model = tree_own_usage_by_model(&root);
        if let Some(mut by_model) = by_model.filter(|by_model| by_model.len() > 1) {
            by_model.sort_by(|a, b| {
                b.totals
                    .cost_total
                    .total_cmp(&a.totals.cost_total)
                    .then_with(|| a.provider.cmp(&b.provider))
                    .then_with(|| a.id.cmp(&b.id))
            });
            for bucket in &by_model {
                lines.push(vec![
                    dim(format!("{}/{}:", bucket.provider, bucket.id)),
                    raw_span(format!(" ${}", js_to_fixed(bucket.totals.cost_total, 4))),
                ]);
            }
        }
    }

    if let Some(root_context) = &root.context_usage {
        lines.push(vec![]);
        lines.push(vec![raw_span("Context")]);
        match (root_context.tokens, root_context.percent) {
            (Some(tokens), Some(percent)) => lines.push(vec![
                dim("Current:"),
                raw_span(format!(
                    " {} / {} ({}%)",
                    grouped(tokens),
                    grouped(root_context.context_window),
                    js_tenth(percent)
                )),
            ]),
            _ => lines.push(vec![dim("Current:"), raw_span(" unknown after compaction")]),
        }
    }

    lines
}

// ---------------------------------------------------------------------------
// Render (the view's paint entry points)
// ---------------------------------------------------------------------------

/// Resolve one info row to styled spans (the TS `theme.fg` tokens).
fn styled_spans(row: &[ClientSpan], theme: &Theme) -> Line {
    row.iter()
        .map(|span| match span.color {
            Some(color) => theme.fg(color, span.text.clone()),
            None => Span::raw(span.text.clone()),
        })
        .collect()
}

/// Count client text using the same styled input runs as rendering.
pub(crate) fn client_text_row_count(rows: &[ClientLine], theme: &Theme, width: usize) -> usize {
    1 + rows
        .iter()
        .map(|row| {
            crate::width::wrapped_line_count(
                &styled_spans(row, theme),
                width.saturating_sub(2).max(1),
            )
        })
        .sum::<usize>()
}

fn changelog_style(theme: &Theme, code_block_indent: &str) -> crate::markdown::MarkdownStyle {
    let mut md = crate::markdown::MarkdownStyle::from_theme(theme);
    md.code_block_indent = code_block_indent.to_string();
    md
}

pub(crate) fn changelog_panel_row_count(
    markdown: &str,
    theme: &Theme,
    code_block_indent: &str,
    width: usize,
) -> usize {
    7 + crate::markdown::markdown_row_count(
        markdown.trim(),
        width.saturating_sub(2).max(1),
        &changelog_style(theme, code_block_indent),
    )
}

/// TS `Spacer(1)` + `Text(info, 1, 0)`: one blank row, then each source
/// line wrapped at `width - 2` with a one-column margin on each side and
/// rows padded to the full width (continuation rows pad inside the open
/// style, the last wrapped row after the segment's reset — TS ANSI
/// behavior).
pub fn render_client_text(rows: &[ClientLine], theme: &Theme, width: usize) -> Vec<Line> {
    let content_width = width.saturating_sub(2).max(1);
    let mut out: Vec<Line> = vec![Vec::new()];
    for row in rows {
        let styled = styled_spans(row, theme);
        let wrapped = crate::width::wrap_line(&styled, content_width);
        let row_count = wrapped.len();
        for (index, mut line) in wrapped.into_iter().enumerate() {
            let padding_style = if index + 1 < row_count {
                line.last().map_or(Style::default(), |span| span.style)
            } else {
                Style::default()
            };
            let mut row: Line = vec![Span::raw(" ")];
            row.append(&mut line);
            out.push(crate::chat::pad_to(row, width, padding_style));
        }
    }
    out
}

/// TS `handleChangelogCommand`: `Spacer(1)`, `DynamicBorder`, the accent
/// `What's New` title (`Text(title, 1, 0)`), `Spacer(1)` + `Markdown(md, 1,
/// 1)`, and the closing `DynamicBorder`.
pub fn render_changelog_panel(
    markdown: &str,
    theme: &Theme,
    code_block_indent: &str,
    width: usize,
) -> Vec<Line> {
    let mut rows: Vec<Line> = Vec::new();
    rows.push(Vec::new());
    rows.push(vec![
        theme.fg(ThemeColor::Border, "\u{2500}".repeat(width.max(1)))
    ]);
    let title: Line = vec![Span::raw(" "), theme.fg(ThemeColor::Accent, "What's New")];
    rows.push(crate::chat::pad_to(title, width, Style::default()));
    rows.push(Vec::new());
    rows.push(Vec::new());
    let md = changelog_style(theme, code_block_indent);
    rows.extend(crate::chat::render_markdown_block(
        markdown,
        &md,
        width,
        &mut crate::markdown::MarkdownBlockCache::default(),
    ));
    rows.push(Vec::new());
    rows.push(vec![
        theme.fg(ThemeColor::Border, "\u{2500}".repeat(width.max(1)))
    ]);
    rows
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plain(rows: &[ClientLine]) -> Vec<String> {
        rows.iter()
            .map(|row| row.iter().map(|span| span.text.as_str()).collect())
            .collect()
    }

    fn json(text: &str) -> Value {
        serde_json::from_str(text).expect("fixture json")
    }

    #[test]
    fn geometry_matches_client_and_changelog_rows() {
        let theme = Theme::builtin("prime", crate::theme::ColorMode::TrueColor);
        let rows = vec![
            vec![],
            vec![raw_span("  ")],
            vec![dim("prefix "), raw_span("wide 界 words words")],
        ];
        for width in [0, 1, 2, 7, 23, 80] {
            assert_eq!(
                client_text_row_count(&rows, &theme, width),
                render_client_text(&rows, &theme, width).len()
            );
            for markdown in [
                "",
                "  ",
                "# Heading\n\nwrapped words 界 words",
                "| a | b |\n|---|---|\n| x | y |",
                "```python\nprint(1)\n```",
            ] {
                assert_eq!(
                    changelog_panel_row_count(markdown, &theme, "    ", width),
                    render_changelog_panel(markdown, &theme, "    ", width).len()
                );
            }
        }
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
            plain(&context_tree_rows(&tree, 120)),
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
            plain(&context_tree_rows(&tree, 100)),
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
            plain(&context_tree_rows(&tree, 120)),
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
        let rows = context_tree_rows(&tree, 120);
        // The root row carries the bar: warning at >= 80 percent.
        let bar = rows[3]
            .iter()
            .find(|span| span.text.contains("\u{2593}"))
            .expect("the bar cell");
        assert_eq!(bar.color, Some(ThemeColor::Warning));
        // Under 80 the bar is the accent color (fixture A covers it at
        // 0.5 percent); the token cells are default-foreground.
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
    fn changelog_panel_renders_the_ts_borders_and_title() {
        let theme = crate::theme::Theme::builtin("prime", crate::theme::ColorMode::TrueColor);
        let rows = render_changelog_panel("Entry one.", &theme, "  ", 20);
        let text: Vec<String> = rows
            .iter()
            .map(|row| row.iter().map(|span| span.content.as_str()).collect())
            .collect();
        assert_eq!(
            text,
            vec![
                String::new(),
                "\u{2500}".repeat(20),
                format!(" What's New{}", " ".repeat(9)),
                String::new(),
                String::new(),
                format!(" Entry one.{}", " ".repeat(9)),
                String::new(),
                "\u{2500}".repeat(20),
            ]
        );
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
}
