//! `OpenCode` routing identity is conversation-scoped, independently of prompt caching.

pub(super) fn apply(headers: &mut Vec<(String, String)>, provider: &str, session_id: Option<&str>) {
    if !matches!(provider, "opencode" | "opencode-go") {
        return;
    }
    for (name, value) in [
        ("User-Agent", Some("prime-agent")),
        ("x-opencode-session", session_id),
    ] {
        let Some(value) = value.filter(|value| !value.trim().is_empty()) else {
            continue;
        };
        if !headers
            .iter()
            .any(|(existing, _)| existing.eq_ignore_ascii_case(name))
        {
            headers.push((name.to_string(), value.to_string()));
        }
    }
}
