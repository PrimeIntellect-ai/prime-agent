//! The skill-problems notice (`skill_problems`): a fresh root session whose
//! skill resolution found problems (an invalid skill file, or a skill that
//! lost a name collision) shows them once as a warning row. The row is
//! display-only and never reaches the model.

use pa_types::session::CustomMessage;

use crate::resources::SkillStatus;

pub const SKILL_PROBLEMS_CUSTOM_TYPE: &str = "skill_problems";

/// The warning row naming each problem skill, its file, and its state.
#[must_use]
pub fn notice_message(problems: &[SkillStatus]) -> CustomMessage {
    let mut lines = vec!["Some skills did not load:".to_string()];
    lines.extend(
        problems
            .iter()
            .map(|status| format!("- {} ({}): {}", status.name, status.path, status.describe())),
    );
    lines.push("Run `prime-agent skills` to list every skill and its state.".to_string());
    CustomMessage {
        custom_type: SKILL_PROBLEMS_CUSTOM_TYPE.to_string(),
        content: pa_types::ai::UserContent::Text(lines.join("\n")),
        display: true,
        details: None,
        timestamp: crate::session_engine::refine::now_millis(),
        rest: serde_json::Map::default(),
    }
}
