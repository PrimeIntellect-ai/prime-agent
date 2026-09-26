//! The Python-skills-unavailable notice (`python_skills_unavailable`).
//!
//! The kernel bootstrap pre-imports every configured Python skill; a broken
//! one (a missing dependency after a venv rebuild, a failed install, an
//! import-time error) stays behind a callable-looking placeholder that only
//! raises on first call. The bootstrap therefore reports failed imports
//! through the marker line ([`parse_unavailable_python_skills`]), and the
//! provisioner's `on_unavailable_skills` seam hands them here so the model
//! is told BEFORE it spends turns reading the skill's SKILL.md and calling
//! it — in every session shape, because the row rides the conversation.
//!
//! TS reference: PR #2381, `agent-session.ts` `_onPythonSkillsUnavailable`
//! (the `onUnavailableSkills` callback of `IpythonKernelProvisioner`),
//! delivered through `sendCustomMessage(..., { deliverAs: "nextTurn" })`.

use pa_types::session::CustomMessage;

use crate::kernel::bootstrap::UnavailablePythonSkills;

/// The notice's `customType` (TS `PYTHON_SKILLS_UNAVAILABLE_CUSTOM_TYPE`).
pub const PYTHON_SKILLS_UNAVAILABLE_CUSTOM_TYPE: &str = "python_skills_unavailable";

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis() as u64)
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

/// The next-turn notice row: display true, `details.skills` naming the
/// failed import names (TS `sendCustomMessage` with `deliverAs:
/// "nextTurn"` — the row rides the next admitted turn ahead of its
/// prompt).
pub fn notice_message(errors: &UnavailablePythonSkills) -> CustomMessage {
    CustomMessage {
        custom_type: PYTHON_SKILLS_UNAVAILABLE_CUSTOM_TYPE.to_string(),
        content: pa_types::ai::UserContent::Text(notice_content(errors)),
        display: true,
        details: Some(serde_json::json!({
            "skills": errors.iter().map(|(name, _)| name.clone()).collect::<Vec<_>>(),
        })),
        timestamp: now_millis(),
        rest: serde_json::Map::default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn errors() -> UnavailablePythonSkills {
        vec![
            ("websearch".to_string(), "No module named 'websearch'".to_string()),
            ("edit".to_string(), "boom".to_string()),
        ]
    }

    #[test]
    fn notice_names_each_failed_skill_and_its_error() {
        let message = notice_message(&errors());
        assert_eq!(message.custom_type, "python_skills_unavailable");
        assert!(message.display);
        assert_eq!(message.details, Some(serde_json::json!({ "skills": ["websearch", "edit"] })));
        let pa_types::ai::UserContent::Text(content) = &message.content else {
            panic!("text content");
        };
        assert_eq!(
            content,
            "[python-skills-unavailable]\n\nThese installed Python skill modules failed to import into the Python kernel, so calling them raises an error:\n- websearch: No module named 'websearch'\n- edit: boom\n\nTheir shell command forms fail the same way. Fix the import error first (for example install the missing dependency with `uv pip install <pkg>` or reinstall the skill into the kernel venv), or use another approach."
        );
    }
}
