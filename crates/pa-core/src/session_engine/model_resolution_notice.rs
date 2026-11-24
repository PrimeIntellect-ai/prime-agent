//! The model-resolution notice (`model_resolution_warning`): a model
//! selection the catalog could not match exactly (a typo'd `--model` runs on
//! a made-up custom id) shows the resolver's warning once as a warning row.
//! The row is display-only and never reaches the model.

use pa_types::session::CustomMessage;

pub const MODEL_RESOLUTION_WARNING_CUSTOM_TYPE: &str = "model_resolution_warning";

#[must_use]
pub fn notice_message(warning: &str) -> CustomMessage {
    CustomMessage {
        custom_type: MODEL_RESOLUTION_WARNING_CUSTOM_TYPE.to_string(),
        content: pa_types::ai::UserContent::Text(warning.to_string()),
        display: true,
        details: None,
        timestamp: crate::session_engine::refine::now_millis(),
        rest: serde_json::Map::default(),
    }
}
