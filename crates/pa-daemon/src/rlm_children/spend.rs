//! The child-spend concern: the parent's durable `child_spend` snapshots of
//! its children, taken at spawn, at settle and teardown, on the supervisor's
//! spend notice, and once per ledger child when the parent's worker starts.
use super::{Arc, ChildRecord, Mutex, SupervisorChildSessionsInner};
use pa_types::{ai::Usage, session::ChildSpendEntry};
use std::path::Path;

/// One child the parent snapshots, keyed by its durable session id (the
/// session file's stem).
#[derive(Debug, Clone)]
pub struct ChildSpendSource {
    pub session_id: String,
    pub session_file: String,
    /// The total to record when the child's transcript cannot be read: the
    /// ledger tombstone's captured total for a child whose delete removed its
    /// transcript.
    pub fallback_total: Option<Usage>,
}

impl ChildSpendSource {
    #[must_use]
    pub fn of_file(session_file: &str, fallback_total: Option<Usage>) -> Option<Self> {
        let session_id = Path::new(session_file)
            .file_stem()?
            .to_string_lossy()
            .into_owned();
        Some(Self {
            session_id,
            session_file: session_file.to_string(),
            fallback_total,
        })
    }
}

/// The parent transcript the `child_spend` rows land in. Implementations
/// append under the parent's runtime lease, serialized with every other
/// write to that transcript, and skip a snapshot that adds nothing over the
/// child's latest row ([`SessionFile::append_child_spend`]).
///
/// [`SessionFile::append_child_spend`]: crate::session_store::SessionFile
pub trait ChildSpendStore: Send + Sync {
    /// Append one snapshot; returns the spend it adds over the child's
    /// previous snapshot (`None` when nothing was appended or it is the
    /// child's first row).
    ///
    /// # Errors
    ///
    /// Returns an error when the parent has no open transcript or the
    /// durable append fails.
    fn append_child_spend(&self, entry: &ChildSpendEntry) -> anyhow::Result<Option<Usage>>;
}

/// The parent's one `child_spend` writer: appends a snapshot and counts the
/// growth in the session's `rlm_child_*` telemetry. A failed write is
/// logged: the next snapshot of the same child restates its total.
pub struct ChildSpendWriter {
    store: Arc<dyn ChildSpendStore>,
    /// The current session build's telemetry (`None` before the first
    /// build, or when the session does not report).
    telemetry: std::sync::Mutex<Option<Arc<pa_core::session_engine::telemetry::SessionTelemetry>>>,
}

impl ChildSpendWriter {
    #[must_use]
    pub fn new(store: Arc<dyn ChildSpendStore>) -> Self {
        Self {
            store,
            telemetry: std::sync::Mutex::new(None),
        }
    }

    /// Count from here on into this session build's telemetry.
    pub fn set_telemetry(
        &self,
        telemetry: Option<Arc<pa_core::session_engine::telemetry::SessionTelemetry>>,
    ) {
        *self
            .telemetry
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = telemetry;
    }

    fn append(&self, entry: &ChildSpendEntry) {
        match self.store.append_child_spend(entry) {
            Ok(Some(added)) => {
                let telemetry = self
                    .telemetry
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .clone();
                if let Some(telemetry) = telemetry {
                    telemetry.note_child_usage_attributed(
                        added.input,
                        added.output,
                        added.cache_read,
                        added.cache_write,
                        added.cost.total.as_f64(),
                    );
                }
            }
            Ok(None) => {}
            Err(error) => eprintln!("pa-daemon: child spend snapshot not persisted: {error:#}"),
        }
    }
}

impl SupervisorChildSessionsInner {
    /// Snapshot one tracked child's spend.
    pub(super) async fn snapshot_child_spend(&self, record: &Arc<Mutex<ChildRecord>>) {
        let session_file = record.lock().await.session_file.clone();
        if let Some(source) = session_file
            .as_deref()
            .and_then(|file| ChildSpendSource::of_file(file, None))
        {
            self.record_child_spend(source).await;
        }
    }

    /// Snapshot one child's current total.
    pub(super) async fn record_child_spend(&self, source: ChildSpendSource) {
        let Some(writer) = self.spend_writer() else {
            return;
        };
        let file = source.session_file.clone();
        let total = tokio::task::spawn_blocking(move || {
            crate::session_store::read_session_info(Path::new(&file)).map(|info| info.totals.total)
        })
        .await
        .ok()
        .flatten()
        .or(source.fallback_total);
        if let Some(total) = total {
            writer.append(&ChildSpendEntry {
                child_session_id: source.session_id,
                child_session_file: source.session_file,
                total,
            });
        }
    }

    /// A just-spawned child's first snapshot: zero, so everything it spends
    /// from here on bills to this parent.
    pub(super) fn record_child_spawn(&self, source: ChildSpendSource) {
        if let Some(writer) = self.spend_writer() {
            writer.append(&ChildSpendEntry {
                child_session_id: source.session_id,
                child_session_file: source.session_file,
                total: Usage::default(),
            });
        }
    }

    fn spend_writer(&self) -> Option<Arc<ChildSpendWriter>> {
        self.spend_sink
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }
}
