//! The `child_spend` append: one cumulative snapshot of a direct child's
//! total spend, written only when it differs from that child's latest row.
use super::SessionFile;
use anyhow::Result;
use pa_types::{ai::Usage, session::ChildSpendEntry};

impl SessionFile {
    /// Append `entry` unless the child's latest retained snapshot already
    /// covers it: a child's total only grows, so a snapshot that is not
    /// larger in some field adds no row (compared in the transcript's JSON
    /// decoding). The skip only avoids redundant rows: the fold keeps each
    /// field's maximum, so no row can lower a child's total. Returns the
    /// spend the new row adds over the previous snapshot; `None` when
    /// nothing was appended or the row is the child's first.
    ///
    /// # Errors
    ///
    /// Returns an error when the snapshot cannot be serialized or the
    /// durable append fails.
    pub(crate) fn append_child_spend(&mut self, entry: &ChildSpendEntry) -> Result<Option<Usage>> {
        let fields = serde_json::to_value(entry)?;
        let total: Usage = serde_json::from_value(fields["total"].clone())?;
        let previous = self.entries.iter().rev().find_map(|row| {
            (row.type_ == "child_spend"
                && row
                    .fields
                    .get("childSessionId")
                    .and_then(serde_json::Value::as_str)
                    == Some(entry.child_session_id.as_str()))
            .then(|| serde_json::from_value::<Usage>(row.fields.get("total")?.clone()).ok())
            .flatten()
        });
        if previous.is_some_and(|previous| covers(&previous, &total)) {
            return Ok(None);
        }
        self.persist_entry("child_spend", fields)?;
        Ok(previous.map(|previous| {
            let mut added = total;
            pa_core::session_engine::compaction_exec::subtract_assistant_usage(
                &mut added, &previous,
            );
            added
        }))
    }
}

/// Whether `previous` is at least `next` in every billed field.
fn covers(previous: &Usage, next: &Usage) -> bool {
    previous.input >= next.input
        && previous.output >= next.output
        && previous.cache_read >= next.cache_read
        && previous.cache_write >= next.cache_write
        && previous.cost.total.as_f64() >= next.cost.total.as_f64()
}
