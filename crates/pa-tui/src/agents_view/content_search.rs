//! Full-text session search: `app.agents.searchContent` (default ctrl+f) switches the search
//! field from session titles to message text. The daemon's `search_session_content` scan answers
//! with the matching session ids, and the list keeps those rows (and their ancestors).
use std::collections::HashSet;
use std::path::PathBuf;
use std::time::Duration;

use super::{mpsc, AgentsViewMode, DaemonClient, DaemonCommand, UiInput, Value};

/// The daemon capability that serves `search_session_content`.
pub(super) const CAPABILITY: &str = "session_content_search";

/// The typing pause before a scan: each scan reads the whole store, so it never runs per key.
const DEBOUNCE: Duration = Duration::from_millis(150);

#[derive(Default)]
pub(super) struct ContentSearch {
    pub(super) supported: bool,
    pub(super) enabled: bool,
    /// The query waiting out the debounce, and when it is due.
    armed: Option<(String, tokio::time::Instant)>,
    /// The query last sent to the daemon: only its answer applies.
    requested: Option<String>,
    /// The query the matches answer, and the matching session ids.
    matches: Option<(String, HashSet<String>)>,
}

impl ContentSearch {
    /// Arm (or re-arm, when the query changed) the debounced scan for `query`.
    pub(super) fn arm(&mut self, query: &str, now: tokio::time::Instant) {
        if !self.enabled || query.is_empty() || self.requested.as_deref() == Some(query) {
            self.armed = None;
            return;
        }
        if self.armed.as_ref().is_none_or(|(armed, _)| armed != query) {
            self.armed = Some((query.to_string(), now + DEBOUNCE));
        }
    }

    pub(super) fn deadline(&self) -> Option<tokio::time::Instant> {
        self.armed.as_ref().map(|(_, at)| *at)
    }

    /// The due query, now recorded as the one in flight.
    pub(super) fn take_due(&mut self) -> Option<String> {
        let (query, _) = self.armed.take()?;
        self.requested = Some(query.clone());
        Some(query)
    }

    /// The latest landed matches; they keep filtering while a newer query's scan runs, so typing
    /// never blanks the list.
    pub(super) fn matches(&self) -> Option<&HashSet<String>> {
        self.matches.as_ref().map(|(_, ids)| ids)
    }

    /// Whether the list still waits for the scan of `query`.
    pub(super) fn pending(&self, query: &str) -> bool {
        self.matches
            .as_ref()
            .is_none_or(|(answered, _)| answered != query)
    }
}

impl AgentsViewMode {
    pub(super) fn toggle_content_search(&mut self) {
        if !self.content_search.supported {
            self.set_status(
                "Message search needs a newer background service: run `prime-agent shutdown`, then reopen",
            );
            return;
        }
        let enabled = !self.content_search.enabled;
        self.content_search = ContentSearch {
            supported: true,
            enabled,
            ..ContentSearch::default()
        };
        if enabled {
            self.actions.push("content_search");
        }
        self.query_changed(false);
    }

    /// One landed scan: only the answer to the query last sent applies.
    pub(super) fn apply_content_search(
        &mut self,
        query: String,
        outcome: Result<Vec<String>, String>,
    ) {
        if self.content_search.requested.as_deref() != Some(query.as_str()) {
            return;
        }
        match outcome {
            Ok(ids) => {
                self.content_search.matches = Some((query, ids.into_iter().collect()));
                self.query_changed(false);
            }
            Err(error) => {
                // The next query change retries.
                self.content_search.requested = None;
                self.set_status(&format!("Message search failed: {error}"));
            }
        }
    }
}

/// One `search_session_content` request; the answer re-enters the loop as a `UiInput`.
pub(super) fn spawn_fetch(
    client: &DaemonClient,
    ui_tx: mpsc::UnboundedSender<UiInput>,
    session_dir: Option<PathBuf>,
    query: String,
) {
    let client = client.clone();
    tokio::spawn(async move {
        let outcome = client
            .request_ok(DaemonCommand::SearchSessionContent {
                id: None,
                session_dir: session_dir.map(|dir| dir.to_string_lossy().into_owned()),
                query: query.clone(),
                rest: serde_json::Map::default(),
            })
            .await
            .map(|data| {
                data.get("sessionIds")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .map_err(|error| error.to_string());
        let _ = ui_tx.send(UiInput::ContentSearchLoaded { query, outcome });
    });
}
