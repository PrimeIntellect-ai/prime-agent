//! The full first-run flow's own surfaces (TS `runOnboardingFlow`'s
//! not-model-ready branch): the welcome block's description paragraphs
//! and single login action, the connect-more-providers picker (TS
//! `OnboardingPickerComponent`), and the panel hosting that mounts each
//! step's surface inside the splash (TS `setPanel` — the flow never
//! nests its panels, so one slot covers it: the login dialog replaces
//! the picker, the loop re-mounts a fresh picker, the question ends the
//! flow).

use crate::keybindings::KeybindingsManager;
use crate::menu_panel::search_field_plain_row;
use crate::onboarding::{highlight_wash, wrap_words, OnboardingDecision};
use crate::onboarding_choice::OnboardingChoice;
use crate::search_input::SearchInput;
use crate::theme::{Theme, ThemeColor};
use crate::{Line, Span};
use ratatui::style::Modifier;

/// TS `prompt` (the picker's question line).
pub(crate) const PROVIDERS_PROMPT: &str = "Connect other providers, or continue.";
/// TS `searchPlaceholder`.
pub(crate) const PROVIDERS_SEARCH_PLACEHOLDER: &str = "Search providers";
/// TS `note`.
pub(crate) const PROVIDERS_NOTE: &str = "You can add providers anytime with /login.";
/// TS `continueLabel`.
pub(crate) const CONTINUE_LABEL: &str = "Continue";
/// TS `LOGIN_ACTION_LABEL`: the welcome screen's single action.
pub(crate) const LOGIN_ACTION_LABEL: &str = "Log in with Prime Intellect";
/// The Prime Inference login's heading (TS `showAuthPanel(dialog, {
/// heading })`): the panel that owns the block names itself in place of
/// the brand line.
pub(crate) const PRIME_LOGIN_HEADING: &str = "Login with Prime Intellect";
/// The API-key prompt's heading label (TS `showPrompt("Enter API key:")`).
pub(crate) const API_KEY_PROMPT: &str = "Enter API key:";

/// TS `DESCRIPTION_PARAGRAPHS`: what the agent is, wrapped under the
/// welcome line.
const WELCOME_DESCRIPTION_PARAGRAPHS: [&str; 2] = [
    "A self-improving RLM harness with persistent context, recursive subagents, and direct swarm communication.",
    "It learns from its history by refining its own memories, skills, prompts, and subagent specifications.",
];
/// TS `DESCRIPTION_WIDTH`: the wrap width for the welcome paragraphs.
const WELCOME_DESCRIPTION_WIDTH: usize = 56;
/// TS `MIN_HIGHLIGHT_WIDTH`: the login action's band floor.
const MIN_HIGHLIGHT_WIDTH: usize = 30;
/// TS `HIGHLIGHT_TRAILING`: the login action's band trailing padding.
const HIGHLIGHT_TRAILING: usize = 6;

/// TS `MARKER_WIDTH`: the `> ` selection marker.
const MARKER_WIDTH: usize = 2;
/// TS `MIN_ROW_WIDTH`.
const MIN_ROW_WIDTH: usize = 34;
/// TS `ROW_TRAILING`.
const ROW_TRAILING: usize = 6;
/// TS `DEFAULT_VISIBLE_ROWS`.
const VISIBLE_ROWS: usize = 6;

/// One picker row (TS `OnboardingPickerItem`): a provider with its
/// signed-in marking.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderPickerOption {
    pub id: String,
    pub name: String,
    /// Already signed in: the row is marked with a check rather than a note.
    pub connected: bool,
}

/// The picker's answer to one key (TS `onSelect`/`onContinue`/`onCancel`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProviderPick {
    /// The pinned continue row.
    Continue,
    /// One provider row, by id.
    Provider(String),
    /// Esc: the step ends (TS `onCancel` → the flow continues).
    Cancelled,
}

/// A searchable list in the onboarding block (TS
/// `OnboardingPickerComponent`): the continue action pinned at index 0,
/// the matching provider rows under it in a scrolling viewport, and the
/// below/top hints. The field owns the keys between the navigation
/// bindings; any key that reaches the field re-clamps the selection and
/// resets the scroll (TS re-reads `getFiltered` after every input).
#[derive(Debug)]
pub struct ProviderPicker {
    options: Vec<ProviderPickerOption>,
    search: SearchInput,
    /// The selected row: 0 is the continue action, 1.. the visible rows.
    selected: usize,
    scroll_top: usize,
}

impl ProviderPicker {
    pub fn new(options: Vec<ProviderPickerOption>) -> Self {
        ProviderPicker {
            options,
            search: SearchInput::new(),
            selected: 0,
            scroll_top: 0,
        }
    }

    /// One key id (TS `handleInput`; the splash answers the exit keys
    /// before the panel sees any key). `None` keeps the picker mounted.
    pub fn handle_key(&mut self, key: &str, kb: &KeybindingsManager) -> Option<ProviderPick> {
        if kb.matches(key, "tui.select.up") {
            self.move_selection(-1);
            return None;
        }
        if kb.matches(key, "tui.select.down") {
            self.move_selection(1);
            return None;
        }
        if kb.matches(key, "tui.select.confirm") {
            if self.selected == 0 {
                return Some(ProviderPick::Continue);
            }
            let filtered = self.filtered();
            let item = filtered.get(self.selected - 1)?;
            return Some(ProviderPick::Provider(item.id.clone()));
        }
        if kb.matches(key, "tui.select.cancel") {
            return Some(ProviderPick::Cancelled);
        }
        self.search.handle_key(key, kb);
        self.selected = self.selected.min(self.filtered().len());
        self.scroll_top = 0;
        None
    }

    /// One paste payload (TS the field's paste): the query accepts pasted
    /// text, and the filter re-clamps the selection and resets the scroll
    /// exactly like a typed query — a paste that shrinks the match list
    /// never strands the cursor on a row that no longer exists.
    pub fn handle_paste(&mut self, text: &str) {
        self.search.paste(text);
        self.selected = self.selected.min(self.filtered().len());
        self.scroll_top = 0;
    }

    /// The query's matches (TS `getFiltered`): the lowercased trimmed
    /// query matches the label or the id.
    fn filtered(&self) -> Vec<&ProviderPickerOption> {
        let query = self.search.value().trim().to_lowercase();
        if query.is_empty() {
            return self.options.iter().collect();
        }
        self.options
            .iter()
            .filter(|option| {
                option.name.to_lowercase().contains(&query)
                    || option.id.to_lowercase().contains(&query)
            })
            .collect()
    }

    /// TS `move`: the selection never leaves `0..=len`, and the viewport
    /// follows it.
    fn move_selection(&mut self, delta: i32) {
        let filtered = self.filtered().len();
        let next = self.selected as i64 + delta as i64;
        if next < 0 || next > filtered as i64 {
            return;
        }
        self.selected = next as usize;
        if self.selected >= 1 {
            let item_index = self.selected - 1;
            if item_index < self.scroll_top {
                self.scroll_top = item_index;
            } else if item_index >= self.scroll_top + VISIBLE_ROWS {
                self.scroll_top = item_index - VISIBLE_ROWS + 1;
            }
        }
    }

    /// The picker's frame (TS `render`): the prompt, the search field, the
    /// pinned continue row, the viewport's rows, the below/top hint, and
    /// the trailing note.
    pub fn render(&self, theme: &Theme, width: usize) -> Vec<Line> {
        let width = width.max(1);
        let filtered = self.filtered();
        let max_scroll = filtered.len().saturating_sub(VISIBLE_ROWS);
        let scroll_top = self.scroll_top.min(max_scroll);
        let row_width = self.row_width(width);
        let mut lines: Vec<Line> = vec![padded(width)];
        lines.push(indented(theme, width, PROVIDERS_PROMPT, ThemeColor::Text));
        lines.push(padded(width));
        lines.push(search_field_plain_row(
            theme,
            width,
            self.search.value(),
            self.search.cursor(),
            true,
            PROVIDERS_SEARCH_PLACEHOLDER,
        ));
        lines.push(padded(width));
        lines.push(self.row(
            theme,
            width,
            row_width,
            CONTINUE_LABEL,
            false,
            self.selected == 0,
        ));
        let end = (scroll_top + VISIBLE_ROWS).min(filtered.len());
        for (index, item) in filtered.iter().enumerate().take(end).skip(scroll_top) {
            lines.push(self.row(
                theme,
                width,
                row_width,
                &item.name,
                item.connected,
                self.selected == index + 1,
            ));
        }
        let remaining = filtered.len() - end;
        if remaining > 0 || scroll_top > 0 {
            let hint = if remaining > 0 {
                format!("{remaining} more below")
            } else {
                "top of list".to_string()
            };
            lines.push(indented(
                theme,
                width,
                &format!("  {hint}"),
                ThemeColor::Dim,
            ));
        }
        lines.push(padded(width));
        lines.push(indented(theme, width, PROVIDERS_NOTE, ThemeColor::Dim));
        lines
    }

    /// One row (TS `renderRow`): the marker, the label, the connected
    /// check, and the row-width padding; the selected row carries the
    /// highlight wash.
    fn row(
        &self,
        theme: &Theme,
        width: usize,
        row_width: usize,
        label: &str,
        connected: bool,
        selected: bool,
    ) -> Line {
        let name = format!("{}{}", if selected { "> " } else { "  " }, label);
        let mark = if connected { "  \u{2713}" } else { "" };
        let pad = " ".repeat(
            row_width
                .saturating_sub(crate::width::str_width(&name) + crate::width::str_width(mark)),
        );
        let wash = highlight_wash(theme);
        let mut line: Line = vec![Span::raw(" ")];
        if selected {
            // The selected row lifts off the canvas (TS
            // `onboardingHighlightBackground`): a bold name, the success
            // check, and the padding all washed.
            let mut washed_name = Span::styled(
                name,
                theme
                    .fg_style(ThemeColor::Text)
                    .add_modifier(Modifier::BOLD),
            );
            washed_name.style = washed_name.style.bg(wash);
            line.push(washed_name);
            if connected {
                let mut washed_mark = Span::styled(mark, theme.fg_style(ThemeColor::Success));
                washed_mark.style = washed_mark.style.bg(wash);
                line.push(washed_mark);
            }
            let mut washed_pad = Span::styled(pad, theme.fg_style(ThemeColor::Dim));
            washed_pad.style = washed_pad.style.bg(wash);
            line.push(washed_pad);
        } else {
            line.push(Span::styled(name, theme.fg_style(ThemeColor::Muted)));
            if connected {
                line.push(Span::styled(mark, theme.fg_style(ThemeColor::Success)));
            }
            line.push(Span::styled(pad, theme.fg_style(ThemeColor::Dim)));
        }
        pad_to(line, width)
    }

    /// TS `getRowWidth`: the longest label (plus its check) under the
    /// width budget, floored at the TS minimum.
    fn row_width(&self, width: usize) -> usize {
        let longest = self
            .options
            .iter()
            .map(|option| {
                crate::width::str_width(&option.name) + if option.connected { 3 } else { 0 }
            })
            .max()
            .unwrap_or(0);
        (MARKER_WIDTH + longest + ROW_TRAILING)
            .max(MIN_ROW_WIDTH)
            .min(width.saturating_sub(1).max(1))
    }
}

/// One mounted flow panel (TS `setPanel`'s stack top): the login dialog,
/// the providers picker, or the trace question.
#[derive(Debug)]
pub enum OnboardingPanel {
    /// A login flow's inline auth panel (TS the `LoginDialogComponent`
    /// over the splash), with the heading line that replaces the brand
    /// mark while it owns the block. The dialog is boxed: it dwarfs the
    /// other variants (progress lines, the paste field), and the enum
    /// rides every mount/unmount by value.
    Auth {
        panel: std::boxed::Box<crate::auth_panel::AuthPanel>,
        heading: Option<String>,
    },
    /// The connect-more-providers picker.
    Providers(ProviderPicker),
    /// The trace question (TS `askOnboardingTraceOptIn`'s choice).
    Question(OnboardingChoice),
}

impl OnboardingPanel {
    /// TS `renderHeadingLine`: the panel that owns the block names
    /// itself; `None` keeps the brand line.
    pub fn heading(&self) -> Option<&str> {
        match self {
            OnboardingPanel::Auth { heading, .. } => heading.as_deref(),
            _ => None,
        }
    }

    /// The panel's rows (TS `render`'s active-panel arm; the panel indents
    /// its own content).
    pub fn render(&mut self, theme: &Theme, width: usize) -> Vec<Line> {
        match self {
            OnboardingPanel::Auth { panel, .. } => panel.render(theme, width),
            OnboardingPanel::Providers(picker) => picker.render(theme, width),
            OnboardingPanel::Question(choice) => choice.render(theme, width),
        }
    }

    /// One key (TS the mounted panel's `handleInput`; the exit keys were
    /// answered before the panel). `None` keeps the pane waiting.
    pub fn handle_key(&mut self, key: &str, kb: &KeybindingsManager) -> Option<OnboardingDecision> {
        match self {
            // The dialog consumes every key itself: its mounted input
            // answers through the request's oneshot, and the flow behind
            // it settles through its own future.
            OnboardingPanel::Auth { panel, .. } => {
                panel.handle_key(key, kb);
                None
            }
            OnboardingPanel::Providers(picker) => {
                picker.handle_key(key, kb).map(OnboardingDecision::Pick)
            }
            OnboardingPanel::Question(choice) => {
                if kb.matches(key, "tui.select.cancel") {
                    return Some(OnboardingDecision::Cancelled);
                }
                if kb.matches(key, "tui.select.up") {
                    choice.move_selection(-1);
                    return None;
                }
                if kb.matches(key, "tui.select.down") {
                    choice.move_selection(1);
                    return None;
                }
                if kb.matches(key, "tui.select.confirm") {
                    return Some(OnboardingDecision::Selected(choice.selected()));
                }
                None
            }
        }
    }

    /// One paste payload (TS the mounted input's paste): the login
    /// dialog's field, or the picker's search — the question has no
    /// input.
    pub fn handle_paste(&mut self, text: &str) {
        match self {
            OnboardingPanel::Auth { panel, .. } => panel.handle_paste(text),
            OnboardingPanel::Providers(picker) => picker.handle_paste(text),
            OnboardingPanel::Question(_) => {}
        }
    }
}

/// The welcome block under the brand line (TS `render`'s `!flowStarted`
/// arm): the wrapped description paragraphs with a blank row between
/// them, and the trailing blank that separates them from the action.
pub(crate) fn welcome_rows(theme: &Theme, width: usize) -> Vec<Line> {
    let wrap = WELCOME_DESCRIPTION_WIDTH
        .min(width.saturating_sub(1))
        .max(1);
    let mut lines: Vec<Line> = vec![padded(width)];
    for (index, paragraph) in WELCOME_DESCRIPTION_PARAGRAPHS.iter().enumerate() {
        if index > 0 {
            lines.push(padded(width));
        }
        for row in wrap_words(paragraph, wrap) {
            lines.push(indented(theme, width, &row, ThemeColor::Muted));
        }
    }
    lines.push(padded(width));
    lines
}

/// The welcome screen's single action (TS `renderActions`): the bold
/// `> Log in with Prime Intellect` row washed across its highlight band,
/// one column in from the pane edge.
pub(crate) fn welcome_action_row(theme: &Theme, width: usize) -> Line {
    let band = MIN_HIGHLIGHT_WIDTH
        .max(MARKER_WIDTH + crate::width::str_width(LOGIN_ACTION_LABEL) + HIGHLIGHT_TRAILING)
        .min(width.saturating_sub(2).max(1));
    let content = format!("> {LOGIN_ACTION_LABEL}");
    let pad = band.saturating_sub(crate::width::str_width(&content));
    let mut washed = Span::styled(
        format!("{content}{}", " ".repeat(pad)),
        theme
            .fg_style(ThemeColor::Text)
            .add_modifier(Modifier::BOLD),
    );
    washed.style = washed.style.bg(highlight_wash(theme));
    pad_to(vec![Span::raw(" "), washed], width)
}

/// TS `line`: the one-space-indented, width-padded row.
fn indented(theme: &Theme, width: usize, text: &str, tone: ThemeColor) -> Line {
    pad_to(vec![Span::raw(" "), theme.fg_span(tone, text)], width)
}

fn padded(width: usize) -> Line {
    pad_to(Vec::new(), width)
}

fn pad_to(mut line: Line, width: usize) -> Line {
    let used = crate::width::spans_width(&line);
    if used < width {
        line.push(Span::raw(" ".repeat(width - used)));
    }
    line
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::{ColorMode, Theme};

    fn theme() -> Theme {
        Theme::builtin("prime", ColorMode::TrueColor)
    }

    fn options(count: usize) -> Vec<ProviderPickerOption> {
        (0..count)
            .map(|index| ProviderPickerOption {
                id: format!("provider-{index}"),
                name: format!("Provider {index}"),
                connected: index == 0,
            })
            .collect()
    }

    fn kb() -> KeybindingsManager {
        KeybindingsManager::new()
    }

    fn row_text(line: &Line) -> String {
        line.iter().map(|span| span.content.to_string()).collect()
    }

    #[test]
    fn the_welcome_action_row_matches_the_ts_band() {
        // The band is the TS label width (26) + marker + trailing = 34,
        // under the pane budget; the row pads the rest of the pane.
        let row = welcome_action_row(&theme(), 80);
        let text = row_text(&row);
        assert!(
            text.starts_with(&format!(" > {LOGIN_ACTION_LABEL}")),
            "the bold action label: {text:?}"
        );
        assert_eq!(crate::width::str_width(&text), 80, "the row fills the pane");
    }

    #[test]
    fn the_welcome_paragraphs_wrap_at_the_ts_width() {
        let rows = welcome_rows(&theme(), 80);
        // The blank, the two wrapped paragraphs, the blank between them,
        // and the trailing blank that separates them from the action.
        assert_eq!(rows.len(), 7);
        let text: Vec<String> = rows.iter().map(row_text).collect();
        assert!(
            text.iter().any(|row| row.contains("persistent context")),
            "the first paragraph renders: {text:?}"
        );
        assert!(
            text.iter().any(|row| row.contains("refining its own")),
            "the second paragraph wraps at the TS width: {text:?}"
        );
    }

    #[test]
    fn the_picker_pins_the_continue_row_and_marks_connected() {
        let picker = ProviderPicker::new(vec![
            ProviderPickerOption {
                id: "one".to_string(),
                name: "One".to_string(),
                connected: true,
            },
            ProviderPickerOption {
                id: "two".to_string(),
                name: "Two".to_string(),
                connected: false,
            },
        ]);
        let rows = picker.render(&theme(), 60);
        let text: Vec<String> = rows.iter().map(row_text).collect();
        assert!(
            text.iter().any(|row| row.contains(CONTINUE_LABEL)),
            "the continue row: {text:?}"
        );
        assert!(
            text.iter()
                .any(|row| row.contains("One") && row.contains('\u{2713}'.to_string().as_str())),
            "the connected check rides its row: {text:?}"
        );
    }

    #[test]
    fn the_picker_answers_the_three_row_kinds() {
        let mut picker = ProviderPicker::new(options(1));
        let kb = kb();
        // Enter on the pinned continue row.
        assert_eq!(
            picker.handle_key("enter", &kb),
            Some(ProviderPick::Continue)
        );
        // Down to the provider row: Enter answers its id.
        picker.handle_key("down", &kb);
        assert_eq!(
            picker.handle_key("enter", &kb),
            Some(ProviderPick::Provider("provider-0".to_string()))
        );
        // Esc ends the step.
        assert_eq!(
            picker.handle_key("escape", &kb),
            Some(ProviderPick::Cancelled)
        );
    }

    #[test]
    fn a_typed_query_filters_the_rows_and_resets_the_scroll() {
        let mut picker = ProviderPicker::new(options(10));
        let kb = kb();
        // Scroll down past the viewport, then type: the filter re-clamps
        // the selection and resets the scroll to the top.
        for _ in 0..9 {
            picker.handle_key("down", &kb);
        }
        picker.handle_key("d", &kb);
        picker.handle_key("7", &kb);
        let rows = picker.render(&theme(), 60);
        let text: Vec<String> = rows.iter().map(row_text).collect();
        assert!(
            text.iter().any(|row| row.contains("Provider 7")),
            "the match renders: {text:?}"
        );
        assert!(
            !text.iter().any(|row| row.contains("Provider 0")),
            "the filter hides the non-matches: {text:?}"
        );
    }
}
