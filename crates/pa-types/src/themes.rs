//! Bundled theme definitions (pure data), shared by the surfaces that need
//! the theme *files* rather than a rendered theme: the TUI's theme loader
//! (pa-tui, which renders terminal colors from these files) and the session
//! HTML exporter (pa-core, which resolves them into CSS variables). The
//! JSON content is the product theme file, verbatim; a theme's `export`
//! section carries the export page's background overrides.
//!
//! Only the built-in themes are data here; discovery of custom theme files
//! (`<agent-dir>/themes/<name>.json`) and every behavior built on top of
//! these files belong to the consuming crates.

/// The bundled theme names, in builtin resolution order.
pub const BUILTIN_THEME_NAMES: [&str; 3] = ["prime", "dark", "light"];

/// The `prime` theme file (Prime Agent's default, dark-first).
pub const PRIME_THEME_JSON: &str = include_str!("../themes/prime.json");
/// The `dark` theme file.
pub const DARK_THEME_JSON: &str = include_str!("../themes/dark.json");
/// The `light` theme file.
pub const LIGHT_THEME_JSON: &str = include_str!("../themes/light.json");

/// The bundled theme file for `name`, when `name` is a built-in theme.
pub fn builtin_theme_json(name: &str) -> Option<&'static str> {
    match name {
        "prime" => Some(PRIME_THEME_JSON),
        "dark" => Some(DARK_THEME_JSON),
        "light" => Some(LIGHT_THEME_JSON),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The bundled files parse as JSON objects with a name and colors, and
    /// each advertises the theme name it is looked up by.
    #[test]
    fn builtin_theme_files_parse_and_match_their_names() {
        for name in BUILTIN_THEME_NAMES {
            let raw = builtin_theme_json(name).unwrap();
            let value: serde_json::Value = serde_json::from_str(raw).expect("valid JSON");
            assert_eq!(value["name"], *name);
            assert!(value["colors"].is_object(), "{name} has colors");
        }
    }
}
