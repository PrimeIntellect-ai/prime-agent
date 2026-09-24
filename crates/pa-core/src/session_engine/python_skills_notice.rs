//! The failed-skill-import notice (`python_skills_unavailable`).
//!
//! A pre-imported Python skill can fail to import into a freshly started
//! kernel (a broken dependency after a venv rebuild, a
//! `PRIME_AGENT_KERNEL_PYTHON` override without the skill installed, a
//! failed `uv pip install` in the venv sync). The bootstrap guard already
//! replaces every broken import with a placeholder that raises on call —
//! but the system prompt still advertises the skill, so the model reads
//! its SKILL.md, plans around it, and only learns of the breakage on its
//! first call. The runtime bootstrap ends its import loop by printing one
//! marker line (the JSON report [`crate::kernel::PYTHON_SKILL_IMPORT_ERROR_REPORT_MARKER`]);
//! the provisioner parses it after a successful bootstrap and reports it
//! here, and the notice rides the next admitted turn ahead of its prompt
//! so the model learns before it spends turns calling unavailable skills.
//!
//! TS reference: `agent-session.ts` `_onPythonSkillsUnavailable` (the
//! `onUnavailableSkills` callback of the kernel provisioner), delivered
//! through `sendCustomMessage(..., { deliverAs: "nextTurn" })`; the
//! marker + parser live beside the bootstrap codegen (TS
//! `tools/ipython.ts`, `parseUnavailablePythonSkills`).

use std::collections::BTreeMap;

use pa_types::session::CustomMessage;

/// The notice's `customType` (TS `PYTHON_SKILLS_UNAVAILABLE_CUSTOM_TYPE`).
pub const PYTHON_SKILLS_UNAVAILABLE_CUSTOM_TYPE: &str = "python_skills_unavailable";

/// Import errors of the pre-imported Python skills that failed to import
/// into the kernel (skill import name -> import error), parsed from a
/// bootstrap cell's stdout (TS `UnavailablePythonSkills`). Ordered
/// (`BTreeMap`): the notice's skill lines render deterministically.
pub type UnavailablePythonSkills = BTreeMap<String, String>;

/// Extract the unavailable-skill report a bootstrap cell printed, or
/// `None` when the marker is absent, the JSON is malformed or not an
/// object, or no entry carries a non-empty error (TS
/// `parseUnavailablePythonSkills`).
pub fn parse_unavailable_python_skills(stdout: &str) -> Option<UnavailablePythonSkills> {
    let at = stdout.find(crate::kernel::PYTHON_SKILL_IMPORT_ERROR_REPORT_MARKER)?;
    let raw = stdout[at + crate::kernel::PYTHON_SKILL_IMPORT_ERROR_REPORT_MARKER.len()..].trim();
    let parsed: serde_json::Map<String, serde_json::Value> = serde_json::from_str(raw).ok()?;
    let mut errors = UnavailablePythonSkills::new();
    for (name, error) in parsed {
        if let serde_json::Value::String(error) = error {
            if !error.is_empty() {
                errors.insert(name, error);
            }
        }
    }
    (!errors.is_empty()).then_some(errors)
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

/// The notice text (TS `_onPythonSkillsUnavailable`'s builder): the
/// `[python-skills-unavailable]` header, the per-skill import errors, and
/// the fix hint.
pub fn notice_content(errors: &UnavailablePythonSkills) -> String {
    let mut lines = vec!["[python-skills-unavailable]".to_string(), String::new()];
    lines.push(
        "These installed Python skill modules failed to import into the Python kernel, so calling them raises an error:".to_string(),
    );
    for (name, error) in errors {
        lines.push(format!("- {name}: {error}"));
    }
    lines.push(String::new());
    lines.push(
        "Their shell command forms fail the same way. Fix the import error first (for example install the missing dependency with `uv pip install <pkg>` or reinstall the skill into the kernel venv), or use another approach.".to_string(),
    );
    lines.join("\n")
}

/// The next-turn notice row: display true, `details.skills` listing the
/// failed imports (TS `sendCustomMessage` with `deliverAs: "nextTurn"` —
/// the row rides the next admitted turn ahead of its prompt).
pub fn notice_message(errors: &UnavailablePythonSkills) -> CustomMessage {
    CustomMessage {
        custom_type: PYTHON_SKILLS_UNAVAILABLE_CUSTOM_TYPE.to_string(),
        content: pa_types::ai::UserContent::Text(notice_content(errors)),
        display: true,
        details: Some(serde_json::json!({
            "skills": errors.keys().cloned().collect::<Vec<String>>(),
        })),
        timestamp: now_millis(),
        rest: Default::default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MARKER: &str = crate::kernel::PYTHON_SKILL_IMPORT_ERROR_REPORT_MARKER;

    // TS test/ipython-bootstrap.test.ts's table: marker+JSON, noise-prefixed,
    // no marker, non-JSON, empty dict.
    #[test]
    fn parses_marker_and_json() {
        let parsed = parse_unavailable_python_skills(&format!(
            "{MARKER}{{\"websearch\":\"No module named 'websearch'\"}}\n"
        ));
        assert_eq!(
            parsed,
            Some(
                [(
                    "websearch".to_string(),
                    "No module named 'websearch'".to_string()
                )]
                .into_iter()
                .collect()
            )
        );
    }

    #[test]
    fn parses_after_noise() {
        let parsed =
            parse_unavailable_python_skills(&format!("noise\n{MARKER}{{\"edit\":\"boom\"}}"));
        assert_eq!(
            parsed,
            Some(
                [("edit".to_string(), "boom".to_string())]
                    .into_iter()
                    .collect()
            )
        );
    }

    #[test]
    fn missing_marker_is_none() {
        assert_eq!(
            parse_unavailable_python_skills("some unrelated kernel output"),
            None
        );
    }

    #[test]
    fn non_json_is_none() {
        assert_eq!(
            parse_unavailable_python_skills(&format!("{MARKER}not json")),
            None
        );
    }

    #[test]
    fn empty_dict_is_none() {
        assert_eq!(
            parse_unavailable_python_skills(&format!("{MARKER}{{}}")),
            None
        );
    }

    #[test]
    fn non_string_and_empty_errors_drop_out() {
        // A non-string value and an empty message drop; a non-empty one survives.
        let parsed = parse_unavailable_python_skills(&format!(
            "{MARKER}{{\"edit\":\"boom\",\"bad\":42,\"empty\":\"\"}}"
        ));
        assert_eq!(
            parsed,
            Some(
                [("edit".to_string(), "boom".to_string())]
                    .into_iter()
                    .collect()
            )
        );
    }

    #[test]
    fn notice_row_lists_skills_and_errors() {
        let errors: UnavailablePythonSkills = [
            (
                "websearch".to_string(),
                "No module named 'websearch'".to_string(),
            ),
            ("edit".to_string(), "boom".to_string()),
        ]
        .into_iter()
        .collect();
        let message = notice_message(&errors);
        assert_eq!(message.custom_type, PYTHON_SKILLS_UNAVAILABLE_CUSTOM_TYPE);
        assert!(message.display);
        // The map is ordered (`BTreeMap`): the skill lines and the details
        // list render deterministically, sorted by import name.
        assert_eq!(
            message.details,
            Some(serde_json::json!({ "skills": ["edit", "websearch"] }))
        );
        let pa_types::ai::UserContent::Text(content) = &message.content else {
            panic!("text content");
        };
        assert_eq!(
            content,
            "[python-skills-unavailable]\n\nThese installed Python skill modules failed to import into the Python kernel, so calling them raises an error:\n- edit: boom\n- websearch: No module named 'websearch'\n\nTheir shell command forms fail the same way. Fix the import error first (for example install the missing dependency with `uv pip install <pkg>` or reinstall the skill into the kernel venv), or use another approach."
        );
    }
}
