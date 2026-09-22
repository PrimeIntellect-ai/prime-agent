//! Export theme resolution: a theme file to the CSS custom properties the
//! export template consumes. Port of the TS exporter's theme pipeline
//! (`getResolvedThemeColors`, `getThemeExportColors`, and the export-color
//! derivation) over the bundled theme data ([`pa_types::themes`]) and custom
//! theme files under `<agent-dir>/themes/`.
//!
//! Pure functions only: the terminal-side theme rendering (ANSI colors,
//! surface blending) is pa-tui's; this module only produces the CSS strings
//! embedded into an exported HTML file.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use serde_json::{Map, Value};

/// The CSS variables plus the three background colors the export template
/// substitutes.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ExportTheme {
    /// The `:root` custom-property block (`--key: value;` per line).
    pub(crate) theme_vars: String,
    pub(crate) body_bg: String,
    pub(crate) container_bg: String,
    pub(crate) info_bg: String,
}

/// The export page/card/info backgrounds, either explicit in the theme's
/// `export` section or derived from the user-message background.
#[derive(Debug, Clone, PartialEq)]
struct ExportBackgrounds {
    page_bg: String,
    card_bg: String,
    info_bg: String,
}

const DEFAULT_DARK_TEXT: &str = "#e5e5e7";
const DEFAULT_LIGHT_TEXT: &str = "#000000";

/// A parsed theme file: the name it advertises, its variables, colors, and
/// the export background overrides.
struct ExportThemeJson {
    name: String,
    vars: Map<String, Value>,
    colors: Map<String, Value>,
    export_page_bg: Option<Value>,
    export_card_bg: Option<Value>,
    export_info_bg: Option<Value>,
}

/// The refinement row colors every theme carries implicitly (TS
/// `refinementColors`); the light theme gets the darker pair.
fn refinement_colors(light: bool) -> [(&'static str, &'static str); 2] {
    if light {
        [
            ("refinementHeader", "#7146ab"),
            ("refinementSummary", "#8a70ad"),
        ]
    } else {
        [
            ("refinementHeader", "#9575cd"),
            ("refinementSummary", "#b7a1d6"),
        ]
    }
}

/// A color value after variable-reference resolution: a CSS color string
/// (possibly empty, meaning the terminal default) or an ANSI-256 index.
#[derive(Debug, Clone, PartialEq)]
enum ResolvedColor {
    Ansi256(u64),
    Css(String),
}

/// Resolve one color value against the theme variables (TS `resolveVarRefs`):
/// numbers, empty strings, and hex colors pass through; anything else is a
/// variable reference, resolved transitively with cycle detection.
fn resolve_var_refs(value: &Value, vars: &Map<String, Value>) -> Result<ResolvedColor> {
    match value {
        Value::Number(index) => Ok(ResolvedColor::Ansi256(as_index(index)?)),
        Value::String(color) => {
            if color.is_empty() || color.starts_with('#') {
                Ok(ResolvedColor::Css(color.clone()))
            } else {
                let referenced = vars
                    .get(color)
                    .ok_or_else(|| anyhow!("Variable reference not found: {color}"))?;
                let mut visited = HashSet::from([color.as_str()]);
                resolve_var_ref_chain(referenced, vars, &mut visited)
            }
        }
        other => Err(anyhow!("Invalid color value: {other}")),
    }
}

fn resolve_var_ref_chain<'a>(
    value: &'a Value,
    vars: &'a Map<String, Value>,
    visited: &mut HashSet<&'a str>,
) -> Result<ResolvedColor> {
    match value {
        Value::Number(index) => Ok(ResolvedColor::Ansi256(as_index(index)?)),
        Value::String(color) => {
            if color.is_empty() || color.starts_with('#') {
                return Ok(ResolvedColor::Css(color.clone()));
            }
            if visited.contains(color.as_str()) {
                return Err(anyhow!("Circular variable reference detected: {color}"));
            }
            let referenced = vars
                .get(color)
                .ok_or_else(|| anyhow!("Variable reference not found: {color}"))?;
            visited.insert(color.as_str());
            resolve_var_ref_chain(referenced, vars, visited)
        }
        other => Err(anyhow!("Invalid color value: {other}")),
    }
}

fn as_index(value: &serde_json::Number) -> Result<u64> {
    value
        .as_u64()
        .ok_or_else(|| anyhow!("Invalid color value: {value}"))
}

/// Convert an ANSI-256 index to a hex color (TS `ansi256ToHex`): the basic 16
/// (approximate terminal values), the 6x6x6 cube, and the grayscale ramp.
fn ansi256_to_hex(index: u64) -> String {
    const BASIC_COLORS: [&str; 16] = [
        "#000000", "#800000", "#008000", "#808000", "#000080", "#800080", "#008080", "#c0c0c0",
        "#808080", "#ff0000", "#00ff00", "#ffff00", "#0000ff", "#ff00ff", "#00ffff", "#ffffff",
    ];
    if index < 16 {
        return BASIC_COLORS[index as usize].to_string();
    }
    if index < 232 {
        let cube_index = index - 16;
        let channel = |n: u64| if n == 0 { 0 } else { 55 + n * 40 };
        let (r, g, b) = (
            channel(cube_index / 36),
            channel((cube_index % 36) / 6),
            channel(cube_index % 6),
        );
        return format!("#{r:02x}{g:02x}{b:02x}");
    }
    let gray = (8 + (index - 232) * 10).min(255) as u8;
    format!("#{gray:02x}{gray:02x}{gray:02x}")
}

/// A resolved color as a CSS color string: ANSI-256 indices become hex, and
/// empty values (the terminal default) become the theme's default text
/// color (TS `getResolvedThemeColors`).
fn css_color(color: ResolvedColor, light: bool) -> String {
    match color {
        ResolvedColor::Ansi256(index) => ansi256_to_hex(index),
        ResolvedColor::Css(value) => {
            if value.is_empty() {
                // The terminal's default fg color; the export falls back to
                // plain black/white like the TS default-text choice.
                if light {
                    DEFAULT_LIGHT_TEXT.to_string()
                } else {
                    DEFAULT_DARK_TEXT.to_string()
                }
            } else {
                value
            }
        }
    }
}

/// The theme file for `name`: a built-in (bundled data) or a custom theme
/// file under `<agent-dir>/themes/<name>.json` (TS `loadThemeJson`).
fn load_theme_json(name: &str, agent_dir: &Path) -> Result<ExportThemeJson> {
    let raw = match pa_types::themes::builtin_theme_json(name) {
        Some(builtin) => builtin.to_string(),
        None => {
            let path = custom_theme_path(agent_dir, name);
            if !path.exists() {
                return Err(anyhow!("Theme not found: {name}"));
            }
            std::fs::read_to_string(&path).with_context(|| format!("read theme {name}"))?
        }
    };
    parse_theme_json(&raw).map_err(|error| anyhow!("Invalid theme \"{name}\": {error}"))
}

fn custom_theme_path(agent_dir: &Path, name: &str) -> PathBuf {
    agent_dir.join("themes").join(format!("{name}.json"))
}

fn parse_theme_json(raw: &str) -> Result<ExportThemeJson> {
    let value: Value = serde_json::from_str(raw)?;
    let name = value
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("missing \"name\""))?
        .to_string();
    let vars = value
        .get("vars")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let colors = value
        .get("colors")
        .and_then(Value::as_object)
        .cloned()
        .ok_or_else(|| anyhow!("missing \"colors\""))?;
    let export = value.get("export").and_then(Value::as_object);
    let export_color = |key: &str| export.and_then(|section| section.get(key)).cloned();
    Ok(ExportThemeJson {
        name,
        vars,
        colors,
        export_page_bg: export_color("pageBg"),
        export_card_bg: export_color("cardBg"),
        export_info_bg: export_color("infoBg"),
    })
}

/// The default theme when settings carry none (TS `getDefaultTheme`): a
/// light terminal background (`COLORFGBG`) selects the light theme, and
/// everything else gets the Prime dark-first default.
pub(crate) fn default_theme_name() -> String {
    if detect_light_terminal_background(std::env::var("COLORFGBG").ok().as_deref()) {
        "light".to_string()
    } else {
        "prime".to_string()
    }
}

/// `COLORFGBG` background detection (TS `detectBackgroundFromColorFgBg`):
/// the background palette slot is 8+ for light terminals.
fn detect_light_terminal_background(value: Option<&str>) -> bool {
    let Some(value) = value else { return false };
    let mut parts = value.split(';');
    parts.next();
    match parts.next().and_then(|bg| bg.parse::<u64>().ok()) {
        Some(bg) => bg >= 8,
        None => false,
    }
}

/// `parseColor`: `#RRGGBB` or `rgb(r, g, b)` to RGB, else `None`.
fn parse_color(color: &str) -> Option<(u8, u8, u8)> {
    if let Some(hex) = color.strip_prefix('#') {
        if hex.len() == 6 {
            return Some((
                u8::from_str_radix(&hex[0..2], 16).ok()?,
                u8::from_str_radix(&hex[2..4], 16).ok()?,
                u8::from_str_radix(&hex[4..6], 16).ok()?,
            ));
        }
        return None;
    }
    let rest = color.trim().strip_prefix("rgb(")?.strip_suffix(')')?;
    let channels: Vec<Option<u8>> = rest
        .split(',')
        .map(|channel| channel.trim().parse::<u8>().ok())
        .collect();
    match channels.as_slice() {
        [Some(r), Some(g), Some(b)] => Some((*r, *g, *b)),
        _ => None,
    }
}

/// Relative luminance, 0-1 (TS `getLuminance`, WCAG).
fn luminance(r: u8, g: u8, b: u8) -> f64 {
    let to_linear = |c: u8| {
        let s = f64::from(c) / 255.0;
        if s <= 0.03928 {
            s / 12.92
        } else {
            ((s + 0.055) / 1.055).powf(2.4)
        }
    };
    0.2126 * to_linear(r) + 0.7152 * to_linear(g) + 0.0722 * to_linear(b)
}

/// Brighten (`factor > 1`) or darken (`factor < 1`) a parsed color (TS
/// `adjustBrightness`).
fn adjust_brightness(color: (u8, u8, u8), factor: f64) -> String {
    let channel = |c: u8| ((f64::from(c) * factor).round().clamp(0.0, 255.0)) as u8;
    let (r, g, b) = color;
    format!("rgb({}, {}, {})", channel(r), channel(g), channel(b))
}

/// The export backgrounds derived from the theme's user-message background
/// (TS `deriveExportColors`): a light base darkens the page slightly, a dark
/// base lightens it, and the info row shifts toward the theme's tint.
/// Unparseable colors fall back to the dark neutrals the TS exporter uses.
fn derive_export_colors(base_color: &str) -> ExportBackgrounds {
    let Some((r, g, b)) = parse_color(base_color) else {
        return ExportBackgrounds {
            page_bg: "rgb(24, 24, 30)".to_string(),
            card_bg: "rgb(30, 30, 36)".to_string(),
            info_bg: "rgb(60, 55, 40)".to_string(),
        };
    };
    if luminance(r, g, b) > 0.5 {
        return ExportBackgrounds {
            page_bg: adjust_brightness((r, g, b), 0.96),
            card_bg: base_color.to_string(),
            info_bg: format!(
                "rgb({}, {}, {})",
                u32::from(r) + 10,
                u32::from(g) + 5,
                b.saturating_sub(20)
            ),
        };
    }
    ExportBackgrounds {
        page_bg: adjust_brightness((r, g, b), 0.7),
        card_bg: adjust_brightness((r, g, b), 0.85),
        info_bg: format!("rgb({}, {}, {})", u32::from(r) + 20, u32::from(g) + 15, b),
    }
}

/// Resolve the export theme (TS `generateThemeVars` + the background
/// substitutions in `generateHtml`): every theme color plus the refinement
/// colors as `--key: value;` lines, then the export backgrounds (the
/// theme's explicit `export` section, else the derived ones).
pub(crate) fn resolve_export_theme(
    theme_name: Option<&str>,
    agent_dir: &Path,
) -> Result<ExportTheme> {
    let name = theme_name
        .map(str::to_string)
        .unwrap_or_else(default_theme_name);
    let theme = load_theme_json(&name, agent_dir)?;
    let light = theme.name == "light";

    // Refinement colors are the implicit base the file's colors override.
    let mut css_colors: BTreeMap<String, String> = refinement_colors(light)
        .into_iter()
        .map(|(key, value)| (key.to_string(), value.to_string()))
        .collect();
    for (key, value) in &theme.colors {
        css_colors.insert(
            key.clone(),
            css_color(resolve_var_refs(value, &theme.vars)?, light),
        );
    }

    let user_message_bg = css_colors
        .get("userMessageBg")
        .cloned()
        .unwrap_or_else(|| "#343541".to_string());
    let derived = derive_export_colors(&user_message_bg);
    let export_bg = |value: &Option<Value>, fallback: &str| -> Result<String> {
        match value {
            None => Ok(fallback.to_string()),
            Some(value) => match resolve_var_refs(value, &theme.vars)? {
                ResolvedColor::Ansi256(index) => Ok(ansi256_to_hex(index)),
                // An explicit-but-empty override behaves like an absent one.
                ResolvedColor::Css(css) if css.is_empty() => Ok(fallback.to_string()),
                ResolvedColor::Css(css) => Ok(css),
            },
        }
    };
    let body_bg = export_bg(&theme.export_page_bg, &derived.page_bg)?;
    let container_bg = export_bg(&theme.export_card_bg, &derived.card_bg)?;
    let info_bg = export_bg(&theme.export_info_bg, &derived.info_bg)?;

    let mut lines: Vec<String> = css_colors
        .iter()
        .map(|(key, value)| format!("--{key}: {value};"))
        .collect();
    lines.push(format!("--exportPageBg: {body_bg};"));
    lines.push(format!("--exportCardBg: {container_bg};"));
    lines.push(format!("--exportInfoBg: {info_bg};"));

    Ok(ExportTheme {
        theme_vars: lines.join("\n      "),
        body_bg,
        container_bg,
        info_bg,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The bundled prime theme resolves its accent and export backgrounds
    /// exactly like the TS exporter: `--accent: #7c6faf;` through the
    /// `primary` variable, and the export section's `bg`/`surface`/`panel`
    /// references resolved to their hex values.
    #[test]
    fn prime_theme_resolves_like_the_ts_exporter() {
        let theme = resolve_export_theme(Some("prime"), Path::new("/nonexistent-agent-dir"))
            .expect("resolve prime");
        assert!(theme.theme_vars.contains("--accent: #7c6faf;"));
        assert!(theme.theme_vars.contains("--exportPageBg: #050506;"));
        assert_eq!(theme.body_bg, "#050506");
        assert_eq!(theme.container_bg, "#0d0d10");
        assert_eq!(theme.info_bg, "#151518");
    }

    /// ANSI-256 palette indices resolve to their hex approximations (TS
    /// `ansi256ToHex`).
    #[test]
    fn ansi256_colors() {
        assert_eq!(ansi256_to_hex(196), "#ff0000");
        assert_eq!(ansi256_to_hex(203), "#ff5f5f");
        assert_eq!(ansi256_to_hex(244), "#808080");
        assert_eq!(ansi256_to_hex(9), "#ff0000");
        // The `dark` theme's error color reaches the export through the
        // `red` variable.
        let theme = resolve_export_theme(Some("dark"), Path::new("/nonexistent-agent-dir"))
            .expect("resolve dark");
        assert!(theme.theme_vars.contains("--error: #cc6666;"));
    }

    /// A custom theme under `<agent-dir>/themes/<name>.json` loads (variables
    /// resolved, the terminal-default color mapped to the theme's default
    /// text color, the `export` override honored), and an unknown theme name
    /// is the TS error.
    #[test]
    fn custom_theme_discovery_and_not_found() {
        let dir = tempfile::TempDir::new().expect("temp dir");
        let themes = dir.path().join("themes");
        std::fs::create_dir_all(&themes).expect("themes dir");
        std::fs::write(
            themes.join("custom.json"),
            r##"{
                "name": "custom",
                "vars": { "base": "#101010" },
                "colors": { "accent": "base", "text": "" },
                "export": { "pageBg": "base" }
            }"##,
        )
        .expect("write theme");
        let theme = resolve_export_theme(Some("custom"), dir.path()).expect("resolve custom");
        assert!(theme.theme_vars.contains("--accent: #101010;"));
        assert!(theme.theme_vars.contains("--text: #e5e5e7;"));
        assert_eq!(theme.body_bg, "#101010");

        let error = resolve_export_theme(Some("missing"), dir.path()).expect_err("unknown theme");
        assert_eq!(error.to_string(), "Theme not found: missing");
    }

    /// Without an explicit theme the default is the COLORFGBG-detected one
    /// (TS `getDefaultTheme`): light terminals get `light`, everything else
    /// `prime`.
    #[test]
    fn default_theme_detection() {
        assert!(!detect_light_terminal_background(Some("15;0")));
        assert!(detect_light_terminal_background(Some("0;15")));
        assert!(!detect_light_terminal_background(Some("15;7")));
        assert!(!detect_light_terminal_background(None));
        assert!(!detect_light_terminal_background(Some("bogus")));
    }

    /// Export backgrounds derive from `userMessageBg` when the theme has no
    /// `export` section: a dark base lightens (0.7/0.85) and the info
    /// background shifts per-channel (TS `deriveExportColors`).
    #[test]
    fn derived_export_colors() {
        let dir = tempfile::TempDir::new().expect("temp dir");
        let themes = dir.path().join("themes");
        std::fs::create_dir_all(&themes).expect("themes dir");
        std::fs::write(
            themes.join("noderived.json"),
            r##"{ "name": "noderived", "colors": { "userMessageBg": "#343541" } }"##,
        )
        .expect("write theme");
        let theme = resolve_export_theme(Some("noderived"), dir.path()).expect("resolve");
        // TS Math.round semantics: 52/53/65 * 0.7 -> 36/37/46, * 0.85 ->
        // 44/45/55; the info row shifts +20/+15/+0.
        assert_eq!(theme.body_bg, "rgb(36, 37, 46)");
        assert_eq!(theme.container_bg, "rgb(44, 45, 55)");
        assert_eq!(theme.info_bg, "rgb(72, 68, 65)");
        assert!(
            theme
                .theme_vars
                .contains("--exportPageBg: rgb(36, 37, 46);"),
            "vars: {}",
            theme.theme_vars
        );
    }

    /// Light themes flip the derivation direction and the default text
    /// color, and carry the light refinement pair.
    #[test]
    fn light_theme_derivation() {
        let dir = tempfile::TempDir::new().expect("temp dir");
        let themes = dir.path().join("themes");
        std::fs::create_dir_all(&themes).expect("themes dir");
        std::fs::write(
            themes.join("lightish.json"),
            r##"{ "name": "light", "colors": { "userMessageBg": "#eeeeee", "text": "" } }"##,
        )
        .expect("write theme");
        let theme = resolve_export_theme(Some("lightish"), dir.path()).expect("resolve");
        assert_eq!(theme.body_bg, "rgb(228, 228, 228)");
        assert_eq!(theme.container_bg, "#eeeeee");
        assert_eq!(theme.info_bg, "rgb(248, 243, 218)");
        assert!(theme.theme_vars.contains("--text: #000000;"));
        assert!(theme.theme_vars.contains("--refinementHeader: #7146ab;"));
    }

    /// Brightness adjustment clamps channels to 0-255 (TS `adjustBrightness`).
    #[test]
    fn adjust_brightness_clamps() {
        assert_eq!(adjust_brightness((255, 0, 10), 1.2), "rgb(255, 0, 12)");
        assert_eq!(adjust_brightness((10, 10, 10), 0.5), "rgb(5, 5, 5)");
    }

    /// Circular and missing variable references are errors, not silent
    /// fallbacks.
    #[test]
    fn var_reference_errors() {
        let dir = tempfile::TempDir::new().expect("temp dir");
        let themes = dir.path().join("themes");
        std::fs::create_dir_all(&themes).expect("themes dir");
        std::fs::write(
            themes.join("circular.json"),
            r##"{ "name": "circular", "vars": { "a": "b", "b": "a" }, "colors": { "accent": "a" } }"##,
        )
        .expect("write theme");
        let error = resolve_export_theme(Some("circular"), dir.path())
            .expect_err("circular reference must fail");
        assert!(
            error.to_string().contains("Circular variable reference"),
            "unexpected: {error}"
        );
        std::fs::write(
            themes.join("missing.json"),
            r##"{ "name": "missing", "colors": { "accent": "nope" } }"##,
        )
        .expect("write theme");
        let error = resolve_export_theme(Some("missing"), dir.path())
            .expect_err("missing reference must fail");
        assert!(
            error.to_string().contains("Variable reference not found"),
            "unexpected: {error}"
        );
    }
}
