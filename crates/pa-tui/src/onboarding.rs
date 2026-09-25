//! First-run onboarding surface (TS `PrimeOnboardingSplashComponent` +
//! `OnboardingChoiceComponent`): the compact brand mark over its animated
//! lab field, the welcome line, and the flow panels the full first-run
//! flow mounts inside the block (the login dialog, the connect-more
//! providers picker, the trace question). [`OnboardingChoice`] is the
//! reusable question panel (options with optional detail subtitles, a
//! row-width override, a seeded cursor); the splash mounts one for the
//! trace question and owns the pane until the flow completes; the
//! answers and the completion flag persist through
//! [`crate::interactive::OnboardingSink`].
//!
//! The two first-run shapes both live here: a home whose startup model
//! is ready skips to the question (the splash mounts it immediately, TS
//! `immediate: true`), while a home with no usable model runs the full
//! flow (TS `runOnboardingFlow`'s not-ready branch) — the welcome
//! screen's description and login action, then the flow panels in
//! [`crate::onboarding_flow`], one at a time.

use crate::keybindings::KeybindingsManager;
use crate::keys::KeyId;
use crate::onboarding_choice::{OnboardingChoice, OnboardingChoiceOption, OnboardingChoiceOptions};
use crate::onboarding_flow::{welcome_action_row, welcome_rows, OnboardingPanel};
use crate::theme::{Theme, ThemeColor};
use crate::{Line, Span};
use ratatui::style::{Color, Modifier, Style};

/// The trace-sharing question (TS `askOnboardingTraceOptIn`).
pub const TRACE_OPT_IN_PROMPT: &str = "Share agent traces with Prime Intellect?";
const TRACE_OPT_IN_DESCRIPTION: &str = "Trace sharing helps us train better open-source models and improve the open agent ecosystem for everyone.";
const TRACE_OPT_IN_NOTE: &str = "You can change this anytime with /traces.";
/// Choice rows: `Share` opts in (index 0), `Not now` keeps traces off.
const CHOICES: [&str; 2] = ["Share", "Not now"];

/// The trace question's options (TS `askOnboardingTraceOptIn` mounts
/// `[{ label: "Share" }, { label: "Not now" }]`).
pub(crate) fn trace_question_options() -> Vec<OnboardingChoiceOption> {
    CHOICES
        .iter()
        .map(|label| OnboardingChoiceOption {
            label: (*label).to_string(),
            detail: None,
        })
        .collect()
}

/// The trace question's copy (TS `askOnboardingTraceOptIn`'s config).
pub(crate) fn trace_question_config() -> OnboardingChoiceOptions {
    OnboardingChoiceOptions {
        prompt: Some(TRACE_OPT_IN_PROMPT.to_string()),
        description: Some(TRACE_OPT_IN_DESCRIPTION.to_string()),
        note: Some(TRACE_OPT_IN_NOTE.to_string()),
        row_width: None,
    }
}

/// TS `PRIME_COMPACT_BUTTERFLY_LOGO` (7 rows, 22 visible columns).
const LOGO_LINES: [&str; 7] = [
    "                 ▗▄▄█▀",
    "   ███▄       ▗▄███▀",
    "  ▗█▛▐█▙   ▗▄█▀▗█▀",
    " ▗█▛ ▟██▙▄██▛ ▟▛",
    " ▗▟▌ ▐███▛▘▗▄█▖",
    "▟███▄  ▄▄▟███▀",
    "▜█▛▀▘  ▜█▛▀▘",
];
const LOGO_WIDTH: usize = 22;
/// The mark sits a little further right than the text column (TS
/// `LOGO_INDENT`).
const LOGO_INDENT: usize = 5;
/// How far a selected row lifts off the canvas (TS `HIGHLIGHT_LIFT`).
const HIGHLIGHT_LIFT: f64 = 0.08;

/// One splash cell: a character, its tone, and the overwrite priority.
#[derive(Clone)]
struct SplashCell {
    character: char,
    tone: ThemeColor,
    priority: u8,
}

fn cell(character: char, tone: ThemeColor, priority: u8) -> SplashCell {
    SplashCell {
        character,
        tone,
        priority,
    }
}

/// The outcome of one onboarding key press.
pub enum OnboardingDecision {
    /// Enter on a choice row: the index of the selected option.
    Selected(usize),
    /// Cancel: the flow completed without an answer.
    Cancelled,
    /// Exit keys while onboarding owns the pane: quit the app.
    Exit,
    /// Enter on the welcome screen's login action (TS the splash's
    /// `onSelect`): the full flow starts.
    Begin,
    /// The connect-more-providers picker's answer (TS `onSelect` /
    /// `onContinue` / `onCancel`).
    Pick(crate::onboarding_flow::ProviderPick),
}

/// The onboarding pane state: the animation frame, the started flag (TS
/// `flowStarted` — the welcome text and action never return once a flow
/// owns the block), and the mounted flow panel.
#[derive(Debug)]
pub struct OnboardingScreen {
    frame: u64,
    flow_started: bool,
    /// The mounted flow panel (TS `setPanel`'s top: the flow never nests
    /// its panels, so one slot covers the sequence).
    panel: Option<OnboardingPanel>,
}

impl Default for OnboardingScreen {
    fn default() -> Self {
        Self {
            frame: 0,
            flow_started: true,
            panel: Some(OnboardingPanel::Question(OnboardingChoice::new(
                trace_question_options(),
                None,
                trace_question_config(),
            ))),
        }
    }
}

impl OnboardingScreen {
    /// The model-ready branch's splash (TS `immediate: true`): the trace
    /// question mounts directly under the brand mark.
    pub fn new() -> Self {
        Self::default()
    }

    /// The full flow's splash (TS the plain `showOnboardingSplash`): the
    /// welcome text and the single login action, until Enter starts the
    /// flow.
    pub fn welcome() -> Self {
        Self {
            frame: 0,
            flow_started: false,
            panel: None,
        }
    }

    /// TS `setPanel`: mount one flow panel — the flow has started from
    /// here on, and the welcome text never comes back.
    pub fn mount_panel(&mut self, panel: OnboardingPanel) {
        self.flow_started = true;
        self.panel = Some(panel);
    }

    /// One animation step (TS `ANIMATION_INTERVAL_MS` tick).
    pub fn tick(&mut self) {
        self.frame = self.frame.wrapping_add(1);
    }

    /// Handle one key id (TS splash + mounted panel `handleInput`). `None`
    /// keeps the pane waiting.
    pub fn handle_key(
        &mut self,
        key: &KeyId,
        kb: &KeybindingsManager,
    ) -> Option<OnboardingDecision> {
        // Onboarding owns the pane before the editor exists, so its panels
        // answer the exit keys themselves (TS `isOnboardingExitKey`).
        if kb.matches(key, "app.clear") || kb.matches(key, "app.exit") {
            return Some(OnboardingDecision::Exit);
        }
        if let Some(panel) = self.panel.as_mut() {
            return panel.handle_key(key, kb);
        }
        // The welcome screen binds one key: Enter starts the flow (TS:
        // cancel is deliberately unbound — signing in is the only way
        // forward).
        if !self.flow_started && kb.matches(key, "tui.select.confirm") {
            return Some(OnboardingDecision::Begin);
        }
        None
    }

    /// One paste payload (TS the mounted input's paste): the login dialog's
    /// field or the picker's search.
    pub fn handle_paste(&mut self, text: &str) {
        if let Some(panel) = self.panel.as_mut() {
            panel.handle_paste(text);
        }
    }

    /// Fold one auth-panel request into the mounted login dialog (the
    /// onboarding phase's channel arm — the same folding the run loop's
    /// `apply_auth_panel_request` does for the session view): the render
    /// requests mount into the panel, and a request with no mounted
    /// dialog cancels its flow (the dropped oneshot reply, the same
    /// contract a closed terminal input had). The settled requests never
    /// arrive here: the onboarding flows settle through their own spawned
    /// futures, so past-the-dialog requests are a no-op.
    pub fn apply_auth_request(&mut self, request: crate::auth_panel::AuthPanelRequest) {
        use crate::auth_panel::AuthPanelRequest;
        let Some(OnboardingPanel::Auth { panel, .. }) = self.panel.as_mut() else {
            return;
        };
        match request {
            AuthPanelRequest::Progress { message } => panel.push_progress(message),
            AuthPanelRequest::AuthUrl { url, instructions } => {
                panel.show_auth_url(url, instructions);
            }
            AuthPanelRequest::PastePrompt {
                prompt,
                style,
                reply,
            } => panel.mount_paste(prompt, style, reply),
            AuthPanelRequest::SelectTeam {
                teams,
                current,
                reply,
            } => panel.mount_teams(teams, current, reply),
            AuthPanelRequest::ProviderSettled { .. }
            | AuthPanelRequest::McpSettled { .. }
            | AuthPanelRequest::TracesSettled { .. } => {}
        }
    }

    /// The full pane frame (TS `PrimeOnboardingSplashComponent.render`).
    pub fn render(&mut self, theme: &Theme, width: usize, height: usize) -> Vec<Line> {
        let width = width.max(1);
        let mut lines: Vec<Line> = vec![Vec::new()];
        lines.extend(self.mark_rows(theme, width));
        lines.push(Vec::new());
        lines.push(self.heading_line(theme));
        // The welcome text and action render only before the flow starts;
        // once a panel owns the block, its rows mount directly under the
        // heading (TS: the panel brings its own leading padding, and it
        // indents its own content by one column — panelLeft =
        // contentLeft - 1; contentLeft = PADDING_X = 1).
        match self.panel.as_mut() {
            None if !self.flow_started => {
                lines.extend(welcome_rows(theme, width));
                lines.push(welcome_action_row(theme, width));
            }
            // A started flow with no mounted panel keeps one blank row in
            // the gap (TS `if (!this.getActivePanel())`).
            None => lines.push(Vec::new()),
            Some(panel) => lines.extend(panel.render(theme, width)),
        }
        while lines.len() < height {
            lines.push(Vec::new());
        }
        lines.truncate(height);
        lines
    }

    /// The block's heading (TS `renderHeadingLine`): the mounted panel
    /// that names itself replaces the brand line.
    fn heading_line(&self, theme: &Theme) -> Line {
        let heading = self.panel.as_ref().and_then(|panel| panel.heading());
        if let Some(heading) = heading {
            let mut row: Line = vec![Span::styled(" ".to_string(), Style::default())];
            row.push(Span::styled(
                heading.to_string(),
                theme
                    .fg_style(ThemeColor::Text)
                    .add_modifier(Modifier::BOLD),
            ));
            return row;
        }
        self.brand_line(theme)
    }

    /// "Welcome to **PRIME** *Agent*" (TS `renderBrandLine`), one column in
    /// from the pane edge.
    fn brand_line(&self, theme: &Theme) -> Line {
        let text = theme.fg_style(ThemeColor::Text);
        let mut row: Line = vec![Span::styled(" ".to_string(), Style::default())];
        row.push(Span::styled("Welcome to ".to_string(), text));
        row.push(Span::styled(
            "PRIME".to_string(),
            text.add_modifier(Modifier::BOLD),
        ));
        row.push(Span::styled(
            " Agent".to_string(),
            text.add_modifier(Modifier::ITALIC),
        ));
        row
    }

    /// The brand mark over its animated field (TS `renderMarkRows`).
    fn mark_rows(&self, theme: &Theme, width: usize) -> Vec<Line> {
        let rows = LOGO_LINES.len();
        let mut canvas = vec![vec![cell(' ', ThemeColor::Dim, 0); width]; rows];
        // The mark keeps a quiet zone on the field: ambient dots and
        // contours still drift across the full width, scan columns only
        // trail to the right of the zone.
        let quiet = (LOGO_INDENT, LOGO_INDENT + LOGO_WIDTH - 1, 0, rows - 1);
        self.draw_field(&mut canvas, width, rows, quiet);
        for (y, line) in LOGO_LINES.iter().enumerate() {
            for (x, character) in line.chars().enumerate() {
                if character != ' ' {
                    put(
                        &mut canvas,
                        LOGO_INDENT + x,
                        y,
                        character,
                        ThemeColor::Text,
                        8,
                    );
                }
            }
        }
        canvas
            .into_iter()
            .map(|row| render_cells(theme, row))
            .collect()
    }

    /// The lab field of the old full-screen splash, scaled to the mark's
    /// band (TS `drawField`): drifting ambient dots, a contour wave, a
    /// horizon of dashes, scan columns, and three particle traces.
    fn draw_field(
        &self,
        canvas: &mut [Vec<SplashCell>],
        width: usize,
        height: usize,
        quiet: (usize, usize, usize, usize),
    ) {
        let frame = self.frame;
        for y in 0..height {
            for x in 0..width {
                let hash = (x * 37 + y * 53 + (frame as usize) * 11 + x * y * 3) % 101;
                if hash < 3 {
                    put(canvas, x, y, '·', ThemeColor::Dim, 1);
                }
                let center_x = width * 36 / 100;
                let center_y = height * 54 / 100;
                let contour = (x as i64 - center_x as i64).abs()
                    + (y as i64 - center_y as i64).abs() * 4
                    + (x / 6) as i64
                    - frame as i64;
                if x < width * 82 / 100 && contour.rem_euclid(24) == 12 {
                    let character = if (x + y) % 5 == 0 { '╌' } else { '·' };
                    put(canvas, x, y, character, ThemeColor::BorderMuted, 2);
                }
                let horizon_y = height * 58 / 100;
                if y == horizon_y && x % 2 == 0 && (x + frame as usize) % 13 < 2 {
                    let tone = if (x + frame as usize).is_multiple_of(3) {
                        ThemeColor::Accent
                    } else {
                        ThemeColor::Dim
                    };
                    put(canvas, x, y, '─', tone, 3);
                }
                // Scan columns trail the mark to the right.
                if x >= quiet.0 && !inside_quiet(x, y, quiet) && x % 4 == 0 {
                    let scan_index = x / 4;
                    let segment = (y + scan_index * 2 + (frame as usize / 2)) % 6;
                    if y > 0 && y < height - 1 && segment < 2 {
                        let character = if (scan_index + y) % 4 == 0 {
                            '┃'
                        } else {
                            '▎'
                        };
                        put(canvas, x, y, character, ThemeColor::MdLink, 4);
                    }
                }
            }
        }
        // Three particle traces ride the field (TS trace loop).
        for trace_index in 0..3usize {
            let base = match trace_index {
                0 => height * 30 / 100,
                1 => height * 49 / 100,
                _ => height * 72 / 100,
            };
            for x in 0..width {
                let mut wave = (x * 2 + frame as usize + trace_index * 7) % 16;
                if wave > 7 {
                    wave = 15 - wave;
                }
                // TS `Math.trunc((wave - 3) / 2)`: negative waves pull the
                // trace one row up, so keep the signed division.
                let trace_y = (base as i64 + (wave as i64 - 3) / 2).max(0) as usize;
                if (x + frame as usize + trace_index * 13).is_multiple_of(41) {
                    put(canvas, x, trace_y, '◆', ThemeColor::Warning, 6);
                } else if (x + frame as usize).is_multiple_of(12) {
                    put(canvas, x, trace_y, '•', ThemeColor::Accent, 6);
                } else {
                    put(canvas, x, trace_y, '·', ThemeColor::Accent, 3);
                }
            }
        }
    }
}

/// Overwrite one cell when the new priority is at least the current one
/// (TS `put`).
fn put(
    canvas: &mut [Vec<SplashCell>],
    x: usize,
    y: usize,
    character: char,
    tone: ThemeColor,
    priority: u8,
) {
    if y >= canvas.len() || x >= canvas[y].len() {
        return;
    }
    if canvas[y][x].priority > priority {
        return;
    }
    canvas[y][x] = cell(character, tone, priority);
}

fn inside_quiet(x: usize, y: usize, zone: (usize, usize, usize, usize)) -> bool {
    x >= zone.0 && x <= zone.1 && y >= zone.2 && y <= zone.3
}

/// One canvas row as same-tone runs (TS `renderCells`).
fn render_cells(theme: &Theme, cells: Vec<SplashCell>) -> Line {
    let mut row: Line = Vec::new();
    let mut current: Option<ThemeColor> = None;
    let mut segment = String::new();
    for cell in cells {
        if current != Some(cell.tone) {
            if let Some(tone) = current.replace(cell.tone) {
                if !segment.is_empty() {
                    row.push(Span::styled(
                        std::mem::take(&mut segment),
                        theme.fg_style(tone),
                    ));
                }
            }
        }
        segment.push(cell.character);
    }
    if !segment.is_empty() {
        let tone = current.unwrap_or(ThemeColor::Dim);
        row.push(Span::styled(segment, theme.fg_style(tone)));
    }
    row
}

/// The selected-row wash (TS `onboardingHighlightBackground`): the canvas
/// lifted a few percent toward the text colour. The canvas is the theme
/// record's parseable `background` (TS `parseHexColor(colors.background)`),
/// else the hardcoded dark/light canvas by the text luma — "on dark" follows
/// TS `isLightColor` (luma > 128) with the terminal-default text counting
/// as light. The built-in themes carry no `background` key, so they keep
/// the hardcoded canvases.
pub(crate) fn highlight_wash(theme: &Theme) -> Color {
    let text = theme.fg_style(ThemeColor::Text).fg;
    // TS: `onDark = !text || isLightColor(text)` — undefined (empty theme
    // value) or a light colour both mean light text over a dark canvas.
    let on_dark = match text {
        Some(Color::Rgb(r, g, b)) => {
            0.299 * f64::from(r) + 0.587 * f64::from(g) + 0.114 * f64::from(b) > 128.0
        }
        None | Some(Color::Reset | _) => true,
    };
    let lift = if on_dark {
        (255u16, 255, 255)
    } else {
        (0u16, 0, 0)
    };
    // TS: `canvas = parseHexColor(colors.background) ?? (onDark ?
    // DARK_CANVAS : LIGHT_CANVAS)`.
    let canvas = theme.background_rgb().map_or(
        if on_dark {
            (16u16, 16, 16)
        } else {
            (255u16, 255, 255)
        },
        |(r, g, b)| (u16::from(r), u16::from(g), u16::from(b)),
    );
    let blend = |lift: u16, canvas: u16| -> u8 {
        let value = lift as f64 * HIGHLIGHT_LIFT + canvas as f64 * (1.0 - HIGHLIGHT_LIFT);
        value.round().clamp(0.0, 255.0) as u8
    };
    let washed = (
        blend(lift.0, canvas.0),
        blend(lift.1, canvas.1),
        blend(lift.2, canvas.2),
    );
    match theme.mode {
        crate::theme::ColorMode::Color256 => Color::Indexed(crate::theme::rgb_to_256(washed)),
        crate::theme::ColorMode::TrueColor => Color::Rgb(washed.0, washed.1, washed.2),
    }
}

/// Greedy word wrap at `width` columns.
pub(crate) fn wrap_words(text: &str, width: usize) -> Vec<String> {
    let mut rows = Vec::new();
    let mut row = String::new();
    for word in text.split(' ') {
        if row.is_empty() {
            row = word.to_string();
        } else if row.chars().count() + 1 + word.chars().count() <= width {
            row.push(' ');
            row.push_str(word);
        } else {
            rows.push(std::mem::take(&mut row));
            row = word.to_string();
        }
        while row.chars().count() > width {
            let cut: String = row.chars().take(width).collect();
            rows.push(cut);
            row = row.chars().skip(width).collect();
        }
    }
    if !row.is_empty() {
        rows.push(row);
    }
    if rows.is_empty() {
        rows.push(String::new());
    }
    rows
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::{ColorMode, Theme, ThemeJson};

    fn custom_theme(json: &str, mode: ColorMode) -> Theme {
        let json: ThemeJson = serde_json::from_str(json).expect("valid theme json");
        Theme::from_json(&json, mode)
    }

    /// The trace-question pane at 80x24, byte-identical to the pre-PR-C
    /// render: the golden was captured from the base commit's
    /// `OnboardingScreen::render` Debug output in the CI VM, so the
    /// parameterized choice panel must not move a single styled cell of
    /// the splash the way it renders today.
    #[test]
    fn trace_question_render_is_unchanged() {
        const GOLDEN: &str = r#"[[], [Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: "·   " }, Span { style: Style::new().fg(Color::Rgb(82, 82, 91)), content: "·" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: "                 " }, Span { style: Style::new().fg(Color::Reset), content: "▗▄▄█▀" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: "              ·   " }, Span { style: Style::new().fg(Color::Rgb(82, 82, 91)), content: "╌" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: "                         ·        " }], [Span { style: Style::new().fg(Color::Rgb(245, 158, 11)), content: "◆" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: "      " }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "·" }, Span { style: Style::new().fg(Color::Reset), content: "███▄" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: "   " }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "··" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: "  " }, Span { style: Style::new().fg(Color::Reset), content: "▗▄███▀" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: "   " }, Span { style: Style::new().fg(Color::Rgb(82, 82, 91)), content: "·" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: "· " }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "··" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: "   " }, Span { style: Style::new().fg(Color::Rgb(56, 189, 248)), content: "▎" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: "  " }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "··" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: "      " }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "·•" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: "      " }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "··" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: "   " }, Span { style: Style::new().fg(Color::Rgb(56, 189, 248)), content: "┃" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: "  " }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "··" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: "      " }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "·•" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: "    · " }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "·" }], [Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: " " }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "··" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: " " }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "···" }, Span { style: Style::new().fg(Color::Reset), content: "▗█▛▐█▙" }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "··" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: " " }, Span { style: Style::new().fg(Color::Reset), content: "▗▄█▀▗█▀" }, Span { style: Style::new().fg(Color::Rgb(82, 82, 91)), content: "╌·" }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "··" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: " " }, Span { style: Style::new().fg(Color::Rgb(245, 158, 11)), content: "◆" }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "··" }, Span { style: Style::new().fg(Color::Rgb(82, 82, 91)), content: "·" }, Span { style: Style::new().fg(Color::Rgb(56, 189, 248)), content: "▎" }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "··" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: " " }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "•··" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: "  " }, Span { style: Style::new().fg(Color::Rgb(245, 158, 11)), content: "◆" }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "·" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: " " }, Span { style: Style::new().fg(Color::Rgb(56, 189, 248)), content: "▎" }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "··" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: "  " }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "··" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: " " }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "···" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: " " }, Span { style: Style::new().fg(Color::Rgb(56, 189, 248)), content: "┃" }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "··" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: " " }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "•··" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: "  " }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "··" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: " " }, Span { style: Style::new().fg(Color::Rgb(56, 189, 248)), content: "▎" }, Span { style: Style::new().fg(Color::Rgb(245, 158, 11)), content: "◆" }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "·" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: "  " }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "··" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: " " }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "···" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: " " }], [Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: "  " }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "··" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: " " }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "·" }, Span { style: Style::new().fg(Color::Reset), content: "▗█▛" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: " " }, Span { style: Style::new().fg(Color::Reset), content: "▟██▙▄██▛" }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "·" }, Span { style: Style::new().fg(Color::Reset), content: "▟▛" }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "··" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: "   " }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "··" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: " " }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "··" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: " " }, Span { style: Style::new().fg(Color::Rgb(56, 189, 248)), content: "▎" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: " " }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "··" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: " " }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "··" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: "   " }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "··" }, Span { style: Style::new().fg(Color::Rgb(56, 189, 248)), content: "▎" }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "··" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: "   " }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "··" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: " " }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "··" }, Span { style: Style::new().fg(Color::Rgb(82, 82, 91)), content: "·" }, Span { style: Style::new().fg(Color::Rgb(56, 189, 248)), content: "▎" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: " " }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "··" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: " " }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "··" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: "   " }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "··" }, Span { style: Style::new().fg(Color::Rgb(56, 189, 248)), content: "┃" }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "··" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: "   " }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "··" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: " " }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "··" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: " " }], [Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "•·" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: "  " }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "·" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: " " }, Span { style: Style::new().fg(Color::Reset), content: "▗▟▌" }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "·" }, Span { style: Style::new().fg(Color::Reset), content: "▐███▛▘▗▄█▖" }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "·" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: "  " }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "·•·" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: "─ " }, Span { style: Style::new().fg(Color::Rgb(56, 189, 248)), content: "▎" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: "  " }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "···" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: "  " }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "•" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: "  " }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "·" }, Span { style: Style::new().fg(Color::Rgb(56, 189, 248)), content: "▎" }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "·" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: "  " }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "·" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: "  " }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "·•·" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: "  " }, Span { style: Style::new().fg(Color::Rgb(56, 189, 248)), content: "▎" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: "  " }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "·" }, Span { style: Style::new().fg(Color::Rgb(245, 158, 11)), content: "◆" }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "·" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: "  " }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "•" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: "  " }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "·" }, Span { style: Style::new().fg(Color::Rgb(56, 189, 248)), content: "┃" }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "·─" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: " " }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "·" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: "  " }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "·•·" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: "· " }, Span { style: Style::new().fg(Color::Rgb(56, 189, 248)), content: "▎" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: " " }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "─·" }], [Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "•" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: " " }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "··" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: " " }, Span { style: Style::new().fg(Color::Reset), content: "▟███▄" }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "··" }, Span { style: Style::new().fg(Color::Reset), content: "▄▄▟███▀" }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "·" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: "   " }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "·•" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: " " }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "··" }, Span { style: Style::new().fg(Color::Rgb(56, 189, 248)), content: "┃" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: "  " }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "··" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: " " }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "··" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: "   " }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "·" }, Span { style: Style::new().fg(Color::Rgb(56, 189, 248)), content: "▎" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: " " }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "··" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: "   " }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "·•" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: " " }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "··" }, Span { style: Style::new().fg(Color::Rgb(56, 189, 248)), content: "▎" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: "  " }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "··" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: " " }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "··" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: "   " }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "·" }, Span { style: Style::new().fg(Color::Rgb(56, 189, 248)), content: "▎" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: " " }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "··" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: "   " }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "·•" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: " " }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "··" }, Span { style: Style::new().fg(Color::Rgb(56, 189, 248)), content: "┃" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: "  " }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "·" }], [Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: "    " }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "·" }, Span { style: Style::new().fg(Color::Reset), content: "▜█▛▀▘" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: "  " }, Span { style: Style::new().fg(Color::Reset), content: "▜█▛▀▘" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: "   " }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "·" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: " " }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "·" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: "     " }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "·" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: " " }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "·" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: "     " }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "•" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: " " }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "·" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: "   · " }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "·" }, Span { style: Style::new().fg(Color::Rgb(82, 82, 91)), content: "·" }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "·" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: "     " }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "·" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: "·" }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "·" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: "     " }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "•" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: " " }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "·" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: " ·   " }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "·" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: " " }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "·" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: "     " }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "·" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: " " }, Span { style: Style::new().fg(Color::Rgb(124, 111, 175)), content: "·" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: " " }], [], [Span { style: Style::new(), content: " " }, Span { style: Style::new().fg(Color::Reset), content: "Welcome to " }, Span { style: Style::new().fg(Color::Reset).bold(), content: "PRIME" }, Span { style: Style::new().fg(Color::Reset).italic(), content: " Agent" }], [], [Span { style: Style::new().fg(Color::Reset), content: " Share agent traces with Prime Intellect?" }], [], [Span { style: Style::new().fg(Color::Rgb(161, 161, 170)), content: " Trace sharing helps us train better open-source" }], [Span { style: Style::new().fg(Color::Rgb(161, 161, 170)), content: " models and improve the open agent ecosystem for" }], [Span { style: Style::new().fg(Color::Rgb(161, 161, 170)), content: " everyone." }], [], [Span { style: Style::new(), content: " " }, Span { style: Style::new().fg(Color::Reset).bg(Color::Rgb(35, 35, 35)).bold(), content: "> Share" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)).bg(Color::Rgb(35, 35, 35)), content: "                       " }], [Span { style: Style::new(), content: " " }, Span { style: Style::new().fg(Color::Rgb(161, 161, 170)), content: "  Not now" }, Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: "                     " }], [], [Span { style: Style::new().fg(Color::Rgb(113, 113, 122)), content: " You can change this anytime with /traces." }], [], [], []]"#;
        let theme = Theme::builtin("prime", ColorMode::TrueColor);
        let lines = OnboardingScreen::new().render(&theme, 80, 24);
        assert_eq!(format!("{lines:?}"), GOLDEN);
    }

    #[test]
    fn wash_blends_against_the_theme_background() {
        let theme = custom_theme(
            r##"{ "name": "custom", "colors": { "text": "#f4f4f5", "background": "#050506" } }"##,
            ColorMode::TrueColor,
        );
        // Light text lifts white over the canvas (TS `HIGHLIGHT_LIFT` 0.08):
        // blend(255, 5) = 25, blend(255, 6) = 26.
        assert_eq!(highlight_wash(&theme), Color::Rgb(25, 25, 26));
        let theme = custom_theme(
            r##"{ "name": "custom", "colors": { "text": "#f4f4f5", "background": "#050506" } }"##,
            ColorMode::Color256,
        );
        // The 256-color mode quantizes the washed colour, not the canvas.
        assert_eq!(
            highlight_wash(&theme),
            Color::Indexed(crate::theme::rgb_to_256((25, 25, 26)))
        );

        let theme = custom_theme(
            r##"{ "name": "custom", "colors": { "text": "#000000", "background": "#f0f0f0" } }"##,
            ColorMode::TrueColor,
        );
        // Dark text lifts black over the light canvas: blend(0, 240) = 221.
        assert_eq!(highlight_wash(&theme), Color::Rgb(221, 221, 221));
    }

    #[test]
    fn wash_falls_back_to_the_hardcoded_canvas() {
        // The built-in themes carry no background key: dark canvas (16,16,16)
        // lifted toward white — blend(255, 16) = 35.
        let theme = Theme::builtin("prime", ColorMode::TrueColor);
        assert_eq!(highlight_wash(&theme), Color::Rgb(35, 35, 35));
        let theme = Theme::builtin("prime", ColorMode::Color256);
        assert_eq!(
            highlight_wash(&theme),
            Color::Indexed(crate::theme::rgb_to_256((35, 35, 35)))
        );
        // A 3-hex background is not the TS `parseHexColor` shape: fallback.
        let theme = custom_theme(
            r##"{ "name": "custom", "colors": { "text": "#f4f4f5", "background": "#abc" } }"##,
            ColorMode::TrueColor,
        );
        assert_eq!(highlight_wash(&theme), Color::Rgb(35, 35, 35));
        // Dark text without a background washes over the light canvas:
        // blend(0, 255) = 235.
        let theme = custom_theme(
            r##"{ "name": "custom", "colors": { "text": "#000000" } }"##,
            ColorMode::TrueColor,
        );
        assert_eq!(highlight_wash(&theme), Color::Rgb(235, 235, 235));
    }
}
