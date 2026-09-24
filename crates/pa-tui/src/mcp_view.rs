//! The `/mcp` view: the TS `ServiceCatalogPickerComponent`'s catalog
//! surface — the resolved service catalog's cards (catalog services plus
//! user-declared servers, connected-first) over the daemon's
//! `get_mcp_connections` response, with the TS picker's search bands,
//! ONE fixed detail line, and the navigate/action/close hint. Enter runs
//! the connection's login flow (TS `onSelect` -> `authenticate`); Esc
//! closes. The panel is the same inline shape as the `/model` picker
//! (the bordered search field over `›`-marker rows), and its frame is
//! budgeted so the dock can never overflow the terminal (the detail line
//! drops when the viewport is too short, never the search field).

use crate::keybindings::{format_key_text, KeybindingsManager};
use crate::menu_panel::{menu_list_layout, search_field_lines};
use crate::search_input::SearchInput;
use crate::theme::{Theme, ThemeColor};
use crate::{Line, Span};

use serde_json::Value;

/// The search field's placeholder (TS `MenuSearchInput("Search MCP
/// connections")`).
const SEARCH_PLACEHOLDER: &str = "Search MCP connections";

/// The picker's preferred visible rows (TS `PREFERRED_VISIBLE_SERVICES`).
const PREFERRED_VISIBLE_SERVICES: usize = 8;

/// The inline search field's rows (the bordered field).
const SEARCH_FIELD_ROWS: usize = 3;

/// The trailing key hint's row.
const HINT_ROWS: usize = 1;

/// The scroll indicator's row (shown when the window is partial).
const SCROLL_INDICATOR_ROWS: usize = 1;

/// The one fixed detail line under the list (TS `DETAIL_ROWS`).
const DETAIL_ROWS: usize = 1;

/// The blank line between the last row and the detail line (TS
/// `DETAIL_SPACER_ROWS`).
const DETAIL_SPACER_ROWS: usize = 1;

/// Viewports below this height cannot fit the search field, one result
/// row, the counter, the spacer, the detail line, and the hint; the
/// detail line drops instead of overflowing the terminal (TS
/// `MIN_ROWS_FOR_DETAIL`, measured against the picker's row budget).
const MIN_ROWS_FOR_DETAIL: usize =
    SEARCH_FIELD_ROWS + HINT_ROWS + SCROLL_INDICATOR_ROWS + DETAIL_ROWS + DETAIL_SPACER_ROWS + 2;

/// The empty state's window rows (the message plus its blank row before
/// the hint): the layout must budget them before the message renders.
const EMPTY_STATE_ROWS: usize = 2;

/// One service-catalog card (the daemon's resolved `services` array; TS
/// `McpPluginView`): a catalog service or a user-declared server with its
/// honestly-computed connection state.
#[derive(Debug, Clone, PartialEq)]
pub struct McpServiceRow {
    pub service_id: String,
    pub label: String,
    pub connection_status: String,
    pub connectable: bool,
    pub login_pending: bool,
    pub uses_oauth: bool,
    pub source: String,
    pub connection_ids: Vec<String>,
    /// The paste-panel marker: a requires-setup token service collecting
    /// exactly one credential. Never a connected/verified claim.
    pub paste_token: bool,
    pub aliases: Vec<String>,
    pub description: Option<String>,
    pub category: Option<String>,
    pub publisher: Option<String>,
    pub docs_url: Option<String>,
    pub setup_hint: Option<String>,
    pub tool_count: Option<usize>,
    pub verified_at: Option<u64>,
}

impl McpServiceRow {
    /// Parse one daemon `services` entry.
    fn from_value(value: &Value) -> Option<Self> {
        let connection_ids = value
            .get("connectionIds")
            .and_then(Value::as_array)
            .map(|ids| {
                ids.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        Some(McpServiceRow {
            service_id: value.get("serviceId")?.as_str()?.to_string(),
            label: value
                .get("label")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            connection_status: value
                .get("connectionStatus")
                .and_then(Value::as_str)
                .unwrap_or("not_connected")
                .to_string(),
            connectable: value
                .get("connectable")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            login_pending: value
                .get("loginPending")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            uses_oauth: value
                .get("usesOAuth")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            source: value
                .get("source")
                .and_then(Value::as_str)
                .unwrap_or("catalog")
                .to_string(),
            connection_ids,
            paste_token: value
                .get("pasteToken")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            aliases: value
                .get("aliases")
                .and_then(Value::as_array)
                .map(|aliases| {
                    aliases
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default(),
            description: value
                .get("description")
                .and_then(Value::as_str)
                .map(str::to_string),
            category: value
                .get("category")
                .and_then(Value::as_str)
                .map(str::to_string),
            publisher: value
                .get("publisher")
                .and_then(Value::as_str)
                .map(str::to_string),
            docs_url: value
                .get("docsUrl")
                .and_then(Value::as_str)
                .map(str::to_string),
            setup_hint: value
                .get("setupHint")
                .and_then(Value::as_str)
                .map(str::to_string),
            tool_count: value
                .get("toolCount")
                .and_then(Value::as_u64)
                .map(|c| c as usize),
            verified_at: value.get("verifiedAt").and_then(Value::as_u64),
        })
    }

    /// The trailing status text (TS `statusText`, catalog mode): the honest
    /// state vocabulary, with the record-carried tool count on connected
    /// rows (the picker reads local state only, like TS).
    fn status_text(&self) -> (ThemeColor, String) {
        if self.login_pending {
            return (ThemeColor::Warning, "Login in progress".to_string());
        }
        match self.connection_status.as_str() {
            "connected" => (
                ThemeColor::Success,
                match self.tool_count {
                    Some(tool_count) => format!("Connected \u{b7} {tool_count} tools"),
                    None => "Connected".to_string(),
                },
            ),
            "pending" => (ThemeColor::Warning, "Needs verification".to_string()),
            "error" => (
                ThemeColor::Error,
                if self.connectable {
                    "Reconnect"
                } else {
                    "Needs attention"
                }
                .to_string(),
            ),
            "setup_required" => (ThemeColor::Warning, "Requires setup".to_string()),
            "disabled" => (ThemeColor::Muted, "Disabled".to_string()),
            _ => (
                if self.connectable {
                    ThemeColor::Text
                } else {
                    ThemeColor::Muted
                },
                if self.connectable {
                    "Connect"
                } else {
                    "Not connected"
                }
                .to_string(),
            ),
        }
    }

    /// The selected row's detail copy (TS `secondaryText`, catalog mode):
    /// the honest setup guidance for setup-required/error rows, the
    /// description otherwise.
    fn detail_text(&self) -> Option<String> {
        if self.connection_status == "setup_required" || self.connection_status == "error" {
            self.setup_hint.clone().or_else(|| self.description.clone())
        } else {
            self.description.clone().or_else(|| self.setup_hint.clone())
        }
    }

    /// The rendered row's primary line (TS `MenuRow` primary: the
    /// label alone, flattened).
    fn primary_line(&self) -> String {
        flatten_to_single_line(&self.label)
    }

    /// The action target (the service id).
    fn target(&self) -> &str {
        self.service_id.as_str()
    }

    /// The paste-panel decision (TS: a requires-setup token service with
    /// exactly one credential and no installed account).
    fn wants_paste(&self) -> bool {
        self.paste_token && self.connection_ids.is_empty()
    }

    /// The Enter action hint (TS `actionText`, catalog mode, in the TS
    /// order): the paste step for pasteable token services, the accounts
    /// step for rows with an account, `manage` for user-declared
    /// non-OAuth servers, then the connection-state verbs.
    fn action_text(&self) -> &'static str {
        if self.paste_token && self.connection_ids.is_empty() {
            return "paste token";
        }
        if !self.connection_ids.is_empty() {
            return "manage accounts";
        }
        if self.source == "user" && !self.uses_oauth {
            return "manage";
        }
        match self.connection_status.as_str() {
            "connected" => "re-verify",
            "pending" => "verify",
            _ if !self.connectable => "setup guidance",
            "error" => "reconnect",
            _ => "connect",
        }
    }
}

/// Flatten all whitespace runs to one space (TS `flattenToSingleLine`):
/// catalog copy routinely contains newlines, and a rendered row must stay
/// exactly one terminal line.
fn flatten_to_single_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

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

/// The query's word split (TS `words`): Unicode letters and numbers,
/// lowercased, empties dropped.
fn words(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(str::to_string)
        .collect()
}

/// TS string operations run on UTF-16 code units (`.length`, indexing,
/// `indexOf`), so the scoring bands and tiebreaks must measure the same
/// units: a surrogate pair counts as two and a substring position is a
/// unit index, or non-ASCII queries rank differently from the TS picker.
fn utf16_len(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

/// The first UTF-16 code-unit index of `needle` in `haystack`, like TS
/// `indexOf` (byte offsets diverge past ASCII).
fn utf16_index(haystack: &[u16], needle: &[u16]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

/// Identity match: exact, prefix (plus the remaining-length tiebreak),
/// word start, substring (plus the position tiebreak), then the
/// subsequence fallback with its span penalty.
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

/// Identity-only subsequence fallback (TS `subsequenceMatchScore`,
/// over UTF-16 code units — the TS walk indexes units, so a surrogate
/// pair is two). The consecutive-run floor — half the query, minimum
/// two units — keeps the fallback for tight abbreviations ("crdb"
/// finds cockroachdb) while rejecting the scattered matches; the span
/// tiebreak spreads matches.
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

/// Description text matches only as a word start or substring (plus the
/// UTF-16 position tiebreak, like TS `indexOf`) — never a subsequence.
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
fn service_search_score(service: &McpServiceRow, query: &str) -> Option<f64> {
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
        for field in std::iter::once(&service.label)
            .chain(std::iter::once(&service.service_id))
            .chain(service.aliases.iter())
        {
            if let Some(score) = identity_match_score(field, token) {
                best = Some(best.map_or(score, |current| current.min(score)));
            }
        }
        if best.is_none() {
            for field in service.description.iter().chain(service.setup_hint.iter()) {
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
    /// Enter on a connectable connection/service: run its login flow (the
    /// caller resolves the auth hook; TS `authenticate`).
    Select(String),
    /// Enter on a pasteable token service with no installed account: open
    /// the paste flow (TS `actionText` "paste token").
    Paste(String),
    /// Esc or Ctrl+C: close without selecting.
    Cancel,
    /// Navigation or search editing only.
    None,
}

/// The `/mcp` service-catalog view: the resolved catalog's cards (the
/// TS `ServiceCatalogPickerComponent`'s catalog surface — every resolved
/// service plus user-declared servers, connected-first) with the TS
/// picker's search bands and one fixed detail line.
#[derive(Debug)]
pub struct McpView {
    rows: Vec<McpServiceRow>,
    search: SearchInput,
    filtered: Vec<usize>,
    selected: usize,
    viewport_rows: usize,
    visible_items: usize,
    last_query: String,
}

impl McpView {
    /// Build the view over the daemon's `get_mcp_connections` response:
    /// the resolved `services` cards (the catalog surface). The response
    /// carries no live tool listing — the picker opens from this local
    /// state exactly like TS, so the open is instant.
    pub fn from_response(data: &Value, viewport_rows: usize) -> Self {
        let rows: Vec<McpServiceRow> = data
            .get("services")
            .and_then(Value::as_array)
            .map(|entries| {
                entries
                    .iter()
                    .filter_map(McpServiceRow::from_value)
                    .collect()
            })
            .unwrap_or_default();
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

    /// The selected row's action target (Enter's service id).
    pub fn selected_server(&self) -> Option<&str> {
        self.rows
            .get(*self.filtered.get(self.selected)?)
            .map(McpServiceRow::target)
    }

    /// One key press (TS `ServiceCatalogPickerComponent.handleInput`):
    /// arrows clamp at the list's bounds (never wrap), page keys step by
    /// the visible window, Enter routes by the selected row, Esc closes,
    /// and everything else edits the search field — including the left
    /// arrow (the catalog surface has no parent to go back to, so it
    /// stays inert instead of cancelling).
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
                Some(row) if row.wants_paste() => McpViewAction::Paste(row.target().to_string()),
                Some(row) => McpViewAction::Select(row.target().to_string()),
                None => McpViewAction::None,
            };
        }
        if kb.matches(key, "tui.select.cancel") {
            return McpViewAction::Cancel;
        }
        // Everything else edits the search field.
        let previous = self.search.value().to_string();
        self.search.handle_key(key, kb);
        if self.search.value() != previous {
            self.refilter();
        }
        McpViewAction::None
    }

    /// Prefill the filter (`/mcp <partial>` + Tab or `/plugins <q>`
    /// opens the view filtered to the typed match), the caret at the
    /// partial's end so typing extends it.
    pub fn set_search(&mut self, query: &str) {
        self.search.prefill(query);
        self.refilter();
    }

    /// A bracketed paste into the search field.
    pub fn paste(&mut self, text: &str) {
        let previous = self.search.value().to_string();
        self.search.paste(text);
        if self.search.value() != previous {
            self.refilter();
        }
    }

    /// The picked frame (TS `updateList` + `render`, the inline panel:
    /// the bordered search field, the visible window's rows, the scroll
    /// indicator, ONE fixed detail line under a blank row, the hint).
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
            // Rows carry their status flush right (TS inline `MenuRow`
            // trailing meta): the honest state vocabulary.
            let (color, status) = row.status_text();
            let status = status.as_str();
            let trailing = vec![(color, status)];
            lines.push(trailing_menu_row(
                theme, width, primary, &trailing, selected,
            ));
        }

        // Nothing to scroll when the frame renders no rows (the
        // reserved-height guard's 0): the indicator would spend a row
        // the viewport does not have.
        if self.visible_items > 0 && (start > 0 || end < self.filtered.len()) {
            let indicator = format!("  ({}/{})", self.selected + 1, self.filtered.len());
            // A narrow frame truncates the indicator to its width (the
            // menu-panel status-row shape): it never overwrites the
            // adjacent cells.
            let line = vec![theme.fg_span(ThemeColor::Muted, indicator)];
            lines.push(crate::width::truncate_line(&line, width, ""));
        }

        if self.visible_items > 0 {
            if self.filtered.is_empty() {
                // The empty state's message and its blank row spend the
                // two rows the window budgets: a viewport too short for
                // both keeps the skeleton alone (the frame never draws
                // past its viewport).
                if self.visible_items >= EMPTY_STATE_ROWS {
                    let message = if self.rows.is_empty() {
                        "No external services available"
                    } else {
                        "No matching services"
                    };
                    // The message row aligns with the rows' labels (the
                    // TS `TruncatedText` pad plus the text's own leading
                    // space) and truncates to the frame width.
                    let line = vec![theme.fg_span(ThemeColor::Muted, format!("  {message}"))];
                    lines.push(crate::width::truncate_line(&line, width, ""));
                    // One blank row between the empty state and the
                    // shortcuts line (TS): the message never touches the
                    // keybinds.
                    lines.push(Vec::new());
                }
            } else if self.detail_rows() > 0 {
                // One blank line between the last row and the description
                // (TS), then the ONE fixed detail line.
                lines.push(Vec::new());
                if let Some(row) = self
                    .filtered
                    .get(self.selected)
                    .and_then(|index| self.rows.get(*index))
                    .cloned()
                {
                    lines.push(row_detail_line(theme, width, &row));
                }
            }
        }

        let action = self
            .filtered
            .get(self.selected)
            .and_then(|index| self.rows.get(*index))
            .map(McpServiceRow::action_text);
        lines.push(hint_line(theme, width, kb, action));
        lines
    }

    /// The inline list layout (TS `getMenuListLayout` shape): the
    /// reserved rows are the search field and the hint, plus the detail
    /// group when the viewport can fit it.
    fn list_layout(&self) -> usize {
        // The shared layout floors at one row so a picker never reads
        // empty; this view must never render past its viewport, so a
        // frame too short for any row renders none (the scroll
        // indicator follows: nothing to scroll).
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

    /// The detail group's rows (TS `DETAIL_ROWS` + `DETAIL_SPACER_ROWS`),
    /// dropped when the viewport cannot fit the panel skeleton (TS
    /// `MIN_ROWS_FOR_DETAIL`).
    fn detail_rows(&self) -> usize {
        if self.viewport_rows >= MIN_ROWS_FOR_DETAIL {
            DETAIL_ROWS + DETAIL_SPACER_ROWS
        } else {
            0
        }
    }

    /// The visible row window centered on the selection. A frame too
    /// short for any row carries the EMPTY window — never raised back
    /// to one row (list_layout's reserved-height guard owns the 0).
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

    /// Rebuild the filtered view (TS `filterServices`): an empty query
    /// shows everything; a query scores every row against the query's
    /// tokens (identity fields first, then the description band), every
    /// token must match, and rows rank by their summed score — stable,
    /// so equal scores keep the catalog's connected-first order.
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
                .filter_map(|(index, row)| Some((service_search_score(row, &trimmed)?, index)))
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

/// One inline menu row with a THEMED trailing cell (the `menu_row` layout
/// with the TS `statusText` colors: success/warning/error/muted).
fn trailing_menu_row(
    theme: &Theme,
    width: usize,
    primary: Line,
    trailing: &[(ThemeColor, &str)],
    selected: bool,
) -> Line {
    let inner_width = width.saturating_sub(2).max(1);
    // TS `getInlineTrailing`: the trailing cluster lives on a budget of
    // the inner width minus five — segments reduce from the front until
    // the cluster fits, then the joined text truncates with the
    // ellipsis, so a narrow row keeps a SHORTENED status instead of
    // losing it to the row's right-edge truncation.
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

/// The selected row's ONE fixed detail line (TS `updateList`'s detail
/// component): the secondary text — setup guidance or the description —
/// or the row's status when neither exists, muted and flattened to a
/// single line. Never a growing block: the panel's height never changes
/// to fit it (the list layout budgets the row).
fn row_detail_line(theme: &Theme, width: usize, row: &McpServiceRow) -> Line {
    // TS `secondaryText ?? statusText`: the ONE fixed detail line falls
    // back to the row's status when the entry carries no copy.
    let text = flatten_to_single_line(&row.detail_text().unwrap_or_else(|| row.status_text().1));
    let line = vec![theme.fg_span(ThemeColor::Muted, format!(" {text}"))];
    let line = crate::width::truncate_line(&line, width, "\u{2026}");
    let used = crate::width::spans_width(&line);
    let mut line = line;
    if used < width {
        line.push(Span::raw(" ".repeat(width - used)));
    }
    line
}

/// The trailing key hint (TS `ServiceCatalogPickerComponent.render`, the
/// shortcuts row): navigate · Enter <action> · close — the action
/// segment appears only when a row is selected (TS renders no `Enter
/// select` filler).
fn hint_line(theme: &Theme, width: usize, kb: &KeybindingsManager, action: Option<&str>) -> Line {
    let select_key = kb
        .first_key("tui.select.confirm")
        .map(|key| format_key_text(&key))
        .unwrap_or_else(|| "Enter".to_string());
    let close_key = kb
        .first_key("tui.select.cancel")
        .map(|key| format_key_text(&key))
        .unwrap_or_else(|| "Esc".to_string());
    let action_segment = action
        .map(|action| format!("{select_key} {action} \u{b7} "))
        .unwrap_or_default();
    let hint = if width >= 70 {
        let navigation = format!(
            "{}/{} navigate \u{b7} ",
            kb.first_key("tui.select.up")
                .map(|key| format_key_text(&key))
                .unwrap_or_else(|| "\u{2191}".to_string()),
            kb.first_key("tui.select.down")
                .map(|key| format_key_text(&key))
                .unwrap_or_else(|| "\u{2193}".to_string())
        );
        format!("{navigation}{action_segment}{close_key} close")
    } else {
        format!("{action_segment}{close_key} close")
    };
    let line = vec![theme.fg_span(ThemeColor::Dim, format!(" {hint}"))];
    crate::width::truncate_line(&line, width, "")
}

#[cfg(test)]
mod tests {
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

    /// A resolved-catalog response (the daemon's `services` array, in the
    /// daemon's TS-rank order: connected-first, then label): the daemon
    /// answers from local state — the connected row's tool count comes
    /// from the connection record, not a live listing.
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

    /// The inline panel shape (TS `updateList` + `render`): the bordered
    /// search field, the row window with the trailing status, ONE blank
    /// row plus ONE fixed detail line, the hint — never a growing block.
    #[test]
    fn renders_the_ts_inline_panel_shape() {
        let mut view = McpView::from_response(&catalog_response(), 19);
        let rows = frame_text(&mut view);
        let border = "\u{2500}".repeat(110);
        assert_eq!(rows[0], border, "top rule");
        assert_eq!(rows[1], " >  Search MCP connections", "search field");
        assert_eq!(rows[2], border, "bottom rule");
        // The connected row leads (the daemon's TS rank); its status
        // reads the honest state. The record-carried tool count reads
        // `Connected · N tools` (TS) on the notion row.
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
        // The user stdio row's detail falls back to its status (no
        // description); the hint names the accounts step.
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

    /// The frame never grows with the detail: at 69 catalog rows the
    /// window clamps to the viewport's budget, so the dock cannot
    /// overflow the terminal (the frame height is exactly the layout's).
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
        // search field (3) + window (8) + counter (1) + blank (1) +
        // detail (1) + hint (1).
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
        // A short viewport drops the detail line instead of the search
        // field: the frame only shrinks.
        let mut view = McpView::from_response(&data, 7);
        let rows = frame_text(&mut view);
        assert_eq!(rows[0], "\u{2500}".repeat(110), "the search field stays");
        assert!(
            !rows.iter().any(|row| row.contains("A catalog service.")),
            "the detail line dropped in the short viewport: {rows:?}"
        );
        assert!(rows.len() <= 7, "the short frame stays within budget");
        // A viewport the search field and hint alone fill renders the
        // skeleton only: no service row, no scroll indicator, no detail —
        // the empty row window is never raised back to one row (the
        // panel cannot draw past its viewport).
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
        // The selected not-connected catalog row's action names the
        // hint (TS `actionText`): no `Enter select` filler.
        assert_eq!(
            rows.last().map(String::as_str),
            Some(" \u{2191}/\u{2193} navigate \u{b7} Enter connect \u{b7} Esc close"),
            "the hint rides the skeleton's last row"
        );
    }

    /// The TS row vocabulary: the pasteable row keeps its honest
    /// `Requires setup` status while the hint names the paste step, and
    /// the setup hint is its detail copy.
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
            rows.iter().any(|row| row
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
            McpViewAction::Select("fixture-echo".to_string())
        );
        view.handle_key("down", &kb());
        assert_eq!(
            view.handle_key("enter", &kb()),
            McpViewAction::Select("notion".to_string())
        );
        view.handle_key("down", &kb());
        assert_eq!(
            view.handle_key("enter", &kb()),
            McpViewAction::Select("linear".to_string())
        );
        view.handle_key("down", &kb());
        assert_eq!(
            view.handle_key("enter", &kb()),
            McpViewAction::Paste("github".to_string())
        );
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

    /// Escape and Ctrl+C close without selecting; the left arrow edits
    /// the search field (TS: the catalog surface has no parent to go
    /// back to), never cancels.
    #[test]
    fn escape_cancels() {
        let mut view = McpView::from_response(&catalog_response(), 19);
        assert_eq!(view.handle_key("escape", &kb()), McpViewAction::Cancel);
        assert_eq!(view.handle_key("ctrl+c", &kb()), McpViewAction::Cancel);
        assert_eq!(
            view.handle_key("left", &kb()),
            McpViewAction::None,
            "left arrow is inert"
        );
        assert_eq!(view.search.value(), "");
    }

    /// The banded search: identity fields (label, id, aliases) rank before
    /// description text; the subsequence fallback finds tight
    /// abbreviations; every query token must match.
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

    /// The TS scoring bands exactly: prefix ties break on the remaining
    /// length, substring ties on the position, the subsequence fallback
    /// carries its run floor and span penalty.
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
                .find(|row| row.service_id == id)
                .expect("row")
        };
        // The exact band.
        assert_eq!(
            service_search_score(row("linear"), "linear"),
            Some(SCORE_EXACT)
        );
        // The prefix band: "linear" prefixes both; the remaining-length
        // tiebreak scores the longer label.
        assert_eq!(
            service_search_score(row("linear-support"), "linear"),
            Some(SCORE_PREFIX + 8.0 * 0.01)
        );
        // The description band only when no identity field matched: a
        // word-start match there outranks a substring match.
        let github = json!({
            "serviceId": "github", "label": "GitHub", "aliases": [],
            "description": "timelinearity charts"
        });
        let github = McpServiceRow::from_value(&github).expect("row");
        assert_eq!(
            service_search_score(&github, "linear"),
            Some(SCORE_DESCRIPTION_SUBSTRING + 4.0 * 0.01)
        );
        // The subsequence fallback with its run floor: "crdb"-style
        // abbreviations match, scattered matches do not.
        let cockroach = json!({
            "serviceId": "cockroachdb", "label": "CockroachDB", "aliases": [],
            "description": "the SQL database"
        });
        let cockroach = McpServiceRow::from_value(&cockroach).expect("row");
        let score = service_search_score(&cockroach, "crdb");
        assert!(score.is_some(), "the tight abbreviation matches");
        assert_eq!(
            service_search_score(&cockroach, "cxxx"),
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
            service_search_score(&notion, "notion workflows"),
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

    /// A query change resets the selection to the first row (TS
    /// `filterServices`), typing filters to the surviving rows, and the
    /// bracketed paste edits the search field too.
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
            McpViewAction::Select("linear".to_string()),
            "Enter applies the surviving match"
        );
        view.paste("-app");
        let rows = frame_text(&mut view);
        assert!(
            rows.iter().any(|row| row.starts_with("\u{203a} Linear")),
            "the alias still matches after the paste: {rows:?}"
        );
    }

    /// TS string operations run on UTF-16 code units: a surrogate pair
    /// is TWO units to the subsequence walk, and the substring tiebreak
    /// measures unit positions. The emoji query ranks exactly like the
    /// TS picker (the review finding).
    #[test]
    fn scoring_measures_utf16_units_like_ts() {
        // The prefix tiebreak: the rest after the emoji prefix is one
        // more emoji — TWO UTF-16 units, not one char (TS `.length`).
        assert_eq!(
            identity_match_score("\u{1f600}\u{1f600}", "\u{1f600}"),
            Some(SCORE_PREFIX + 2.0 * 0.01),
            "the prefix remainder counts UTF-16 units"
        );
        // The substring tiebreak: the position after the two-unit emoji
        // is 2, not the byte offset 4.
        assert_eq!(
            identity_match_score("x\u{1f600}y", "y"),
            Some(SCORE_SUBSTRING + 2.0 * 0.01),
            "the substring position is a UTF-16 unit index"
        );
        // The subsequence walk matches surrogate halves like TS: the
        // query "\u{1f600}a" (3 units) is a subsequence of "\u{1f600}x a"
        // (5 units) with the emoji's two consecutive units as a run.
        let haystack: Vec<u16> = "\u{1f600}x a".encode_utf16().collect();
        let token: Vec<u16> = "\u{1f600}a".encode_utf16().collect();
        assert_eq!(
            subsequence_match_score(&haystack, &token),
            Some(SCORE_SUBSEQUENCE + (4.0 - 3.0) * 2.0),
            "the subsequence span counts UTF-16 units"
        );
    }

    /// A viewport too short for the empty state's message and its blank
    /// row keeps the skeleton alone (the frame never draws past its
    /// viewport; the review finding).
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

    /// A narrow row keeps a SHORTENED trailing status (TS
    /// `getInlineTrailing`: the cluster reduces from the front, then
    /// truncates with the ellipsis) instead of dropping it at the row's
    /// right edge (the review finding).
    #[test]
    fn narrow_rows_shorten_the_trailing_status() {
        let theme = theme();
        // Width 24: the trailing budget is 17, so the 19-wide status
        // SHORTENS with the ellipsis instead of dropping off the row.
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

    /// A prefill from a typed partial (`/mcp lin` + Tab or `/plugins lin`)
    /// filters the view, the caret at the partial's end so typing extends
    /// it.
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
            McpViewAction::Select("linear".to_string()),
            "Enter applies the surviving match"
        );
    }
}
