//! The `/mcp` view: the TS `ServiceCatalogPickerComponent`'s catalog
//! surface — the resolved service catalog's cards (catalog services plus
//! user-declared servers, connected-first) and the api-key credential
//! rows (the stored keys, e.g. the web-search key) over the daemon's
//! `get_mcp_connections` response, with the TS picker's search bands,
//! ONE fixed detail line, and the navigate/action/close hint. Enter runs
//! the connection's login flow (TS `onSelect` -> `authenticate`) or the
//! credential's paste-the-key prompt; Esc closes. The panel is the same
//! inline shape as the `/model` picker (the bordered search field over
//! `›`-marker rows), and its frame is budgeted so the dock can never
//! overflow the terminal (the detail line drops when the viewport is too
//! short, never the search field).

use crate::keybindings::{format_key_text, KeybindingsManager};
use crate::menu_panel::{menu_list_layout, search_field_lines};
use crate::search_input::SearchInput;
use crate::theme::{Theme, ThemeColor};
use crate::{Line, Span};

use serde_json::Value;

mod rows;

use rows::{flatten_to_single_line, McpCredentialRow, McpRow, McpServiceRow};

/// The search field's placeholder (TS `MenuSearchInput("Search MCP
/// connections")`).
const SEARCH_PLACEHOLDER: &str = "Search MCP connections";

const PREFERRED_VISIBLE_SERVICES: usize = 8;

const SEARCH_FIELD_ROWS: usize = 3;

const HINT_ROWS: usize = 1;

const SCROLL_INDICATOR_ROWS: usize = 1;

const DETAIL_ROWS: usize = 1;

const DETAIL_SPACER_ROWS: usize = 1;

/// Viewports below this height cannot fit the search field, one result row, the counter, the
/// spacer, the detail line, and the hint; the detail line drops instead (TS `MIN_ROWS_FOR_DETAIL`).
const MIN_ROWS_FOR_DETAIL: usize =
    SEARCH_FIELD_ROWS + HINT_ROWS + SCROLL_INDICATOR_ROWS + DETAIL_ROWS + DETAIL_SPACER_ROWS + 2;

/// The empty state's window rows (the message plus its blank row before the hint): the layout must
/// budget them before the message renders.
const EMPTY_STATE_ROWS: usize = 2;

// Search bands (TS `service-catalog-picker.ts`): lower scores rank
// first; identity fields (label, service id, aliases) always outrank
// description/setup-hint text. The fractional tiebreaks are the TS
// bands exactly (prefix closeness, substring position, subsequence
// span), so the ranking is the TS ranking.
const SCORE_EXACT: f64 = 0.0;
const SCORE_PREFIX: f64 = 100.0;
const SCORE_WORD_START: f64 = 200.0;
const SCORE_SUBSTRING: f64 = 300.0;
const SCORE_SUBSEQUENCE: f64 = 400.0;
const SCORE_DESCRIPTION_WORD_START: f64 = 500.0;
const SCORE_DESCRIPTION_SUBSTRING: f64 = 600.0;

/// The query's word split (TS `words`): Unicode letters and numbers, lowercased, empties dropped.
fn words(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(str::to_string)
        .collect()
}

/// TS string operations run on UTF-16 code units (`.length`, indexing, `indexOf`), so the scoring
/// bands and tiebreaks must measure the same units: a surrogate pair counts as two and a substring
/// position is a unit index, or non-ASCII queries rank differently from the TS picker.
fn utf16_len(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

/// The first UTF-16 code-unit index of `needle` in `haystack`, like TS `indexOf` (byte offsets
/// diverge past ASCII).
fn utf16_index(haystack: &[u16], needle: &[u16]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

/// Identity match: exact, prefix (plus the remaining-length tiebreak), word start, substring (plus
/// the position tiebreak), then the subsequence fallback with its span penalty.
fn identity_match_score(text: &str, token: &str) -> Option<f64> {
    let haystack = text.to_lowercase();
    if haystack == *token {
        return Some(SCORE_EXACT);
    }
    if let Some(rest) = haystack.strip_prefix(token) {
        return Some(SCORE_PREFIX + utf16_len(rest) as f64 * 0.01);
    }
    if words(&haystack).iter().any(|word| word.starts_with(token)) {
        return Some(SCORE_WORD_START);
    }
    let units: Vec<u16> = haystack.encode_utf16().collect();
    let token_units: Vec<u16> = token.encode_utf16().collect();
    if let Some(at) = utf16_index(&units, &token_units) {
        return Some(SCORE_SUBSTRING + at as f64 * 0.01);
    }
    subsequence_match_score(&units, &token_units)
}

/// Identity-only subsequence fallback (TS `subsequenceMatchScore`, over UTF-16 code units). The
/// consecutive-run floor — half the query, minimum two units — keeps the fallback for tight
/// abbreviations while rejecting the scattered matches; the span tiebreak spreads matches.
fn subsequence_match_score(haystack: &[u16], token: &[u16]) -> Option<f64> {
    if token.len() < 2 || token.len() > haystack.len() {
        return None;
    }
    let mut token_index = 0;
    let mut run_length: i64 = 0;
    let mut longest_run: i64 = 0;
    let mut first_match: i64 = -1;
    let mut last_match: i64 = -1;
    let mut index = 0;
    while index < haystack.len() && token_index < token.len() {
        let matched = haystack[index] == token[token_index];
        if !matched {
            index += 1;
            continue;
        }
        run_length = if last_match == index as i64 - 1 {
            run_length + 1
        } else {
            1
        };
        longest_run = longest_run.max(run_length);
        if first_match == -1 {
            first_match = index as i64;
        }
        last_match = index as i64;
        token_index += 1;
        index += 1;
    }
    if token_index < token.len() || longest_run < 2.max((token.len() as i64 + 1) / 2) {
        return None;
    }
    let span = (last_match - first_match + 1) - token.len() as i64;
    Some(SCORE_SUBSEQUENCE + span as f64 * 2.0)
}

/// Description text matches only as a word start or substring (plus the UTF-16 position tiebreak) —
/// never a subsequence.
fn description_match_score(text: &str, token: &str) -> Option<f64> {
    let haystack = text.to_lowercase();
    if words(&haystack).iter().any(|word| word.starts_with(token)) {
        return Some(SCORE_DESCRIPTION_WORD_START);
    }
    let units: Vec<u16> = haystack.encode_utf16().collect();
    let token_units: Vec<u16> = token.encode_utf16().collect();
    utf16_index(&units, &token_units).map(|at| SCORE_DESCRIPTION_SUBSTRING + at as f64 * 0.01)
}

/// The row's search score for the whole query (TS `serviceMatchScore`):
/// every token must match somewhere; each token's best field score is
/// summed into the row's total. Identity fields first; the
/// description/setup-hint band only when no identity field matched.
fn row_search_score(row: &McpRow, query: &str) -> Option<f64> {
    let query = query.trim().to_lowercase();
    let tokens: Vec<&str> = query
        .split_whitespace()
        .filter(|token| !token.is_empty())
        .collect();
    if tokens.is_empty() {
        return Some(0.0);
    }
    let mut total = 0.0;
    for token in tokens {
        let mut best: Option<f64> = None;
        for field in row.identity_fields() {
            if let Some(score) = identity_match_score(field, token) {
                best = Some(best.map_or(score, |current| current.min(score)));
            }
        }
        if best.is_none() {
            for field in row.description_fields() {
                if let Some(score) = description_match_score(field, token) {
                    best = Some(best.map_or(score, |current| current.min(score)));
                }
            }
        }
        best?;
        total += best.expect("matched");
    }
    Some(total)
}

/// One key press while the view is open.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum McpViewAction {
    /// Enter on a connectable connection/service: run its login flow (the caller resolves
    /// the auth hook; TS `authenticate`). `label` feeds the inline auth panel's title.
    Select { server: String, label: String },
    /// Enter on a pasteable token service with no installed account: open the paste flow
    /// ("paste token"). `label` feeds the panel's title.
    Paste { server: String, label: String },
    /// Enter on an api-key credential row (the stored keys the view
    /// manages alongside the connections): open the paste-the-key prompt
    /// (the panel's masked paste field). `id` is the credential's auth
    /// slot, `label` its display name (the panel's title reads "Connect
    /// {label}").
    Key { id: String, label: String },
    /// Esc, Ctrl+C, or back: close without selecting.
    Cancel,
    /// Navigation or search editing only.
    None,
}

/// The `/mcp` service-catalog view: the resolved catalog's cards (the
/// TS `ServiceCatalogPickerComponent`'s catalog surface — every resolved
/// service plus user-declared servers, connected-first) and the api-key
/// credential rows, with the TS picker's search bands and one fixed
/// detail line.
#[derive(Debug)]
pub struct McpView {
    rows: Vec<McpRow>,
    search: SearchInput,
    filtered: Vec<usize>,
    selected: usize,
    viewport_rows: usize,
    visible_items: usize,
    last_query: String,
}

impl McpView {
    /// Build the view over the daemon's `get_mcp_connections` response:
    /// the resolved `services` cards (the catalog surface) plus the
    /// `credentials` rows (the api-key entries the view manages alongside
    /// the connections). The response carries no live tool listing — the
    /// picker opens from this local state exactly like TS, so the open is
    /// instant.
    pub fn from_response(data: &Value, viewport_rows: usize) -> Self {
        let services: Vec<McpServiceRow> = data
            .get("services")
            .and_then(Value::as_array)
            .map(|entries| {
                entries
                    .iter()
                    .filter_map(McpServiceRow::from_value)
                    .collect()
            })
            .unwrap_or_default();
        let credentials: Vec<McpCredentialRow> = data
            .get("credentials")
            .and_then(Value::as_array)
            .map(|entries| {
                entries
                    .iter()
                    .filter_map(McpCredentialRow::from_value)
                    .collect()
            })
            .unwrap_or_default();
        // The catalog cards own the service rows when the daemon serves
        // them (TS `buildPluginViews` already includes user-declared
        // servers); a daemon that predates the catalog surface serves only
        // the legacy `connections` roster, and its rows render from the
        // roster. The credential rows ride after the cards (the api-key
        // class the view serves alongside the connections).
        let mut rows: Vec<McpRow> = if services.is_empty() {
            data.get("connections")
                .and_then(Value::as_array)
                .map(|entries| {
                    entries
                        .iter()
                        .filter_map(McpServiceRow::from_roster_entry)
                        .map(McpRow::Service)
                        .collect()
                })
                .unwrap_or_default()
        } else {
            services.into_iter().map(McpRow::Service).collect()
        };
        rows.extend(credentials.into_iter().map(McpRow::Credential));
        let mut view = McpView {
            rows,
            search: SearchInput::new(),
            filtered: Vec::new(),
            selected: 0,
            viewport_rows,
            visible_items: PREFERRED_VISIBLE_SERVICES,
            last_query: String::new(),
        };
        view.refilter();
        view
    }

    /// The selected row's action target (Enter's service id, or the
    /// credential's auth slot).
    pub fn selected_server(&self) -> Option<&str> {
        self.rows
            .get(*self.filtered.get(self.selected)?)
            .map(McpRow::target)
    }

    /// One key press (TS `handleInput`): arrows clamp at the list's bounds (never wrap), page
    /// keys step by the visible window, Enter routes by the selected row, Esc closes, and
    /// everything else edits the search field — including the left arrow (the catalog surface has
    /// no parent to go back to).
    pub fn handle_key(&mut self, key: &str, kb: &KeybindingsManager) -> McpViewAction {
        if key == "ctrl+c" {
            return McpViewAction::Cancel;
        }
        if kb.matches(key, "tui.select.up") {
            if !self.filtered.is_empty() {
                self.selected = self.selected.saturating_sub(1);
            }
            return McpViewAction::None;
        }
        if kb.matches(key, "tui.select.down") {
            if !self.filtered.is_empty() {
                self.selected = (self.selected + 1).min(self.filtered.len() - 1);
            }
            return McpViewAction::None;
        }
        if kb.matches(key, "tui.select.pageUp") || kb.matches(key, "tui.select.pageDown") {
            let direction = if kb.matches(key, "tui.select.pageUp") {
                -(self.visible_items as isize)
            } else {
                self.visible_items as isize
            };
            let count = self.filtered.len();
            if count > 0 {
                self.selected =
                    (self.selected as isize + direction).clamp(0, count as isize - 1) as usize;
            }
            return McpViewAction::None;
        }
        if kb.matches(key, "tui.select.confirm") {
            let selected_row = self
                .filtered
                .get(self.selected)
                .and_then(|index| self.rows.get(*index));
            return match selected_row {
                // The credential rows route to the paste-the-key prompt
                // (a configured row's Enter replaces the stored key).
                Some(McpRow::Credential(credential)) => McpViewAction::Key {
                    id: credential.id.clone(),
                    label: credential.label.clone(),
                },
                Some(McpRow::Service(service)) if service.wants_paste() => McpViewAction::Paste {
                    server: service.target().to_string(),
                    label: service.label.clone(),
                },
                Some(McpRow::Service(service)) => McpViewAction::Select {
                    server: service.target().to_string(),
                    label: service.label.clone(),
                },
                None => McpViewAction::None,
            };
        }
        // Esc/Ctrl+C close; the modal back key closes from an empty search (its left-edge editing
        // otherwise feeds the field).
        if kb.matches(key, "tui.select.cancel")
            || (kb.matches(key, "app.modal.back") && self.search.cursor() == 0)
        {
            return McpViewAction::Cancel;
        }
        let previous = self.search.value().to_string();
        self.search.handle_key(key, kb);
        if self.search.value() != previous {
            self.refilter();
        }
        McpViewAction::None
    }

    /// Prefill the filter (`/mcp <partial>` + Tab or `/plugins <q>`), the caret at the partial's
    /// end.
    pub fn set_search(&mut self, query: &str) {
        self.search.prefill(query);
        self.refilter();
    }

    pub fn paste(&mut self, text: &str) {
        let previous = self.search.value().to_string();
        self.search.paste(text);
        if self.search.value() != previous {
            self.refilter();
        }
    }

    /// The picked frame (TS `updateList` + `render`: the bordered search field, the visible
    /// window's rows, the scroll indicator, ONE fixed detail line under a blank row, the hint).
    pub fn render(&mut self, theme: &Theme, width: usize, kb: &KeybindingsManager) -> Vec<Line> {
        self.visible_items = self.list_layout();

        let mut lines = search_field_lines(
            theme,
            width,
            self.search.value(),
            self.search.cursor(),
            true,
            SEARCH_PLACEHOLDER,
        );

        let (start, end) = self.window();
        for index in start..end {
            let Some(&filtered_index) = self.filtered.get(index) else {
                continue;
            };
            let Some(row) = self.rows.get(filtered_index) else {
                continue;
            };
            let selected = index == self.selected;
            let primary: Line = vec![Span::raw(row.primary_line())];
            // Rows carry their status flush right (TS `MenuRow` trailing meta).
            let (color, status) = row.status_text();
            let status = status.as_str();
            let trailing = vec![(color, status)];
            lines.push(trailing_menu_row(
                theme, width, primary, &trailing, selected,
            ));
        }

        // The indicator would spend a row the viewport does not have.
        if self.visible_items > 0 && (start > 0 || end < self.filtered.len()) {
            let indicator = format!("  ({}/{})", self.selected + 1, self.filtered.len());
            // A narrow frame truncates the indicator to its width, never overwriting adjacent
            // cells.
            let line = vec![theme.fg_span(ThemeColor::Muted, indicator)];
            lines.push(crate::width::truncate_line(&line, width, ""));
        }

        if self.visible_items > 0 {
            if self.filtered.is_empty() {
                // The empty state's message and its blank row spend the two rows the window
                // budgets: a viewport too short for both keeps the skeleton alone (the
                // frame never draws past its viewport).
                if self.visible_items >= EMPTY_STATE_ROWS {
                    let message = if self.rows.is_empty() {
                        "No external services available"
                    } else {
                        "No matching services"
                    };
                    // The message row aligns with the row labels and truncates to the frame width.
                    let line = vec![theme.fg_span(ThemeColor::Muted, format!("  {message}"))];
                    lines.push(crate::width::truncate_line(&line, width, ""));
                    lines.push(Vec::new());
                }
            } else if self.detail_rows() > 0 {
                // One blank line between the last row and the ONE fixed detail line (TS).
                lines.push(Vec::new());
                if let Some(row) = self
                    .filtered
                    .get(self.selected)
                    .and_then(|index| self.rows.get(*index))
                    .cloned()
                {
                    // TS `secondaryText ?? statusText`: the detail falls back to the row's
                    // status when the entry carries no copy.
                    let text = flatten_to_single_line(
                        &row.detail_text().unwrap_or_else(|| row.status_text().1),
                    );
                    let line = vec![theme.fg_span(ThemeColor::Muted, format!(" {text}"))];
                    lines.push(crate::menu_panel::detail_row(theme, width, &line));
                }
            }
        }

        let action = self
            .filtered
            .get(self.selected)
            .and_then(|index| self.rows.get(*index))
            .map(McpRow::action_text);
        lines.push(hint_line(theme, width, kb, action));
        lines
    }

    /// The inline list layout (TS `getMenuListLayout` shape): the reserved rows are the
    /// search field and the hint, plus the detail group when the viewport can fit it.
    fn list_layout(&self) -> usize {
        // The shared layout floors at one row so a picker never reads empty; this view must
        // never render past its viewport, so a frame too short for any row renders none
        // (the scroll indicator follows: nothing to scroll).
        let reserved = SEARCH_FIELD_ROWS + HINT_ROWS + self.detail_rows();
        if self.viewport_rows <= reserved {
            return 0;
        }
        menu_list_layout(
            Some(self.viewport_rows),
            PREFERRED_VISIBLE_SERVICES,
            self.filtered.len(),
            reserved,
            SCROLL_INDICATOR_ROWS,
        )
    }

    /// The detail group's rows (TS `DETAIL_ROWS`), dropped when the viewport cannot fit
    /// the panel skeleton (TS `MIN_ROWS_FOR_DETAIL`).
    fn detail_rows(&self) -> usize {
        if self.viewport_rows >= MIN_ROWS_FOR_DETAIL {
            DETAIL_ROWS + DETAIL_SPACER_ROWS
        } else {
            0
        }
    }

    /// The visible row window centered on the selection. A frame too short for any row carries the
    /// EMPTY window — never raised back to one row (`list_layout`'s guard owns the 0).
    fn window(&self) -> (usize, usize) {
        if self.visible_items == 0 {
            return (0, 0);
        }
        let max_visible = self.visible_items;
        let selected = self.selected.min(self.filtered.len().saturating_sub(1));
        let start = selected
            .saturating_sub(max_visible / 2)
            .min(self.filtered.len().saturating_sub(max_visible));
        let end = (start + max_visible).min(self.filtered.len());
        (start, end)
    }

    /// Rebuild the filtered view (TS `filterServices`): an empty query shows everything; a
    /// query scores every row against the query's tokens (identity fields first, then the
    /// description band), every token must match, and rows rank by their summed score —
    /// stable, so equal scores keep the catalog's connected-first order.
    fn refilter(&mut self) {
        let query = self.search.value().to_string();
        let query_changed = query != self.last_query;
        self.last_query.clone_from(&query);
        let trimmed = query.trim().to_string();
        self.filtered = if trimmed.is_empty() {
            (0..self.rows.len()).collect()
        } else {
            let mut scored: Vec<(f64, usize)> = self
                .rows
                .iter()
                .enumerate()
                .filter_map(|(index, row)| Some((row_search_score(row, &trimmed)?, index)))
                .collect();
            scored.sort_by(|left, right| left.0.total_cmp(&right.0));
            scored.into_iter().map(|(_, index)| index).collect()
        };
        if query_changed {
            self.selected = 0;
        } else {
            self.selected = self.selected.min(self.filtered.len().saturating_sub(1));
        }
        self.visible_items = self.list_layout();
    }
}

/// One inline menu row with a THEMED trailing cell (the `menu_row` layout with the TS `statusText`
/// colors).
fn trailing_menu_row(
    theme: &Theme,
    width: usize,
    primary: Line,
    trailing: &[(ThemeColor, &str)],
    selected: bool,
) -> Line {
    let inner_width = width.saturating_sub(2).max(1);
    // TS `getInlineTrailing`: the trailing cluster lives on a budget of the inner width minus five
    // — segments reduce from the front until the cluster fits, then the joined text truncates with
    // the ellipsis, so a narrow row keeps a SHORTENED status instead of losing it.
    let budget = inner_width.saturating_sub(5).max(1);
    let mut reduced: Vec<&(ThemeColor, &str)> = trailing
        .iter()
        .filter(|(_, text)| !text.is_empty())
        .collect();
    let cluster = |segments: &[&(ThemeColor, &str)]| -> String {
        segments
            .iter()
            .map(|(_, text)| *text)
            .collect::<Vec<_>>()
            .join(" \u{b7} ")
    };
    while reduced.len() > 1 && crate::width::str_width(&cluster(&reduced)) > budget {
        reduced.remove(0);
    }
    let mut trailing_spans: Line = if reduced.is_empty() {
        Vec::new()
    } else {
        let mut spans: Vec<Span> = Vec::with_capacity(reduced.len() * 2);
        for (index, (color, text)) in reduced.iter().enumerate() {
            if index > 0 {
                spans.push(Span::raw(" \u{b7} "));
            }
            spans.push(theme.fg_span(*color, *text));
        }
        spans
    };
    if !trailing_spans.is_empty() {
        trailing_spans = crate::width::truncate_line(&trailing_spans, budget, "\u{2026}");
    }
    let trailing_width = crate::width::spans_width(&trailing_spans);
    let gap = if trailing_width > 0 { 2 } else { 0 };
    let primary_width = inner_width.saturating_sub(trailing_width + gap).max(1);
    let mut primary = primary;
    if selected {
        primary = primary
            .into_iter()
            .map(|mut span| {
                span.style = span.style.add_modifier(ratatui::style::Modifier::BOLD);
                span
            })
            .collect();
    }
    let primary = crate::width::truncate_line(&primary, primary_width, "\u{2026}");
    let filler_width = inner_width
        .saturating_sub(crate::width::spans_width(&primary))
        .saturating_sub(trailing_width);
    let mut row: Line = Vec::with_capacity(primary.len() + trailing_spans.len() + 4);
    row.push(Span::raw(if selected { "\u{203a}" } else { " " }));
    row.push(Span::raw(" "));
    row.extend(primary);
    if filler_width > 0 {
        row.push(Span::raw(" ".repeat(filler_width)));
    }
    row.extend(trailing_spans);
    let mut row = crate::width::truncate_line(&row, width, "");
    let used = crate::width::spans_width(&row);
    if used < width {
        row.push(Span::raw(" ".repeat(width - used)));
    }
    if selected {
        let style = theme.soft_selection_style();
        row = row
            .into_iter()
            .map(|mut span| {
                span.style = span.style.patch(style);
                span
            })
            .collect();
    }
    row
}

/// The trailing key hint (TS the shortcuts row): navigate · Enter <action> · close — the action
/// segment appears only when a row is selected (TS renders no `Enter select` filler).
fn hint_line(theme: &Theme, width: usize, kb: &KeybindingsManager, action: Option<&str>) -> Line {
    let select_key = kb
        .first_key("tui.select.confirm")
        .map_or_else(|| "Enter".to_string(), |key| format_key_text(&key));
    let close_key = kb
        .first_key("tui.select.cancel")
        .map_or_else(|| "Esc".to_string(), |key| format_key_text(&key));
    let action_segment = action
        .map(|action| format!("{select_key} {action} \u{b7} "))
        .unwrap_or_default();
    let hint = if width >= 70 {
        let navigation = format!(
            "{}/{} navigate \u{b7} ",
            kb.first_key("tui.select.up")
                .map_or_else(|| "\u{2191}".to_string(), |key| format_key_text(&key)),
            kb.first_key("tui.select.down")
                .map_or_else(|| "\u{2193}".to_string(), |key| format_key_text(&key))
        );
        format!("{navigation}{action_segment}{close_key} close")
    } else {
        format!("{action_segment}{close_key} close")
    };
    let line = vec![theme.fg_span(ThemeColor::Dim, format!(" {hint}"))];
    crate::width::truncate_line(&line, width, "")
}
#[cfg(test)]
mod tests;
