//! nano-rlm-compatible cumulative semantic edges in ACP response metadata.

use pa_types::daemon::DaemonCommand;
use serde_json::{Map, Value};

use super::daemon::DaemonLink;

pub(super) const SEMANTIC_EDGES_METADATA_KEY: &str = "ai.prime.acp/semantic-edges-v1";

pub(super) async fn snapshot(link: &DaemonLink, session_id: &str) -> anyhow::Result<Value> {
    let response = link
        .request(DaemonCommand::GetSemanticEdges {
            id: None,
            active_session_id: session_id.to_string(),
            rest: Map::default(),
        })
        .await?;
    if !response.success {
        anyhow::bail!(
            "{}",
            response
                .error
                .unwrap_or_else(|| "semantic-edge snapshot failed".to_string())
        );
    }
    response
        .data
        .ok_or_else(|| anyhow::anyhow!("semantic-edge snapshot missing"))
}

pub(super) fn attach(result: &mut Value, edges: Value) {
    let meta = result
        .as_object_mut()
        .expect("ACP result is an object")
        .entry("_meta")
        .or_insert_with(|| Value::Object(Map::new()));
    meta.as_object_mut()
        .expect("ACP metadata is an object")
        .insert(SEMANTIC_EDGES_METADATA_KEY.to_string(), edges);
}
