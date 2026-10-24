//! Validate the complete response before applying an event-specific decision.
use anyhow::{bail, ensure};
use serde::Deserialize;

use super::config::Event;
use super::process::CommandOutput;
use super::HookOutcome;

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct HookResponse {
    system_message: Option<String>,
    decision: Option<String>,
    reason: Option<String>,
    #[serde(rename = "continue")]
    continue_processing: Option<bool>,
    stop_reason: Option<String>,
    suppress_output: Option<bool>,
    hook_specific_output: Option<Specific>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Specific {
    hook_event_name: String,
    permission_decision: Option<String>,
    permission_decision_reason: Option<String>,
}

pub(super) fn parse(event: Event, output: CommandOutput) -> anyhow::Result<HookOutcome> {
    let CommandOutput {
        stdout,
        stderr,
        code,
    } = output;
    if code == Some(2)
        && matches!(
            event,
            Event::PreToolUse | Event::UserPromptSubmit | Event::Stop
        )
    {
        let reason = String::from_utf8_lossy(&stderr).trim().to_string();
        ensure!(
            !reason.is_empty(),
            "exit 2 requires a nonempty reason on stderr"
        );
        return Ok(if event == Event::Stop {
            HookOutcome {
                continuation: Some(reason),
                ..Default::default()
            }
        } else {
            HookOutcome {
                deny: Some(reason),
                ..Default::default()
            }
        });
    }
    if code != Some(0) {
        let status = code.map_or_else(|| "a signal".to_string(), |code| format!("status {code}"));
        // The first stderr line names the cause in diagnostics, bounded.
        let stderr = String::from_utf8_lossy(&stderr);
        let detail: String = stderr
            .trim()
            .lines()
            .next()
            .unwrap_or_default()
            .chars()
            .take(200)
            .collect();
        if detail.is_empty() {
            bail!("command exited with {status}");
        }
        bail!("command exited with {status}: {detail}");
    }
    // SessionEnd is advisory: successful stdout has no contract, even JSON or non-UTF8.
    if event == Event::SessionEnd {
        return Ok(HookOutcome::default());
    }
    let stdout = std::str::from_utf8(&stdout)?.trim();
    if stdout.is_empty() {
        return Ok(HookOutcome::default());
    }
    if !stdout.starts_with(['{', '[']) {
        return match event {
            Event::PreToolUse | Event::PostToolUse | Event::PreCompact => {
                Ok(HookOutcome::default())
            }
            Event::SessionStart | Event::UserPromptSubmit => bail!(
                "plain-text developer context is not supported; return supported JSON controls"
            ),
            Event::Stop => bail!("Stop requires JSON output"),
            Event::SessionEnd => unreachable!("advisory output returned above"),
        };
    }
    let parsed: HookResponse = serde_json::from_str(stdout)?;
    let common_controls = matches!(
        event,
        Event::SessionStart | Event::UserPromptSubmit | Event::PreCompact | Event::Stop
    );
    ensure!(
        common_controls
            || (parsed.continue_processing.is_none()
                && parsed.stop_reason.is_none()
                && parsed.suppress_output.is_none()),
        "common control fields are unsupported for this event"
    );
    // suppressOutput is parsed but intentionally has no effect, as in Codex.
    let mut outcome = HookOutcome {
        message: parsed.system_message,
        ..Default::default()
    };
    if let Some(specific) = parsed.hook_specific_output {
        ensure!(
            specific.hook_event_name == event.name(),
            "hookEventName does not match the dispatched event"
        );
        ensure!(
            !matches!(event, Event::Stop | Event::PreCompact),
            "hookSpecificOutput is unsupported for this event"
        );
        match specific.permission_decision.as_deref() {
            Some("deny") if event == Event::PreToolUse => {
                let reason = specific.permission_decision_reason.unwrap_or_default();
                ensure!(!reason.trim().is_empty(), "permissionDecision:deny requires a nonempty permissionDecisionReason");
                outcome.deny = Some(reason.trim().to_string());
            }
            Some("allow") if event == Event::PreToolUse => bail!("permissionDecision:allow requires updatedInput, which this subset does not support"),
            None if specific.permission_decision_reason.is_none() => {}
            Some(_) | None => bail!("unsupported permission decision for this event"),
        }
    }
    if let Some(decision) = parsed.decision.as_deref() {
        ensure!(
            matches!(
                event,
                Event::PreToolUse | Event::UserPromptSubmit | Event::Stop
            ) && decision == "block",
            "unsupported hook decision for this event"
        );
        if parsed.continue_processing != Some(false) {
            let reason = parsed.reason.as_deref().unwrap_or_default().trim();
            ensure!(
                !reason.is_empty(),
                "decision:block requires a nonempty reason"
            );
            let reason = reason.to_string();
            if event == Event::Stop {
                outcome.continuation = Some(reason);
            } else if outcome.deny.is_none() {
                outcome.deny = Some(reason);
            }
        }
    } else {
        ensure!(
            parsed.reason.is_none(),
            "hook reason requires decision:block"
        );
    }
    if parsed.continue_processing == Some(false) {
        outcome.stop = Some(
            parsed
                .stop_reason
                .unwrap_or_else(|| format!("{} hook stopped execution", event.name())),
        );
        outcome.continuation = None;
        outcome.deny = None;
    }
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn output(value: &str) -> CommandOutput {
        CommandOutput {
            stdout: value.as_bytes().to_vec(),
            stderr: Vec::new(),
            code: Some(0),
        }
    }

    #[test]
    fn event_specific_controls_and_precedence() {
        for event in [
            Event::SessionStart,
            Event::UserPromptSubmit,
            Event::PreCompact,
            Event::Stop,
        ] {
            assert_eq!(
                parse(event, output(r#"{"suppressOutput":true}"#)).unwrap(),
                HookOutcome::default()
            );
            assert_eq!(
                parse(event, output(r#"{"continue":false,"stopReason":"halt"}"#)).unwrap(),
                HookOutcome {
                    stop: Some("halt".into()),
                    ..Default::default()
                }
            );
        }
        for event in [Event::UserPromptSubmit, Event::Stop] {
            assert!(parse(event, output(r#"{"decision":"block"}"#)).is_err());
            assert!(parse(event, output(r#"{"decision":"block","reason":" "}"#)).is_err());
            assert!(
                parse(event, output(r#"{"decision":"block","continue":false}"#))
                    .unwrap()
                    .stop
                    .is_some()
            );
        }
        assert_eq!(
            parse(
                Event::Stop,
                output(r#"{"decision":"block","reason":"retry"}"#)
            )
            .unwrap(),
            HookOutcome {
                continuation: Some("retry".into()),
                ..Default::default()
            }
        );
        assert_eq!(
            parse(
                Event::UserPromptSubmit,
                output(r#"{"decision":"block","reason":"reject"}"#)
            )
            .unwrap(),
            HookOutcome {
                deny: Some("reject".into()),
                ..Default::default()
            }
        );
    }

    #[test]
    fn exit_two_is_event_specific_and_end_stdout_is_ignored() {
        for event in [
            Event::SessionStart,
            Event::PreCompact,
            Event::SessionEnd,
            Event::PostToolUse,
        ] {
            assert!(parse(
                event,
                CommandOutput {
                    code: Some(2),
                    stderr: b"reason".to_vec(),
                    stdout: Vec::new()
                }
            )
            .is_err());
        }
        for event in [Event::Stop, Event::UserPromptSubmit] {
            assert!(parse(
                event,
                CommandOutput {
                    code: Some(2),
                    stderr: b" ".to_vec(),
                    stdout: Vec::new()
                }
            )
            .is_err());
            let result = parse(
                event,
                CommandOutput {
                    code: Some(2),
                    stderr: b"reason".to_vec(),
                    stdout: b"ignored".to_vec(),
                },
            )
            .unwrap();
            assert!(result.deny.is_some() || result.continuation.is_some());
        }
        assert_eq!(
            parse(
                Event::SessionEnd,
                CommandOutput {
                    code: Some(0),
                    stderr: Vec::new(),
                    stdout: vec![255]
                }
            )
            .unwrap(),
            HookOutcome::default()
        );
    }

    #[test]
    fn unsupported_output_is_rejected_atomically() {
        for value in [
            r#"{"decision":"block","reason":"stop","continue":false}"#,
            r#"{"hookSpecificOutput":{"hookEventName":"PreToolUse","updatedInput":{}}}"#,
            r#"{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"x"}}"#,
            r#"{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask"}}"#,
            "{",
            "[]",
        ] {
            assert!(parse(Event::PreToolUse, output(value)).is_err());
        }
        for event in [Event::SessionStart, Event::UserPromptSubmit, Event::Stop] {
            assert!(parse(event, output("context")).is_err());
        }
        for event in [Event::PreToolUse, Event::PostToolUse, Event::PreCompact] {
            assert_eq!(
                parse(event, output("ignored")).unwrap(),
                HookOutcome::default()
            );
        }
        assert!(parse(
            Event::PreCompact,
            output(r#"{"decision":"block","reason":"x"}"#)
        )
        .is_err());
        assert!(parse(
            Event::Stop,
            output(r#"{"hookSpecificOutput":{"hookEventName":"Stop"}}"#)
        )
        .is_err());
    }

    #[test]
    fn pre_output_requires_reasons_and_cannot_authorize() {
        for value in [
            r#"{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}"#,
            r#"{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny"}}"#,
            r#"{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":" "}}"#,
            r#"{"decision":"block"}"#,
            r#"{"decision":"block","reason":" "}"#,
            r#"{"decision":"approve","hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"deny"}}"#,
        ] {
            assert!(parse(Event::PreToolUse, output(value)).is_err());
        }
        assert!(parse(
            Event::PreToolUse,
            CommandOutput {
                code: Some(2),
                stderr: Vec::new(),
                stdout: Vec::new()
            }
        )
        .is_err());
        let result = parse(
            Event::PreToolUse,
            output(r#"{"decision":"block","reason":"deny"}"#),
        )
        .unwrap();
        assert_eq!(result.deny.as_deref(), Some("deny"));
        assert!(parse(
            Event::PostToolUse,
            output(r#"{"decision":"block","reason":"deny"}"#)
        )
        .is_err());
    }
}
