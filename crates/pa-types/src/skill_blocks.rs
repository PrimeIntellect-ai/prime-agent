//! The skill-invocation block format. Port of `core/skill-blocks.ts`: the
//! `<skill name="..." location="...">...</skill>` wrapper the session
//! engine expands `/skill:<name>` submissions into, and the parse the
//! renderers use to pull that block back out of a persisted user message.
//!
//! Pure data and pure functions only, like the slash-command table: the
//! session engine (pa-core) builds the block, every surface that renders
//! user messages (the TUI live and replay paths) parses it, so the format
//! lives in the shared crate.

/// A parsed skill block from a user message.
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedSkillBlock {
    /// The invoked skill's name (`<skill name="...">`).
    pub name: String,
    /// The skill file path (`<skill location="...">`).
    pub location: String,
    /// The block body (the skill content, frontmatter stripped).
    pub content: String,
    /// The user text that followed the block (`None` when the submission
    /// carried no arguments).
    pub user_message: Option<String>,
}

/// The block opener both sides emit byte-identically (TS
/// `AgentSession._expandSkillCommand`).
const BLOCK_OPEN: &str = "<skill name=\"";

/// Parse a skill block from message text.
///
/// Mirrors the TS `parseSkillBlock` anchored match: the text must BE one
/// block (`^<skill name="..." location="...">\n[body]\n</skill>`), with an
/// optional `\n\n`-separated user message after it. Like the TS regex's
/// non-greedy body group, the body closes at the FIRST `\n</skill>` whose
/// tail can still satisfy the match (empty, or `\n\n` plus trailing text);
/// a body containing earlier close tags keeps them. Returns `None` when
/// the text is not a skill block.
pub fn parse_skill_block(text: &str) -> Option<ParsedSkillBlock> {
    let rest = text.strip_prefix(BLOCK_OPEN)?;
    let (name, rest) = rest.split_once('"')?;
    let rest = rest.strip_prefix(" location=\"")?;
    let (location, rest) = rest.split_once('"')?;
    let body = rest.strip_prefix(">\n")?;
    let close = "\n</skill>";
    let mut search_from = 0usize;
    loop {
        let end = body[search_from..].find(close)? + search_from;
        let tail = &body[end + close.len()..];
        // The TS match after the close tag: end of text, or the
        // `\n\n`-separated user message (`([\s\S]+)`, so the trailing
        // text must be non-empty for the occurrence to win).
        let user_message = match tail.strip_prefix("\n\n") {
            Some(trailing) if !trailing.is_empty() => {
                let trimmed = trailing.trim();
                (!trimmed.is_empty()).then(|| trimmed.to_string())
            }
            _ if tail.is_empty() => None,
            // This close tag cannot satisfy the anchored match; the TS
            // regex extends its non-greedy body past it.
            _ => {
                search_from = end + 1;
                continue;
            }
        };
        return Some(ParsedSkillBlock {
            name: name.to_string(),
            location: location.to_string(),
            content: body[..end].to_string(),
            user_message,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_block_without_user_message() {
        let text = "<skill name=\"websearch\" location=\"/skills/websearch/SKILL.md\">\nReferences are relative to /skills/websearch.\n\nRun a search.\n</skill>";
        let parsed = parse_skill_block(text).expect("parses");
        assert_eq!(
            parsed,
            ParsedSkillBlock {
                name: "websearch".to_string(),
                location: "/skills/websearch/SKILL.md".to_string(),
                content: "References are relative to /skills/websearch.\n\nRun a search."
                    .to_string(),
                user_message: None,
            }
        );
    }

    #[test]
    fn parses_block_with_user_message() {
        let text = "<skill name=\"edit\" location=\"/e/SKILL.md\">\nUse it.\n</skill>\n\nfix the bug in src/main.rs";
        let parsed = parse_skill_block(text).expect("parses");
        assert_eq!(parsed.name, "edit");
        assert_eq!(parsed.content, "Use it.");
        assert_eq!(
            parsed.user_message.as_deref(),
            Some("fix the bug in src/main.rs")
        );
    }

    #[test]
    fn a_whitespace_only_user_message_is_none() {
        // TS: `match[4]?.trim() || undefined`.
        let text = "<skill name=\"edit\" location=\"/e/SKILL.md\">\nUse it.\n</skill>\n\n   ";
        let parsed = parse_skill_block(text).expect("parses");
        assert_eq!(parsed.user_message, None);
    }

    #[test]
    fn rejects_non_block_text() {
        // Plain prompts and partial blocks never parse: the TS match is
        // anchored to the whole text.
        for text in [
            "",
            "hello world",
            "/skill:websearch run a search",
            "<skill name=\"x\" location=\"/x\">\nbody\n",
            "prefix <skill name=\"x\" location=\"/x\">\nb\n</skill>",
            "<skill name=\"x\" location=\"/x\">\nb\n</skill> trailing",
            "<skill name=\"x\" location=\"/x\">\nb\n</skill>\nsingle-newline tail",
            // The trailing user-message group needs content: a block
            // ending with exactly the separator does not match.
            "<skill name=\"x\" location=\"/x\">\nb\n</skill>\n\n",
        ] {
            assert!(parse_skill_block(text).is_none(), "parsed {text:?}");
        }
    }

    #[test]
    fn the_body_keeps_close_tags_the_tail_cannot_absorb() {
        // The non-greedy TS body group extends past a close tag whose tail
        // cannot satisfy the anchored match; a LATER close tag with a valid
        // tail wins instead.
        let nested = "<skill name=\"x\" location=\"/x\">\nkeep \n</skill> inner\n</skill>";
        let parsed = parse_skill_block(nested).expect("parses");
        assert_eq!(parsed.content, "keep \n</skill> inner");
        assert_eq!(parsed.user_message, None);
        let with_args = "<skill name=\"x\" location=\"/x\">\nb\n</skill>\nkeep2\n</skill>\n\nargs";
        let parsed = parse_skill_block(with_args).expect("parses");
        assert_eq!(parsed.content, "b\n</skill>\nkeep2");
        assert_eq!(parsed.user_message.as_deref(), Some("args"));
    }
}
