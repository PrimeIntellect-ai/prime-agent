//! `/new` argument parsing (TS `new-session-command.ts`): the `--name`
//! option plus the verbatim initial prompt, with `--` separating the two.

/// A parsed `/new` suffix: the `--name` value and the initial prompt, both
/// verbatim (never trimmed).
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct NewSessionCommand {
    pub(crate) name: Option<String>,
    pub(crate) prompt: Option<String>,
}

/// Parse the raw suffix after the `/new` command name
/// (TS `parseNewSessionCommand`).
pub(crate) fn parse_new_session_command(raw_args: &str) -> Result<NewSessionCommand, String> {
    if raw_args.is_empty() {
        return Ok(NewSessionCommand::default());
    }
    let args = consume_new_separator(raw_args, "Expected whitespace after /new")?;
    if !args.starts_with('-') {
        return Ok(NewSessionCommand {
            name: None,
            prompt: Some(args.to_string()),
        });
    }
    if starts_with_token(args, "--") {
        let prompt = require_new_prompt(&args["--".len()..])?;
        return Ok(NewSessionCommand {
            name: None,
            prompt: Some(prompt),
        });
    }
    if !starts_with_token(args, "--name") {
        let option = first_word(args);
        return Err(format!("Unknown /new option: {option}"));
    }
    let rest = consume_new_separator(
        &args["--name".len()..],
        "Missing value for /new option \"--name\"",
    )?;
    if starts_with_token(rest, "--name") {
        return Err("Duplicate /new option: \"--name\"".to_string());
    }
    if rest.is_empty() || rest.starts_with('-') {
        return Err("Missing value for /new option \"--name\"".to_string());
    }
    let (name, rest) = split_name(rest)?;
    if name.trim().is_empty() {
        return Err("/new option \"--name\" cannot be empty".to_string());
    }
    if rest.is_empty() {
        return Ok(NewSessionCommand {
            name: Some(name),
            prompt: None,
        });
    }
    let rest = consume_new_separator(rest, "Expected \"--\" before the /new prompt")?;
    if starts_with_token(rest, "--name") {
        return Err("Duplicate /new option: \"--name\"".to_string());
    }
    if !starts_with_token(rest, "--") {
        if rest.starts_with('-') {
            let option = first_word(rest);
            return Err(format!("Unknown /new option: {option}"));
        }
        return Err("Expected \"--\" before the /new prompt".to_string());
    }
    let prompt = require_new_prompt(&rest["--".len()..])?;
    Ok(NewSessionCommand {
        name: Some(name),
        prompt: Some(prompt),
    })
}

/// TS `consumeNewSeparator`: any run of spaces/tabs, then at most one
/// newline — a zero-length consumption is the given error.
fn consume_new_separator<'a>(value: &'a str, error: &str) -> Result<&'a str, String> {
    let trimmed = value.trim_start_matches([' ', '\t']);
    let offset = value.len() - trimmed.len();
    let offset = if trimmed.starts_with("\r\n") {
        offset + 2
    } else if trimmed.starts_with('\n') || trimmed.starts_with('\r') {
        offset + 1
    } else {
        offset
    };
    if offset == 0 {
        return Err(error.to_string());
    }
    Ok(&value[offset..])
}

/// TS `requireNewPrompt`: a separator, then a prompt with non-whitespace
/// content, returned verbatim.
fn require_new_prompt(value: &str) -> Result<String, String> {
    let prompt = consume_new_separator(value, "Missing prompt after /new \"--\"")?;
    if prompt.trim().is_empty() {
        return Err("Missing prompt after /new \"--\"".to_string());
    }
    Ok(prompt.to_string())
}

/// TS's `/^<token>(?:\s|$)/` checks: the token starts the value and is
/// followed by whitespace or the end.
fn starts_with_token(value: &str, token: &str) -> bool {
    value
        .strip_prefix(token)
        .is_some_and(|rest| rest.is_empty() || rest.starts_with(char::is_whitespace))
}

/// TS `args.match(/^\S+/)?.[0] ?? args`: the first non-whitespace run.
fn first_word(value: &str) -> &str {
    value
        .find(char::is_whitespace)
        .map_or(value, |end| &value[..end])
}

/// The `--name` value: quoted (the quote pair preserved spaces) or the first
/// word, with the remainder after it.
fn split_name(rest: &str) -> Result<(String, &str), String> {
    if let Some(quote @ ('"' | '\'')) = rest.chars().next() {
        let Some(closing) = rest[1..].find(quote) else {
            return Err("Unterminated quote in /new --name".to_string());
        };
        Ok((rest[1..=closing].to_string(), &rest[closing + 2..]))
    } else {
        let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
        Ok((rest[..end].to_string(), &rest[end..]))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_names_prompts_and_errors_like_ts() {
        let ok = [
            (
                " write a\n  multiline prompt  ",
                NewSessionCommand {
                    name: None,
                    prompt: Some("write a\n  multiline prompt  ".to_string()),
                },
            ),
            (
                " --name stable",
                NewSessionCommand {
                    name: Some("stable".to_string()),
                    prompt: None,
                },
            ),
            (
                " --name \"stable name\" --  \n  --keep\nformat  ",
                NewSessionCommand {
                    name: Some("stable name".to_string()),
                    prompt: Some("  --keep\nformat  ".to_string()),
                },
            ),
            // The bare `--` form the TS wiring depends on.
            (
                " -- prompt",
                NewSessionCommand {
                    name: None,
                    prompt: Some("prompt".to_string()),
                },
            ),
            // The bare `/new`.
            ("", NewSessionCommand::default()),
        ];
        for (raw, expected) in ok {
            assert_eq!(parse_new_session_command(raw), Ok(expected), "raw: {raw:?}");
        }
        let errors = [
            (" --name", "Missing value for /new option \"--name\""),
            (
                " --name \"one\" --name \"two\"",
                "Duplicate /new option: \"--name\"",
            ),
            (" --other value", "Unknown /new option: --other"),
            (" --name \"broken", "Unterminated quote in /new --name"),
            (" --name x prompt", "Expected \"--\" before the /new prompt"),
        ];
        for (raw, expected) in errors {
            assert_eq!(
                parse_new_session_command(raw),
                Err(expected.to_string()),
                "raw: {raw:?}"
            );
        }
    }
}
