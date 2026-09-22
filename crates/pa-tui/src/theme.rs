//! Theme engine ported from `coding-agent/src/modes/interactive/theme`.
//!
//! Ships the `prime`, `dark`, and `light` built-in palettes with the same
//! variable/color layout as the TS JSON themes. Colors resolve to truecolor or
//! 256-color ANSI depending on `COLORTERM`/`TERM`.

use anyhow::{Context, Result};
use ratatui::style::{Color, Modifier, Style};
use serde::Deserialize;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ThemeColor {
    Accent,
    Border,
    BorderAccent,
    BorderMuted,
    Success,
    Error,
    Warning,
    Muted,
    Dim,
    Text,
    ThinkingText,
    UserMessageText,
    CustomMessageText,
    CustomMessageLabel,
    RefinementHeader,
    RefinementSummary,
    ToolTitle,
    ToolOutput,
    MdBody,
    MdHeading,
    MdLink,
    MdLinkUrl,
    MdCode,
    MdCodeBlock,
    MdCodeBlockBorder,
    MdQuote,
    MdQuoteBorder,
    MdHr,
    MdListBullet,
    ToolDiffAdded,
    ToolDiffRemoved,
    ToolDiffText,
    ToolDiffContext,
    SyntaxComment,
    SyntaxKeyword,
    SyntaxFunction,
    SyntaxVariable,
    SyntaxString,
    SyntaxNumber,
    SyntaxType,
    SyntaxOperator,
    SyntaxPunctuation,
    ThinkingOff,
    ThinkingMinimal,
    ThinkingLow,
    ThinkingMedium,
    ThinkingHigh,
    ThinkingXhigh,
    BashMode,
}

impl ThemeColor {
    fn name(self) -> &'static str {
        match self {
            ThemeColor::Accent => "accent",
            ThemeColor::Border => "border",
            ThemeColor::BorderAccent => "borderAccent",
            ThemeColor::BorderMuted => "borderMuted",
            ThemeColor::Success => "success",
            ThemeColor::Error => "error",
            ThemeColor::Warning => "warning",
            ThemeColor::Muted => "muted",
            ThemeColor::Dim => "dim",
            ThemeColor::Text => "text",
            ThemeColor::ThinkingText => "thinkingText",
            ThemeColor::UserMessageText => "userMessageText",
            ThemeColor::CustomMessageText => "customMessageText",
            ThemeColor::CustomMessageLabel => "customMessageLabel",
            ThemeColor::RefinementHeader => "refinementHeader",
            ThemeColor::RefinementSummary => "refinementSummary",
            ThemeColor::ToolTitle => "toolTitle",
            ThemeColor::ToolOutput => "toolOutput",
            ThemeColor::MdBody => "mdBody",
            ThemeColor::MdHeading => "mdHeading",
            ThemeColor::MdLink => "mdLink",
            ThemeColor::MdLinkUrl => "mdLinkUrl",
            ThemeColor::MdCode => "mdCode",
            ThemeColor::MdCodeBlock => "mdCodeBlock",
            ThemeColor::MdCodeBlockBorder => "mdCodeBlockBorder",
            ThemeColor::MdQuote => "mdQuote",
            ThemeColor::MdQuoteBorder => "mdQuoteBorder",
            ThemeColor::MdHr => "mdHr",
            ThemeColor::MdListBullet => "mdListBullet",
            ThemeColor::ToolDiffAdded => "toolDiffAdded",
            ThemeColor::ToolDiffRemoved => "toolDiffRemoved",
            ThemeColor::ToolDiffText => "toolDiffText",
            ThemeColor::ToolDiffContext => "toolDiffContext",
            ThemeColor::SyntaxComment => "syntaxComment",
            ThemeColor::SyntaxKeyword => "syntaxKeyword",
            ThemeColor::SyntaxFunction => "syntaxFunction",
            ThemeColor::SyntaxVariable => "syntaxVariable",
            ThemeColor::SyntaxString => "syntaxString",
            ThemeColor::SyntaxNumber => "syntaxNumber",
            ThemeColor::SyntaxType => "syntaxType",
            ThemeColor::SyntaxOperator => "syntaxOperator",
            ThemeColor::SyntaxPunctuation => "syntaxPunctuation",
            ThemeColor::ThinkingOff => "thinkingOff",
            ThemeColor::ThinkingMinimal => "thinkingMinimal",
            ThemeColor::ThinkingLow => "thinkingLow",
            ThemeColor::ThinkingMedium => "thinkingMedium",
            ThemeColor::ThinkingHigh => "thinkingHigh",
            ThemeColor::ThinkingXhigh => "thinkingXhigh",
            ThemeColor::BashMode => "bashMode",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ThemeBg {
    SelectedBg,
    UserMessageBg,
    CustomMessageBg,
    ToolPendingBg,
    ToolSuccessBg,
    ToolErrorBg,
    ToolDiffAddedBg,
    ToolDiffRemovedBg,
    ToolPanelBg,
}

impl ThemeBg {
    fn name(self) -> &'static str {
        match self {
            ThemeBg::SelectedBg => "selectedBg",
            ThemeBg::UserMessageBg => "userMessageBg",
            ThemeBg::CustomMessageBg => "customMessageBg",
            ThemeBg::ToolPendingBg => "toolPendingBg",
            ThemeBg::ToolSuccessBg => "toolSuccessBg",
            ThemeBg::ToolErrorBg => "toolErrorBg",
            ThemeBg::ToolDiffAddedBg => "toolDiffAddedBg",
            ThemeBg::ToolDiffRemovedBg => "toolDiffRemovedBg",
            ThemeBg::ToolPanelBg => "toolPanelBg",
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct ThemeJson {
    name: String,
    #[serde(default)]
    vars: BTreeMap<String, String>,
    colors: BTreeMap<String, serde_json::Value>,
}

/// Resolve a color value: hex string, var reference, or "" (terminal default).
fn resolve_color(value: &serde_json::Value, vars: &BTreeMap<String, String>) -> Option<Color> {
    let Some(s) = value.as_str() else {
        return value
            .as_u64()
            .map(|n| Color::Indexed(u8::try_from(n).unwrap_or(255)));
    };
    let mut s: &str = s;
    if !s.is_empty() && !s.starts_with('#') {
        if let Some(var) = vars.get(s) {
            s = var.as_str();
        }
    }
    if s.is_empty() {
        return Some(Color::Reset);
    }
    hex_to_color(s)
}

fn hex_to_color(s: &str) -> Option<Color> {
    let hex = s.strip_prefix('#')?;
    if hex.len() == 3 {
        let rgb: Vec<u8> = hex
            .chars()
            .filter_map(|c| u8::from_str_radix(&c.to_string(), 16).ok().map(|v| v * 17))
            .collect();
        if rgb.len() == 3 {
            return Some(Color::Rgb(rgb[0], rgb[1], rgb[2]));
        }
        return None;
    }
    if hex.len() != 6 {
        return None;
    }
    let r = u8::from_str_radix(&hex[0..2], 16).ok()?;
    let g = u8::from_str_radix(&hex[2..4], 16).ok()?;
    let b = u8::from_str_radix(&hex[4..6], 16).ok()?;
    Some(Color::Rgb(r, g, b))
}

/// Quantize RGB to the xterm 256-color palette (TS `rgbTo256`): nearest cube
/// level per channel, gray chosen by luma, gray wins only for near-neutral
/// colors where it is the closer weighted distance.
pub fn rgb_to_256(rgb: (u8, u8, u8)) -> u8 {
    const CUBE_VALUES: [u8; 6] = [0, 95, 135, 175, 215, 255];
    const GRAY_VALUES: [u8; 24] = {
        let mut values = [0u8; 24];
        let mut index = 0;
        while index < 24 {
            values[index] = (8 + index * 10) as u8;
            index += 1;
        }
        values
    };
    let (r, g, b) = (f64::from(rgb.0), f64::from(rgb.1), f64::from(rgb.2));
    let find_closest = |value: f64, values: &[u8]| -> usize {
        values
            .iter()
            .enumerate()
            .min_by(|(_, candidate), (index, _)| {
                (value - f64::from(**candidate))
                    .abs()
                    .partial_cmp(&(value - f64::from(values[*index])).abs())
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .map(|(index, _)| index)
            .unwrap_or(0)
    };
    let distance = |other: (u8, u8, u8)| -> f64 {
        let (dr, dg, db) = (
            r - f64::from(other.0),
            g - f64::from(other.1),
            b - f64::from(other.2),
        );
        dr * dr * 0.299 + dg * dg * 0.587 + db * db * 0.114
    };
    let (r_index, g_index, b_index) = (
        find_closest(r, &CUBE_VALUES),
        find_closest(g, &CUBE_VALUES),
        find_closest(b, &CUBE_VALUES),
    );
    let cube_rgb = (
        CUBE_VALUES[r_index],
        CUBE_VALUES[g_index],
        CUBE_VALUES[b_index],
    );
    let cube_index = 16 + 36 * r_index + 6 * g_index + b_index;
    let cube_dist = distance(cube_rgb);
    let gray = 0.299 * r + 0.587 * g + 0.114 * b;
    let gray_slot = find_closest(gray, &GRAY_VALUES);
    let gray_value = GRAY_VALUES[gray_slot];
    let gray_index = 232 + gray_slot;
    let gray_dist = distance((gray_value, gray_value, gray_value));
    let max_channel = r.max(g).max(b);
    let min_channel = r.min(g).min(b);
    if max_channel - min_channel < 10.0 && gray_dist < cube_dist {
        u8::try_from(gray_index).unwrap_or(16)
    } else {
        u8::try_from(cube_index).unwrap_or(16)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColorMode {
    TrueColor,
    Color256,
}

/// TS `detectColorMode`: truecolor unless the terminal is truly limited.
/// tmux reports `screen*` but forwards 24-bit color, so it stays truecolor;
/// only genuine GNU screen (no `$TMUX`) falls back to the 256-color cube.
pub fn detect_color_mode() -> ColorMode {
    let colorterm = std::env::var("COLORTERM").unwrap_or_default();
    if colorterm == "truecolor" || colorterm == "24bit" {
        return ColorMode::TrueColor;
    }
    if std::env::var_os("WT_SESSION").is_some() {
        return ColorMode::TrueColor;
    }
    let term = std::env::var("TERM").unwrap_or_default();
    if term == "dumb" || term.is_empty() || term == "linux" {
        return ColorMode::Color256;
    }
    if std::env::var("TERM_PROGRAM").as_deref() == Ok("Apple_Terminal") {
        return ColorMode::Color256;
    }
    let in_tmux = std::env::var_os("TMUX").is_some() || term.starts_with("tmux");
    let genuine_screen =
        term == "screen" || term.starts_with("screen-") || term.starts_with("screen.");
    if !in_tmux && genuine_screen {
        return ColorMode::Color256;
    }
    ColorMode::TrueColor
}

fn to_terminal_color(color: Color, mode: ColorMode) -> Color {
    match (color, mode) {
        (Color::Rgb(r, g, b), ColorMode::Color256) => Color::Indexed(rgb_to_256((r, g, b))),
        (c, _) => c,
    }
}

/// The active theme: resolved styles per color slot.
#[derive(Debug, Clone)]
pub struct Theme {
    pub name: String,
    fg: BTreeMap<&'static str, Style>,
    bg: BTreeMap<&'static str, Style>,
    bg_colors: BTreeMap<&'static str, Color>,
    pub mode: ColorMode,
}

impl Theme {
    pub(crate) fn from_json(json: &ThemeJson, mode: ColorMode) -> Theme {
        let mut fg = BTreeMap::new();
        let mut bg = BTreeMap::new();
        let mut bg_colors = BTreeMap::new();
        for (name, value) in &json.colors {
            let Some(resolved) = resolve_color(value, &json.vars) else {
                continue;
            };
            let color = to_terminal_color(resolved, mode);
            // Background slots end with "Bg" (camel case); the rest are foreground.
            if name.ends_with("Bg") {
                let key = bg_name_lookup(name);
                if let Some(key) = key {
                    bg_colors.insert(key, color);
                    bg.insert(key, Style::default().bg(color));
                }
            } else if let Some(key) = fg_name_lookup(name) {
                fg.insert(key, Style::default().fg(color));
            }
        }
        Theme {
            name: json.name.clone(),
            fg,
            bg,
            bg_colors,
            mode,
        }
    }

    pub fn builtin(name: &str, mode: ColorMode) -> Theme {
        let json = builtin_theme_json(name);
        Theme::from_json(&json, mode)
    }

    pub fn fg_style(&self, color: ThemeColor) -> Style {
        self.fg.get(color.name()).copied().unwrap_or_default()
    }

    pub fn bg_style(&self, color: ThemeBg) -> Style {
        self.bg.get(color.name()).copied().unwrap_or_default()
    }

    pub fn bg_color(&self, color: ThemeBg) -> Option<Color> {
        self.bg_colors.get(color.name()).copied()
    }

    /// `theme.fg("muted", text)` equivalent.
    pub fn fg(&self, color: ThemeColor, text: impl Into<String>) -> crate::Span {
        crate::Span::styled(text.into(), self.fg_style(color))
    }

    pub fn fg_span(&self, color: ThemeColor, text: impl Into<String>) -> crate::Span {
        self.fg(color, text)
    }

    /// Bold helper (chalk.bold equivalent).
    pub fn bold(&self, span: crate::Span) -> crate::Span {
        span_with(span, Modifier::BOLD)
    }

    pub fn italic(&self, span: crate::Span) -> crate::Span {
        span_with(span, Modifier::ITALIC)
    }

    pub fn underline(&self, span: crate::Span) -> crate::Span {
        span_with(span, Modifier::UNDERLINED)
    }

    pub fn strikethrough(&self, span: crate::Span) -> crate::Span {
        span_with(span, Modifier::CROSSED_OUT)
    }

    /// Background-paint helper: apply a bg style to whole line content.
    pub fn bg_paint(&self, color: ThemeBg, line: crate::Line) -> crate::Line {
        let style = self.bg_style(color);
        line.into_iter()
            .map(|mut span| {
                span.style = span.style.patch(style);
                span
            })
            .collect()
    }

    /// Editor surface background (userMessageBg) — in the TS theme the editor
    /// and user messages share the surface color.
    pub fn editor_background(&self) -> Option<Style> {
        Some(self.bg_style(ThemeBg::UserMessageBg))
    }

    /// Filled effort squares: a pastel purple that reads softer than the
    /// theme accent (TS `getEffortSquareColor`). The TS theme picks a light
    /// pastel on light terminal backgrounds; the Rust theme does not yet
    /// detect the terminal background kind, so the dark pastel is the
    /// default-terminal match.
    pub fn effort_square_style(&self) -> Style {
        const EFFORT_SQUARE_DARK_COLOR: Color = Color::Rgb(0xa7, 0x8b, 0xfa);
        Style::default().fg(to_terminal_color(EFFORT_SQUARE_DARK_COLOR, self.mode))
    }

    /// Row-selection highlight for menu rows (TS
    /// `getSoftSelectionBackgroundColor`): the selection color blended
    /// halfway toward the editor surface — a softer band than the full
    /// selection block. Non-RGB palettes have no reliable blend base, so
    /// they keep the plain selection background.
    pub fn soft_selection_style(&self) -> Style {
        let blend = |top: (u16, u16, u16), bottom: (u16, u16, u16), alpha: f32| {
            Color::Rgb(
                (top.0 as f32 * alpha + bottom.0 as f32 * (1.0 - alpha)).round() as u8,
                (top.1 as f32 * alpha + bottom.1 as f32 * (1.0 - alpha)).round() as u8,
                (top.2 as f32 * alpha + bottom.2 as f32 * (1.0 - alpha)).round() as u8,
            )
        };
        let (Some(Color::Rgb(sr, sg, sb)), Some(surface @ Color::Rgb(ur, ug, ub))) = (
            self.bg_color(ThemeBg::SelectedBg),
            self.bg_color(ThemeBg::UserMessageBg),
        ) else {
            return self.bg_style(ThemeBg::SelectedBg);
        };
        let selection = (sr as u16, sg as u16, sb as u16);
        let editor_surface = (ur as u16, ug as u16, ub as u16);
        let surface_ansi = to_terminal_color(surface, self.mode);
        // Half contrast by default; strengthen the blend only when
        // quantization would collapse the highlight into the editor surface.
        for alpha in [0.5, 0.75, 1.0] {
            let adjusted = to_terminal_color(blend(selection, editor_surface, alpha), self.mode);
            if adjusted != surface_ansi {
                return Style::default().bg(adjusted);
            }
        }
        self.bg_style(ThemeBg::SelectedBg)
    }
}

fn span_with(span: crate::Span, modifier: Modifier) -> crate::Span {
    let mut s = span;
    s.style = s.style.add_modifier(modifier);
    s
}

fn fg_name_lookup(name: &str) -> Option<&'static str> {
    Some(match name {
        "accent" => "accent",
        "border" => "border",
        "borderAccent" => "borderAccent",
        "borderMuted" => "borderMuted",
        "success" => "success",
        "error" => "error",
        "warning" => "warning",
        "muted" => "muted",
        "dim" => "dim",
        "text" => "text",
        "thinkingText" => "thinkingText",
        "userMessageText" => "userMessageText",
        "customMessageText" => "customMessageText",
        "customMessageLabel" => "customMessageLabel",
        "refinementHeader" => "refinementHeader",
        "refinementSummary" => "refinementSummary",
        "toolTitle" => "toolTitle",
        "toolOutput" => "toolOutput",
        "mdBody" => "mdBody",
        "mdHeading" => "mdHeading",
        "mdLink" => "mdLink",
        "mdLinkUrl" => "mdLinkUrl",
        "mdCode" => "mdCode",
        "mdCodeBlock" => "mdCodeBlock",
        "mdCodeBlockBorder" => "mdCodeBlockBorder",
        "mdQuote" => "mdQuote",
        "mdQuoteBorder" => "mdQuoteBorder",
        "mdHr" => "mdHr",
        "mdListBullet" => "mdListBullet",
        "toolDiffAdded" => "toolDiffAdded",
        "toolDiffRemoved" => "toolDiffRemoved",
        "toolDiffText" => "toolDiffText",
        "toolDiffContext" => "toolDiffContext",
        "syntaxComment" => "syntaxComment",
        "syntaxKeyword" => "syntaxKeyword",
        "syntaxFunction" => "syntaxFunction",
        "syntaxVariable" => "syntaxVariable",
        "syntaxString" => "syntaxString",
        "syntaxNumber" => "syntaxNumber",
        "syntaxType" => "syntaxType",
        "syntaxOperator" => "syntaxOperator",
        "syntaxPunctuation" => "syntaxPunctuation",
        "thinkingOff" => "thinkingOff",
        "thinkingMinimal" => "thinkingMinimal",
        "thinkingLow" => "thinkingLow",
        "thinkingMedium" => "thinkingMedium",
        "thinkingHigh" => "thinkingHigh",
        "thinkingXhigh" => "thinkingXhigh",
        "bashMode" => "bashMode",
        _ => return None,
    })
}

fn bg_name_lookup(name: &str) -> Option<&'static str> {
    Some(match name {
        "selectedBg" => "selectedBg",
        "userMessageBg" => "userMessageBg",
        "customMessageBg" => "customMessageBg",
        "toolPendingBg" => "toolPendingBg",
        "toolSuccessBg" => "toolSuccessBg",
        "toolErrorBg" => "toolErrorBg",
        "toolDiffAddedBg" => "toolDiffAddedBg",
        "toolDiffRemovedBg" => "toolDiffRemovedBg",
        "toolPanelBg" => "toolPanelBg",
        _ => return None,
    })
}

/// The bundled theme files, shared with the session HTML exporter via
/// [`pa_types::themes`] (the theme *data* is shared vocabulary; this crate
/// owns everything built on top of it).
pub const PRIME_JSON: &str = pa_types::themes::PRIME_THEME_JSON;
pub const DARK_JSON: &str = pa_types::themes::DARK_THEME_JSON;
pub const LIGHT_JSON: &str = pa_types::themes::LIGHT_THEME_JSON;

pub fn builtin_theme_json(name: &str) -> ThemeJson {
    let raw = pa_types::themes::builtin_theme_json(name).unwrap_or(PRIME_JSON);
    serde_json::from_str(raw)
        .unwrap_or_else(|_| serde_json::from_str(PRIME_JSON).expect("prime.json is valid"))
}

/// Load a theme from a JSON file path.
pub fn load_theme_from_path(path: &std::path::Path, mode: ColorMode) -> Result<Theme> {
    let raw = std::fs::read_to_string(path)
        .with_context(|| format!("reading theme {}", path.display()))?;
    let json: ThemeJson =
        serde_json::from_str(&raw).with_context(|| format!("parsing theme {}", path.display()))?;
    Ok(Theme::from_json(&json, mode))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prime_theme_resolves() {
        let theme = Theme::builtin("prime", ColorMode::TrueColor);
        let accent = theme.fg_style(ThemeColor::Accent);
        match accent.fg {
            Some(Color::Rgb(0x7c, 0x6f, 0xaf)) => {}
            other => panic!("unexpected accent {other:?}"),
        }
        let panel = theme.bg_style(ThemeBg::ToolPanelBg);
        assert!(matches!(panel.bg, Some(Color::Rgb(0x0d, 0x0d, 0x10))));
    }

    #[test]
    fn rgb_to_256_gray() {
        assert_eq!(rgb_to_256((0, 0, 0)), 16);
        assert_eq!(rgb_to_256((255, 255, 255)), 231);
    }

    #[test]
    fn var_reference_resolves() {
        let theme = Theme::builtin("prime", ColorMode::Color256);
        let accent = theme.fg_style(ThemeColor::Accent);
        assert!(matches!(accent.fg, Some(Color::Indexed(_))));
    }
}
