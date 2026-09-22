//! First-run onboarding surface (TS `PrimeOnboardingSplashComponent` +
//! `OnboardingChoiceComponent`): the compact brand mark over its animated
//! lab field, the welcome line, and the trace-sharing question in the same
//! selection language as the pickers. The splash owns the pane until the
//! question is answered; the answer and the completion flag persist through
//! [`crate::interactive::OnboardingSink`].

use crate::keybindings::KeybindingsManager;
use crate::keys::KeyId;
use crate::theme::{Theme, ThemeColor};
use crate::{Line, Span};
use ratatui::style::{Color, Modifier, Style};

/// The trace-sharing question (TS `askOnboardingTraceOptIn`).
pub const TRACE_OPT_IN_PROMPT: &str = "Share agent traces with Prime Intellect?";
const TRACE_OPT_IN_DESCRIPTION: &str = "Trace sharing helps us train better open-source models and improve the open agent ecosystem for everyone.";
const TRACE_OPT_IN_NOTE: &str = "You can change this anytime with /traces.";
/// Choice rows: `Share` opts in (index 0), `Not now` keeps traces off.
const CHOICES: [&str; 2] = ["Share", "Not now"];

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

/// The onboarding pane state: the animation frame and the selected row.
#[derive(Debug, Clone, Default)]
pub struct OnboardingScreen {
    frame: u64,
    selected: usize,
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
            self.selected = self.selected.saturating_sub(1);
            return None;
        }
        if kb.matches(key, "tui.select.down") {
            self.selected = (self.selected + 1).min(CHOICES.len() - 1);
            return None;
        }
        if kb.matches(key, "tui.select.confirm") {
            return Some(OnboardingDecision::Selected(self.selected));
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
        lines.extend(self.choice_rows(theme, width));
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

    /// The question panel (TS `OnboardingChoiceComponent.render`): prompt,
    /// wrapped description, choice rows, and the change-anytime note.
    fn choice_rows(&self, theme: &Theme, width: usize) -> Vec<Line> {
        let mut lines: Vec<Line> = vec![Vec::new()];
        lines.push(vec![Span::styled(
            format!(" {TRACE_OPT_IN_PROMPT}"),
            theme.fg_style(ThemeColor::Text),
        )]);
        lines.push(Vec::new());
        let wrap = DESCRIPTION_WIDTH.min(width.saturating_sub(2)).max(1);
        for row in wrap_words(TRACE_OPT_IN_DESCRIPTION, wrap) {
            lines.push(vec![Span::styled(
                format!(" {row}"),
                theme.fg_style(ThemeColor::Muted),
            )]);
        }
        lines.push(Vec::new());
        let label_width = CHOICES.iter().map(|label| label.len()).max().unwrap_or(0);
        // TS clamps the row to the panel width: a narrow pane shortens the
        // highlight instead of running past the edge.
        let row_width = width
            .min((MARKER_WIDTH + label_width + ROW_TRAILING).max(MIN_ROW_WIDTH))
            .max(1);
        let wash = highlight_wash(theme);
        for (index, label) in CHOICES.iter().enumerate() {
            let selected = index == self.selected;
            let name = format!("{}{}", if selected { "> " } else { "  " }, label);
            let pad = " ".repeat(row_width.saturating_sub(name.len()));
            let mut row: Line = vec![Span::styled(" ".to_string(), Style::default())];
            if selected {
                // The selected row lifts off the canvas (TS
                // `onboardingHighlightBackground`): a bold name over the
                // washed background, dim padding inside the wash.
                let mut washed_name = Span::styled(
                    name.clone(),
                    theme
                        .fg_style(ThemeColor::Text)
                        .add_modifier(Modifier::BOLD),
                );
                washed_name.style = washed_name.style.bg(wash);
                row.push(washed_name);
                let mut washed_pad = Span::styled(pad, theme.fg_style(ThemeColor::Dim));
                washed_pad.style = washed_pad.style.bg(wash);
                row.push(washed_pad);
            } else {
                row.push(Span::styled(name, theme.fg_style(ThemeColor::Muted)));
                row.push(Span::styled(pad, theme.fg_style(ThemeColor::Dim)));
            }
            lines.push(row);
        }
        lines.push(Vec::new());
        lines.push(vec![Span::styled(
            format!(" {TRACE_OPT_IN_NOTE}"),
            theme.fg_style(ThemeColor::Dim),
        )]);
        lines
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
/// lifted a few percent toward the text colour. "On dark" follows TS
/// `isLightColor` (luma > 128) with the terminal-default text counting as
/// light; the dark canvas is the TS default because the theme colour
/// record carries no parseable `background`.
fn highlight_wash(theme: &Theme) -> Color {
    let text = theme.fg_style(ThemeColor::Text).fg;
    // TS: `onDark = !text || isLightColor(text)` — undefined (empty theme
    // value) or a light colour both mean light text over a dark canvas.
    let on_dark = match text {
        None | Some(Color::Reset) => true,
        Some(Color::Rgb(r, g, b)) => {
            0.299 * f64::from(r) + 0.587 * f64::from(g) + 0.114 * f64::from(b) > 128.0
        }
        Some(_) => true,
    };
    let (lift, canvas) = if on_dark {
        ((255u16, 255, 255), (16u16, 16, 16))
    } else {
        ((0u16, 0, 0), (255u16, 255, 255))
    };
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
