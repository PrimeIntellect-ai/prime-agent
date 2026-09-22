//! Static system-prompt layers: human-editable markdown files assembled into
//! the cache-stable prefix of the prompt. The layers are, in order:
//!
//! 1. `core.md` — the harness description and the full programmatic-tool API
//!    surface (one tool: `ipython`; everything else lives in the REPL).
//! 2. `usage.md` — mandatory usage rules.
//! 3. `opinionated.md` — style and engineering guidelines users may override.
//! 4. `per_model.md` — the per-model instruction map (blocks keyed by model
//!    selector patterns; shipped empty, the mechanism is live).
//!
//! Layer files must never contain session-specific values: the cached
//! prefix ends where the dynamic tail (`system_prompt.rs`) begins, and the
//! cache-safety guard test pins that boundary.

/// The core harness layer (file `layers/core.md`).
pub const CORE_LAYER: &str = include_str!("layers/core.md");
/// The mandatory usage layer (file `layers/usage.md`).
pub const USAGE_LAYER: &str = include_str!("layers/usage.md");
/// The opinionated guidelines layer (file `layers/opinionated.md`).
pub const OPINIONATED_LAYER: &str = include_str!("layers/opinionated.md");
/// The per-model instruction map (file `layers/per_model.md`).
pub const PER_MODEL_MAP: &str = include_str!("layers/per_model.md");

/// Layer names, in assembly order, for breakdown rendering.
pub const LAYER_NAMES: [&str; 4] = ["core", "usage", "opinionated", "per-model"];

/// Source file of one layer (breakdown provenance).
pub fn layer_source(name: &str) -> Option<&'static str> {
    match name {
        "core" => Some("prompts/layers/core.md"),
        "usage" => Some("prompts/layers/usage.md"),
        "opinionated" => Some("prompts/layers/opinionated.md"),
        "per-model" => Some("prompts/layers/per_model.md"),
        _ => None,
    }
}

/// One per-model instruction block from the map file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PerModelBlock {
    /// Comma-separated selector patterns from the block header.
    pub patterns: Vec<String>,
    /// The instruction text between the markers.
    pub text: String,
}

/// Parse the per-model map. Blocks are delimited by
/// `<!-- pa:model: <patterns> -->` ... `<!-- /pa:model -->`; whitespace-only
/// blocks are ignored. Everything outside blocks (the format documentation)
/// is not prompt content.
pub fn parse_per_model_blocks(map: &str) -> Vec<PerModelBlock> {
    // Documentation comments (anything that is not a pa:model block) are
    // not prompt content; drop them before scanning for blocks so prose
    // examples cannot smuggle in markers.
    let map = strip_documentation_comments(map);
    const OPEN: &str = "<!-- pa:model:";
    const CLOSE: &str = "<!-- /pa:model -->";
    let mut blocks = Vec::new();
    let mut rest = map.as_str();
    while let Some(start) = rest.find(OPEN) {
        let after_open = &rest[start + OPEN.len()..];
        let Some(header_end) = after_open.find("-->") else {
            break;
        };
        let patterns = after_open[..header_end]
            .split(',')
            .map(str::trim)
            .filter(|pattern| !pattern.is_empty())
            .map(str::to_string)
            .collect::<Vec<_>>();
        let body = &after_open[header_end + 3..];
        let Some(end) = body.find(CLOSE) else { break };
        let text = body[..end].trim().to_string();
        if !text.is_empty() {
            blocks.push(PerModelBlock { patterns, text });
        }
        rest = &body[end + CLOSE.len()..];
    }
    blocks
}

/// Remove `<!-- ... -->` spans that are neither `pa:model` markers nor their
/// terminators.
fn strip_documentation_comments(map: &str) -> String {
    let mut out = String::with_capacity(map.len());
    let mut rest = map;
    while let Some(start) = rest.find("<!--") {
        out.push_str(&rest[..start]);
        let Some(end) = rest[start..].find("-->") else {
            // Unterminated comment: drop the remainder.
            return out;
        };
        let inner = &rest[start + 4..start + end];
        if inner.trim_start().starts_with("pa:model:") || inner.trim() == "/pa:model" {
            out.push_str(&rest[start..start + end + 3]);
        }
        rest = &rest[start + end + 3..];
    }
    out.push_str(rest);
    out
}

/// Wildcard match: `*` matches any run of characters, the rest matches
/// literally.
pub fn selector_matches(pattern: &str, selector: &str) -> bool {
    let mut parts = pattern.split('*');
    let mut rest = selector;
    let Some(first) = parts.next() else {
        return selector.is_empty();
    };
    if !rest.starts_with(first) {
        return false;
    }
    rest = &rest[first.len()..];
    for part in parts {
        if part.is_empty() {
            continue;
        }
        let Some(at) = rest.find(part) else {
            return false;
        };
        rest = &rest[at + part.len()..];
    }
    // A pattern ending in `*` matches the remainder; otherwise the pattern
    // must end exactly at the selector's end.
    pattern.ends_with('*') || rest.is_empty()
}

/// The per-model instructions that apply to `model` (a resolved
/// `provider/id` selector), in map order. `None` model selects blocks whose
/// patterns include `*`.
pub fn per_model_text(model: Option<&str>) -> Vec<String> {
    parse_per_model_blocks(PER_MODEL_MAP)
        .into_iter()
        .filter(|block| {
            model.is_some_and(|selector| {
                block
                    .patterns
                    .iter()
                    .any(|pattern| selector_matches(pattern, selector))
            })
        })
        .map(|block| block.text)
        .collect()
}

/// The cache-stable static prefix for `model`: the three constant layers plus
/// any matching per-model blocks, joined with blank lines. This is exactly
/// what a provider may cache; everything after it is session-specific.
pub fn static_prefix(model: Option<&str>) -> String {
    let mut parts: Vec<String> = vec![
        CORE_LAYER.trim().to_string(),
        USAGE_LAYER.trim().to_string(),
        OPINIONATED_LAYER.trim().to_string(),
    ];
    parts.extend(per_model_text(model));
    parts.join("\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn per_model_map_ships_empty() {
        // The shipped map documents the format but contains no instructions.
        assert!(parse_per_model_blocks(PER_MODEL_MAP).is_empty());
    }

    #[test]
    fn parses_blocks_and_matches_selectors() {
        let map = "<!-- pa:model: openai/gpt-5, anthropic/claude-* -->\nUse thinking mode.\n<!-- /pa:model -->\n<!-- pa:model: * -->\nFallback.\n<!-- /pa:model -->\n";
        let blocks = parse_per_model_blocks(map);
        assert_eq!(blocks.len(), 2);
        assert_eq!(
            blocks[0].patterns,
            vec!["openai/gpt-5", "anthropic/claude-*"]
        );
        assert_eq!(blocks[0].text, "Use thinking mode.");
        assert_eq!(blocks[1].patterns, vec!["*"]);
        assert!(selector_matches(
            "anthropic/claude-*",
            "anthropic/claude-4-sonnet"
        ));
        assert!(!selector_matches("anthropic/claude-*", "openai/gpt-5"));
        assert!(selector_matches("*", "anything"));
    }

    #[test]
    fn empty_blocks_are_ignored() {
        let map = "<!-- pa:model: * -->\n   \n<!-- /pa:model -->\n";
        assert!(parse_per_model_blocks(map).is_empty());
    }

    #[test]
    fn static_prefix_is_layer_composition() {
        let prefix = static_prefix(None);
        assert!(prefix.starts_with("# prime-agent harness"));
        assert!(prefix.contains("The following are mandatory rules"));
        assert!(prefix.contains("guidelines to agents have been shown"));
        // Exact composition: the three constant layers, no per-model text.
        assert_eq!(
            prefix,
            format!(
                "{}\n\n{}\n\n{}",
                CORE_LAYER.trim(),
                USAGE_LAYER.trim(),
                OPINIONATED_LAYER.trim()
            )
        );
    }
}
