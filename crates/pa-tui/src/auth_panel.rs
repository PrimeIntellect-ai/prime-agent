//! The inline auth panel (TS `LoginDialogComponent` +
//! `PrimeTeamSelectorComponent`, the surfaces `host.showAuthPanel`
//! mounts): the ONE TUI surface the interactive login flows render
//! through. A flow runs in the background and drives the panel through
//! [`AuthPanelHandle`] — progress lines, the browser URL block, a paste
//! prompt, or the Prime team picker — while the TUI run loop folds each
//! request into the mounted panel and answers the prompt/picker requests
//! from the keyboard. No login path ever takes over the plain terminal
//! (the TS auth flows never drop out of the TUI either): no
//! alternate-screen leave, no screen clear, no raw-stdin prompt.
//!
//! The request/reply channel follows the run loop's background-note
//! pattern: the flow's task owns the handle (a plain sender), the loop
//! owns the receiving side, and every prompt carries its own oneshot
//! reply. A flow completion is a request too (the `Settled` variants):
//! the loop unmounts the panel and applies the outcome row.
//!
//! TS carries an abort signal on its login dialog (Esc cancels a running
//! check); the flow seams here have no cancel-push, so a settled flow
//! always unmounts the panel — the paste prompt and the team picker are
//! cancellable, and the network steps settle within their request
//! timeouts.

use tokio::sync::{mpsc, oneshot};

use crate::fuzzy::fuzzy_filter;
use crate::hyperlinks::{osc8_open, OSC8_CLOSE};
use crate::keybindings::KeybindingsManager;
use crate::menu_panel::{
    hint_row, menu_row, no_match_row, scroll_row, scrub_controls, search_field_lines, MenuSegment,
};
use crate::provider_auth::ProviderAuthOutcome;
use crate::search_input::SearchInput;
use crate::theme::{Theme, ThemeColor};
use crate::traces::TraceLoginOutcome;
use crate::{Line, Span};

/// One Prime team option (TS `PrimeTeam` as the selector renders it).
/// `created_at` is carry-through metadata the flow stores with the
/// selection (the picker never renders it).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrimeTeamOption {
    pub team_id: String,
    pub name: String,
    pub slug: Option<String>,
    pub role: Option<String>,
    pub created_at: Option<String>,
}

/// The team picker's answer (TS `PrimeTeamSelectorComponent`'s
/// `onSelect`/`onCancel`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PrimeTeamPick {
    /// TS `onSelect(team)`.
    Team(PrimeTeamOption),
    /// TS `onSelect(null)`: the personal account.
    PersonalAccount,
    /// TS `onCancel`: the stored selection stays untouched.
    Cancelled,
}

/// How the paste field renders its value (TS `MenuSearchInput`'s masked
/// mode: the token paste panel renders bullets, the login dialog
/// renders the typed key).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PasteStyle {
    /// The typed value renders as typed (TS `LoginDialogComponent`).
    Visible,
    /// The typed value renders as bullets (TS
    /// `McpTokenPastePanelComponent`: a rendered line never contains the
    /// secret).
    Masked,
}

/// One request a login flow (or its session wrapper) sends to the inline
/// auth panel. Fire-and-forget requests render; the prompt and picker
/// requests await their oneshot replies; the settled requests close the
/// panel and apply the outcome.
pub enum AuthPanelRequest {
    /// TS `dialog.showProgress`: a muted progress line joins the panel.
    Progress { message: String },
    /// TS `dialog.showAuth`: the browser URL block (the flow launches
    /// the browser itself; the panel only renders).
    AuthUrl {
        url: String,
        /// The provider instructions; `None` renders TS's default
        /// "Complete the sign-in in your browser." line.
        instructions: Option<String>,
    },
    /// TS `dialog.showManualInput` / `armManualInput`: the prompt above
    /// the panel's paste field. Enter submits the trimmed value (an
    /// empty submit stays mounted with the notice); Esc cancels the
    /// flow (`None`).
    PastePrompt {
        prompt: String,
        style: PasteStyle,
        reply: oneshot::Sender<Option<String>>,
    },
    /// TS `PrimeTeamSelectorComponent` mounts over the panel: Esc
    /// cancels the selection (the stored selection stays).
    SelectTeam {
        teams: Vec<PrimeTeamOption>,
        /// TS `currentTeamId`: the stored selection's team id; `None`
        /// marks the personal account current.
        current: Option<String>,
        reply: oneshot::Sender<PrimeTeamPick>,
    },
    /// A provider login settled (`/login`'s rows): the outcome row
    /// applies and the panel unmounts.
    ProviderSettled { outcome: ProviderAuthOutcome },
    /// A `/mcp` view auth command settled: its status line applies.
    McpSettled { note: String },
    /// The `/traces` login settled: the login's outcome applies (the
    /// enable intent continues in the session).
    TracesSettled { outcome: TraceLoginOutcome },
}

/// The flow-side handle to the inline auth panel: one login run's
/// request channel. The composition root drives its flow against this
/// handle; the TUI run loop owns the receiving side and services every
/// request. Cheap to clone; a clone shares the run's channel.
#[derive(Clone)]
pub struct AuthPanelHandle {
    tx: mpsc::UnboundedSender<AuthPanelRequest>,
}

impl AuthPanelHandle {
    /// Build the handle over one run's request channel (the session
    /// creates the pair; the loop owns the receiver).
    pub fn new(tx: mpsc::UnboundedSender<AuthPanelRequest>) -> Self {
        AuthPanelHandle { tx }
    }

    /// Submit one request directly (the helpers below and the session's
    /// settled notes all funnel here).
    pub fn send(&self, request: AuthPanelRequest) {
        let _ = self.tx.send(request);
    }

    /// TS `dialog.showProgress`.
    pub fn progress(&self, message: impl Into<String>) {
        self.send(AuthPanelRequest::Progress {
            message: message.into(),
        });
    }

    /// TS `dialog.showAuth`.
    pub fn auth_url(&self, url: &str, instructions: Option<&str>) {
        self.send(AuthPanelRequest::AuthUrl {
            url: url.to_string(),
            instructions: instructions.map(str::to_string),
        });
    }

    /// TS `dialog.showManualInput` / `armManualInput`: prompt above the
    /// paste field; the submitted value resolves the future, a cancel
    /// answers `None`.
    pub async fn paste_prompt(&self, prompt: &str, style: PasteStyle) -> Option<String> {
        let (reply, answer) = oneshot::channel();
        self.send(AuthPanelRequest::PastePrompt {
            prompt: prompt.to_string(),
            style,
            reply,
        });
        answer.await.unwrap_or(None)
    }

    /// TS `PrimeTeamSelectorComponent`: the team picker; a cancel
    /// answers [`PrimeTeamPick::Cancelled`] (the stored selection
    /// stays).
    pub async fn select_team(
        &self,
        teams: Vec<PrimeTeamOption>,
        current: Option<&str>,
    ) -> PrimeTeamPick {
        let (reply, answer) = oneshot::channel();
        self.send(AuthPanelRequest::SelectTeam {
            teams,
            current: current.map(str::to_string),
            reply,
        });
        answer.await.unwrap_or(PrimeTeamPick::Cancelled)
    }
}

impl std::fmt::Debug for AuthPanelHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AuthPanelHandle").finish()
    }
}

/// TS `PREFERRED_VISIBLE_TEAMS`.
const PREFERRED_VISIBLE_TEAMS: usize = 8;

/// The login dialog's paste field placeholder (TS
/// `MenuSearchInput("Paste value")`).
const PASTE_PLACEHOLDER: &str = "Paste value";

/// The token paste panel's placeholder (TS `MenuSearchInput("Paste
/// token", ..., { masked: true })`).
const TOKEN_PLACEHOLDER: &str = "Paste token";

/// The team picker's panel title (TS `MenuPanel` title).
const TEAM_PANEL_TITLE: &str = "Select a Prime Team:";

/// The team picker's subtitle (TS `MenuPanel` subtitle).
const TEAM_PANEL_SUBTITLE: &str = "Choose which account pays for Prime Inference usage.";

/// The team picker's search placeholder (TS `MenuSearchInput("Search
/// teams")`).
const TEAM_SEARCH_PLACEHOLDER: &str = "Search teams";

/// The empty-submit notice (TS `McpTokenPastePanelComponent`'s
/// "The value cannot be empty.").
const EMPTY_VALUE_NOTICE: &str = "The value cannot be empty.";

/// TS `LoginDialogComponent`'s default browser-step line.
const BROWSER_DEFAULT_INSTRUCTIONS: &str = "Complete the sign-in in your browser.";

/// The mounted panel: the flow's progress lines, the browser URL block,
/// and the one active input (a paste prompt or the team picker).
#[derive(Debug)]
pub struct AuthPanel {
    /// TS the dialog's panel title: `Login to {provider}` / `Connect
    /// {service}`.
    title: String,
    /// TS the `MenuPanel` subtitle; the team picker sets its own.
    subtitle: Option<String>,
    /// TS `showProgress` lines, in arrival order (the section title
    /// "Preparing authentication" rides first, TS `showProgress`'s
    /// empty-content arm).
    progress: Vec<String>,
    /// TS `showAuth`'s URL block.
    auth_url: Option<String>,
    auth_instructions: Option<String>,
    /// The empty-submit notice row.
    notice: Option<String>,
    /// The active input.
    input: PanelInput,
}

/// The panel's active input.
#[derive(Debug)]
enum PanelInput {
    /// No input mounted: the flow works between requests (its progress
    /// lines stay; Esc has nothing to cancel — the flow settles within
    /// its request timeouts).
    Working,
    /// The paste prompt (TS `showManualInput`).
    Paste {
        prompt: String,
        style: PasteStyle,
        field: SearchInput,
        reply: Option<oneshot::Sender<Option<String>>>,
    },
    /// The team picker (TS `PrimeTeamSelectorComponent`).
    Teams {
        picker: PrimeTeamPicker,
        reply: Option<oneshot::Sender<PrimeTeamPick>>,
    },
}

/// The mounted team picker (TS `PrimeTeamSelectorComponent`): the search
/// field over the personal-first rows.
#[derive(Debug)]
struct PrimeTeamPicker {
    /// The team rows; the personal account rides first as its own row.
    teams: Vec<PrimeTeamOption>,
    /// TS `currentTeamId`: the stored selection's team id; `None` marks
    /// the personal account current.
    current: Option<String>,
    search: SearchInput,
    /// Indices over the full row list (0 = personal, i + 1 = teams[i]).
    filtered: Vec<usize>,
    selected: usize,
}

/// One trailing cell of a team row: a muted detail or the "current"
/// marker (TS `MenuRow`'s meta with `theme.fg("success", ...)`).
enum PickerSegment {
    Muted(String),
    Current,
}

impl AuthPanel {
    /// Mount the panel for one login run: the title rides the top rule
    /// (TS `showAuthPanel` mounts the dialog the moment the flow starts).
    pub fn new(title: impl Into<String>) -> Self {
        AuthPanel {
            title: scrub_controls(&title.into()),
            subtitle: None,
            progress: Vec::new(),
            auth_url: None,
            auth_instructions: None,
            notice: None,
            input: PanelInput::Working,
        }
    }

    /// TS `showProgress`: the first line lands under the section title.
    /// One request-fold entry (the session's channel arm calls it).
    pub fn push_progress(&mut self, message: String) {
        if self.progress.is_empty() {
            self.progress.push("Preparing authentication".to_string());
        }
        // The flow's lines can quote provider text: the same control
        // character hygiene every daemon-supplied row carries.
        self.progress.push(scrub_controls(&message));
    }

    /// TS `showAuth`: the URL block replaces the content (the paste
    /// field unmounts with it, TS `startContent` clears). One
    /// request-fold entry (the session's channel arm calls it).
    pub fn show_auth_url(&mut self, url: String, instructions: Option<String>) {
        self.auth_url = Some(url);
        self.auth_instructions = instructions;
        self.input = PanelInput::Working;
        self.notice = None;
    }

    /// TS `showManualInput` / `armManualInput`: the prompt above a fresh
    /// paste field (the flow's progress lines stay). One request-fold
    /// entry (the session's channel arm calls it).
    pub fn mount_paste(
        &mut self,
        prompt: String,
        style: PasteStyle,
        reply: oneshot::Sender<Option<String>>,
    ) {
        self.input = PanelInput::Paste {
            prompt: scrub_controls(&prompt),
            style,
            field: SearchInput::new(),
            reply: Some(reply),
        };
        self.notice = None;
    }

    /// TS `PrimeTeamSelectorComponent`: the picker mounts as its own
    /// panel (fresh title, subtitle, and rows; the login dialog's
    /// progress lines go with it). One request-fold entry (the
    /// session's channel arm calls it).
    pub fn mount_teams(
        &mut self,
        teams: Vec<PrimeTeamOption>,
        current: Option<String>,
        reply: oneshot::Sender<PrimeTeamPick>,
    ) {
        self.title = TEAM_PANEL_TITLE.to_string();
        self.subtitle = Some(TEAM_PANEL_SUBTITLE.to_string());
        self.progress.clear();
        self.auth_url = None;
        self.auth_instructions = None;
        self.notice = None;
        let mut picker = PrimeTeamPicker {
            teams,
            current,
            search: SearchInput::new(),
            filtered: Vec::new(),
            selected: 0,
        };
        picker.refilter();
        self.input = PanelInput::Teams {
            picker,
            reply: Some(reply),
        };
    }

    /// One key press while the panel owns the frame (TS
    /// `LoginDialogComponent.handleInput` /
    /// `PrimeTeamSelectorComponent.handleInput`). The arms answer the
    /// mounted input through its oneshot; the answered flag hands the
    /// panel back to the flow after the match (the arms never hold the
    /// input's reply past its last use).
    pub fn handle_key(&mut self, key: &str, kb: &KeybindingsManager) {
        // Ctrl+C cancels the mounted input like Esc (the surfaces that
        // consume the pair note it handled).
        if key == "ctrl+c" {
            self.cancel_input();
            return;
        }
        let mut answered = false;
        match &mut self.input {
            PanelInput::Working => {}
            PanelInput::Paste { field, reply, .. } => {
                if kb.matches(key, "tui.select.cancel") {
                    if let Some(reply) = reply.take() {
                        let _ = reply.send(None);
                    }
                    answered = true;
                } else if kb.matches(key, "tui.select.confirm") {
                    let value = field.value().trim().to_string();
                    if value.is_empty() {
                        // TS the paste panel's empty-submit notice; the
                        // field stays mounted.
                        self.notice = Some(EMPTY_VALUE_NOTICE.to_string());
                    } else if let Some(reply) = reply.take() {
                        let _ = reply.send(Some(value));
                        answered = true;
                    }
                } else {
                    field.handle_key(key, kb);
                }
            }
            PanelInput::Teams { picker, reply } => {
                if kb.matches(key, "tui.select.cancel") {
                    if let Some(reply) = reply.take() {
                        let _ = reply.send(PrimeTeamPick::Cancelled);
                    }
                    answered = true;
                } else if kb.matches(key, "tui.select.up") && !picker.filtered.is_empty() {
                    picker.selected = picker.selected.saturating_sub(1);
                } else if kb.matches(key, "tui.select.down") && !picker.filtered.is_empty() {
                    picker.selected = (picker.selected + 1).min(picker.filtered.len() - 1);
                } else if kb.matches(key, "tui.select.confirm") {
                    if let (Some(pick), Some(reply)) = (picker.pick(), reply.take()) {
                        let _ = reply.send(pick);
                        answered = true;
                    }
                } else {
                    let previous = picker.search.value().to_string();
                    picker.search.handle_key(key, kb);
                    if picker.search.value() != previous {
                        picker.refilter();
                    }
                }
            }
        }
        if answered {
            self.input = PanelInput::Working;
            self.notice = None;
        }
    }

    /// One paste payload while the panel owns the frame (TS the dialog's
    /// field and the selector's search accept pasted text): the payload
    /// lands in the mounted input — the paste field or the picker's
    /// search — never in the hidden editor behind the panel.
    pub fn handle_paste(&mut self, text: &str) {
        match &mut self.input {
            PanelInput::Working => {}
            PanelInput::Paste { field, .. } => field.paste(text),
            PanelInput::Teams { picker, .. } => {
                picker.search.paste(text);
                picker.refilter();
            }
        }
    }

    /// Esc/Ctrl+C on the mounted input: the paste prompt answers `None`
    /// (the flow cancels), the picker answers `Cancelled` (the stored
    /// selection stays, TS `onCancel`); no input means nothing to
    /// cancel.
    fn cancel_input(&mut self) {
        match &mut self.input {
            PanelInput::Working => {}
            PanelInput::Paste { reply, .. } => {
                if let Some(reply) = reply.take() {
                    let _ = reply.send(None);
                }
                self.input = PanelInput::Working;
            }
            PanelInput::Teams { reply, .. } => {
                if let Some(reply) = reply.take() {
                    let _ = reply.send(PrimeTeamPick::Cancelled);
                }
                self.input = PanelInput::Working;
            }
        }
        self.notice = None;
    }

    /// The panel's rendered rows (the provider selector's panel chrome:
    /// the top rule, the title, the subtitle, the content, the hint, the
    /// bottom rule).
    pub fn render(&mut self, theme: &Theme, width: usize) -> Vec<Line> {
        let mut lines: Vec<Line> = Vec::new();
        lines.push(Vec::new());
        lines.push(vec![
            theme.fg_span(ThemeColor::Border, "\u{2500}".repeat(width.max(1)))
        ]);
        lines.push(vec![crate::Span::raw(format!("  {}", self.title))]);
        if let Some(subtitle) = &self.subtitle {
            lines.push(vec![
                theme.fg_span(ThemeColor::Muted, format!("  {subtitle}"))
            ]);
        }
        lines.push(Vec::new());
        for message in &self.progress {
            lines.push(vec![
                theme.fg_span(ThemeColor::Muted, format!("  {message}"))
            ]);
        }
        if let Some(url) = &self.auth_url {
            // The URL and the instructions are provider-supplied: control
            // characters can never execute terminal control operations
            // when rendered (the same hygiene every daemon-supplied row
            // carries); a URL is additionally single-line, so newlines
            // drop. TS `showAuth` wraps the URL in OSC 8 (the URL is the
            // link's own display text) when the terminal is known to
            // implement hyperlinks, else prints it plain.
            let safe = scrub_controls(url).replace('\n', "");
            let linked = if crate::hyperlinks::hyperlinks_enabled() {
                format!("{}{safe}{OSC8_CLOSE}", osc8_open(&safe))
            } else {
                safe
            };
            lines.push(vec![
                theme.fg_span(ThemeColor::Accent, format!("  {linked}"))
            ]);
            let instructions = self
                .auth_instructions
                .clone()
                .map(|text| scrub_controls(&text))
                .unwrap_or_else(|| BROWSER_DEFAULT_INSTRUCTIONS.to_string());
            lines.push(vec![
                theme.fg_span(ThemeColor::Text, format!("  {instructions}"))
            ]);
        }
        match &mut self.input {
            PanelInput::Working => {}
            PanelInput::Paste {
                prompt,
                style,
                field,
                ..
            } => {
                lines.push(vec![theme.fg_span(ThemeColor::Muted, format!("  {prompt}"))]);
                let placeholder = match style {
                    PasteStyle::Visible => PASTE_PLACEHOLDER,
                    PasteStyle::Masked => TOKEN_PLACEHOLDER,
                };
                let (value, cursor) = match style {
                    // A masked render never contains the secret: only the
                    // bullet projection rides the line (TS
                    // `McpTokenPastePanelComponent`).
                    PasteStyle::Masked => (
                        "\u{2022}".repeat(field.value().chars().count()),
                        field.value().chars().count(),
                    ),
                    PasteStyle::Visible => (field.value().to_string(), field.cursor()),
                };
                lines.append(&mut search_field_lines(
                    theme,
                    width,
                    &value,
                    cursor,
                    true,
                    placeholder,
                ));
                if let Some(notice) = &self.notice {
                    lines.push(vec![
                        theme.fg_span(ThemeColor::Warning, format!("  {notice}"))
                    ]);
                }
                lines.push(hint_row(theme, width, "enter submit  escape cancel"));
            }
            PanelInput::Teams { picker, .. } => {
                let mut search = search_field_lines(
                    theme,
                    width,
                    picker.search.value(),
                    picker.search.cursor(),
                    false,
                    TEAM_SEARCH_PLACEHOLDER,
                );
                lines.append(&mut search);
                let count = picker.filtered.len();
                let visible = PREFERRED_VISIBLE_TEAMS.min(count.max(1));
                let start = if count > visible {
                    picker
                        .selected
                        .saturating_sub(visible / 2)
                        .min(count - visible)
                } else {
                    0
                };
                let end = (start + visible).min(count);
                for index in start..end {
                    let Some(row) = picker.filtered.get(index) else {
                        continue;
                    };
                    let selected = index == picker.selected;
                    let (primary, trailing) = picker.row_parts(*row);
                    let segments: Vec<MenuSegment> = trailing
                        .iter()
                        .map(|segment| match segment {
                            PickerSegment::Muted(text) => MenuSegment::muted(text),
                            PickerSegment::Current => {
                                MenuSegment::themed(ThemeColor::Success, "current")
                            }
                        })
                        .collect();
                    lines.push(menu_row(theme, width, primary, &segments, selected));
                }
                if start > 0 || end < count {
                    lines.push(scroll_row(theme, width, picker.selected + 1, count));
                }
                if count == 0 {
                    lines.push(no_match_row(theme, width, "No matching teams"));
                }
                lines.push(hint_row(
                    theme,
                    width,
                    "\u{2191}\u{2193} navigate  enter select  escape cancel",
                ));
            }
        }
        lines.push(vec![
            theme.fg_span(ThemeColor::Border, "\u{2500}".repeat(width.max(1)))
        ]);
        lines
    }
}

impl PrimeTeamPicker {
    /// TS `filterOptions`: the fuzzy filter over the full row list; a
    /// fresh query resets the cursor to the first row.
    fn refilter(&mut self) {
        let query = self.search.value().to_string();
        let rows = self.teams.len() + 1;
        self.filtered = if query.is_empty() {
            (0..rows).collect()
        } else {
            fuzzy_filter(&(0..rows).collect::<Vec<_>>(), &query, |row| {
                self.search_text(*row)
            })
        };
        self.selected = 0;
    }

    /// TS `getSearchText`: the personal account or the team's name,
    /// slug, role, and id.
    fn search_text(&self, row: usize) -> String {
        if row == 0 {
            return "personal account".to_string();
        }
        match self.teams.get(row - 1) {
            Some(team) => format!(
                "{} {} {} {}",
                team.name,
                team.slug.clone().unwrap_or_default(),
                team.role.clone().unwrap_or_default(),
                team.team_id
            ),
            None => String::new(),
        }
    }

    /// The row's primary and trailing cells (TS `getPrimary`/
    /// `getSecondary`/`getMeta`): the name with the slug/role detail,
    /// "personal account" for the personal row, and the "current"
    /// marker on the stored selection.
    fn row_parts(&self, row: usize) -> (Line, Vec<PickerSegment>) {
        if row == 0 {
            let mut trailing = vec![PickerSegment::Muted("personal account".to_string())];
            if self.current.is_none() {
                trailing.push(PickerSegment::Current);
            }
            return (vec![Span::raw("Personal")], trailing);
        }
        let Some(team) = self.teams.get(row - 1) else {
            return (Vec::new(), Vec::new());
        };
        // The team fields are provider-supplied: the same control
        // character hygiene every daemon-supplied row carries.
        let name = scrub_controls(&team.name);
        let role = team
            .role
            .as_deref()
            .map(|role| scrub_controls(role).to_lowercase())
            .unwrap_or_else(|| "member".to_string());
        let detail = match &team.slug {
            Some(slug) => format!("slug: {}, role: {role}", scrub_controls(slug)),
            None => format!("role: {role}"),
        };
        let mut trailing = vec![PickerSegment::Muted(detail)];
        if self.current.as_deref() == Some(team.team_id.as_str()) {
            trailing.push(PickerSegment::Current);
        }
        (vec![Span::raw(name)], trailing)
    }

    /// TS confirm on the selected row: the personal row answers the
    /// personal account, a team row answers the team; an empty filter
    /// selects nothing.
    fn pick(&self) -> Option<PrimeTeamPick> {
        let row = *self.filtered.get(self.selected)?;
        Some(if row == 0 {
            PrimeTeamPick::PersonalAccount
        } else {
            let team = self.teams.get(row - 1)?;
            PrimeTeamPick::Team(team.clone())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keybindings::KeybindingsManager;

    fn kb() -> KeybindingsManager {
        KeybindingsManager::new()
    }

    fn theme() -> Theme {
        Theme::builtin("prime", crate::theme::ColorMode::TrueColor)
    }

    fn acme() -> PrimeTeamOption {
        PrimeTeamOption {
            team_id: "team-acme".to_string(),
            name: "Acme Corp".to_string(),
            slug: Some("acme".to_string()),
            role: Some("Owner".to_string()),
            created_at: None,
        }
    }

    fn beta() -> PrimeTeamOption {
        PrimeTeamOption {
            team_id: "team-beta".to_string(),
            name: "Beta Team".to_string(),
            slug: None,
            role: None,
            created_at: None,
        }
    }

    fn frame_text(panel: &mut AuthPanel) -> Vec<String> {
        panel
            .render(&theme(), 90)
            .iter()
            .map(|line| line.iter().map(|span| span.content.as_str()).collect())
            .collect()
    }

    /// A paste prompt mounted over a panel with its oneshot pair.
    fn mount_paste() -> (AuthPanel, oneshot::Receiver<Option<String>>) {
        let mut panel = AuthPanel::new("Login to Prime Inference");
        let (reply, answer) = oneshot::channel();
        panel.mount_paste(
            "Paste a Prime API key below:".to_string(),
            PasteStyle::Visible,
            reply,
        );
        (panel, answer)
    }

    /// A team picker mounted with its oneshot pair.
    fn mount_teams(
        teams: Vec<PrimeTeamOption>,
        current: Option<&str>,
    ) -> (AuthPanel, oneshot::Receiver<PrimeTeamPick>) {
        let mut panel = AuthPanel::new("Login to Prime Inference");
        let (reply, answer) = oneshot::channel();
        panel.mount_teams(teams, current.map(str::to_string), reply);
        (panel, answer)
    }

    /// TS `dialog.showProgress`: the first line lands under the section
    /// title.
    #[test]
    fn the_first_progress_line_lands_under_the_section_title() {
        let mut panel = AuthPanel::new("Login to Prime Inference");
        panel.push_progress("Checking existing Prime CLI credentials...".to_string());
        let rows = frame_text(&mut panel);
        assert!(rows
            .iter()
            .any(|row| row.contains("Login to Prime Inference")));
        assert!(
            rows.iter()
                .any(|row| row.contains("Preparing authentication")),
            "the TS section title rides the first progress: {rows:?}"
        );
        assert!(rows
            .iter()
            .any(|row| row.contains("Checking existing Prime CLI credentials...")));
    }

    /// TS `dialog.showAuth`: the URL renders with its instructions (the
    /// default browser line without them), and the paste field unmounts.
    #[test]
    fn the_auth_url_block_replaces_the_content() {
        let mut panel = AuthPanel::new("Login to Linear");
        panel.mount_paste(
            "Paste the code below:".to_string(),
            PasteStyle::Visible,
            oneshot::channel().0,
        );
        panel.show_auth_url(
            "https://fixture.example/authorize".to_string(),
            Some("Enter the code from the browser.".to_string()),
        );
        let rows = frame_text(&mut panel);
        assert!(rows
            .iter()
            .any(|row| row.contains("https://fixture.example/authorize")));
        assert!(
            rows.iter()
                .any(|row| row.contains("Enter the code from the browser.")),
            "the instructions render: {rows:?}"
        );
        assert!(
            !rows.iter().any(|row| row.contains("Paste the code below:")),
            "the mounted field unmounts with the content"
        );
        panel.show_auth_url("https://fixture.example/x".to_string(), None);
        let rows = frame_text(&mut panel);
        assert!(
            rows.iter()
                .any(|row| row.contains("Complete the sign-in in your browser.")),
            "the TS default browser line renders: {rows:?}"
        );
    }

    /// The paste prompt renders the TS prompt row, the bordered field
    /// with the "Paste value" placeholder, and the hint row; Enter
    /// submits the trimmed value through the oneshot.
    #[test]
    fn the_paste_prompt_submits_the_typed_value() {
        let (mut panel, mut answer) = mount_paste();
        // The mounted field shows its placeholder while empty, the prompt
        // row above it, and the hint row below.
        let rows = frame_text(&mut panel);
        assert!(rows
            .iter()
            .any(|row| row.contains("Paste a Prime API key below:")));
        assert!(rows.iter().any(|row| row.contains("Paste value")));
        assert!(rows.iter().any(|row| row.contains("enter submit")));
        for character in "  sk-live  ".chars() {
            panel.handle_key(character.to_string().as_str(), &kb());
        }
        panel.handle_key("enter", &kb());
        assert_eq!(answer.try_recv(), Ok(Some("sk-live".to_string())));
    }

    /// Esc on the paste prompt cancels the flow (`None`), TS the dialog
    /// cancel.
    #[test]
    fn escape_on_the_paste_prompt_cancels_the_flow() {
        let (mut panel, mut answer) = mount_paste();
        panel.handle_key("escape", &kb());
        assert_eq!(answer.try_recv(), Ok(None));
    }

    /// TS the token paste panel: an empty submit keeps the field mounted
    /// and shows the notice; the submit that follows still works.
    #[test]
    fn an_empty_paste_submit_shows_the_notice() {
        let (mut panel, mut answer) = mount_paste();
        panel.handle_key("enter", &kb());
        let rows = frame_text(&mut panel);
        assert!(rows
            .iter()
            .any(|row| row.contains("The value cannot be empty.")));
        assert!(answer.try_recv().is_err(), "nothing answered");
        panel.handle_key("k", &kb());
        panel.handle_key("enter", &kb());
        assert_eq!(answer.try_recv(), Ok(Some("k".to_string())));
    }

    /// TS `McpTokenPastePanelComponent`: a masked field renders bullets,
    /// never the secret.
    #[test]
    fn the_masked_field_renders_bullets_never_the_secret() {
        let mut panel = AuthPanel::new("Connect GitHub");
        panel.mount_paste(
            "Paste the token for github:".to_string(),
            PasteStyle::Masked,
            oneshot::channel().0,
        );
        for character in "ghp_secretvalue".chars() {
            panel.handle_key(character.to_string().as_str(), &kb());
        }
        let rows = frame_text(&mut panel);
        let joined = rows.join("\n");
        assert!(
            !joined.contains("ghp_secretvalue"),
            "the secret never renders: {joined:?}"
        );
        assert!(
            joined.contains("\u{2022}\u{2022}\u{2022}"),
            "bullets render"
        );
    }

    /// The team picker renders the TS `PrimeTeamSelectorComponent`
    /// panel: the title and subtitle, the search field, Personal first
    /// with its meta and the current marker, and the slug/role detail.
    #[test]
    fn the_team_picker_renders_the_ts_rows() {
        let (mut panel, _answer) = mount_teams(vec![acme(), beta()], Some("team-beta"));
        let rows = frame_text(&mut panel);
        assert!(rows.iter().any(|row| row.contains("Select a Prime Team:")));
        assert!(rows
            .iter()
            .any(|row| { row.contains("Choose which account pays for Prime Inference usage.") }));
        assert!(rows.iter().any(|row| row.contains("Search teams")));
        assert!(rows.iter().any(|row| row.contains("Personal")));
        assert!(rows.iter().any(|row| row.contains("personal account")));
        assert!(rows.iter().any(|row| row.contains("Acme Corp")));
        assert!(rows
            .iter()
            .any(|row| row.contains("slug: acme, role: owner")));
        assert!(rows.iter().any(|row| row.contains("role: member")));
        // The stored selection (Beta) is the current row; the personal
        // row carries no current marker.
        let beta_row = rows
            .iter()
            .find(|row| row.contains("Beta Team"))
            .expect("the beta row");
        assert!(beta_row.contains("current"), "the beta row: {beta_row:?}");
        assert!(
            !rows
                .iter()
                .any(|row| row.contains("personal account · current")),
            "personal is not current while a team is stored"
        );
    }

    /// With no stored selection the personal account is the current row
    /// (TS `getMeta`).
    #[test]
    fn the_personal_row_is_current_without_a_stored_selection() {
        let (mut panel, _answer) = mount_teams(vec![acme()], None);
        let rows = frame_text(&mut panel);
        assert!(rows
            .iter()
            .any(|row| row.contains("personal account · current")));
    }

    /// Down/Enter on the picker answers the selected team (TS
    /// `onSelect`); the personal row answers the personal account.
    #[test]
    fn the_picker_navigates_and_picks() {
        let (mut panel, mut answer) = mount_teams(vec![acme(), beta()], None);
        panel.handle_key("down", &kb());
        panel.handle_key("enter", &kb());
        assert_eq!(answer.try_recv(), Ok(PrimeTeamPick::Team(acme())));
        let (mut panel, mut answer) = mount_teams(vec![acme()], None);
        panel.handle_key("enter", &kb());
        assert_eq!(answer.try_recv(), Ok(PrimeTeamPick::PersonalAccount));
    }

    /// TS `onCancel`: Esc answers the cancelled pick (the stored
    /// selection stays; the flow resolves the default status).
    #[test]
    fn escape_on_the_picker_answers_the_cancelled_pick() {
        let (mut panel, mut answer) = mount_teams(vec![acme()], None);
        panel.handle_key("escape", &kb());
        assert_eq!(answer.try_recv(), Ok(PrimeTeamPick::Cancelled));
    }

    /// TS `filterOptions`: the search filters over the personal row's and
    /// the teams' search text (name, slug, role, id); Enter on the
    /// surviving row picks it.
    #[test]
    fn the_picker_search_filters_and_picks_the_surviving_row() {
        let (mut panel, mut answer) = mount_teams(vec![acme(), beta()], None);
        for character in "acme".chars() {
            panel.handle_key(character.to_string().as_str(), &kb());
        }
        let rows = frame_text(&mut panel);
        assert!(rows.iter().any(|row| row.contains("Acme Corp")));
        assert!(
            !rows.iter().any(|row| row.contains("Beta Team")),
            "the non-match is filtered out: {rows:?}"
        );
        assert!(
            !rows.iter().any(|row| row.contains("Personal")),
            "the personal row is filtered out too: {rows:?}"
        );
        panel.handle_key("enter", &kb());
        assert_eq!(answer.try_recv(), Ok(PrimeTeamPick::Team(acme())));
        // The personal row's search text matches "personal account".
        let (mut panel, _answer) = mount_teams(vec![acme()], None);
        for character in "personal".chars() {
            panel.handle_key(character.to_string().as_str(), &kb());
        }
        let rows = frame_text(&mut panel);
        assert!(rows.iter().any(|row| row.contains("Personal")));
        assert!(
            !rows.iter().any(|row| row.contains("Acme Corp")),
            "the team row is filtered out: {rows:?}"
        );
    }

    /// A filter that matches nothing renders the TS empty row, and Enter
    /// selects nothing (the reply stays mounted, TS `if (selected)`).
    #[test]
    fn an_empty_filter_renders_the_ts_empty_row_and_selects_nothing() {
        let (mut panel, mut answer) = mount_teams(vec![acme()], None);
        for character in "zzz".chars() {
            panel.handle_key(character.to_string().as_str(), &kb());
        }
        let rows = frame_text(&mut panel);
        assert!(rows.iter().any(|row| row.contains("No matching teams")));
        panel.handle_key("enter", &kb());
        assert!(
            answer.try_recv().is_err(),
            "an empty filter selects nothing"
        );
    }

    /// The picker's navigation clamps at both ends (TS
    /// `Math.max(0, ...)` / `Math.min(...)`; no wrap): up from the first
    /// row stays personal, down past the last row stays on it.
    #[test]
    fn the_picker_navigation_clamps_instead_of_wrapping() {
        let (mut panel, mut answer) = mount_teams(vec![acme()], None);
        panel.handle_key("up", &kb());
        panel.handle_key("enter", &kb());
        assert_eq!(
            answer.try_recv(),
            Ok(PrimeTeamPick::PersonalAccount),
            "up clamps at the personal row (index 0)"
        );
        let (mut panel, mut answer) = mount_teams(vec![acme()], None);
        panel.handle_key("down", &kb());
        panel.handle_key("down", &kb());
        panel.handle_key("enter", &kb());
        assert_eq!(
            answer.try_recv(),
            Ok(PrimeTeamPick::Team(acme())),
            "down clamps at the last row"
        );
    }

    /// A request with no mounted panel is not an error path for the
    /// handle: the dropped reply cancels the flow (the old terminal
    /// input's EOF contract).
    #[tokio::test]
    async fn a_dropped_prompt_reply_cancels_the_flow() {
        let (tx, rx) = mpsc::unbounded_channel();
        // The receiving side is gone (the run loop's channel died with
        // the session): the dropped request's reply cancels the flow —
        // the paste prompt answers `None`, the picker `Cancelled`.
        drop(rx);
        let handle = AuthPanelHandle::new(tx);
        assert_eq!(
            handle
                .paste_prompt("Paste a key:", PasteStyle::Visible)
                .await,
            None
        );
        assert_eq!(
            handle.select_team(vec![acme()], None).await,
            PrimeTeamPick::Cancelled
        );
    }

    /// A paste payload lands in the mounted field (never the hidden
    /// editor): the pasted value submits through the oneshot.
    #[test]
    fn a_paste_payload_lands_in_the_mounted_field() {
        let (mut panel, mut answer) = mount_paste();
        panel.handle_paste("  sk-pasted-key  ");
        panel.handle_key("enter", &kb());
        assert_eq!(answer.try_recv(), Ok(Some("sk-pasted-key".to_string())));
        // The picker's search accepts pasted text too (TS `MenuSearchInput`).
        let (mut panel, mut answer) = mount_teams(vec![acme()], None);
        panel.handle_paste("acme");
        panel.handle_key("enter", &kb());
        assert_eq!(answer.try_recv(), Ok(PrimeTeamPick::Team(acme())));
    }

    /// Provider-supplied text can never execute terminal control
    /// operations: the panel scrubs control characters out of the title,
    /// the URL block, the instructions, the paste prompt, and the team
    /// rows (the URL is additionally single-line for the OSC 8 wrap).
    #[test]
    fn provider_text_is_scrubbed_never_a_terminal_sequence() {
        let mut panel = AuthPanel::new("Login to \u{1b}]8;;https://evil.example\u{7}Evil");
        panel.push_progress("Loading\u{1b}[2J teams...".to_string());
        panel.show_auth_url(
            "https://a.example/\u{1b}]8;;https://evil.example\u{7}link\u{1b}\\\u{1b}]8;;\u{1b}\\"
                .to_string(),
            Some("Open\r\nhttps://evil".to_string()),
        );
        let rows = frame_text(&mut panel);
        let joined = rows.join("\n");
        assert!(
            !joined.contains("\u{1b}]8;;https://evil.example"),
            "the escape never renders: {joined:?}"
        );
        assert!(
            !joined.contains("\u{1b}[2J"),
            "the clear never renders: {joined:?}"
        );
        assert!(!joined.contains("\u{1b}]8;;"));

        let (mut panel, mut _answer) = mount_teams(
            vec![PrimeTeamOption {
                team_id: "t".to_string(),
                name: "A\u{1b}[2J Corp".to_string(),
                slug: Some("s\u{7}".to_string()),
                role: Some("Owner\u{1b}".to_string()),
                created_at: None,
            }],
            None,
        );
        let rows = frame_text(&mut panel);
        let joined = rows.join("\n");
        assert!(!joined.contains("\u{1b}"), "no escapes render: {joined:?}");
        assert!(joined.contains("A"), "the scrubbed name still renders");
    }

    /// The OSC 8 link carries the URL as its own display text (an empty
    /// link region would paint an empty row on hyperlink terminals).
    #[test]
    fn the_auth_url_link_carries_the_url_as_display_text() {
        let mut panel = AuthPanel::new("Login to Linear");
        panel.show_auth_url("https://fixture.example/authorize".to_string(), None);
        let rows = frame_text(&mut panel);
        let linked = rows
            .iter()
            .find(|row| row.contains("https://fixture.example/authorize"))
            .expect("the URL row");
        // The plain URL renders (hyperlinks off in the test env renders it
        // unlinked; the hyperlink path wraps the same text inside the
        // sequence pair).
        assert!(linked.contains("https://fixture.example/authorize"));
    }
}
