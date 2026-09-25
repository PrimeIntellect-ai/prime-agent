//! First-run onboarding surface (TS `PrimeOnboardingSplashComponent` +
//! `OnboardingChoiceComponent`): the compact brand mark over its animated
//! lab field, the welcome line, and the trace-sharing question in the same
//! selection language as the pickers. [`OnboardingChoice`] is the reusable
//! question panel (options with optional detail subtitles, a row-width
//! override, a seeded cursor); the splash mounts one for the trace question
//! and owns the pane until it is answered; the answer and the completion
//! flag persist through [`crate::interactive::OnboardingSink`].
//!
//! Fresh installs never mount this pane: trace sharing is on by default
//! (the `run_onboarding_phase` skip in `crate::interactive`), so the
//! splash appears only for a home that explicitly opted out before
//! completing onboarding.

use crate::keybindings::KeybindingsManager;
use crate::keys::KeyId;
use crate::theme::{Theme, ThemeColor};
use crate::width::str_width;
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
fn trace_question_options() -> Vec<OnboardingChoiceOption> {
    CHOICES
        .iter()
        .map(|label| OnboardingChoiceOption {
            label: (*label).to_string(),
            detail: None,
        })
        .collect()
}

/// The trace question's copy (TS `askOnboardingTraceOptIn`'s config).
fn trace_question_config() -> OnboardingChoiceOptions {
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
/// Selection-row metrics (TS `OnboardingChoiceComponent`).
const MARKER_WIDTH: usize = 2;
const MIN_ROW_WIDTH: usize = 30;
const ROW_TRAILING: usize = 6;
const DESCRIPTION_WIDTH: usize = 50;
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
}

/// The onboarding pane state: the animation frame and the mounted question.
#[derive(Debug, Clone)]
pub struct OnboardingScreen {
    frame: u64,
    /// The trace-sharing question the splash hosts (TS mounts one
    /// `OnboardingChoiceComponent` inside the splash).
    trace_question: OnboardingChoice,
}

impl Default for OnboardingScreen {
    fn default() -> Self {
        Self {
            frame: 0,
            trace_question: OnboardingChoice::new(
                trace_question_options(),
                None,
                trace_question_config(),
            ),
        }
    }
}

impl OnboardingScreen {
    pub fn new() -> Self {
        Self::default()
    }

    /// One animation step (TS `ANIMATION_INTERVAL_MS` tick).
    pub fn tick(&mut self) {
        self.frame = self.frame.wrapping_add(1);
    }

    /// Handle one key id (TS splash/choice `handleInput`). `None` keeps the
    /// pane waiting.
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
        if kb.matches(key, "tui.select.cancel") {
            return Some(OnboardingDecision::Cancelled);
        }
        if kb.matches(key, "tui.select.up") {
            self.trace_question.move_selection(-1);
            return None;
        }
        if kb.matches(key, "tui.select.down") {
            self.trace_question.move_selection(1);
            return None;
        }
        if kb.matches(key, "tui.select.confirm") {
            return Some(OnboardingDecision::Selected(self.trace_question.selected()));
        }
        None
    }

    /// The full pane frame (TS `PrimeOnboardingSplashComponent.render` in
    /// immediate mode with the question panel mounted).
    pub fn render(&self, theme: &Theme, width: usize, height: usize) -> Vec<Line> {
        let width = width.max(1);
        let mut lines: Vec<Line> = vec![Vec::new()];
        lines.extend(self.mark_rows(theme, width));
        lines.push(Vec::new());
        lines.push(self.heading_line(theme));
        // The question panel indents its own content by one column (TS:
        // panelLeft = contentLeft - 1; contentLeft = PADDING_X = 1).
        lines.extend(self.trace_question.render(theme, width));
        while lines.len() < height {
            lines.push(Vec::new());
        }
        lines.truncate(height);
        lines
    }

    /// "Welcome to **PRIME** *Agent*" (TS `renderBrandLine`), one column in
    /// from the pane edge.
    fn heading_line(&self, theme: &Theme) -> Line {
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

/// One choice row (TS `OnboardingChoiceOption`): a label with an optional
/// identifier shown as its dim subtitle.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OnboardingChoiceOption {
    /// The row label.
    pub label: String,
    /// Identifier rendered as `  @detail` after the label — dimmer than the
    /// label, and counted toward the label-width calc (TS `detail`).
    pub detail: Option<String>,
}

/// The choice panel's copy and layout (TS `OnboardingChoiceOptions`): the
/// question text around the rows and the row-width override.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OnboardingChoiceOptions {
    /// The question line above the options (TS `prompt`).
    pub prompt: Option<String>,
    /// Muted sentence under the prompt, before the options (TS
    /// `description`), wrapped at 50 columns.
    pub description: Option<String>,
    /// Grey footnote under the list, e.g. how to change the answer later
    /// (TS `note`).
    pub note: Option<String>,
    /// Row-width override (TS `rowWidth`); absent sizes the rows from the
    /// labels, always clamped to the panel width.
    pub row_width: Option<usize>,
}

/// A question in the onboarding block (TS `OnboardingChoiceComponent`): the
/// prompt, a list of options in the same selection language as the
/// first-run actions, and an optional grey footnote. The host mounts one
/// per question and drives the cursor with the selection keys.
#[derive(Debug, Clone)]
pub struct OnboardingChoice {
    options: Vec<OnboardingChoiceOption>,
    selected: usize,
    config: OnboardingChoiceOptions,
}

impl OnboardingChoice {
    /// TS constructor: the cursor seeds at `selected_index` (TS
    /// `selectedIndex`), clamped into the option list.
    pub fn new(
        options: Vec<OnboardingChoiceOption>,
        selected_seed: Option<usize>,
        config: OnboardingChoiceOptions,
    ) -> Self {
        let last = options.len().saturating_sub(1);
        Self {
            selected: selected_seed.unwrap_or(0).min(last),
            options,
            config,
        }
    }

    /// The row the cursor sits on.
    pub fn selected(&self) -> usize {
        self.selected
    }

    /// Move the cursor `delta` rows (TS `move`): no wrap; `false` when the
    /// move would leave the list, so the caller skips the re-render.
    pub fn move_selection(&mut self, delta: isize) -> bool {
        // The checked sum keeps a huge delta an out-of-range move (TS
        // `next < 0 || next >= options.length`) instead of an overflow.
        let Some(next) = self.selected.checked_add_signed(delta) else {
            return false;
        };
        if next >= self.options.len() {
            return false;
        }
        self.selected = next;
        true
    }

    /// The panel block (TS `OnboardingChoiceComponent.render`): the prompt,
    /// the wrapped description, the option rows (the selected one washed),
    /// and the change-anytime note, each indented one column.
    pub fn render(&self, theme: &Theme, width: usize) -> Vec<Line> {
        let safe_width = width.max(1);
        let mut lines: Vec<Line> = vec![Vec::new()];
        if let Some(prompt) = &self.config.prompt {
            lines.push(vec![Span::styled(
                format!(" {prompt}"),
                theme.fg_style(ThemeColor::Text),
            )]);
            lines.push(Vec::new());
        }
        if let Some(description) = &self.config.description {
            let wrap = DESCRIPTION_WIDTH.min(safe_width.saturating_sub(2)).max(1);
            for row in wrap_words(description, wrap) {
                lines.push(vec![Span::styled(
                    format!(" {row}"),
                    theme.fg_style(ThemeColor::Muted),
                )]);
            }
            lines.push(Vec::new());
        }
        lines.extend(self.option_rows(theme, safe_width));
        if let Some(note) = &self.config.note {
            lines.push(Vec::new());
            lines.push(vec![Span::styled(
                format!(" {note}"),
                theme.fg_style(ThemeColor::Dim),
            )]);
        }
        lines
    }

    /// The option rows (TS `render`'s row loop): marker + label + the dim
    /// `  @detail` subtitle, padded to the row width so the wash forms a
    /// band; the selected row lifts off the canvas with a bold label.
    fn option_rows(&self, theme: &Theme, safe_width: usize) -> Vec<Line> {
        let label_width = self
            .options
            .iter()
            .map(|option| match &option.detail {
                // TS joins label and detail with two spaces for the width
                // calc; the rendered subtitle adds the `@` on top.
                Some(detail) => str_width(&option.label) + 2 + str_width(detail),
                None => str_width(&option.label),
            })
            .max()
            .unwrap_or(0);
        // TS clamps the row to the panel width: a narrow pane shortens the
        // highlight instead of running past the edge.
        let row_width = self
            .config
            .row_width
            .unwrap_or((MARKER_WIDTH + label_width + ROW_TRAILING).max(MIN_ROW_WIDTH))
            .min(safe_width)
            .max(1);
        let wash = highlight_wash(theme);
        let mut rows: Vec<Line> = Vec::with_capacity(self.options.len());
        for (index, option) in self.options.iter().enumerate() {
            let selected = index == self.selected;
            let name = format!("{}{}", if selected { "> " } else { "  " }, option.label);
            let detail = match &option.detail {
                Some(detail) => format!("  @{detail}"),
                None => String::new(),
            };
            let pad = " ".repeat(row_width.saturating_sub(str_width(&name) + str_width(&detail)));
            let mut row: Line = vec![Span::styled(" ".to_string(), Style::default())];
            if selected {
                // The selected row lifts off the canvas (TS
                // `onboardingHighlightBackground`): a bold name over the
                // washed background, the dim detail and padding inside
                // the wash.
                let mut washed_name = Span::styled(
                    name,
                    theme
                        .fg_style(ThemeColor::Text)
                        .add_modifier(Modifier::BOLD),
                );
                washed_name.style = washed_name.style.bg(wash);
                row.push(washed_name);
                let mut washed_tail =
                    Span::styled(format!("{detail}{pad}"), theme.fg_style(ThemeColor::Dim));
                washed_tail.style = washed_tail.style.bg(wash);
                row.push(washed_tail);
            } else {
                row.push(Span::styled(name, theme.fg_style(ThemeColor::Muted)));
                row.push(Span::styled(
                    format!("{detail}{pad}"),
                    theme.fg_style(ThemeColor::Dim),
                ));
            }
            rows.push(row);
        }
        rows
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
fn wrap_words(text: &str, width: usize) -> Vec<String> {
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

    fn option(label: &str, detail: Option<&str>) -> OnboardingChoiceOption {
        OnboardingChoiceOption {
            label: label.to_string(),
            detail: detail.map(str::to_string),
        }
    }

    fn choice_config(row_width: Option<usize>) -> OnboardingChoiceOptions {
        OnboardingChoiceOptions {
            prompt: Some("Pick one".to_string()),
            description: None,
            note: None,
            row_width,
        }
    }

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

    #[test]
    fn detail_renders_as_a_dim_subtitle_and_counts_toward_the_row_width() {
        let theme = Theme::builtin("prime", ColorMode::TrueColor);
        let wash = highlight_wash(&theme);
        let choice = OnboardingChoice::new(
            vec![
                option("Personal account", None),
                option("Prime", Some("prime-intellect")),
            ],
            Some(1),
            choice_config(None),
        );
        let lines = choice.render(&theme, 80);
        // blank, prompt, blank, then the two option rows.
        assert_eq!(lines.len(), 5);
        let unselected = &lines[3];
        // Label width = max("Personal account" = 16, "Prime  prime-intellect"
        // = 19) → row width max(30, 2 + 19 + 6) = 30.
        assert_eq!(
            unselected[1],
            Span::styled("  Personal account", theme.fg_style(ThemeColor::Muted))
        );
        assert_eq!(
            unselected[2],
            Span::styled(
                " ".repeat(30 - "  Personal account".len()),
                theme.fg_style(ThemeColor::Dim)
            )
        );
        let selected = &lines[4];
        // The subtitle reads as a dimmer identifier after the name, and the
        // wash covers the detail and the padding inside the band.
        assert_eq!(
            selected[1],
            Span::styled(
                "> Prime",
                theme
                    .fg_style(ThemeColor::Text)
                    .add_modifier(Modifier::BOLD)
                    .bg(wash)
            )
        );
        assert_eq!(
            selected[2],
            Span::styled(
                format!("  @prime-intellect{}", " ".repeat(30 - 7 - 18)),
                theme.fg_style(ThemeColor::Dim).bg(wash)
            )
        );
    }

    #[test]
    fn row_width_overrides_and_clamps_to_the_pane() {
        let theme = Theme::builtin("prime", ColorMode::TrueColor);
        // An explicit override under the pane sizes the wash band exactly.
        let choice =
            OnboardingChoice::new(vec![option("Share", None)], None, choice_config(Some(20)));
        let lines = choice.render(&theme, 80);
        assert_eq!(lines[3][2].content, " ".repeat(20 - "  Share".len()));
        // An override past the pane clamps to the pane.
        let choice =
            OnboardingChoice::new(vec![option("Share", None)], None, choice_config(Some(100)));
        let lines = choice.render(&theme, 50);
        assert_eq!(lines[3][2].content, " ".repeat(50 - "  Share".len()));
        // Without an override the labels size the band, still clamped:
        // "Continue with the current setup" (31 columns) →
        // max(30, 2 + 31 + 6) = 39.
        let choice = OnboardingChoice::new(
            vec![option("Continue with the current setup", None)],
            None,
            choice_config(None),
        );
        let lines = choice.render(&theme, 80);
        assert_eq!(
            lines[3][2].content,
            " ".repeat(39 - "  Continue with the current setup".len())
        );
        let lines = choice.render(&theme, 35);
        assert_eq!(
            lines[3][2].content,
            " ".repeat(35 - "  Continue with the current setup".len())
        );
    }

    #[test]
    fn selected_seed_clamps_into_the_options() {
        let options = || vec![option("a", None), option("b", None), option("c", None)];
        assert_eq!(
            OnboardingChoice::new(options(), Some(2), OnboardingChoiceOptions::default())
                .selected(),
            2
        );
        assert_eq!(
            OnboardingChoice::new(options(), Some(99), OnboardingChoiceOptions::default())
                .selected(),
            2
        );
        assert_eq!(
            OnboardingChoice::new(options(), None, OnboardingChoiceOptions::default()).selected(),
            0
        );
        assert_eq!(
            OnboardingChoice::new(vec![], Some(3), OnboardingChoiceOptions::default()).selected(),
            0
        );
    }

    #[test]
    fn cursor_moves_without_wrapping() {
        let mut choice = OnboardingChoice::new(
            vec![option("a", None), option("b", None)],
            None,
            OnboardingChoiceOptions::default(),
        );
        assert!(choice.move_selection(1));
        assert!(!choice.move_selection(1));
        assert!(choice.move_selection(-1));
        assert!(!choice.move_selection(-1));
        // Extreme deltas stay out-of-range moves, never overflow panics.
        assert!(!choice.move_selection(isize::MAX));
        assert!(!choice.move_selection(isize::MIN));
    }
}
