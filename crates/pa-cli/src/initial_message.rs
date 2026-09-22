//! Initial message composition for non-interactive runs, ported from
//! `cli/initial-message.ts`.

/// The combined initial prompt for a run.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct InitialMessageResult {
    pub initial_message: Option<String>,
}

/// Combine stdin content, @file text, and the first CLI message into a single
/// initial prompt, mirroring `buildInitialMessage`. The first message is
/// consumed from `messages` in place.
pub fn build_initial_message(
    messages: &mut Vec<String>,
    file_text: Option<&str>,
    stdin_content: Option<&str>,
) -> InitialMessageResult {
    let mut parts: Vec<String> = Vec::new();
    if let Some(stdin_content) = stdin_content {
        parts.push(stdin_content.to_string());
    }
    if let Some(file_text) = file_text.filter(|text| !text.is_empty()) {
        parts.push(file_text.to_string());
    }
    if let Some(first) = messages.first() {
        parts.push(first.clone());
        messages.remove(0);
    }
    InitialMessageResult {
        initial_message: (!parts.is_empty()).then(|| parts.join("\n\n")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn combines_parts_with_blank_lines() {
        let mut messages = vec!["hello".to_string(), "world".to_string()];
        let result = build_initial_message(&mut messages, Some("file text"), Some("stdin text"));
        assert_eq!(
            result.initial_message.as_deref(),
            Some("stdin text\n\nfile text\n\nhello")
        );
        assert_eq!(messages, vec!["world"]);
    }

    #[test]
    fn empty_when_nothing_given() {
        let mut messages: Vec<String> = vec![];
        let result = build_initial_message(&mut messages, None, None);
        assert_eq!(result.initial_message, None);
    }
}
