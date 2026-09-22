//! Resource diagnostics shared by skill and resource loading.
//! Port of core/diagnostics.ts.

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResourceCollision {
    pub resource_type: &'static str,
    pub name: String,
    pub winner_path: String,
    pub loser_path: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ResourceDiagnostic {
    Warning {
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        path: Option<String>,
    },
    Error {
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        path: Option<String>,
    },
    Collision {
        message: String,
        path: String,
        collision: ResourceCollision,
    },
}
