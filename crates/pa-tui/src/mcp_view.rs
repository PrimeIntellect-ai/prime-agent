//! The `/mcp` inline connections view: the TS `handleMcpCommand`'s bare
//! arm — the configuration menu's MCP Connections tab (the inline
//! `OAuthSelectorComponent`) over the daemon's connection roster, plus the
//! tool listing each connected generic server offers (the
//! `get_mcp_connections` seam). Same inline geometry as the `/model`
//! picker: the bordered search field over `›`-marker rows, the selected
//! connection's detail block, and the navigate/select/close hint. Enter
//! runs the connection's login flow (TS `onSelectMcpConnection` ->
//! `authenticate`); Esc closes.

use crate::keybindings::{format_key_text, KeybindingsManager};
use crate::menu_panel::{menu_list_layout, search_field_lines};
use crate::search_input::SearchInput;
use crate::theme::{Theme, ThemeColor};
use crate::{Line, Span};
use std::collections::HashMap;

use serde_json::Value;

/// The search field's placeholder (TS `MenuSearchInput("Search MCP
/// connections")`).
const SEARCH_PLACEHOLDER: &str = "Search MCP connections";

/// Tool detail lines the view renders before the "+N more" tail.
const TOOL_DETAIL_LINES: usize = 6;

/// One tool a connected server offers (the kernel listing's entry).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpToolInfo {
    pub name: String,
    pub description: String,
}

/// One connection row (the daemon `get_mcp_connections` entry).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpConnection {
    pub server: String,
    pub label: String,
    /// Connected: credentials present and the server enabled.
    pub connected: bool,
    /// The kind cell the row shows (TS `subscription` / `api key`, or the
    /// transport for credential-less user servers).
    pub auth_kind: String,
    /// `None` when the listing was unavailable (no kernel, session busy)
    /// or the server is not listable (skills-based built-ins).
    pub tools: Option<Vec<McpToolInfo>>,
    /// The listing's failure text for this server (timeouts, handshake
    /// errors) when one was attempted and failed.
    pub error: Option<String>,
}

impl McpConnection {
    /// Parse one daemon roster entry.
    fn from_value(value: &Value) -> Option<Self> {
        Some(McpConnection {
            server: value.get("server")?.as_str()?.to_string(),
            label: value
                .get("label")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            connected: value
                .get("connected")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            auth_kind: value
                .get("authKind")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            tools: value.get("tools").and_then(Value::as_array).map(|tools| {
                tools
                    .iter()
                    .filter_map(|tool| {
                        Some(McpToolInfo {
                            name: tool.get("name")?.as_str()?.to_string(),
                            description: tool
                                .get("description")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_string(),
                        })
                    })
                    .collect()
            }),
            error: value
                .get("error")
                .and_then(Value::as_str)
                .filter(|error| !error.is_empty())
                .map(str::to_string),
        })
    }
}

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
    /// state vocabulary with the paste hint for token services.
    fn status_text(&self) -> (ThemeColor, &'static str) {
        if self.login_pending {
            return (ThemeColor::Warning, "Login in progress");
        }
        match self.connection_status.as_str() {
            "connected" => (ThemeColor::Success, "Connected"),
            "pending" => (ThemeColor::Warning, "Needs verification"),
            "error" => (
                ThemeColor::Error,
                if self.connectable {
                    "Reconnect"
                } else {
                    "Needs attention"
                },
            ),
            "setup_required" => (ThemeColor::Warning, "Requires setup"),
            "disabled" => (ThemeColor::Muted, "Disabled"),
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
                },
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

    /// The Enter action hint (TS `actionText`, catalog mode): the paste hint
    /// names the step for token services.
    fn action_text(&self) -> &'static str {
        if self.paste_token && self.connection_ids.is_empty() {
            return "paste token";
        }
        if self.login_pending {
            return "login in progress";
        }
        if !self.connection_ids.is_empty() {
            return "manage accounts";
        }
        match self.connection_status.as_str() {
            "connected" => "re-verify",
            "pending" => "verify",
            _ if !self.connectable => "setup guidance",
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

// Search bands (TS `ServiceCatalogPickerComponent`): lower scores rank
// first; identity fields (label, service id, aliases) always outrank
// description/setup-hint text.
const SCORE_EXACT: u32 = 0;
const SCORE_PREFIX: u32 = 100;
const SCORE_WORD_START: u32 = 200;
const SCORE_SUBSTRING: u32 = 300;
const SCORE_SUBSEQUENCE: u32 = 400;
const SCORE_DESCRIPTION_WORD_START: u32 = 500;
const SCORE_DESCRIPTION_SUBSTRING: u32 = 600;

fn word_starts(text: &str, token: &str) -> bool {
    text.split(|c: char| !c.is_alphanumeric())
        .any(|word| word.starts_with(token))
}

fn subsequence_match(haystack: &str, token: &str) -> bool {
    // Identity-only subsequence fallback with the consecutive-run floor:
    // keeps tight abbreviations ("crdb" finds cockroachdb), rejects
    // scattered matches.
    let token: Vec<char> = token.chars().collect();
    if token.len() < 2 || token.len() > haystack.chars().count() {
        return false;
    }
    let mut token_index = 0;
    let mut run = 0;
    let mut longest_run = 0;
    for character in haystack.chars() {
        if token
            .get(token_index)
            .is_some_and(|want| *want == character)
        {
            token_index += 1;
            run += 1;
            longest_run = longest_run.max(run);
        } else {
            run = 0;
        }
    }
    token_index == token.len() && longest_run >= (token.len() / 2).max(2)
}

/// Identity match: exact, prefix, word start, substring, then the
/// subsequence fallback.
fn identity_match_score(text: &str, token: &str) -> Option<u32> {
    let haystack = text.to_lowercase();
    if haystack == *token {
        return Some(SCORE_EXACT);
    }
    if haystack.starts_with(token) {
        return Some(SCORE_PREFIX);
    }
    if word_starts(&haystack, token) {
        return Some(SCORE_WORD_START);
    }
    if let Some(at) = haystack.find(token) {
        return Some(SCORE_SUBSTRING + at as u32);
    }
    subsequence_match(&haystack, token).then_some(SCORE_SUBSEQUENCE)
}

/// The row's search score for one query token: identity fields first, the
/// description/setup-hint text as the secondary band.
fn service_search_score(service: &McpServiceRow, token: &str) -> Option<u32> {
    let mut best: Option<u32> = None;
    for field in std::iter::once(&service.label)
        .chain(std::iter::once(&service.service_id))
        .chain(service.aliases.iter())
    {
        if let Some(score) = identity_match_score(field, token) {
            best = Some(best.map_or(score, |current| current.min(score)));
        }
    }
    if best.is_some() {
        return best;
    }
    for field in service.description.iter().chain(service.setup_hint.iter()) {
        let haystack = field.to_lowercase();
        if word_starts(&haystack, token) {
            best = Some(best.map_or(SCORE_DESCRIPTION_WORD_START, |score| {
                score.min(SCORE_DESCRIPTION_WORD_START)
            }));
        } else if haystack.contains(token) {
            best = Some(best.map_or(SCORE_DESCRIPTION_SUBSTRING, |score| {
                score.min(SCORE_DESCRIPTION_SUBSTRING)
            }));
        }
    }
    best
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
    /// Esc, Ctrl+C, or back: close without selecting.
    Cancel,
    /// Navigation or search editing only.
    None,
}

/// One rendered row: a resolved service card (the catalog), or a bare
/// connection when the daemon predates the catalog surface.
#[derive(Debug, Clone)]
enum ViewRow {
    Service(McpServiceRow),
    Connection(McpConnection),
}

impl ViewRow {
    fn primary_line(&self) -> String {
        match self {
            // TS `MenuRow` primary: the label alone (flattened).
            ViewRow::Service(service) => flatten_to_single_line(&service.label),
            ViewRow::Connection(connection) => flatten_to_single_line(&connection.label),
        }
    }

    /// The Enter action for the hint line (TS `actionText`): "paste token"
    /// for token services, "connect"/"re-verify"/... for the rest.
    fn action_hint(&self) -> &'static str {
        match self {
            ViewRow::Service(service) => service.action_text(),
            ViewRow::Connection(_) => "connect",
        }
    }

    /// The action target (connection/service id).
    fn target(&self) -> &str {
        match self {
            ViewRow::Service(service) => service.service_id.as_str(),
            ViewRow::Connection(connection) => connection.server.as_str(),
        }
    }

    /// The paste-panel decision (TS: a requires-setup token service with
    /// exactly one credential and no installed account).
    fn wants_paste(&self) -> bool {
        matches!(self, ViewRow::Service(service)
            if service.paste_token && service.connection_ids.is_empty())
    }
}

/// The inline MCP connections view: the resolved service catalog (the TS
/// service-catalog picker surface — every resolved service plus
/// user-declared servers, connected-first) over the daemon roster, with
/// the per-connection tool listing for the selected row.
#[derive(Debug)]
pub struct McpView {
    rows: Vec<ViewRow>,
    /// The connections by server name (tool listings for the detail block).
    listings: HashMap<String, McpConnection>,
    search: SearchInput,
    filtered: Vec<usize>,
    selected: usize,
    viewport_rows: usize,
    visible_items: usize,
    last_query: String,
}

impl McpView {
    /// Build the view over the daemon's `get_mcp_connections` response: the
    /// resolved `services` cards when present (the catalog surface),
    /// otherwise the legacy `connections` roster alone.
    pub fn from_response(data: &Value, viewport_rows: usize) -> Self {
        let connections: Vec<McpConnection> = data
            .get("connections")
            .and_then(Value::as_array)
            .map(|entries| {
                entries
                    .iter()
                    .filter_map(McpConnection::from_value)
                    .collect()
            })
            .unwrap_or_default();
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
        // The catalog cards own the rows when the daemon serves them (TS
        // buildPluginViews already includes user-declared servers); the
        // connections stay for the per-row tool listings.
        let rows = if services.is_empty() {
            connections
                .iter()
                .map(|connection| ViewRow::Connection(connection.clone()))
                .collect()
        } else {
            services.into_iter().map(ViewRow::Service).collect()
        };
        let mut view = McpView {
            rows,
            listings: connections
                .into_iter()
                .map(|connection| (connection.server.clone(), connection))
                .collect(),
            search: SearchInput::new(),
            filtered: Vec::new(),
            selected: 0,
            viewport_rows,
            visible_items: 8,
            last_query: String::new(),
        };
        view.refilter();
        view
    }

    /// The selected row's action target (Enter's server/service id).
    pub fn selected_server(&self) -> Option<&str> {
        self.rows
            .get(*self.filtered.get(self.selected)?)
            .map(|row| row.target())
    }

    /// One key id (the same binding set as the `/model` picker, without the
    /// effort cluster).
    pub fn handle_key(&mut self, key: &str, kb: &KeybindingsManager) -> McpViewAction {
        if key == "ctrl+c" {
            return McpViewAction::Cancel;
        }
        if kb.matches(key, "tui.select.up") || kb.matches(key, "tui.select.down") {
            let count = self.filtered.len();
            if count > 0 {
                let direction = if kb.matches(key, "tui.select.up") {
                    -1isize
                } else {
                    1
                };
                self.selected =
                    (self.selected as isize + direction).rem_euclid(count as isize) as usize;
            }
            return McpViewAction::None;
        }
        if kb.matches(key, "tui.select.pageUp") || kb.matches(key, "tui.select.pageDown") {
            let count = self.filtered.len();
            if count > 0 {
                let direction = if kb.matches(key, "tui.select.pageUp") {
                    -(self.visible_items as isize)
                } else {
                    self.visible_items as isize
                };
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
        if kb.matches(key, "tui.select.cancel")
            || (kb.matches(key, "app.modal.back") && self.search.cursor() == 0)
        {
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

    /// A bracketed paste into the search field.
    pub fn paste(&mut self, text: &str) {
        let previous = self.search.value().to_string();
        self.search.paste(text);
        if self.search.value() != previous {
            self.refilter();
        }
    }

    /// The picked frame (the inline panel: bordered search field, rows,
    /// scroll indicator, the selected row's detail, hint).
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
            // trailing meta): the honest state vocabulary, or the plain
            // `connected` flag for legacy connection rows.
            let (color, status) = match row {
                ViewRow::Service(service) => service.status_text(),
                ViewRow::Connection(connection) => {
                    if connection.connected {
                        (ThemeColor::Success, "connected")
                    } else {
                        (ThemeColor::Muted, "disconnected")
                    }
                }
            };
            let trailing = vec![(color, status)];
            lines.push(trailing_menu_row(
                theme, width, primary, &trailing, selected,
            ));
        }

        if start > 0 || end < self.filtered.len() {
            let indicator = format!("  ({}/{})", self.selected + 1, self.filtered.len());
            lines.push(vec![theme.fg_span(ThemeColor::Muted, indicator)]);
        }

        if self.filtered.is_empty() {
            let message = if self.rows.is_empty() {
                "No external services available"
            } else {
                "No matching services"
            };
            lines.push(vec![theme.fg_span(ThemeColor::Muted, message)]);
        } else if let Some(row) = self
            .filtered
            .get(self.selected)
            .and_then(|index| self.rows.get(*index))
            .cloned()
        {
            lines.push(Vec::new());
            lines.extend(row_detail_lines(theme, width, &row, &self.listings));
        }

        let action = self
            .filtered
            .get(self.selected)
            .and_then(|index| self.rows.get(*index))
            .map(|row| row.action_hint());
        lines.push(hint_line(theme, width, kb, action));
        lines
    }

    /// The inline list layout (TS `getMenuListLayout` shape; the detail
    /// block reserves its tool rows).
    fn list_layout(&self) -> usize {
        menu_list_layout(
            Some(self.viewport_rows),
            8,
            self.filtered.len(),
            3 + TOOL_DETAIL_LINES,
            1,
        )
    }

    /// The visible row window centered on the selection.
    fn window(&self) -> (usize, usize) {
        let max_visible = self.visible_items.max(1);
        let selected = self.selected.min(self.filtered.len().saturating_sub(1));
        let start = selected
            .saturating_sub(max_visible / 2)
            .min(self.filtered.len().saturating_sub(max_visible));
        let end = (start + max_visible).min(self.filtered.len());
        (start, end)
    }

    /// Rebuild the filtered view: an empty query shows everything; a query
    /// scores every token against the identity fields first (exact, prefix,
    /// word start, substring, subsequence), then the description/setup-hint
    /// text, ranking rows by their worst-token score (the TS picker's
    /// search bands).
    fn refilter(&mut self) {
        let query = self.search.value().to_string();
        let query_changed = query != self.last_query;
        self.last_query = query.clone();
        let tokens: Vec<String> = query
            .trim()
            .to_lowercase()
            .split_whitespace()
            .map(str::to_string)
            .collect();
        self.filtered = if tokens.is_empty() {
            (0..self.rows.len()).collect()
        } else {
            let mut scored: Vec<(u32, usize)> = self
                .rows
                .iter()
                .enumerate()
                .filter_map(|(index, row)| {
                    let mut worst: u32 = 0;
                    for token in &tokens {
                        let score = match row {
                            ViewRow::Service(service) => service_search_score(service, token),
                            ViewRow::Connection(connection) => {
                                identity_match_score(&connection.label, token)
                                    .or_else(|| identity_match_score(&connection.server, token))
                            }
                        }?;
                        worst = worst.max(score);
                    }
                    Some((worst, index))
                })
                .collect();
            scored.sort_by_key(|(score, index)| (*score, *index));
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
    let _budget = inner_width.saturating_sub(5).max(1);
    let trailing_spans: Line = if trailing.is_empty() {
        Vec::new()
    } else {
        let mut spans: Vec<Span> = Vec::with_capacity(trailing.len() * 2 - 1);
        for (index, (color, text)) in trailing.iter().enumerate() {
            if index > 0 {
                spans.push(Span::raw(" \u{b7} "));
            }
            spans.push(theme.fg_span(*color, *text));
        }
        spans
    };
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

/// The selected row's detail block: the service card's status + setup
/// guidance (the TS picker's one fixed description line, flattened), with
/// the per-connection tool listing when the daemon reported one for the
/// row's connection.
fn row_detail_lines(
    theme: &Theme,
    width: usize,
    row: &ViewRow,
    listings: &HashMap<String, McpConnection>,
) -> Vec<Line> {
    match row {
        ViewRow::Service(service) => {
            let (color, status) = service.status_text();
            let mut lines: Vec<Line> = Vec::new();
            let mut head = vec![theme.fg_span(color, format!(" {status}"))];
            if let Some(tool_count) = service.tool_count {
                head.push(Span::raw(" \u{b7} "));
                head.push(theme.fg_span(
                    ThemeColor::Muted,
                    format!(
                        "{tool_count} {}",
                        if tool_count == 1 { "tool" } else { "tools" }
                    ),
                ));
            }
            lines.push(detail_line(theme, width, head));
            // ONE fixed line about the selected connector (the TS picker's
            // description line): setup guidance or description, flattened.
            if let Some(text) = service.detail_text() {
                let text = flatten_to_single_line(&text);
                if !text.is_empty() {
                    lines.push(detail_line(
                        theme,
                        width,
                        vec![theme.fg_span(ThemeColor::Muted, format!(" {text}"))],
                    ));
                }
            }
            // The per-connection tool listing (the lane's required detail).
            let listing = listings.get(&service.service_id).cloned();
            if let Some(listing) = listing {
                lines.extend(tool_detail_lines(theme, width, &listing));
            }
            lines
        }
        ViewRow::Connection(connection) => detail_lines(theme, width, connection),
    }
}

/// The tool listing detail rows for one connection (shared by both row
/// kinds): status + tool count, then one line per tool.
fn tool_detail_lines(theme: &Theme, width: usize, connection: &McpConnection) -> Vec<Line> {
    let mut lines: Vec<Line> = Vec::new();
    if let Some(tools) = &connection.tools {
        if !tools.is_empty() {
            let count_text = format!(
                "{} {}",
                tools.len(),
                if tools.len() == 1 { "tool" } else { "tools" }
            );
            lines.push(detail_line(
                theme,
                width,
                vec![
                    Span::raw("   "),
                    theme.fg_span(ThemeColor::Muted, count_text),
                ],
            ));
            for tool in tools.iter().take(TOOL_DETAIL_LINES) {
                let mut line = vec![Span::raw("   "), Span::raw(tool.name.clone())];
                if !tool.description.is_empty() {
                    line.push(
                        theme.fg_span(ThemeColor::Muted, format!(" \u{2014} {}", tool.description)),
                    );
                }
                lines.push(detail_line(theme, width, line));
            }
            if tools.len() > TOOL_DETAIL_LINES {
                lines.push(detail_line(
                    theme,
                    width,
                    vec![
                        Span::raw("   "),
                        theme.fg_span(
                            ThemeColor::Muted,
                            format!("+{} more", tools.len() - TOOL_DETAIL_LINES),
                        ),
                    ],
                ));
            }
        }
    }
    lines
}

/// The selected connection's detail block: its status, then one line per
/// tool it offers (the lane's required tool listing; the TS detail row
/// carries only the auth status).
fn detail_lines(theme: &Theme, width: usize, connection: &McpConnection) -> Vec<Line> {
    let status = if connection.connected {
        theme.fg_span(ThemeColor::Success, " connected")
    } else {
        theme.fg_span(ThemeColor::Muted, " disconnected")
    };
    let mut lines: Vec<Line> = Vec::new();
    match &connection.tools {
        Some(tools) if !tools.is_empty() => {
            let count_text = format!(
                "{} {}",
                tools.len(),
                if tools.len() == 1 { "tool" } else { "tools" }
            );
            let head = vec![
                status,
                Span::raw(" \u{b7} "),
                theme.fg_span(ThemeColor::Muted, count_text),
            ];
            lines.push(detail_line(theme, width, head));
            for tool in tools.iter().take(TOOL_DETAIL_LINES) {
                let mut line = vec![Span::raw("   "), Span::raw(tool.name.clone())];
                if !tool.description.is_empty() {
                    line.push(
                        theme.fg_span(ThemeColor::Muted, format!(" \u{2014} {}", tool.description)),
                    );
                }
                lines.push(detail_line(theme, width, line));
            }
            if tools.len() > TOOL_DETAIL_LINES {
                lines.push(detail_line(
                    theme,
                    width,
                    vec![
                        Span::raw("   "),
                        theme.fg_span(
                            ThemeColor::Muted,
                            format!("+{} more", tools.len() - TOOL_DETAIL_LINES),
                        ),
                    ],
                ));
            }
        }
        Some(_) => {
            lines.push(detail_line(
                theme,
                width,
                vec![
                    status,
                    Span::raw(" \u{b7} "),
                    theme.fg_span(ThemeColor::Muted, "no tools"),
                ],
            ));
        }
        None => {
            let mut head = vec![status];
            if let Some(error) = &connection.error {
                head.push(Span::raw(" \u{b7} "));
                head.push(
                    theme.fg_span(ThemeColor::Warning, format!("tools unavailable ({error})")),
                );
            } else if connection.connected {
                head.push(Span::raw(" \u{b7} "));
                head.push(theme.fg_span(ThemeColor::Muted, "tools unavailable"));
            }
            lines.push(detail_line(theme, width, head));
        }
    }
    lines
}

/// Truncate one detail line to the pane width and pad it to the full row.
fn detail_line(theme: &Theme, width: usize, line: Line) -> Line {
    let line = crate::width::truncate_line(&line, width, "\u{2026}");
    let used = crate::width::spans_width(&line);
    let _ = theme;
    let mut line = line;
    if used < width {
        line.push(Span::raw(" ".repeat(width - used)));
    }
    line
}

/// The trailing key hint (TS `ServiceCatalogPickerComponent.render`, the
/// shortcuts row): navigate · Enter <action> · close, with the selected
/// row's action text (TS `actionText`).
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
            "{}/{}",
            kb.first_key("tui.select.up")
                .map(|key| format_key_text(&key))
                .unwrap_or_else(|| "\u{2191}".to_string()),
            kb.first_key("tui.select.down")
                .map(|key| format_key_text(&key))
                .unwrap_or_else(|| "\u{2193}".to_string())
        );
        if action.is_some() {
            format!("{navigation} navigate \u{b7} {action_segment}{close_key} close")
        } else {
            format!("{navigation} navigate \u{b7} {select_key} select \u{b7} {close_key} close")
        }
    } else if action.is_some() {
        format!("{action_segment}{close_key} close")
    } else {
        format!("{select_key} select \u{b7} {close_key} close")
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

    /// The daemon response shape: a connected generic stdio server with one
    /// listed tool, plus a disconnected built-in.
    fn roster_response() -> serde_json::Value {
        json!({
            "connections": [
                {
                    "server": "fixture-echo",
                    "label": "fixture-echo",
                    "connected": true,
                    "usesOAuth": false,
                    "authKind": "stdio",
                    "transport": "stdio",
                    "userDeclared": true,
                    "generic": true,
                    "tools": [
                        {
                            "name": "echo",
                            "description": "Echoes the message argument back."
                        }
                    ],
                    "error": null
                },
                {
                    "server": "linear",
                    "label": "Linear",
                    "connected": false,
                    "usesOAuth": true,
                    "authKind": "subscription",
                    "transport": "http",
                    "userDeclared": false,
                    "generic": false,
                    "tools": null,
                    "error": null
                }
            ]
        })
    }

    #[test]
    fn renders_the_ts_inline_panel_shape() {
        let mut view = McpView::from_response(&roster_response(), 19);
        let rows = frame_text(&mut view);
        let border = "\u{2500}".repeat(110);
        assert_eq!(rows[0], border, "top rule");
        assert_eq!(rows[1], " >  Search MCP connections", "search field");
        assert_eq!(rows[2], border, "bottom rule");
        // The connected row: `›` marker, label · kind, status flush right.
        let connected = rows
            .iter()
            .find(|row| row.starts_with("\u{203a}"))
            .expect("selected row");
        assert!(
            connected.starts_with("\u{203a} fixture-echo"),
            "row primary: {connected}"
        );
        assert!(
            connected.ends_with("connected"),
            "status flush right: {connected}"
        );
        // The detail block: status, tool count, one line per tool.
        assert!(
            rows.iter()
                .any(|row| row.contains(" connected \u{b7} 1 tool")),
            "detail status row: {rows:?}"
        );
        assert!(
            rows.iter()
                .any(|row| row.contains("echo \u{2014} Echoes the message argument back.")),
            "tool detail line: {rows:?}"
        );
        // The key hint.
        assert!(
            rows.iter()
                .any(|row| row
                    == " \u{2191}/\u{2193} navigate \u{b7} Enter connect \u{b7} Esc close"),
            "hint row"
        );
    }

    /// A resolved-catalog response (the `services` array): the discovery
    /// rows with their TS status vocabulary, the paste hint, and the setup
    /// detail line.
    #[test]
    fn catalog_rows_render_the_service_cards() {
        let data = json!({
            "connections": [],
            "services": [
                {
                    "serviceId": "notion", "label": "Notion",
                    "connectionStatus": "connected", "connectable": false,
                    "usesOAuth": true, "source": "catalog",
                    "connectionIds": ["notion"], "pasteToken": false,
                    "description": "Notion workflows.", "toolCount": 12,
                    "verifiedAt": 1790000000
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
        });
        let mut view = McpView::from_response(&data, 19);
        let rows = frame_text(&mut view);
        // The connected row leads (TS rank), its trailing status flush right.
        let first = rows
            .iter()
            .find(|row| row.starts_with("\u{203a}"))
            .expect("selected row");
        assert!(first.starts_with("\u{203a} Notion"), "row primary: {first}");
        assert!(first.ends_with("Connected"), "status flush right: {first}");
        // The detail block: status + tool count + description + tools.
        assert!(
            rows.iter()
                .any(|row| row.contains(" Connected \u{b7} 12 tools")),
            "detail status row: {rows:?}"
        );
        assert!(
            rows.iter().any(|row| row.contains(" Notion workflows.")),
            "the description detail line: {rows:?}"
        );
        // The pasteable row: the paste hint names the step.
        assert!(
            rows.iter().any(|row| row.contains("GitHub")),
            "pasteable row: {rows:?}"
        );
        assert!(
            rows.iter().any(|row| row.contains("Requires setup")),
            "trailing status: {rows:?}"
        );
        // Selecting the pasteable row names the step in the hint (TS
        // `actionText`: the hint carries the Enter action, the row keeps
        // the honest status).
        for _ in 0..2 {
            view.handle_key("down", &kb());
        }
        let rows = frame_text(&mut view);
        assert!(
            rows.iter()
                .any(|row| row.contains("Enter paste token \u{b7} Esc close")),
            "the paste action hint names the step: {rows:?}"
        );
    }

    /// Enter routes by row kind: a pasteable token service opens the paste
    /// flow; a connectable OAuth service runs its login.
    #[test]
    fn enter_routes_paste_and_connect() {
        let data = json!({
            "connections": [],
            "services": [
                {
                    "serviceId": "github", "label": "GitHub",
                    "connectionStatus": "setup_required", "connectable": false,
                    "usesOAuth": false, "source": "catalog", "connectionIds": [],
                    "pasteToken": true, "aliases": []
                },
                {
                    "serviceId": "linear", "label": "Linear",
                    "connectionStatus": "not_connected", "connectable": true,
                    "usesOAuth": true, "source": "catalog", "connectionIds": [],
                    "pasteToken": false, "aliases": ["linear-app"]
                }
            ]
        });
        let mut view = McpView::from_response(&data, 19);
        assert_eq!(
            view.handle_key("enter", &kb()),
            McpViewAction::Paste("github".to_string())
        );
        view.handle_key("down", &kb());
        assert_eq!(
            view.handle_key("enter", &kb()),
            McpViewAction::Select("linear".to_string())
        );
    }

    /// The banded search: identity fields (label, id, aliases) rank before
    /// description text; the subsequence fallback finds tight
    /// abbreviations.
    #[test]
    fn search_ranks_identity_fields_before_descriptions() {
        let data = json!({
            "connections": [],
            "services": [
                {
                    "serviceId": "linear", "label": "Linear",
                    "connectionStatus": "not_connected", "connectable": true,
                    "usesOAuth": true, "source": "catalog", "connectionIds": [],
                    "pasteToken": false, "aliases": ["linear-app"],
                    "description": "Manage your GitHub repositories."
                },
                {
                    "serviceId": "github", "label": "GitHub",
                    "connectionStatus": "setup_required", "connectable": false,
                    "usesOAuth": false, "source": "catalog", "connectionIds": [],
                    "pasteToken": true, "aliases": []
                }
            ]
        });
        let mut view = McpView::from_response(&data, 19);
        // "github" matches the identity field first even though the OTHER
        // row's description mentions GitHub.
        for character in "github".chars() {
            view.handle_key(&character.to_string(), &kb());
        }
        let rows = frame_text(&mut view);
        let first = rows
            .iter()
            .find(|row| row.starts_with("\u{203a}"))
            .expect("selected row");
        assert!(
            first.contains("GitHub"),
            "identity ranks first: {first} (all: {rows:?})"
        );
        // The alias band: "linear-app" finds Linear.
        let mut view = McpView::from_response(&data, 19);
        for character in "linear-app".chars() {
            view.handle_key(&character.to_string(), &kb());
        }
        let rows = frame_text(&mut view);
        assert!(
            rows.iter().any(|row| row.contains("Linear")),
            "alias band: {rows:?}"
        );
    }

    #[test]
    fn the_empty_roster_renders_the_empty_message() {
        let mut view = McpView::from_response(&json!({ "connections": [] }), 19);
        let rows = frame_text(&mut view);
        assert!(rows
            .iter()
            .any(|row| row.starts_with("No external services available")));
    }

    #[test]
    fn disconnected_rows_show_the_status_in_the_detail_block() {
        let mut view = McpView::from_response(&roster_response(), 19);
        // Move to the disconnected builtin.
        view.handle_key("down", &kb());
        let rows = frame_text(&mut view);
        assert!(
            rows.iter().any(|row| row.contains(" disconnected")),
            "disconnected detail: {rows:?}"
        );
        assert!(
            rows.iter().any(|row| row.contains("Linear")),
            "builtin row: {rows:?}"
        );
    }

    #[test]
    fn enter_selects_and_escape_cancels() {
        let mut view = McpView::from_response(&roster_response(), 19);
        assert_eq!(
            view.handle_key("enter", &kb()),
            McpViewAction::Select("fixture-echo".to_string())
        );
        view.handle_key("down", &kb());
        assert_eq!(
            view.handle_key("enter", &kb()),
            McpViewAction::Select("linear".to_string())
        );
        assert_eq!(view.handle_key("escape", &kb()), McpViewAction::Cancel);
        assert_eq!(view.handle_key("ctrl+c", &kb()), McpViewAction::Cancel);
    }

    #[test]
    fn typing_filters_by_label_and_server() {
        let mut view = McpView::from_response(&roster_response(), 19);
        for character in "linear".chars() {
            view.handle_key(&character.to_string(), &kb());
        }
        let rows = frame_text(&mut view);
        assert!(
            rows.iter().any(|row| row.contains("Linear")),
            "filtered row: {rows:?}"
        );
        assert!(
            !rows.iter().any(|row| row.contains("fixture-echo")),
            "non-match filtered out: {rows:?}"
        );
        // Enter applies the surviving match.
        assert_eq!(
            view.handle_key("enter", &kb()),
            McpViewAction::Select("linear".to_string())
        );
        // A query with no matches renders the no-match row.
        view.handle_key("backspace", &kb());
        for _ in "linear".chars() {
            view.handle_key("backspace", &kb());
        }
        for character in "zzz".chars() {
            view.handle_key(&character.to_string(), &kb());
        }
        let rows = frame_text(&mut view);
        assert!(rows.iter().any(|row| row == "No matching services"));
    }

    #[test]
    fn a_failed_listing_reports_its_error() {
        let data = json!({
            "connections": [
                {
                    "server": "broken",
                    "label": "broken",
                    "connected": true,
                    "usesOAuth": false,
                    "authKind": "stdio",
                    "transport": "stdio",
                    "userDeclared": true,
                    "generic": true,
                    "tools": null,
                    "error": "McpStartupError: fixture failed"
                }
            ]
        });
        let mut view = McpView::from_response(&data, 19);
        let rows = frame_text(&mut view);
        assert!(
            rows.iter()
                .any(|row| row.contains("tools unavailable (McpStartupError")),
            "error surfaced: {rows:?}"
        );
    }
}
