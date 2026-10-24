//! Which rows besides assistant messages bill a model call: compactions and
//! branch summaries (the summarizer's usage on the row) and `model_usage`
//! rows (refinement planning and review, side questions, uncommitted
//! compaction summaries). Every usage reader classifies rows here.

use pa_types::ai::{Usage, UsageCost};
use pa_types::session::FileEntry;
use pa_types::JsNumber;
use serde::Deserialize;

use crate::session_engine::model_usage::MODEL_USAGE_CUSTOM_TYPE;

/// The scan-side wire shape of a usage block. Persisted files carry
/// partial objects (`{input, output, totalTokens}` without
/// `cacheRead`/`cacheWrite`/`cost`), and TS `JSON.parse` never rejects
/// one — the fold keeps the row and every field it does not find
/// defaults to zero, instead of dropping the message (its count, model,
/// and search text) with the block.
#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanUsage {
    #[serde(default)]
    input: u64,
    #[serde(default)]
    output: u64,
    #[serde(default)]
    cache_read: u64,
    #[serde(default)]
    cache_write: u64,
    #[serde(default)]
    total_tokens: u64,
    #[serde(default)]
    cost: ScanUsageCost,
}

#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScanUsageCost {
    #[serde(default)]
    input: JsNumber,
    #[serde(default)]
    output: JsNumber,
    #[serde(default)]
    cache_read: JsNumber,
    #[serde(default)]
    cache_write: JsNumber,
    #[serde(default)]
    total: JsNumber,
}

impl From<ScanUsage> for Usage {
    fn from(scan: ScanUsage) -> Usage {
        Usage {
            input: scan.input,
            output: scan.output,
            cache_read: scan.cache_read,
            cache_write: scan.cache_write,
            total_tokens: scan.total_tokens,
            cost: UsageCost {
                input: scan.cost.input,
                output: scan.cost.output,
                cache_read: scan.cost.cache_read,
                cache_write: scan.cost.cache_write,
                total: scan.cost.total,
            },
        }
    }
}

/// One model call a non-message row bills. `model` is the serving
/// `(provider, modelId)` when the row records it.
#[derive(Debug, Clone, PartialEq)]
pub struct BilledRow {
    pub usage: Usage,
    pub model: Option<(String, String)>,
}

/// Receives each billed row a durable store appends.
pub type BilledRowSink = std::sync::Arc<dyn Fn(&BilledRow) + Send + Sync>;

/// The fields a billed row keeps its call in.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BilledRowFields {
    #[serde(default)]
    custom_type: Option<String>,
    #[serde(default)]
    usage: Option<ScanUsage>,
    #[serde(default)]
    provider: Option<String>,
    #[serde(default)]
    model_id: Option<String>,
    /// Typed straight away: a custom row with other data fails the parse
    /// and bills nothing, without building that data in memory.
    #[serde(default)]
    data: Option<ModelUsageData>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelUsageData {
    usage: ScanUsage,
    provider: String,
    model_id: String,
}

/// The one rule: which row types bill and where each keeps its call.
/// `fields` parses the row lazily: only a candidate row type pays for it.
fn billed_row(type_: &str, fields: impl FnOnce() -> Option<BilledRowFields>) -> Option<BilledRow> {
    match type_ {
        "compaction" | "branch_summary" => {
            let fields = fields()?;
            Some(BilledRow::new(
                fields.usage?,
                fields.provider.zip(fields.model_id),
            ))
        }
        "custom" => {
            let fields = fields()?;
            if fields.custom_type.as_deref() != Some(MODEL_USAGE_CUSTOM_TYPE) {
                return None;
            }
            let data = fields.data?;
            Some(BilledRow::new(
                data.usage,
                Some((data.provider, data.model_id)),
            ))
        }
        _ => None,
    }
}

impl BilledRow {
    fn new(usage: ScanUsage, model: Option<(String, String)>) -> Self {
        Self {
            usage: usage.into(),
            model: model
                .filter(|(provider, model_id)| !provider.is_empty() && !model_id.is_empty()),
        }
    }
}

/// [`billed_row`] over one raw JSONL line.
#[must_use]
pub fn billed_line(type_: &str, line: &str) -> Option<BilledRow> {
    billed_row(type_, || serde_json::from_str(line).ok())
}

/// [`billed_row`] over a row's parsed fields.
#[must_use]
pub fn billed_fields(type_: &str, fields: &serde_json::Value) -> Option<BilledRow> {
    billed_row(type_, || BilledRowFields::deserialize(fields).ok())
}

/// [`billed_row`] over a session entry.
#[must_use]
pub fn billed_file_entry(entry: &FileEntry) -> Option<BilledRow> {
    billed_row(super::manager_ext::entry_type(entry), || {
        serde_json::to_value(entry)
            .ok()
            .and_then(|fields| BilledRowFields::deserialize(fields).ok())
    })
}
