//! The one-shot daemon/worker event trackers (moved with their concern):
//! the `daemon event` and `model refused` one-shot surfaces the supervisor
//! notes/adoption/sessions and model-allowlist seams call once per lifecycle
//! event. Counts/categories only, never session payload (the module's
//! privacy contract).
use super::{base_properties, model_category, provider_category, TelemetryClient, Value};

/// Track the supervision summary (`daemon event`, kind `summary`): the
/// frequent supervision events of one window as `<kind>_count`
/// properties. Kinds and counts only, never session payload.
pub fn track_daemon_event_summary(
    client: &TelemetryClient,
    window_ms: u64,
    counts: &std::collections::BTreeMap<String, u64>,
    saved_sessions_usage_rows_max: u64,
) {
    let mut properties = base_properties("daemon");
    properties.set("kind", Value::from("summary"));
    properties.set("window_ms", Value::from(window_ms));
    for (key, count) in counts {
        properties.set(key, Value::from(*count));
    }
    if counts.contains_key("saved_sessions_list_count") {
        properties.set(
            "saved_sessions_usage_rows_max",
            Value::from(saved_sessions_usage_rows_max),
        );
    }
    client.track("daemon event", properties);
}

/// Track a deleted subagent's durable usage capture (`daemon event`,
/// kind `deleted_child_usage_captured`): the deletion lifecycle's
/// adoption backbone — how many tombstoned edges received the usage
/// amendment that keeps a deleted child's spend billable after its
/// transcript goes. Source and count only, never the spend values.
pub fn track_deleted_child_usage_captured(client: &TelemetryClient, source: &str, count: usize) {
    let mut properties = base_properties("daemon");
    properties.set("kind", Value::from("deleted_child_usage_captured"));
    properties.set("source", Value::from(source));
    properties.set("count", Value::from(count));
    client.track("daemon event", properties);
}

/// Track a daemon model-allowlist refusal (`model refused`, schema v1):
/// a daemon model resolution (the `set_model` command, an RLM
/// spawn/`create_session` resolution, or the worker's startup model chain)
/// refused a model outside the settings `allowedModels` allowlist.
/// Categories and surface only — never the refused selector, pattern
/// content, or session payload (the `daemon event` catalog-refresh rule:
/// no model ids).
pub fn track_model_refused(
    client: &TelemetryClient,
    surface: &str,
    provider: &str,
    model_id: &str,
) {
    let mut properties = base_properties("daemon");
    properties.set("surface", Value::from(surface));
    properties.set(
        "provider_category",
        Value::from(provider_category(Some(provider))),
    );
    properties.set("model_category", Value::from(model_category(model_id)));
    client.track("model refused", properties);
}

/// Track one image-turn delegation's outcome (`image delegation`, schema
/// 2, the telemetry worker's locked interface): the delegating parent
/// session's id and the outcome only — never child ids, model ids, or
/// prompt/answer content.
pub fn track_image_delegation(client: &TelemetryClient, session_id: &str, outcome: &str) {
    let mut properties = base_properties("daemon");
    properties.set("session_id", Value::from(session_id));
    properties.set("outcome", Value::from(outcome));
    client.track("image delegation", properties);
}

/// Track the disk-archive sweep's `daemon event` (schema v1, kind
/// `sessions_archived`): a count only, never session payload.
pub fn track_sessions_archived(client: &TelemetryClient, count: usize) {
    let mut properties = base_properties("daemon");
    properties.set("kind", Value::from("sessions_archived"));
    properties.set("count", Value::from(count));
    client.track("daemon event", properties);
}

/// Track the boot descriptor-adoption pass's `daemon event` (schema v1,
/// kind `worker_adoption`): the boot kind and per-outcome counts, never
/// session payload. `skipped_idle` counts the dead descriptors the durable
/// busy-evidence filter parked (plain boots only; update boots revive every
/// kept worker ahead of the roster restore).
pub fn track_worker_adoption(
    client: &TelemetryClient,
    boot: &str,
    adopted_live: usize,
    revived: usize,
    skipped_idle: usize,
    stopped: usize,
    failed: usize,
) {
    let mut properties = base_properties("daemon");
    properties.set("kind", Value::from("worker_adoption"));
    properties.set("boot", Value::from(boot));
    properties.set("adopted_live", Value::from(adopted_live));
    properties.set("revived", Value::from(revived));
    properties.set("skipped_idle", Value::from(skipped_idle));
    properties.set("stopped", Value::from(stopped));
    properties.set("failed", Value::from(failed));
    client.track("daemon event", properties);
}

/// Track the live-catalog warm-up settle's `daemon event` (schema v1,
/// kind `catalog_refresh`): how many models the resolved
/// no-cold-start chain serves after the daemon's startup refresh. A
/// count only, never model ids, credentials, or catalog payloads.
pub fn track_catalog_refresh(client: &TelemetryClient, count: usize) {
    let mut properties = base_properties("daemon");
    properties.set("kind", Value::from("catalog_refresh"));
    properties.set("count", Value::from(count));
    client.track("daemon event", properties);
}

/// Track the abort supervision's terminal declaration (`daemon event`,
/// schema v1, kind `compaction_abort_declared`): the supervisor declared
/// a wedged worker's compaction aborted after its abort grace expired. A
/// count only, never session payload.
pub fn track_compaction_abort_declared(client: &TelemetryClient) {
    let mut properties = base_properties("daemon");
    properties.set("kind", Value::from("compaction_abort_declared"));
    properties.set("count", Value::from(1));
    client.track("daemon event", properties);
}

/// Track the parent-death child close's `daemon event` (schema v1, kind
/// `worker_children_closed`): how many resident RLM children the
/// supervisor stopped with a hard-killed parent worker. A count only,
/// never session payload.
pub fn track_worker_children_closed(client: &TelemetryClient, count: usize) {
    let mut properties = base_properties("daemon");
    properties.set("kind", Value::from("worker_children_closed"));
    properties.set("count", Value::from(count));
    client.track("daemon event", properties);
}
