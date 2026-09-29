//! The render surface (moved with its concern): the per-surface chrome,
//! the progress block, the URL block with the OSC 8 wrap, the paste
//! field, the team picker rows, and the auth-actions row the provider
//! selector's API-key prompt reuses.

use super::{
    hint_row, key_hint, login_field_row, menu_row, no_match_row, osc8_open, scroll_row,
    scrub_controls, search_field_lines, search_field_plain_row, AuthPanel, CopyStatus,
    KeybindingsManager, Line, MenuSegment, Modifier, PanelInput, PanelSurface, PastePromptTone,
    PasteStyle, PickerSegment, Span, Theme, ThemeColor, BROWSER_DEFAULT_INSTRUCTIONS, OSC8_CLOSE,
    PASTE_PLACEHOLDER, PREFERRED_VISIBLE_TEAMS, TEAM_SEARCH_PLACEHOLDER, TOKEN_PLACEHOLDER,
};

impl AuthPanel {
    /// The panel's rendered rows (TS `MenuPanel`'s per-surface chrome over
    /// the `LoginDialogComponent` content: the session's dock opens with
    /// the borderMuted rule and the muted one-space title, the onboarding
    /// block mounts the content chrome-less; the content is the blank
    /// `startContent` row, the progress block, the URL block, the paste
    /// field, and the auth-actions row last — no bottom rule on either
    /// surface).
    pub fn render(&mut self, theme: &Theme, width: usize, kb: &KeybindingsManager) -> Vec<Line> {
        let width = width.max(1);
        let mut lines: Vec<Line> = Vec::new();
        // TS `MenuPanel` inline's per-surface chrome: the session dock
        // opens with the borderMuted rule and the muted one-space title
        // (TS `loginDialogOptions`'s non-onboarding shape); the
        // onboarding block mounts the panel chrome-less (`topRule:
        // false, hideTitle: true` — the splash renders the heading).
        if self.surface == PanelSurface::Session {
            lines.push(vec![
                theme.fg_span(ThemeColor::BorderMuted, "\u{2500}".repeat(width))
            ]);
            lines.push(content_row(theme, width, ThemeColor::Muted, &self.title));
            if let Some(subtitle) = &self.subtitle {
                lines.push(content_row(theme, width, ThemeColor::Muted, subtitle));
            }
        }
        // The team picker is TS `PrimeTeamSelectorComponent` — its own
        // panel: the rule, the title, the subtitle, the bordered field,
        // the rows (no leading content blank, no auth-actions row, no nav
        // hint).
        if let PanelInput::Teams { picker, .. } = &mut self.input {
            lines.append(&mut search_field_lines(
                theme,
                width,
                picker.search.value(),
                picker.search.cursor(),
                false,
                TEAM_SEARCH_PLACEHOLDER,
            ));
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
            return lines;
        }
        if !self.content_open() {
            // TS renders the empty dialog as zero rows: only the
            // surface's chrome (nothing, on the onboarding block) shows.
            return lines;
        }
        // TS `startContent`'s Spacer(1): the content's leading blank row.
        lines.push(Vec::new());
        // TS `showProgress`'s empty-content arm: the section title rides
        // the first progress line (text colour, TS `addSectionTitle`).
        if self.progress_open {
            lines.push(content_row(
                theme,
                width,
                ThemeColor::Text,
                "Preparing authentication",
            ));
        }
        for message in &self.progress {
            lines.push(content_row(theme, width, ThemeColor::Muted, message));
        }
        if let Some(url) = &self.auth_url {
            // The URL and the instructions are provider-supplied: control
            // characters can never execute terminal control operations
            // when rendered (the same hygiene every daemon-supplied row
            // carries); a URL is additionally single-line, so newlines
            // drop. TS `showAuth` renders the link in the text colour
            // and wraps it in OSC 8 (the URL is the link's own display
            // text) when the terminal is known to implement hyperlinks,
            // else prints it plain.
            let safe = scrub_controls(url).replace('\n', "");
            // The OSC 8 wrap survives truncation intact: the display text
            // truncates to the column budget BEFORE the wrap (a long URL
            // cut mid-sequence would leave the terminal's link region
            // open), and the URI parameter always carries the full URL.
            let budget = width.saturating_sub(2);
            let display = if crate::width::str_width(&safe) > budget {
                crate::width::truncate_line(&vec![Span::raw(safe.clone())], budget, "")
                    .iter()
                    .map(|span| span.content.clone())
                    .collect::<String>()
            } else {
                safe.clone()
            };
            let linked = if crate::hyperlinks::hyperlinks_enabled() {
                format!("{}{display}{OSC8_CLOSE}", osc8_open(&safe))
            } else {
                display
            };
            lines.push(content_row(theme, width, ThemeColor::Text, &linked));
            // TS `addSectionSpacer`: the browser-step text reads apart
            // from the URL.
            lines.push(Vec::new());
            let instructions = self.auth_instructions.clone().map_or_else(
                || BROWSER_DEFAULT_INSTRUCTIONS.to_string(),
                |text| scrub_controls(&text),
            );
            if let Some(code) = verification_code(&instructions) {
                // TS `addInstructions`' code arm: a blank row separates
                // the sign-in link from the code below it.
                lines.push(Vec::new());
                lines.push(content_row(
                    theme,
                    width,
                    ThemeColor::Muted,
                    "Verification code",
                ));
                let bold_code = vec![
                    Span::raw(" ".to_string()),
                    Span::styled(
                        code,
                        theme
                            .fg_style(ThemeColor::Text)
                            .add_modifier(Modifier::BOLD),
                    ),
                ];
                lines.push(crate::width::truncate_line(&bold_code, width, ""));
            } else if self.auth_instructions.is_some() {
                // Provider instructions already describe the browser step
                // (TS renders them in the text colour).
                lines.push(content_row(theme, width, ThemeColor::Text, &instructions));
            } else {
                // TS `addMutedText`'s default browser-step line.
                lines.push(content_row(theme, width, ThemeColor::Muted, &instructions));
            }
        }
        match &mut self.input {
            PanelInput::Working => {}
            PanelInput::Paste {
                prompt,
                tone,
                style,
                field,
                ..
            } => {
                // TS `addSectionSpacer`: the blank before the prompt
                // rides only when content already rendered above (an
                // empty panel's `startContent` blank already opened the
                // body).
                if !self.progress.is_empty() || self.auth_url.is_some() {
                    lines.push(Vec::new());
                }
                let prompt_tone = match tone {
                    PastePromptTone::Muted => ThemeColor::Muted,
                    PastePromptTone::Text => ThemeColor::Text,
                };
                lines.push(content_row(theme, width, prompt_tone, prompt));
                let placeholder = match style {
                    PasteStyle::Visible => PASTE_PLACEHOLDER,
                    PasteStyle::Masked => TOKEN_PLACEHOLDER,
                };
                match style {
                    // The login dialog's field is the plain prompt-bearing
                    // field (TS `MenuSearchInput` inline + plain, no
                    // enclosing rules).
                    PasteStyle::Visible => lines.push(login_field_row(
                        theme,
                        width,
                        field.value(),
                        field.cursor(),
                        true,
                        placeholder,
                    )),
                    // A masked render never contains the secret: only the
                    // bullet projection rides the prompt-less plain field
                    // (TS `McpTokenPastePanelComponent`).
                    PasteStyle::Masked => lines.push(search_field_plain_row(
                        theme,
                        width,
                        &"\u{2022}".repeat(field.value().chars().count()),
                        field.value().chars().count(),
                        true,
                        placeholder,
                    )),
                }
                if let Some(notice) = &self.notice {
                    lines.push(content_row(theme, width, ThemeColor::Warning, notice));
                }
                // TS `addInputField`'s inputSpacer: the blank row between
                // the field and the actions (the actions row rides last
                // while the URL block shows; a paste-only panel — the MCP
                // token surface — keeps its own hint row instead).
                if self.auth_url.is_some() {
                    lines.push(Vec::new());
                } else {
                    let hints = [
                        key_hint(kb, &["tui.select.confirm"], "submit"),
                        key_hint(kb, &["tui.select.cancel"], "cancel"),
                    ]
                    .into_iter()
                    .flatten()
                    .collect::<Vec<String>>()
                    .join("  ");
                    lines.push(hint_row(theme, width, &hints));
                }
            }
            PanelInput::Teams { .. } => unreachable!("the team picker returned above"),
        }
        // TS `showWaiting`: the waiting line joins above the actions row
        // in the accent colour — its `addSectionSpacer` blank rides only
        // under already-rendered content (the empty arm's `startContent`
        // blank is the panel's leading row already).
        if let Some(waiting) = &self.waiting {
            if self.progress_open
                || !self.progress.is_empty()
                || self.auth_url.is_some()
                || !matches!(self.input, PanelInput::Working)
            {
                lines.push(Vec::new());
            }
            lines.push(content_row(theme, width, ThemeColor::Accent, waiting));
        }
        // TS `getAuthActionsText`: the URL block's actions row rides last —
        // the copy-key hint with the status of the last copy, the submit
        // hint while the paste field is mounted, and the cancel hint.
        if self.auth_url.is_some() {
            lines.push(auth_actions_row(
                theme,
                width,
                kb,
                matches!(self.input, PanelInput::Paste { .. }),
                self.copy_status,
            ));
        }
        lines
    }
}

/// TS `isTextEntryKeybinding` over one bound key id: a binding whose
/// final part is a single character (or `space`) with no ctrl/alt
/// modifier is the field's text while the paste field shows.
fn is_text_entry_keybinding(key: &str) -> bool {
    let parts: Vec<&str> = key.split('+').collect();
    let key_part = parts.last().copied().unwrap_or("");
    !parts.iter().any(|part| *part == "ctrl" || *part == "alt")
        && (key_part == "space" || key_part.chars().count() == 1)
}

/// TS `getAuthActionsText`: the key-hint row that rides the panel's last
/// row — the submit hint while the field is visible, the copy status, the
/// copy hint, and the cancel hint, joined by two spaces (the provider
/// selector's API-key prompt renders the same row).
pub(crate) fn auth_actions_row(
    theme: &Theme,
    width: usize,
    keybindings: &KeybindingsManager,
    input_visible: bool,
    copy_state: Option<CopyStatus>,
) -> Line {
    let mut row: Line = vec![Span::raw(" ".to_string())];
    let mut parts: Vec<Line> = Vec::new();
    if input_visible {
        if let Some(hint) = key_hint_row(theme, keybindings, "tui.select.confirm", "submit") {
            parts.push(hint);
        }
    }
    if let Some(state) = copy_state {
        let tone = match state {
            CopyStatus::Copied => ThemeColor::Success,
            CopyStatus::Failed => ThemeColor::Error,
        };
        let text = match state {
            CopyStatus::Copied => "Copied sign-in link",
            CopyStatus::Failed => "Failed to copy sign-in link",
        };
        parts.push(vec![theme.fg_span(tone, text.to_string())]);
    }
    // TS `copyHint`: the copy keys (the plain text-entry keys drop out
    // while the field is visible — a typed key is field input), the
    // description turning to "retry" after a failed copy.
    let configured_copy_keys = keybindings.get_keys("app.clipboard.copyLoginUrl");
    let copy_keys = if input_visible {
        configured_copy_keys
            .iter()
            .filter(|key| !is_text_entry_keybinding(key))
            .cloned()
            .collect::<Vec<_>>()
    } else {
        configured_copy_keys
            .iter()
            .take(1)
            .cloned()
            .collect::<Vec<_>>()
    };
    if !copy_keys.is_empty() {
        let action = if copy_state == Some(CopyStatus::Failed) {
            "retry"
        } else {
            "copy"
        };
        parts.push(vec![
            Span::styled(
                crate::keybindings::format_key_text(&copy_keys.join("/")),
                theme.fg_style(ThemeColor::Dim),
            ),
            Span::styled(format!(" {action}"), theme.fg_style(ThemeColor::Muted)),
        ]);
    }
    if let Some(hint) = key_hint_row(theme, keybindings, "tui.select.cancel", "cancel") {
        parts.push(hint);
    }
    for (index, part) in parts.into_iter().enumerate() {
        if index > 0 {
            row.push(Span::raw("  ".to_string()));
        }
        row.extend(part);
    }
    crate::width::truncate_line(&row, width, "")
}

/// One content row at the panel's single-column indent: `" {text}"` in
/// `tone`, truncated to the frame width (TS `MenuPanel` inline prefixes
/// each child row with one space).
fn content_row(theme: &Theme, width: usize, tone: ThemeColor, text: &str) -> Line {
    crate::width::truncate_line(
        &vec![
            Span::raw(" ".to_string()),
            theme.fg_span(tone, text.to_string()),
        ],
        width,
        "",
    )
}

/// TS `keyHint`: the dim key label over the muted ` {action}` — one
/// hint part of the auth-actions row. An unbound action is omitted: the
/// hint never advertises a key the surface does not handle.
fn key_hint_row(
    theme: &Theme,
    keybindings: &KeybindingsManager,
    binding: &str,
    action: &str,
) -> Option<Line> {
    let label = keybindings.key_text(binding);
    if label.is_empty() {
        return None;
    }
    Some(vec![
        Span::styled(label, theme.fg_style(ThemeColor::Dim)),
        Span::styled(format!(" {action}"), theme.fg_style(ThemeColor::Muted)),
    ])
}

/// TS `addInstructions`' code arm (`/^(?:Code|Enter code):\s*(.+)$/i`):
/// the verification code the browser instructions carry, rendered below
/// the muted label. The TS `.` stops at line terminators and `$` anchors
/// the string's end, so a multi-line `Code: ABC\nmore instructions`
/// matches no code arm at all — the instructions render as provider
/// text.
pub(super) fn verification_code(instructions: &str) -> Option<String> {
    let trimmed = instructions.trim();
    for prefix in ["Enter code:", "Code:"] {
        let head: String = trimmed.chars().take(prefix.chars().count()).collect();
        if head.eq_ignore_ascii_case(prefix) {
            let code: String = trimmed
                .chars()
                .skip(prefix.chars().count())
                .collect::<String>()
                .trim()
                .to_string();
            if !code.is_empty() && !code.contains('\n') && !code.contains('\r') {
                return Some(code);
            }
        }
    }
    None
}
