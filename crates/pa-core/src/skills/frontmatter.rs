//! YAML frontmatter parsing. Port of utils/frontmatter.ts.

use serde_json::Value;

fn normalize_newlines(value: &str) -> String {
    value
        .trim_start_matches('\u{feff}')
        .replace("\r\n", "\n")
        .replace('\r', "\n")
}

fn extract_frontmatter(content: &str) -> (Option<String>, String) {
    let normalized = normalize_newlines(content);
    if !normalized.starts_with("---") {
        return (None, normalized);
    }
    let Some(end_index) = normalized[3..].find("\n---") else {
        return (None, normalized);
    };
    // end_index is relative to offset 3; the body starts after "\n---" (4 chars
    // from the find position).
    let yaml = normalized[4..end_index + 3].to_string();
    let body = normalized[end_index + 3 + 4..].trim().to_string();
    (Some(yaml), body)
}

/// Parse `---` YAML frontmatter into a JSON object plus the body.
pub fn parse_frontmatter(content: &str) -> (Value, String) {
    let (yaml_string, body) = extract_frontmatter(content);
    let Some(yaml_string) = yaml_string else {
        return (serde_json::Map::new().into(), body);
    };
    let parsed: serde_yaml::Value = match serde_yaml::from_str(&yaml_string) {
        Ok(parsed) => parsed,
        Err(_) => return (serde_json::Map::new().into(), body),
    };
    let converted = serde_json::to_value(parsed).unwrap_or_else(|_| serde_json::Map::new().into());
    let frontmatter = if converted.is_null() {
        serde_json::Map::new().into()
    } else {
        converted
    };
    (frontmatter, body)
}

/// The body with frontmatter stripped.
pub fn strip_frontmatter(content: &str) -> String {
    parse_frontmatter(content).1
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_simple_frontmatter() {
        let (frontmatter, body) =
            parse_frontmatter("---\nname: my-skill\ndescription: A skill\n---\nUse it well.");
        assert_eq!(frontmatter["name"], "my-skill");
        assert_eq!(frontmatter["description"], "A skill");
        assert_eq!(body, "Use it well.");
    }

    #[test]
    fn no_frontmatter_returns_body() {
        let (frontmatter, body) = parse_frontmatter("Just text");
        assert!(frontmatter.as_object().unwrap().is_empty());
        assert_eq!(body, "Just text");
    }

    #[test]
    fn unterminated_frontmatter_returns_body() {
        let (frontmatter, body) = parse_frontmatter("---\nname: x\nno end");
        assert!(frontmatter.as_object().unwrap().is_empty());
        assert_eq!(body, "---\nname: x\nno end");
    }

    #[test]
    fn crlf_and_bom_normalized() {
        let (frontmatter, _) = parse_frontmatter("\u{feff}---\r\nname: x\r\n---\r\nbody");
        assert_eq!(frontmatter["name"], "x");
    }
}
