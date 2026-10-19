//! The transcript window: the resident run of display-transcript chunks above the
//! live tail. A chunk loads before the viewport reaches the resident edge, and the
//! chunk farthest from the viewport is evicted, so the view holds a bounded slice of
//! a session of any length. The tail (the attach rows plus live appends) is never
//! evicted.

use std::collections::VecDeque;

use anyhow::Result;
use pa_types::daemon::{DaemonCommand, TranscriptPage};
use serde_json::{Map, Value};

use super::SessionUi;
use crate::chat::{ChatEntry, StatusKind};
use crate::snapshot::BackfillSeam;
use crate::view::AgentView;

/// Messages per page request.
pub(crate) const CHUNK_MESSAGES: usize = 256;
/// Fetched chunks resident above the tail.
const RESIDENT_CHUNKS: usize = 3;
/// A page loads once the viewport is this many entries from the resident edge.
const PREFETCH_ENTRIES: usize = 128;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PageKind {
    /// Above the resident run.
    Older,
    /// Between the resident run and the tail (closing the gap).
    Newer,
    /// The session's first page, replacing the resident run.
    Head,
}

pub(crate) struct TranscriptPageNote {
    pub epoch: u64,
    pub kind: PageKind,
    pub page: std::result::Result<LoadedPage, String>,
}

pub(crate) struct LoadedPage {
    entries: Vec<ChatEntry>,
    seam: BackfillSeam,
    first_id: Option<String>,
    last_id: Option<String>,
    more: bool,
}

struct Chunk {
    first_id: String,
    last_id: String,
    entries: usize,
    seam: BackfillSeam,
}

#[derive(Default)]
pub(crate) struct TranscriptWindow {
    /// The attached branch: every page request is validated against it.
    leaf_id: Option<String>,
    /// The tail's oldest row; `None` when nothing older than the tail exists.
    tail_first_id: Option<String>,
    tail_seam: BackfillSeam,
    chunks: VecDeque<Chunk>,
    /// The oldest resident row is the session's first.
    start_resident: bool,
    /// Rows between the resident chunks and the tail are evicted; one status row
    /// marks the boundary.
    gap: bool,
    head_requested: bool,
    /// A page failed: no more pages until the next reset.
    failed: bool,
    epoch: u64,
    /// Dropping the handle aborts the in-flight page; the epoch fences a note
    /// that was already queued.
    fetch: Option<tokio_util::task::AbortOnDropHandle<()>>,
}

impl TranscriptWindow {
    /// Start over on a freshly replaced transcript: the view holds only the tail.
    pub(crate) fn reset(
        &mut self,
        leaf_id: Option<String>,
        tail_first_id: Option<String>,
        tail_seam: BackfillSeam,
    ) {
        let epoch = self.epoch.wrapping_add(1);
        *self = Self {
            start_resident: tail_first_id.is_none(),
            leaf_id,
            tail_first_id,
            tail_seam,
            epoch,
            ..Self::default()
        };
    }

    /// Fence the in-flight page without touching the resident rows.
    pub(crate) fn retire(&mut self) {
        self.epoch = self.epoch.wrapping_add(1);
        self.fetch = None;
    }

    /// Abandon the in-flight page; a note that already arrived still applies.
    pub(crate) fn retire_fetch(&mut self) {
        self.fetch = None;
    }

    /// Whether history the view does not hold exists (or is being loaded).
    pub(crate) fn incomplete(&self) -> bool {
        !self.start_resident || self.gap || self.fetch.is_some()
    }

    /// The top key: the session's first page replaces the resident run.
    pub(crate) fn request_head(&mut self) {
        self.head_requested = !self.start_resident;
    }

    fn resident_entries(&self) -> usize {
        self.chunks.iter().map(|chunk| chunk.entries).sum()
    }

    fn tail_start(&self) -> usize {
        self.resident_entries() + usize::from(self.gap)
    }

    /// The page the viewport needs next, if any.
    fn next_page(&self, view: &AgentView) -> Option<(PageKind, TranscriptPage)> {
        if self.fetch.is_some() || self.failed {
            return None;
        }
        let tail_first_id = self.tail_first_id.clone()?;
        if self.head_requested {
            let page = TranscriptPage::Start {
                after: None,
                until: Some(tail_first_id),
                limit: CHUNK_MESSAGES,
            };
            return Some((PageKind::Head, page));
        }
        let (first, last) = view.visible_entries()?;
        if !self.start_resident && first < PREFETCH_ENTRIES {
            let before = self
                .chunks
                .front()
                .map_or(tail_first_id, |chunk| chunk.first_id.clone());
            let page = TranscriptPage::End {
                before: Some(before),
                limit: CHUNK_MESSAGES,
            };
            return Some((PageKind::Older, page));
        }
        let back = self.chunks.back()?;
        if self.gap && last + PREFETCH_ENTRIES >= self.resident_entries() {
            let page = TranscriptPage::Start {
                after: Some(back.last_id.clone()),
                until: Some(tail_first_id),
                limit: CHUNK_MESSAGES,
            };
            return Some((PageKind::Newer, page));
        }
        None
    }

    /// Fold a loaded page into the view. Returns how many entries the rows above
    /// the tail grew by (negative when they shrank).
    fn apply(&mut self, kind: PageKind, page: LoadedPage, view: &mut AgentView) -> isize {
        let (Some(first_id), Some(last_id)) = (page.first_id, page.last_id) else {
            match kind {
                PageKind::Older | PageKind::Head => self.start_resident = true,
                PageKind::Newer => self.gap = false,
            }
            self.head_requested = false;
            return 0;
        };
        let mut entries = page.entries;
        // A page that reaches the tail joins it, as an older page joins what lies below.
        if kind != PageKind::Older && !page.more {
            crate::snapshot::join_backfilled_entries(&mut entries, self.tail_seam);
        }
        let chunk = |entries: usize| Chunk {
            first_id,
            last_id,
            entries,
            seam: page.seam,
        };
        match kind {
            PageKind::Older => {
                let top_seam = self.chunks.front().map_or(self.tail_seam, |top| top.seam);
                crate::snapshot::join_backfilled_entries(&mut entries, top_seam);
                let count = entries.len();
                view.prepend_entries(entries);
                self.chunks.push_front(chunk(count));
                self.start_resident = !page.more;
                let mut grown = count as isize;
                if self.chunks.len() > RESIDENT_CHUNKS {
                    grown += self.evict_newest(view);
                }
                grown
            }
            PageKind::Newer => {
                let at = self.resident_entries();
                let count = entries.len();
                if page.more {
                    entries.push(gap_row());
                }
                view.replace_entries(at..at + 1, entries);
                self.chunks.push_back(chunk(count));
                self.gap = page.more;
                let mut grown = count as isize - isize::from(!page.more);
                if self.chunks.len() > RESIDENT_CHUNKS {
                    let oldest = self.chunks.pop_front().map_or(0, |chunk| chunk.entries);
                    view.drop_leading_entries(oldest);
                    self.start_resident = false;
                    grown -= oldest as isize;
                }
                grown
            }
            PageKind::Head => {
                let replaced = self.tail_start();
                let count = entries.len();
                if page.more {
                    entries.push(gap_row());
                }
                let inserted = entries.len();
                view.drop_leading_entries(replaced);
                view.prepend_entries(entries);
                view.scroll_to_top();
                self.chunks = VecDeque::from([chunk(count)]);
                self.gap = page.more;
                self.start_resident = true;
                self.head_requested = false;
                inserted as isize - replaced as isize
            }
        }
    }

    /// Evict the chunk next to the tail, leaving the gap row in its place.
    fn evict_newest(&mut self, view: &mut AgentView) -> isize {
        let Some(newest) = self.chunks.pop_back() else {
            return 0;
        };
        let at = self.resident_entries();
        if self.gap {
            view.replace_entries(at..at + newest.entries, Vec::new());
            -(newest.entries as isize)
        } else {
            view.replace_entries(at..at + newest.entries, vec![gap_row()]);
            self.gap = true;
            1 - newest.entries as isize
        }
    }

    /// Drop a disjoint resident run, leaving the contiguous tail. Returns how many
    /// entries the rows above the tail shrank by.
    fn collapse_to_tail(&mut self, view: &mut AgentView) -> usize {
        if !self.gap {
            return 0;
        }
        let dropped = self.tail_start();
        view.drop_leading_entries(dropped);
        self.chunks.clear();
        self.gap = false;
        self.start_resident = false;
        self.retire();
        dropped
    }
}

fn gap_row() -> ChatEntry {
    ChatEntry::Status {
        text: "Loading newer history\u{2026}".to_string(),
        kind: StatusKind::Info,
    }
}

impl SessionUi {
    /// Whether the viewport needs a page that is not yet in flight.
    pub(crate) fn wants_transcript_page(&self, view: &AgentView) -> bool {
        self.window.next_page(view).is_some()
    }

    /// Start the page the viewport needs, if any. Runs at the loop top after a paint,
    /// so the visible range is the painted one.
    pub(crate) fn spawn_transcript_page(&mut self, view: &AgentView) {
        let Some((kind, page)) = self.window.next_page(view) else {
            return;
        };
        let client = self.client.clone();
        let active_session_id = self.active_session_id.clone();
        let epoch = self.window.epoch;
        let leaf_id = self.window.leaf_id.clone();
        let notes = self.page_notes.clone();
        let task = tokio_util::task::AbortOnDropHandle::new(tokio::spawn(async move {
            let page: Result<LoadedPage> = async {
                let leaf_id =
                    leaf_id.ok_or_else(|| anyhow::anyhow!("missing history branch anchor"))?;
                let command = DaemonCommand::GetMessages {
                    id: None,
                    active_session_id,
                    page: Some(page),
                    capabilities: Some(crate::session_ui::attach_capabilities()),
                    rest: Map::from_iter([(
                        "historyLeafId".to_owned(),
                        Value::String(leaf_id.clone()),
                    )]),
                };
                // A read-only request can safely retry once on a live link. Keep
                // the same cursor; a second failure must not masquerade as an empty page.
                let data = match client.request_ok(command.clone()).await {
                    Ok(data) => data,
                    Err(error) if crate::daemon_client::is_daemon_timeout(&error) => {
                        return Err(error)
                    }
                    Err(_) => client.request_ok(command).await?,
                };
                // Require the echo so workers that ignore the anchor fail closed.
                if data.get("historyLeafId").and_then(Value::as_str) != Some(leaf_id.as_str()) {
                    return Err(anyhow::anyhow!("unverified history branch anchor"));
                }
                parse_page(data).await
            }
            .await;
            let page = page.map_err(|error| error.to_string());
            let _ = notes.send(TranscriptPageNote { epoch, kind, page });
        }));
        self.window.fetch = Some(task);
    }

    pub(crate) fn apply_transcript_page(&mut self, note: TranscriptPageNote, view: &mut AgentView) {
        if note.epoch != self.window.epoch {
            return;
        }
        self.window.fetch = None;
        let page = match note.page {
            Ok(page) => page,
            Err(error) => {
                self.window.failed = true;
                view.push_entry(ChatEntry::Status {
                    text: format!(
                        "History could not be loaded: {error}. Reopen the session to retry."
                    ),
                    kind: StatusKind::Warning,
                });
                self.dirty = true;
                return;
            }
        };
        if self.last_assistant_text.is_none() {
            self.last_assistant_text = super::last_assistant_text_of(&page.entries);
        }
        let grown = self.window.apply(note.kind, page, view);
        self.shift_tail_indices(grown);
        self.pressed_click = None;
        self.trim_after_frame = true;
        self.dirty = true;
    }

    /// The follow key and the exit flush: a resident run cut off from the tail drops.
    pub(crate) fn collapse_transcript_window(&mut self, view: &mut AgentView) {
        let dropped = self.window.collapse_to_tail(view);
        if dropped > 0 {
            self.shift_tail_indices(-(dropped as isize));
            self.dirty = true;
        }
    }

    /// The session's chat indices all point into the tail: rows changing above it
    /// move them.
    fn shift_tail_indices(&mut self, delta: isize) {
        for index in [
            &mut self.last_status_index,
            &mut self.streaming_index,
            &mut self.goal_view.last_status_index,
        ]
        .into_iter()
        .flatten()
        {
            *index = index.saturating_add_signed(delta);
        }
    }

    /// Re-read the transcript tail and replace the view with it (the navigation,
    /// fork, import, and reload rebuilds). Best effort: a failed fetch keeps the view.
    pub(crate) async fn rebuild_transcript(&mut self, view: &mut AgentView) {
        let incomplete_history = self.window.incomplete();
        self.window.retire();
        self.last_status_index = None;
        self.pressed_click = None;
        let data = self
            .bounded_request(
                std::time::Duration::from_millis(super::UI_REQUEST_TIMEOUT_MS),
                DaemonCommand::GetMessages {
                    id: None,
                    active_session_id: self.active_session_id.clone(),
                    page: Some(TranscriptPage::End {
                        before: None,
                        limit: CHUNK_MESSAGES,
                    }),
                    capabilities: Some(crate::session_ui::attach_capabilities()),
                    rest: Map::default(),
                },
            )
            .await;
        let leaf_id = data
            .as_ref()
            .ok()
            .and_then(|data| data.get("historyLeafId"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        let page = match data {
            Ok(data) => parse_page(data).await.ok(),
            Err(_) => None,
        };
        let Some(page) = page else {
            // The resident rows may no longer match the branch: page no further.
            self.window.failed = true;
            if incomplete_history {
                view.push_entry(ChatEntry::Status {
                    text: "Transcript refresh failed; displayed history may be incomplete or stale. Reopen the session to retry.".to_string(),
                    kind: StatusKind::Warning,
                });
                self.dirty = true;
            }
            return;
        };
        self.window
            .reset(leaf_id, page.first_id.filter(|_| page.more), page.seam);
        view.clear_chat();
        for entry in page.entries {
            view.push_entry(entry);
        }
        view.follow();
        self.dirty = true;
    }
}

/// Decode a page response off the UI thread.
async fn parse_page(mut data: Value) -> Result<LoadedPage> {
    let Some(Value::Array(messages)) = data.get_mut("messages").map(Value::take) else {
        return Err(anyhow::anyhow!("missing messages in history response"));
    };
    let id = |key: &str| data.get(key).and_then(Value::as_str).map(str::to_owned);
    let (first_id, last_id) = (id("firstEntryId"), id("lastEntryId"));
    let more = data.get("more").and_then(Value::as_bool).unwrap_or(false);
    let (entries, seam) = tokio::task::spawn_blocking(move || {
        crate::snapshot::transcript_with_backfill_seam(&messages)
    })
    .await?;
    Ok(LoadedPage {
        entries,
        seam,
        first_id,
        last_id,
        more,
    })
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::daemon_client::DaemonClient;
    use crate::interactive::SessionSelection;
    use crate::session_ui::ActivityUpdates;
    use serde_json::json;
    use std::time::Duration;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::sync::mpsc;

    #[tokio::test]
    async fn a_rebuild_rejects_an_already_queued_backfill_note() {
        tokio::time::timeout(Duration::from_secs(10), async {
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("backfill.sock");
        let listener = tokio::net::UnixListener::bind(&socket).unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let (read, mut write) = stream.into_split();
            write.write_all(b"{\"type\":\"daemon_hello\",\"protocol\":{\"name\":\"prime-agent.daemon\",\"version\":7},\"serverCapabilities\":[],\"clientId\":\"mock\"}\n").await.unwrap();
            let mut lines = BufReader::new(read).lines();
            while let Some(line) = lines.next_line().await.unwrap() {
                let request: Value = serde_json::from_str(&line).unwrap();
                let kind = request["command"]["type"].as_str().unwrap();
                let data = match kind {
                    "attach" => json!({
                        "activeSessionId": "s1", "snapshot": {
                            "activeSessionId": "s1", "summary": {"id": "s1", "cwd": "/tmp"},
                            "state": {"sessionId": "s1", "cwd": "/tmp", "isStreaming": false, "leafId": "leaf"},
                            "messages": [], "historyBeforeEntryId": "e1", "lastEventSequence": 0,
                        }, "replay": {"status": "complete", "toSequence": 0},
                        "lastEventSequence": 0,
                    }),
                    "get_messages" => {
                        json!({
                            "messages": [{"role": "user", "content": "rebuilt transcript", "timestamp": 1}],
                            "firstEntryId": "e2", "lastEntryId": "e2", "more": false,
                            "historyLeafId": "leaf",
                        })
                    }
                    _ => json!({}),
                };
                let mut reply = serde_json::to_vec(&json!({
                    "type": "response", "id": request["id"], "command": kind,
                    "success": true, "data": data,
                }))
                .unwrap();
                reply.push(b'\n');
                write.write_all(&reply).await.unwrap();
            }
        });
            let mut options =
                crate::interactive::tests::options(crate::interactive::ModelSelection::default());
        options.socket_path = socket.clone();
        options.session = SessionSelection::Attach("s1".to_string());
        let (client, _events) = DaemonClient::connect(&socket).await.unwrap();
        let (page_tx, mut page_rx) = mpsc::unbounded_channel();
        let mut session = SessionUi::open(
            client,
            &options,
            mpsc::unbounded_channel().0,
            mpsc::unbounded_channel().0,
            mpsc::unbounded_channel().0,
            mpsc::unbounded_channel().0,
            mpsc::unbounded_channel().0,
            mpsc::unbounded_channel().0,
            mpsc::unbounded_channel().0,
            mpsc::unbounded_channel().0,
            mpsc::unbounded_channel().0,
            ActivityUpdates {
                heartbeats: mpsc::unbounded_channel().0,
                bash: mpsc::unbounded_channel().0,
                factory: mpsc::unbounded_channel().0,
                commands: mpsc::unbounded_channel().0,
            },
            page_tx.clone(),
        )
        .await
        .unwrap();
        let old_epoch = session.window.epoch;
        assert!(page_tx
            .send(TranscriptPageNote {
                epoch: old_epoch,
                kind: PageKind::Older,
                page: Ok(LoadedPage {
                    entries: crate::snapshot::transcript_to_entries(&[
                        json!({"role": "user", "content": "stale history", "timestamp": 0}),
                    ]),
                    seam: BackfillSeam::Preserve,
                    first_id: Some("e0".to_string()),
                    last_id: Some("e0".to_string()),
                    more: false,
                }),
            })
            .is_ok());
        let mut view = AgentView::new(crate::theme::Theme::builtin(
            "prime",
            crate::theme::ColorMode::TrueColor,
        ));
        session.rebuild_transcript(&mut view).await;
        assert_ne!(session.window.epoch, old_epoch);
        assert_eq!(view.chat.len(), 1, "rebuild applied the current transcript");
        let expected = view.chat.clone();
        // Deliver the note that was demonstrably queued before the real rebuild.
        session.apply_transcript_page(page_rx.try_recv().unwrap(), &mut view);
        assert_eq!(
            view.chat, expected,
            "an obsolete queued page cannot prepend rows after rebuild"
        );
        drop(session);
        server.abort();
        }).await.expect("mock session open, rebuild and stale-note delivery complete within ten seconds");
    }

    #[test]
    fn a_page_reaching_the_tail_joins_its_retry_seam() {
        let attempt = json!({
            "role": "assistant", "content": [], "stopReason": "error",
            "errorMessage": "attempt failed", "timestamp": 2,
        });
        let (entries, seam) = crate::snapshot::transcript_with_backfill_seam(&[
            json!({"role": "user", "content": "run", "timestamp": 1}),
            attempt,
        ]);
        let mut window = TranscriptWindow::default();
        window.reset(
            Some("leaf".to_string()),
            Some("tail".to_string()),
            BackfillSeam::RetryOutcome,
        );
        let mut view = AgentView::new(crate::theme::Theme::builtin(
            "prime",
            crate::theme::ColorMode::TrueColor,
        ));
        let page = LoadedPage {
            entries,
            seam,
            first_id: Some("e0".to_string()),
            last_id: Some("e1".to_string()),
            more: false,
        };
        window.apply(PageKind::Head, page, &mut view);
        assert_eq!(
            view.chat,
            vec![ChatEntry::User {
                text: "run".to_string()
            }],
            "the tail's retry outcome supersedes the attempt the head page ends with"
        );
    }
}
