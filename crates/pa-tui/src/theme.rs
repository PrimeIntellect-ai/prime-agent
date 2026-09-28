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

/// Resolve one var reference (TS `resolveVarRefs`): empty and hex values pass
/// through, any other name looks up `vars` once and stays as-is when unknown
/// (it then fails hex parsing and the slot drops).
fn resolve_var_ref<'a>(value: &'a str, vars: &'a BTreeMap<String, String>) -> &'a str {
    if value.is_empty() || value.starts_with('#') {
        return value;
    }
    vars.get(value).map_or(value, String::as_str)
}

/// Resolve a color value: hex string, var reference, or "" (terminal default).
fn resolve_color(value: &serde_json::Value, vars: &BTreeMap<String, String>) -> Option<Color> {
    let Some(s) = value.as_str() else {
        return value
            .as_u64()
            .map(|n| Color::Indexed(u8::try_from(n).unwrap_or(255)));
    };
    let s = resolve_var_ref(s, vars);
    if s.is_empty() {
        return Some(Color::Reset);
    }
    hex_to_color(s)
}

/// TS `parseHexColor` on the theme record's `background` (the onboarding
/// wash canvas): `^#?([0-9a-f]{6})$` case-insensitive on the trimmed value,
/// after var resolution — only the 6-hex shape parses; anything else (empty,
/// 3-hex shorthand, an ANSI index, a var miss) stays `None` so callers fall
/// back to their hardcoded canvases.
fn parse_theme_background(
    value: &serde_json::Value,
    vars: &BTreeMap<String, String>,
) -> Option<(u8, u8, u8)> {
    let raw = value.as_str()?;
    let trimmed = resolve_var_ref(raw, vars).trim();
    let hex = trimmed.strip_prefix('#').unwrap_or(trimmed);
    if hex.len() != 6 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let channel = |range: std::ops::Range<usize>| u8::from_str_radix(&hex[range], 16).ok();
    Some((channel(0..2)?, channel(2..4)?, channel(4..6)?))
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
            .map_or(0, |(index, _)| index)
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

/// How far a selection wash must stand off the surface it renders on:
/// TS `SELECTION_MIN_LUMINANCE_DELTA` — "Selection rows must stand out
/// clearly, much more than passive surfaces" (TS theme.ts). The operator's
/// 2026-09-26 directive makes the bar binding for the panel redesign's
/// selection: a wash within a few luminance points of the surface reads as
/// no selection at all.
pub(crate) const SELECTION_MIN_LUMINANCE_DELTA: f64 = 28.0;

/// The contrast lift's blend cap (TS `SELECTION_MAX_BLEND_ALPHA`): the
/// wash never lifts further than halfway toward the endpoint.
const SELECTION_MAX_BLEND_ALPHA: f32 = 0.5;

/// The contrast lift's step (TS `SELECTION_BLEND_STEP`).
const SELECTION_BLEND_STEP: f32 = 0.05;

/// The perceived-lightness blend TS weighs every color decision with
/// (TS `luminance`).
fn luminance(rgb: (u16, u16, u16)) -> f64 {
    0.299 * f64::from(rgb.0) + 0.587 * f64::from(rgb.1) + 0.114 * f64::from(rgb.2)
}

/// The xterm-256 palette slot's RGB (TS `ansi256ToRgb`): the 6x6x6 cube
/// and the gray ramp. The base ANSI slots (0-15) are terminal-defined, so
/// their rendered color is unknown.
fn indexed_to_rgb(index: u8) -> Option<(u16, u16, u16)> {
    const CUBE_VALUES: [u16; 6] = [0, 95, 135, 175, 215, 255];
    match index {
        16..=231 => {
            let slot = u16::from(index) - 16;
            let (red, rest) = (slot / 36, slot % 36);
            let (green, blue) = (rest / 6, rest % 6);
            Some((
                CUBE_VALUES[red as usize],
                CUBE_VALUES[green as usize],
                CUBE_VALUES[blue as usize],
            ))
        }
        232..=255 => {
            let gray = u16::from(index) * 10 - 2312;
            Some((gray, gray, gray))
        }
        _ => None,
    }
}

/// The luminance of what actually renders: a 256-color terminal paints the
/// palette slot, not the configured RGB (the quantized candidate evaluates
/// through this; base ANSI slots stay unknown).
pub(crate) fn quantized_luminance(color: Color) -> Option<f64> {
    match color {
        Color::Rgb(r, g, b) => Some(luminance((u16::from(r), u16::from(g), u16::from(b)))),
        Color::Indexed(index) => indexed_to_rgb(index).map(luminance),
        _ => None,
    }
}

/// The active theme: resolved styles per color slot.
#[derive(Debug, Clone, PartialEq)]
pub struct Theme {
    pub name: String,
    fg: BTreeMap<&'static str, Style>,
    bg: BTreeMap<&'static str, Style>,
    bg_colors: BTreeMap<&'static str, Color>,
    /// The theme record's parseable `background` key, raw RGB: blends that
    /// use it (TS `onboardingHighlightBackground`) mix against the true
    /// colour and quantize their result per [`Theme::mode`], not this.
    background: Option<(u8, u8, u8)>,
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
            // `background` is not a fg/bg slot, so the loop above drops it;
            // the wash reads it as its canvas (TS `parseHexColor`).
            background: json
                .colors
                .get("background")
                .and_then(|value| parse_theme_background(value, &json.vars)),
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

    /// The theme record's parseable `background` (strict 6-hex shape after
    /// var resolution, TS `parseHexColor`), raw RGB; `None` when the theme
    /// carries no such value, so callers fall back to their own canvases.
    pub(crate) fn background_rgb(&self) -> Option<(u8, u8, u8)> {
        self.background
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
    ///
    /// The halfway blend is kept only when it still READS against the
    /// surface: every built-in theme's selection sits a few luminance
    /// points off the editor surface, so the blend used to paint as a
    /// near-invisible wash — the operator could not tell which row was
    /// selected (the operator's 2026-09-26 directive: the panel redesign's
    /// selection must be unmistakable). When the blend cannot clear
    /// [`SELECTION_MIN_LUMINANCE_DELTA`] over the surface, the wash steps
    /// toward the contrast endpoint — white when the selection reads
    /// lighter than the surface, black when it reads darker — until it
    /// clears the bar (TS `getSelectionBackgroundColor`'s endpoint ladder,
    /// anchored to the editor surface because the TUI cannot query the
    /// terminal's own background the way TS's `getDefaultTerminalColors`
    /// does; the endpoint machinery is TS's own, TS `theme.ts`:207-209
    /// "Selection rows must stand out clearly, much more than passive
    /// surfaces"). Candidates evaluate after [`Theme::mode`]
    /// quantization, so a 256-color terminal keeps a wash the palette
    /// actually separates from the surface.
    pub fn soft_selection_style(&self) -> Style {
        let blend = |top: (u16, u16, u16), bottom: (u16, u16, u16), alpha: f32| {
            Color::Rgb(
                (top.0 as f32 * alpha + bottom.0 as f32 * (1.0 - alpha)).round() as u8,
                (top.1 as f32 * alpha + bottom.1 as f32 * (1.0 - alpha)).round() as u8,
                (top.2 as f32 * alpha + bottom.2 as f32 * (1.0 - alpha)).round() as u8,
            )
        };
        // The blend needs real RGB. A truecolor theme carries its
        // configured RGB directly; a 256-color theme stores the
        // quantized slot, whose palette RGB is what the terminal
        // actually renders there. The base ANSI slots (0-15) are
        // terminal-defined, so those keep the plain selection (TS's
        // ANSI guard: no reliable blend base exists).
        let slot_rgb = |color: Option<Color>| -> Option<(u16, u16, u16)> {
            match color? {
                Color::Rgb(r, g, b) => Some((u16::from(r), u16::from(g), u16::from(b))),
                Color::Indexed(index) => indexed_to_rgb(index),
                _ => None,
            }
        };
        let (Some(selection), Some(editor_surface)) = (
            slot_rgb(self.bg_color(ThemeBg::SelectedBg)),
            slot_rgb(self.bg_color(ThemeBg::UserMessageBg)),
        ) else {
            return self.bg_style(ThemeBg::SelectedBg);
        };
        let surface_color = Color::Rgb(
            editor_surface.0 as u8,
            editor_surface.1 as u8,
            editor_surface.2 as u8,
        );
        let surface_ansi = to_terminal_color(surface_color, self.mode);
        // The selection also evaluates through the palette: a 256-color
        // terminal paints the quantized slot, so the ladder aims from
        // what actually renders (TS's `renderedSelection`).
        let selection_render_luminance = quantized_luminance(to_terminal_color(
            Color::Rgb(selection.0 as u8, selection.1 as u8, selection.2 as u8),
            self.mode,
        ))
        .unwrap_or(luminance(selection));
        let surface_render_luminance =
            quantized_luminance(surface_ansi).unwrap_or(luminance(editor_surface));
        // The wash reads when its rendered color clears the visibility bar
        // over the surface (both after mode quantization — a 256-color
        // terminal paints the palette slot, not the blend). A candidate the
        // palette maps to an unknown slot never blocks: showing the wash
        // beats refusing to compute.
        let reads = |candidate: Color| {
            quantized_luminance(candidate).is_none_or(|candidate_luminance| {
                (candidate_luminance - surface_render_luminance).abs()
                    >= SELECTION_MIN_LUMINANCE_DELTA
            })
        };
        // Half contrast by default; strengthen the blend only when the
        // quantized wash still separates from the editor surface AND reads.
        for alpha in [0.5, 0.75, 1.0] {
            let adjusted = to_terminal_color(blend(selection, editor_surface, alpha), self.mode);
            if adjusted != surface_ansi && reads(adjusted) {
                return Style::default().bg(adjusted);
            }
        }
        // The blend reads too close to the surface (every built-in
        // theme): step the wash toward the contrast endpoint — the one on
        // the selection's side of the surface first, the opposite one
        // (crossing the surface) second — until the quantized candidate
        // clears the bar. The strongest step is tracked across BOTH
        // endpoints like TS: the first candidate to clear the bar wins,
        // and when nothing clears it a step replaces the selection only
        // if it improved on the selection's own delta.
        let delta = (selection_render_luminance - surface_render_luminance).abs();
        let endpoints = if selection_render_luminance >= surface_render_luminance {
            [(255u16, 255, 255), (0, 0, 0)]
        } else {
            [(0u16, 0, 0), (255, 255, 255)]
        };
        let mut best: Option<Color> = None;
        let mut best_delta = delta;
        for endpoint in endpoints {
            let spread = luminance(endpoint) - selection_render_luminance;
            if spread == 0.0 {
                continue;
            }
            let target = surface_render_luminance + spread.signum() * SELECTION_MIN_LUMINANCE_DELTA;
            let base_alpha = ((target - selection_render_luminance) / spread)
                .clamp(0.0, f64::from(SELECTION_MAX_BLEND_ALPHA));
            // If the direct hit undershoots the bar, keep stepping toward
            // the cap — a stronger blend may quantize to a palette slot
            // that passes.
            let mut alphas = Vec::new();
            let mut alpha = base_alpha as f32;
            while alpha < SELECTION_MAX_BLEND_ALPHA {
                alphas.push(alpha);
                alpha += SELECTION_BLEND_STEP;
            }
            alphas.push(SELECTION_MAX_BLEND_ALPHA);
            for alpha in alphas {
                let candidate = to_terminal_color(blend(endpoint, selection, alpha), self.mode);
                let Some(candidate_luminance) = quantized_luminance(candidate) else {
                    continue;
                };
                let result_delta = (candidate_luminance - surface_render_luminance).abs();
                if result_delta >= SELECTION_MIN_LUMINANCE_DELTA - 1.0 {
                    best = Some(candidate);
                    best_delta = result_delta;
                    break;
                }
                if result_delta > best_delta {
                    best = Some(candidate);
                    best_delta = result_delta;
                }
            }
            if best.is_some() && best_delta >= SELECTION_MIN_LUMINANCE_DELTA - 1.0 {
                break;
            }
        }
        match best {
            Some(candidate) => Style::default().bg(candidate),
            // A selection pinned at its own endpoint with a palette too
            // coarse to reach the bar: the plain selection is the least
            // surprising fallback (TS keeps the configured value too).
            None => self.bg_style(ThemeBg::SelectedBg),
        }
    }

    /// The ONE selected-row style every activity surface paints (the
    /// operator's 2026-09-28 consistency rule: the selected row's
    /// background is IDENTICAL across the dock's groups, the agents
    /// view's rows, the heartbeats picker, and the bash view — one
    /// style, not per-surface copies): the accent purple as the
    /// selection background — the shade the dock's selection carried
    /// before #2831 swapped it for the near-invisible dark-green
    /// `ToolSuccessBg` band — at FULL opacity (a solid band, never a
    /// translucent wash), with the selected row's text bold. Each
    /// surface keeps its own foreground colors; the style patches only
    /// the background and the bold modifier.
    ///
    /// TS parity: the TS fork paints `theme.bg("selectedBg", ...)` on
    /// its focused rows (a plain dark-gray band — no purple, no bold);
    /// the purple+opaque+bold treatment is the operator's sanctioned
    /// divergence. A theme too partial to resolve the accent falls
    /// back to the plain selection background and then the onboarding
    /// wash, so a selected row always reads as selected (Macroscope
    /// PR #2908's contract).
    pub fn selection_row_style(&self) -> Style {
        let purple = self
            .fg_style(ThemeColor::Accent)
            .fg
            .or_else(|| self.bg_color(ThemeBg::SelectedBg))
            .unwrap_or_else(|| crate::onboarding::highlight_wash(self));
        Style::default().bg(purple).add_modifier(Modifier::BOLD)
    }

    /// Paint one line's spans with [`Theme::selection_row_style`] —
    /// the `bg_paint` counterpart for the one selection style: each
    /// span keeps its own foreground, gains the purple band and the
    /// bold modifier.
    pub fn selection_paint(&self, line: crate::Line) -> crate::Line {
        let style = self.selection_row_style();
        line.into_iter()
            .map(|mut span| {
                span.style = span.style.patch(style);
                span
            })
            .collect()
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

/// Resolve a bundled theme JSON by name, falling back to the prime
/// theme when the name is unknown.
///
/// # Panics
///
/// Panics only if the bundled `prime` theme JSON fails to parse (a
/// build-time invariant the shipped constant satisfies).
pub fn builtin_theme_json(name: &str) -> ThemeJson {
    let raw = pa_types::themes::builtin_theme_json(name).unwrap_or(PRIME_JSON);
    serde_json::from_str(raw)
        .unwrap_or_else(|_| serde_json::from_str(PRIME_JSON).expect("prime.json is valid"))
}

/// Load a theme from a JSON file path.
///
/// # Errors
///
/// Returns `Err` when the file cannot be read or its JSON cannot be
/// parsed; both errors carry the theme path.
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

    #[test]
    fn background_parses_strict_six_hex_after_var_resolution() {
        let json = serde_json::from_str::<ThemeJson>(
            r##"{
                "name": "custom",
                "vars": { "canvas": "#0A0B0C" },
                "colors": { "background": "canvas", "text": "#f4f4f5" }
            }"##,
        )
        .expect("valid theme json");
        let theme = Theme::from_json(&json, ColorMode::TrueColor);
        // Case-insensitive 6-hex, reached through a var reference.
        assert_eq!(theme.background_rgb(), Some((0x0a, 0x0b, 0x0c)));
    }

    /// The selection wash must READ (the operator's 2026-09-26 directive:
    /// the panel redesign's selection was barely visible): every built-in
    /// theme's wash clears [`SELECTION_MIN_LUMINANCE_DELTA`] over the
    /// editor surface, in both color modes — a 256-color terminal
    /// evaluates the palette slots it actually paints.
    #[test]
    fn soft_selection_reads_off_the_editor_surface() {
        for name in ["prime", "dark", "light"] {
            for mode in [ColorMode::TrueColor, ColorMode::Color256] {
                let theme = Theme::builtin(name, mode);
                let wash = theme
                    .soft_selection_style()
                    .bg
                    .expect("the selection wash paints a background");
                let surface = theme
                    .bg_color(ThemeBg::UserMessageBg)
                    .expect("the editor surface resolves");
                let (Some(wash_lum), Some(surface_lum)) =
                    (quantized_luminance(wash), quantized_luminance(surface))
                else {
                    panic!("{name}/{mode:?}: wash and surface must both evaluate");
                };
                assert!(
                    (wash_lum - surface_lum).abs() >= SELECTION_MIN_LUMINANCE_DELTA - 1.0,
                    "{name}/{mode:?}: wash {wash:?} lum {wash_lum:.2} vs surface {surface:?} lum {surface_lum:.2}"
                );
            }
        }
    }

    /// The ladder's pinned values: the wash clears the bar by stepping
    /// from the selection toward the endpoint on its side of the surface
    /// (white for the dark themes, black for the light one), and the
    /// 256-color palette keeps a slot the surface's slot separates from.
    #[test]
    fn soft_selection_pins_the_contrast_ladder_values() {
        let prime = Theme::builtin("prime", ColorMode::TrueColor);
        assert_eq!(
            prime.soft_selection_style().bg,
            Some(Color::Rgb(54, 54, 58))
        );
        let prime256 = Theme::builtin("prime", ColorMode::Color256);
        assert_eq!(
            prime256.soft_selection_style().bg,
            Some(Color::Indexed(237))
        );
        let dark = Theme::builtin("dark", ColorMode::TrueColor);
        assert_eq!(dark.soft_selection_style().bg, Some(Color::Rgb(80, 80, 95)));
        let dark256 = Theme::builtin("dark", ColorMode::Color256);
        assert_eq!(dark256.soft_selection_style().bg, Some(Color::Indexed(244)));
        let light = Theme::builtin("light", ColorMode::TrueColor);
        assert_eq!(
            light.soft_selection_style().bg,
            Some(Color::Rgb(202, 202, 218))
        );
        let light256 = Theme::builtin("light", ColorMode::Color256);
        assert_eq!(
            light256.soft_selection_style().bg,
            Some(Color::Indexed(251))
        );
    }

    /// No reliable blend base, no ladder: a base-ANSI selection (the
    /// terminal defines its rendered color) keeps the plain selection —
    /// TS's ANSI guard.
    #[test]
    fn soft_selection_keeps_the_plain_selection_without_a_blend_base() {
        let json = serde_json::from_str::<ThemeJson>(
            r##"{
                "name": "ansi",
                "colors": {
                    "selectedBg": 4,
                    "userMessageBg": "#1a1a1f"
                }
            }"##,
        )
        .expect("valid theme json");
        let theme = Theme::from_json(&json, ColorMode::TrueColor);
        assert_eq!(
            theme.soft_selection_style().bg,
            theme.bg_style(ThemeBg::SelectedBg).bg
        );
    }

    #[test]
    fn background_stays_none_for_non_six_hex_shapes() {
        // Empty, 3-hex shorthand, an unknown var, an ANSI index, and a
        // missing value are all unparseable: the wash falls back to its
        // hardcoded canvas (the built-in themes carry no background at all).
        for raw in ["\"\"", "\"#abc\"", "\"5\"", "17", "null"] {
            let json: ThemeJson = serde_json::from_str(&format!(
                r#"{{ "name": "custom", "colors": {{ "background": {raw} }} }}"#
            ))
            .expect("valid theme json");
            let theme = Theme::from_json(&json, ColorMode::TrueColor);
            assert_eq!(theme.background_rgb(), None, "background {raw}");
        }
    }
}
