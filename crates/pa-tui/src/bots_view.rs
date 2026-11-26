//! The `/bots` view: the sandbox bots this daemon owns, agents-view-style
//! — a status dot, the name and model, the version and last turn — grouped
//! into the agents page's `Running`/`Idle`/`Inactive` sections, most recent
//! activity first within a section, with the raw facts (bot id, sandbox id,
//! checkpoint id, the pause timer) on a detail pane. Enter attaches to the selected bot; `p`
//! pauses or resumes it.

use std::fmt::Write as _;

use serde_json::Value;

use crate::agents_view_state::{section_rank, section_title, Section};
use crate::keybindings::{format_key_text, KeybindingsManager};
use crate::menu_panel::{hint_row, menu_list_layout, scroll_row, scrub_controls};
use crate::theme::{Theme, ThemeColor};
use crate::width::{truncate_line, wrap_line};
use crate::{Line, Span};

/// One bot row, parsed from the daemon's `list_bots` answer.
#[derive(Debug, Clone, PartialEq)]
pub struct BotRow {
    pub bot_id: String,
    pub name: String,
    /// The registry status: `creating`, `running`, `paused`, `stopped`, or `error`.
    pub status: String,
    pub model: Option<String>,
    /// The prime-agent version the bot runs (the owning Mac's version at its last start).
    pub version: String,
    pub sandbox_id: String,
    pub checkpoint_id: Option<String>,
    pub created_at: String,
    /// The UTC ISO stamp of the bot's last settled turn, falling back to `createdAt` for a bot
    /// that never ran a turn.
    pub last_activity_at: String,
    pub has_turn: bool,
    /// A TUI holds a live attach on the bot.
    pub attached: bool,
    /// The bot reaches GitHub with the owner's token.
    pub github: bool,
    /// The owner logins of the bot whose refresh failed or that expired.
    pub login_stale: Vec<String>,
    /// The bot may spawn its own bots, or already has children.
    pub spawns_bots: bool,
    /// The bot that spawned this one, when a bot did.
    pub parent_bot_id: Option<String>,
    /// Unix milliseconds of the last status change.
    pub status_since: Option<i64>,
    /// Unix milliseconds when the daemon pauses the idle bot.
    pub pause_at: Option<i64>,
}

impl BotRow {
    /// The row's dot and color: green running, amber creating, plain paused, grey stopped, red
    /// error.
    fn dot(&self) -> (&'static str, ThemeColor) {
        match self.status.as_str() {
            "running" => ("\u{25cf}", ThemeColor::Success),
            "creating" => ("\u{25d0}", ThemeColor::Warning),
            "paused" => ("\u{25cf}", ThemeColor::Text),
            "error" => ("\u{25cb}", ThemeColor::Error),
            _ => ("\u{25cb}", ThemeColor::Dim),
        }
    }

    /// The row's section (the agents page's grouping): `Running` while the sandbox runs,
    /// `Idle` while it is paused or starting, `Inactive` when it is stopped or failed.
    pub(crate) fn section(&self) -> Section {
        match self.status.as_str() {
            "running" => Section::Running,
            "paused" | "creating" => Section::Idle,
            _ => Section::Inactive,
        }
    }

    /// The right-hand cell: the version the bot runs.
    fn version_cell(&self) -> String {
        format!("v{}", self.version)
    }

    /// The dim note under the title: the status and the last turn.
    fn note(&self) -> String {
        let mut note = self.status.clone();
        if self.attached {
            note.push_str(" \u{b7} attached");
        }
        if !self.login_stale.is_empty() {
            let _ = write!(note, " \u{b7} login stale: {}", self.login_stale.join(", "));
        }
        if self.spawns_bots {
            note.push_str(" \u{b7} spawns bots");
        }
        if self.has_turn {
            let _ = write!(
                note,
                " \u{b7} last turn {}",
                short_stamp(&self.last_activity_at)
            );
        } else {
            note.push_str(" \u{b7} no turn yet");
        }
        note
    }

    /// The pause line: when the idle bot pauses, or since when it is paused.
    fn pause_note(&self, now_ms: i64) -> String {
        match (self.status.as_str(), self.pause_at, self.status_since) {
            ("running", _, _) if self.attached => "stays running while attached".into(),
            ("running", Some(at), _) => {
                let minutes = ((at - now_ms).max(0) + 59_999) / 60_000;
                let minutes = minutes.max(1);
                format!("pauses in {minutes} min")
            }
            ("paused", _, Some(since)) => format!("paused since {}", iso_from_unix_ms(since)),
            _ => "\u{2014}".into(),
        }
    }

    /// The detail pane's raw facts.
    fn detail_pairs(&self, now_ms: i64) -> Vec<(String, String)> {
        vec![
            ("pause".into(), self.pause_note(now_ms)),
            ("bot".into(), self.bot_id.clone()),
            ("sandbox".into(), self.sandbox_id.clone()),
            (
                "checkpoint".into(),
                self.checkpoint_id.clone().unwrap_or_else(|| "—".into()),
            ),
            ("version".into(), self.version.clone()),
            (
                "model".into(),
                self.model.clone().unwrap_or_else(|| "—".into()),
            ),
            (
                "github".into(),
                if self.github { "on" } else { "off" }.into(),
            ),
            (
                "spawns".into(),
                if self.spawns_bots { "on" } else { "off" }.into(),
            ),
            ("created".into(), self.created_at.clone()),
            ("activity".into(), self.last_activity_at.clone()),
        ]
    }
}

/// `2026-11-23T05:10:42Z` -> `11-23 05:10`: the row's compact stamp. A stamp in another
/// shape shows as is.
fn short_stamp(stamp: &str) -> String {
    match (stamp.get(5..10), stamp.get(11..16)) {
        (Some(day), Some(time)) if stamp.len() >= 16 => format!("{day} {time}"),
        _ => stamp.to_string(),
    }
}

/// Unix milliseconds as a UTC ISO stamp (`2026-11-23T05:10:42Z`).
fn iso_from_unix_ms(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let (days, rest) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Civil date from days since 1970-01-01 (H. Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rest / 3600,
        rest % 3600 / 60,
        rest % 60
    )
}

/// The rows of one `list_bots` answer, plus the count of rows that did not parse.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct BotsCatalog {
    pub rows: Vec<BotRow>,
    pub skipped: usize,
}

/// The error a `list_bots` answer without a `bots` list shows on the page.
pub const MALFORMED_BOTS_REPLY: &str = "the daemon's list_bots answer carries no bots list";

/// Parse the daemon's `list_bots` answer, ordered like the agents page: by section
/// (`Running`, then `Idle`, then `Inactive`), then most recent activity first within a
/// section. A row without its identity, name, or status is skipped and counted.
///
/// # Errors
///
/// Returns [`MALFORMED_BOTS_REPLY`] when the answer carries no `bots` array.
pub fn parse_bots(value: &Value) -> Result<BotsCatalog, String> {
    let rows = value
        .get("bots")
        .and_then(Value::as_array)
        .ok_or_else(|| MALFORMED_BOTS_REPLY.to_string())?;
    let text = |row: &Value, key: &str| row.get(key).and_then(Value::as_str).map(scrub_controls);
    // The stamps are Unix milliseconds.
    let stamp = |row: &Value, key: &str| row.get(key).and_then(Value::as_i64).map(iso_from_unix_ms);
    let mut bots: Vec<BotRow> = rows
        .iter()
        .filter_map(|row| {
            let created_at = stamp(row, "createdAt").unwrap_or_default();
            let last_turn = stamp(row, "lastTurnAt");
            Some(BotRow {
                bot_id: text(row, "botId")?,
                name: text(row, "name")?,
                status: text(row, "status")?,
                model: text(row, "model"),
                version: text(row, "version").unwrap_or_default(),
                sandbox_id: text(row, "sandboxId").unwrap_or_default(),
                checkpoint_id: text(row, "checkpointId"),
                has_turn: last_turn.is_some(),
                last_activity_at: last_turn.unwrap_or_else(|| created_at.clone()),
                created_at,
                attached: row
                    .get("attached")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                github: row.get("github").and_then(Value::as_bool).unwrap_or(false),
                login_stale: row
                    .get("loginStale")
                    .and_then(Value::as_array)
                    .map(|stale| {
                        stale
                            .iter()
                            .filter_map(Value::as_str)
                            .map(scrub_controls)
                            .collect()
                    })
                    .unwrap_or_default(),
                spawns_bots: row
                    .get("spawnsBots")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                parent_bot_id: text(row, "parentBotId"),
                status_since: row.get("statusSince").and_then(Value::as_i64),
                pause_at: row.get("pauseAt").and_then(Value::as_i64),
            })
        })
        .collect();
    let skipped = rows.len() - bots.len();
    // The sort the agents page orders by: section first, then recency within a section (the
    // ISO stamps share one format, so the lexicographic order is the chronological order).
    bots.sort_by(|a, b| {
        section_rank(a.section())
            .cmp(&section_rank(b.section()))
            .then_with(|| b.last_activity_at.cmp(&a.last_activity_at))
    });
    // The tree: a bot's children follow it, indented. A child whose parent
    // sits later in the same section waits for it; a child whose parent is
    // absent or in another section keeps its own sorted place.
    let mut treed: Vec<BotRow> = Vec::with_capacity(bots.len());
    let mut placed = vec![false; bots.len()];
    let parent_position = |row: &BotRow| {
        row.parent_bot_id
            .as_deref()
            .and_then(|parent| bots.iter().position(|bot| bot.bot_id == parent))
    };
    for index in 0..bots.len() {
        if placed[index] {
            continue;
        }
        let waits_for_parent = parent_position(&bots[index]).is_some_and(|parent| {
            !placed[parent] && bots[parent].section() == bots[index].section()
        });
        if waits_for_parent {
            continue;
        }
        placed[index] = true;
        treed.push(bots[index].clone());
        for child in 0..bots.len() {
            if !placed[child]
                && bots[child].parent_bot_id.as_deref() == Some(bots[index].bot_id.as_str())
                && bots[child].section() == bots[index].section()
            {
                placed[child] = true;
                treed.push(bots[child].clone());
            }
        }
    }
    // A parent that never appeared in its child's section leaves the child
    // here, in its sorted place.
    for index in 0..bots.len() {
        if !placed[index] {
            treed.push(bots[index].clone());
        }
    }
    Ok(BotsCatalog {
        rows: treed,
        skipped,
    })
}

/// One key press while the view is open.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BotsAction {
    Close,
    /// `d`: toggle the selected bot's detail pane.
    ToggleDetail,
    /// Enter: attach to the selected bot (the normal session view over its link).
    Attach {
        bot_id: String,
        name: String,
    },
    /// `p`: pause the selected running bot, or resume the selected paused bot.
    TogglePause {
        bot_id: String,
        name: String,
        pause: bool,
    },
    /// `r`: fetch the rows again.
    Refresh,
    None,
}

/// The `/bots` list view.
#[derive(Debug, Default)]
pub struct BotsView {
    rows: Vec<BotRow>,
    skipped: usize,
    selected: usize,
    detail_open: bool,
    fetch_error: Option<String>,
    /// The last failed attach, pause, or resume (a version mismatch shows here); a fetch never
    /// clears it.
    attach_error: Option<String>,
    /// The latest `list_bots` request; only its answer applies.
    catalog_request: u64,
    /// The attach request in flight: `(request number, bot name)`.
    attaching: Option<(u64, String)>,
    /// The pause or resume in flight: `(request number, progress note)`.
    toggling: Option<(u64, String)>,
}

/// The name column's fixed width.
const NAME_COLUMN_W: usize = 22;
/// The model column's fixed width.
const MODEL_COLUMN_W: usize = 24;
/// Rows the list reserves outside its items (rule, title, blank, hint).
const LIST_FRAME_ROWS: usize = 5;
/// Rows per bot (the row + its note) plus the detail pane's height.
const ROW_HEIGHT: usize = 2;
/// The detail pane: a blank row, its heading, and one row per fact.
const DETAIL_ROWS: usize = 12;

/// One display entry in the sectioned list: the spacer between section
/// blocks, a section heading with its row count, or one bot's row pair
/// (carrying the row's index in `rows` — the selection's identity).
enum DisplayItem {
    Spacer,
    Heading(Section, usize),
    Row(usize),
}

impl DisplayItem {
    /// The entry's rendered line count (a bot is its row plus its note).
    fn lines(&self) -> usize {
        match self {
            Self::Spacer | Self::Heading(..) => 1,
            Self::Row(_) => ROW_HEIGHT,
        }
    }
}

impl BotsView {
    /// A landed fetch: replace the rows, clear the fetch error, keep the selection when the
    /// row survived.
    pub fn apply_catalog(&mut self, catalog: BotsCatalog) {
        self.fetch_error = None;
        let selected_bot = self.rows.get(self.selected).map(|row| row.bot_id.clone());
        self.rows = catalog.rows;
        self.skipped = catalog.skipped;
        self.selected = selected_bot
            .and_then(|bot| self.rows.iter().position(|row| row.bot_id == bot))
            .unwrap_or(0);
    }

    /// A failed fetch: the rows stay, the error renders.
    pub fn set_fetch_error(&mut self, error: Option<String>) {
        self.fetch_error = error;
    }

    /// A failed attach (`Some`), or a new attach clearing the last one (`None`).
    pub fn set_attach_error(&mut self, error: Option<String>) {
        self.attach_error = error;
    }

    /// The `list_bots` request whose answer this page waits for.
    pub fn set_catalog_request(&mut self, request: u64) {
        self.catalog_request = request;
    }

    /// Whether rows from `list_bots` request `request` apply: the page's own request or a
    /// newer one.
    #[must_use]
    pub fn takes_catalog(&self, request: u64) -> bool {
        request >= self.catalog_request
    }

    /// Whether `request` is the latest `list_bots` request of this page.
    #[must_use]
    pub fn awaits_catalog(&self, request: u64) -> bool {
        self.catalog_request == request
    }

    /// The attach in flight (`Some((request, name))`), or none.
    pub fn set_attaching(&mut self, attach: Option<(u64, String)>) {
        self.attaching = attach;
    }

    /// Whether this page is waiting for attach request `request`.
    #[must_use]
    pub fn is_attaching(&self, request: u64) -> bool {
        self.attaching
            .as_ref()
            .is_some_and(|(id, _)| *id == request)
    }

    /// The pause or resume in flight (`Some((request, note))`), or none.
    pub fn set_toggling(&mut self, toggle: Option<(u64, String)>) {
        self.toggling = toggle;
    }

    /// Whether this page is waiting for pause or resume request `request`.
    #[must_use]
    pub fn is_toggling(&self, request: u64) -> bool {
        self.toggling.as_ref().is_some_and(|(id, _)| *id == request)
    }

    /// One key press.
    pub fn handle_key(&mut self, key_id: &str, kb: &KeybindingsManager) -> BotsAction {
        if key_id == "ctrl+c" {
            return BotsAction::Close;
        }
        if kb.matches(key_id, "tui.select.cancel") || kb.matches(key_id, "app.modal.back") {
            return BotsAction::Close;
        }
        if kb.matches(key_id, "tui.select.confirm") {
            return match self.rows.get(self.selected) {
                Some(row) if self.attaching.is_none() && self.toggling.is_none() => {
                    BotsAction::Attach {
                        bot_id: row.bot_id.clone(),
                        name: row.name.clone(),
                    }
                }
                _ => BotsAction::None,
            };
        }
        if key_id == "d" {
            self.detail_open = !self.detail_open;
            return BotsAction::ToggleDetail;
        }
        if key_id == "r" {
            return BotsAction::Refresh;
        }
        if key_id == "p" {
            return match self.rows.get(self.selected) {
                Some(row) if self.toggling.is_none() && self.attaching.is_none() => {
                    match row.status.as_str() {
                        "running" | "paused" => BotsAction::TogglePause {
                            bot_id: row.bot_id.clone(),
                            name: row.name.clone(),
                            pause: row.status == "running",
                        },
                        _ => BotsAction::None,
                    }
                }
                _ => BotsAction::None,
            };
        }
        if kb.matches(key_id, "tui.select.up") {
            self.selected = self.selected.saturating_sub(1);
            self.detail_open = false;
            return BotsAction::None;
        }
        if kb.matches(key_id, "tui.select.down") {
            self.selected = (self.selected + 1).min(self.rows.len().saturating_sub(1));
            self.detail_open = false;
            return BotsAction::None;
        }
        BotsAction::None
    }

    /// The view's frame, windowed to the current `viewport_rows`.
    #[must_use]
    pub fn render(
        &self,
        theme: &Theme,
        width: usize,
        kb: &KeybindingsManager,
        viewport_rows: usize,
    ) -> Vec<Line> {
        let mut lines =
            vec![vec![theme.fg_span(
                ThemeColor::BorderMuted,
                "\u{2500}".repeat(width.max(1)),
            )]];
        {
            let title = vec![
                Span::raw("  "),
                theme.fg_span(ThemeColor::Text, "Bots".to_string()),
                theme.fg_span(
                    ThemeColor::Muted,
                    " \u{b7} sandboxes this Mac owns".to_string(),
                ),
            ];
            lines.push(truncate_line(&title, width, ""));
        }
        lines.push(Vec::new());

        // The error wraps: a version mismatch's upgrade message must read in full.
        let error_lines: Vec<Line> = [&self.fetch_error, &self.attach_error]
            .into_iter()
            .flatten()
            .flat_map(|error| {
                let line = vec![theme.fg_span(ThemeColor::Error, format!("Error: {error}"))];
                wrap_line(&line, width.saturating_sub(2).max(1))
            })
            .map(|mut line| {
                line.insert(0, Span::raw("  "));
                line
            })
            .collect();
        let error_rows = error_lines.len() + usize::from(!error_lines.is_empty());
        if !error_lines.is_empty() {
            lines.extend(error_lines);
            lines.push(Vec::new());
        }
        if self.skipped > 0 {
            let line = vec![
                Span::raw("  "),
                theme.fg_span(
                    ThemeColor::Warning,
                    format!("{} malformed bot rows skipped", self.skipped),
                ),
            ];
            lines.push(truncate_line(&line, width, ""));
        }
        let progress = self
            .attaching
            .as_ref()
            .map(|(_, name)| format!("Attaching to {name}. A paused bot takes a moment to resume."))
            .or_else(|| self.toggling.as_ref().map(|(_, note)| note.clone()));
        if let Some(progress) = &progress {
            let line = vec![
                Span::raw("  "),
                theme.fg_span(ThemeColor::Muted, progress.clone()),
            ];
            lines.push(truncate_line(&line, width, ""));
        }
        if self.rows.is_empty() && self.fetch_error.is_none() {
            let line = vec![
                Span::raw("  "),
                theme.fg_span(
                    ThemeColor::Muted,
                    "No bots. An agent starts one with rlm.spawn(target=\"sandbox\").".to_string(),
                ),
            ];
            lines.push(truncate_line(&line, width, ""));
        }

        // The sectioned list (the agents page's grouping): each non-empty
        // section contributes a spacer (when not the first), its heading,
        // then its rows — `parse_bots` already sorted the rows into this
        // order, so the window follows every landed refresh.
        let mut display: Vec<DisplayItem> = Vec::new();
        for section in [Section::Running, Section::Idle, Section::Inactive] {
            let count = self
                .rows
                .iter()
                .filter(|row| row.section() == section)
                .count();
            if count == 0 {
                continue;
            }
            if !display.is_empty() {
                display.push(DisplayItem::Spacer);
            }
            display.push(DisplayItem::Heading(section, count));
            display.extend(
                self.rows
                    .iter()
                    .enumerate()
                    .filter(|(_, row)| row.section() == section)
                    .map(|(index, _)| DisplayItem::Row(index)),
            );
        }

        // The window's budget covers every rendered line, so the
        // headings and spacers consume it like the row pairs do. The
        // window is item-aligned (a row's pair never splits, a heading
        // rides above its rows) and keeps the selected row visible: it
        // extends backward from the selection to the budget's edge,
        // then forward with whatever remains.
        let visible = menu_list_layout(
            Some(viewport_rows),
            viewport_rows,
            display.iter().map(DisplayItem::lines).sum::<usize>(),
            LIST_FRAME_ROWS
                + error_rows
                + usize::from(self.skipped > 0)
                + usize::from(progress.is_some())
                + if self.detail_open { DETAIL_ROWS } else { 0 },
            1,
        );
        let selected_item = display
            .iter()
            .position(|item| matches!(item, DisplayItem::Row(index) if *index == self.selected));
        if let Some(selected_item) = selected_item {
            let mut first = selected_item;
            let mut used = ROW_HEIGHT;
            while first > 0 && used + display[first - 1].lines() <= visible {
                used += display[first - 1].lines();
                first -= 1;
            }
            let mut last = selected_item;
            while last + 1 < display.len() && used + display[last + 1].lines() <= visible {
                used += display[last + 1].lines();
                last += 1;
            }
            for item in &display[first..=last] {
                match item {
                    DisplayItem::Spacer => lines.push(Vec::new()),
                    DisplayItem::Heading(section, count) => {
                        let heading = vec![theme.fg_span(
                            ThemeColor::Muted,
                            format!("{} ({count})", section_title(*section)),
                        )];
                        lines.push(truncate_line(&heading, width, ""));
                    }
                    DisplayItem::Row(index) => {
                        let row = &self.rows[*index];
                        let selected = *index == self.selected;
                        let (glyph, color) = row.dot();
                        let marker = if selected { "\u{25b8} " } else { "  " };
                        // Row 1: dot, name (fixed 22), model (fixed 24),
                        // version right-aligned in the remaining width.
                        let mut line = vec![
                            Span::raw(marker.to_string()),
                            Span::styled(glyph.to_string(), theme.fg_style(color)),
                            Span::raw(" ".to_string()),
                        ];
                        // A child nests under its parent: the arrow keeps the
                        // indent inside the fixed name column.
                        let name: String = if row.parent_bot_id.is_some() {
                            format!("\u{21b3} {}", row.name)
                        } else {
                            row.name.clone()
                        }
                        .chars()
                        .take(NAME_COLUMN_W)
                        .collect();
                        let name_pad =
                            " ".repeat(NAME_COLUMN_W.saturating_sub(name.chars().count()));
                        line.push(theme.fg_span(
                            if selected {
                                ThemeColor::Accent
                            } else {
                                ThemeColor::Text
                            },
                            name,
                        ));
                        line.push(Span::raw(name_pad));
                        line.push(Span::raw("  ".to_string()));
                        let model = row.model.as_deref().unwrap_or("");
                        let model: std::borrow::Cow<str> =
                            model.chars().take(MODEL_COLUMN_W).collect();
                        let model_pad =
                            " ".repeat(MODEL_COLUMN_W.saturating_sub(model.chars().count()));
                        line.push(theme.fg(ThemeColor::Muted, model.into_owned()));
                        line.push(Span::raw(model_pad));
                        // The version cell right-aligned in whatever width remains.
                        let version = row.version_cell();
                        let used = 2
                            + 1
                            + 1
                            + NAME_COLUMN_W
                            + 2
                            + MODEL_COLUMN_W
                            + version.chars().count();
                        let pad = width.saturating_sub(used + 2).max(1);
                        line.push(Span::raw(" ".repeat(pad)));
                        line.push(theme.fg(ThemeColor::Dim, version));
                        lines.push(truncate_line(&line, width, ""));
                        // Row 2: the dim note.
                        let note = vec![Span::raw("    "), theme.fg(ThemeColor::Dim, row.note())];
                        lines.push(truncate_line(&note, width, ""));
                    }
                }
            }
        }

        if self.detail_open {
            if let Some(row) = self.rows.get(self.selected) {
                lines.push(Vec::new());
                lines.push(vec![
                    theme.fg_span(ThemeColor::Muted, "  Details".to_string())
                ]);
                let now_ms = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0, |elapsed| {
                        i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX)
                    });
                for (key, value) in row.detail_pairs(now_ms) {
                    let line = vec![
                        Span::raw("  "),
                        theme.fg(ThemeColor::Muted, format!("{key:<12}")),
                        theme.fg(ThemeColor::Dim, value),
                    ];
                    lines.push(truncate_line(&line, width, ""));
                }
            }
        }

        lines.push(scroll_row(theme, width, self.selected + 1, self.rows.len()));
        let key = |binding: &str, fallback: &str| {
            kb.first_key(binding)
                .map_or_else(|| fallback.to_string(), |key| format_key_text(&key))
        };
        let up = key("tui.select.up", "\u{2191}");
        let down = key("tui.select.down", "\u{2193}");
        let enter = key("tui.select.confirm", "Enter");
        let close = key("tui.select.cancel", "Esc");
        lines.push(hint_row(
            theme,
            width,
            &format!(
                "{up}/{down} select \u{b7} {enter} attach \u{b7} p pause/resume \u{b7} d details \u{b7} r refresh \u{b7} {close} close"
            ),
        ));
        lines
    }
}
