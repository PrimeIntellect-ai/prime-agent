//! The task table: one entry per A2A task, its lifecycle, its reply, and
//! its stream subscribers. Every mutation runs under the server's state
//! lock and publishes in the same step, so a subscriber that snapshots
//! and subscribes under that lock sees every later frame exactly once.

use std::collections::{HashMap, VecDeque};

use tokio::sync::{broadcast, watch};

use super::types::{
    Artifact, ListTasksParams, ListTasksResponse, Message, Part, Role, StreamResponse, Task,
    TaskArtifactUpdateEvent, TaskState, TaskStatus, TaskStatusUpdateEvent,
};

/// Terminal tasks kept readable through `GetTask`/`ListTasks`; older ones
/// are dropped at the settle that pushes them out.
const RETAINED_TERMINAL_TASKS: usize = 256;
/// Frames one subscriber may fall behind before its stream ends.
const STREAM_CAPACITY: usize = 1024;
const DEFAULT_PAGE_SIZE: u32 = 50;
const MAX_PAGE_SIZE: u32 = 100;

/// A context as the server keys it: each client names its contexts in its
/// own namespace, so one `contextId` from two clients is two conversations.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ContextKey {
    pub client: String,
    pub id: String,
}

struct TaskEntry {
    /// The client that created the task's context owns the task.
    context: ContextKey,
    state: TaskState,
    user_message: Message,
    reply_message_id: String,
    /// The final reply: the turn's assistant messages, blank-line joined.
    reply: String,
    /// The text of the assistant message that is streaming now; it joins
    /// the reply even when the message never finishes (a failure, a cancel).
    open: Option<String>,
    /// The artifact text the streams received so far (the live chunks);
    /// a live task's snapshot carries it, so later chunks append to it.
    streamed: String,
    /// An assistant message started after streamed text: the next chunk
    /// opens with a blank line.
    separator: bool,
    /// The FAILED status message.
    status_message: Option<Message>,
    updated_at: u64,
    /// Dropped at the settle: the receivers drain the last frames and end.
    stream: Option<broadcast::Sender<StreamResponse>>,
    terminal: watch::Sender<bool>,
}

impl TaskEntry {
    fn publish(&self, frame: StreamResponse) {
        if let Some(stream) = &self.stream {
            let _ = stream.send(frame);
        }
    }

    fn artifact(id: &str, text: String) -> Artifact {
        Artifact {
            artifact_id: format!("{id}-response"),
            name: "response".to_string(),
            parts: vec![Part::text(text)],
        }
    }

    fn status(&self) -> TaskStatus {
        TaskStatus {
            state: self.state,
            message: self.status_message.clone(),
            timestamp: crate::util::iso_from_unix_ms(self.updated_at),
        }
    }

    fn snapshot(&self, id: &str, history_length: Option<u32>, artifacts: bool) -> Task {
        let mut history = vec![self.user_message.clone()];
        if !self.reply.is_empty() {
            history.push(Message {
                message_id: self.reply_message_id.clone(),
                context_id: Some(self.context.id.clone()),
                task_id: Some(id.to_string()),
                role: Role::Agent,
                parts: vec![Part::text(self.reply.clone())],
                metadata: None,
            });
        }
        let keep = history_length.map_or(history.len(), |n| (n as usize).min(history.len()));
        history.drain(..history.len() - keep);
        Task {
            id: id.to_string(),
            context_id: self.context.id.clone(),
            status: self.status(),
            artifacts: artifacts.then(|| {
                let text = if self.state.is_terminal() {
                    &self.reply
                } else {
                    &self.streamed
                };
                if text.is_empty() {
                    Vec::new()
                } else {
                    vec![Self::artifact(id, text.clone())]
                }
            }),
            history,
        }
    }

    fn push_reply(&mut self, text: &str) {
        if text.is_empty() {
            return;
        }
        if !self.reply.is_empty() {
            self.reply.push_str("\n\n");
        }
        self.reply.push_str(text);
    }

    fn publish_status(&mut self, id: &str, state: TaskState) {
        self.state = state;
        self.updated_at = crate::util::now_ms();
        self.publish(StreamResponse::StatusUpdate(TaskStatusUpdateEvent {
            task_id: id.to_string(),
            context_id: self.context.id.clone(),
            status: self.status(),
        }));
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum SubscribeError {
    NotFound,
    Terminal,
}

pub struct Tasks {
    entries: HashMap<String, TaskEntry>,
    terminal_order: VecDeque<String>,
    /// This server run's id: page tokens carry it, so a token from an
    /// earlier run is refused instead of paging a different table.
    run: String,
}

impl Default for Tasks {
    fn default() -> Self {
        Self {
            entries: HashMap::new(),
            terminal_order: VecDeque::new(),
            run: uuid::Uuid::new_v4().simple().to_string()[..8].to_string(),
        }
    }
}

impl Tasks {
    /// Admit a SUBMITTED task for `message` (its ids already set), owned by
    /// `client`.
    pub fn admit(&mut self, id: &str, client: &str, message: Message) {
        let context = ContextKey {
            client: client.to_string(),
            id: message.context_id.clone().unwrap_or_default(),
        };
        self.entries.insert(
            id.to_string(),
            TaskEntry {
                context,
                state: TaskState::Submitted,
                user_message: message,
                reply_message_id: uuid::Uuid::new_v4().to_string(),
                reply: String::new(),
                open: None,
                streamed: String::new(),
                separator: false,
                status_message: None,
                updated_at: crate::util::now_ms(),
                stream: Some(broadcast::channel(STREAM_CAPACITY).0),
                terminal: watch::channel(false).0,
            },
        );
    }

    pub fn state(&self, id: &str) -> Option<TaskState> {
        self.entries.get(id).map(|entry| entry.state)
    }

    pub fn context(&self, id: &str) -> Option<&ContextKey> {
        self.entries.get(id).map(|entry| &entry.context)
    }

    /// Whether the task exists and belongs to `client`.
    pub fn owned(&self, client: &str, id: &str) -> bool {
        self.context(id)
            .is_some_and(|context| context.client == client)
    }

    /// SUBMITTED -> WORKING. `false` when the task already settled (a
    /// cancel won the race).
    pub fn start(&mut self, id: &str) -> bool {
        match self.entries.get_mut(id) {
            Some(entry) if entry.state == TaskState::Submitted => {
                entry.publish_status(id, TaskState::Working);
                true
            }
            _ => false,
        }
    }

    /// Resolves once the task is terminal.
    pub fn terminal_watch(&self, id: &str) -> Option<watch::Receiver<bool>> {
        self.entries.get(id).map(|entry| entry.terminal.subscribe())
    }

    pub fn assistant_message_start(&mut self, id: &str) {
        if let Some(entry) = self.live(id) {
            entry.separator = !entry.streamed.is_empty();
            if let Some(unfinished) = entry.open.replace(String::new()) {
                entry.push_reply(&unfinished);
            }
        }
    }

    /// One streamed text delta: an artifact chunk for the live streams.
    pub fn text_delta(&mut self, id: &str, delta: &str) {
        let Some(entry) = self.live(id) else {
            return;
        };
        let text = if std::mem::take(&mut entry.separator) {
            format!("\n\n{delta}")
        } else {
            delta.to_string()
        };
        let append = !entry.streamed.is_empty();
        entry.streamed.push_str(&text);
        if let Some(open) = &mut entry.open {
            open.push_str(delta);
        }
        entry.publish(StreamResponse::ArtifactUpdate(TaskArtifactUpdateEvent {
            task_id: id.to_string(),
            context_id: entry.context.id.clone(),
            artifact: TaskEntry::artifact(id, text),
            append,
            last_chunk: false,
        }));
    }

    /// A finished assistant message: its text joins the final reply.
    pub fn assistant_message_end(&mut self, id: &str, text: &str) {
        if let Some(entry) = self.live(id) {
            entry.open = None;
            entry.push_reply(text);
        }
    }

    /// Settle a live task: the complete artifact (replacing the live
    /// chunks), then the terminal status, which ends every stream. A
    /// FAILED task carries `error` as its status message. Returns the
    /// settled snapshot, or `None` when the task already settled.
    pub fn settle(&mut self, id: &str, state: TaskState, error: Option<String>) -> Option<Task> {
        let entry = self.live(id)?;
        if let Some(unfinished) = entry.open.take() {
            entry.push_reply(&unfinished);
        }
        if !entry.reply.is_empty() {
            entry.publish(StreamResponse::ArtifactUpdate(TaskArtifactUpdateEvent {
                task_id: id.to_string(),
                context_id: entry.context.id.clone(),
                artifact: TaskEntry::artifact(id, entry.reply.clone()),
                append: false,
                last_chunk: true,
            }));
        }
        entry.status_message = error.map(|error| Message {
            message_id: uuid::Uuid::new_v4().to_string(),
            context_id: Some(entry.context.id.clone()),
            task_id: Some(id.to_string()),
            role: Role::Agent,
            parts: vec![Part::text(error)],
            metadata: None,
        });
        entry.publish_status(id, state);
        entry.stream = None;
        entry.streamed = String::new();
        entry.terminal.send_replace(true);
        let snapshot = entry.snapshot(id, None, true);
        self.terminal_order.push_back(id.to_string());
        while self.terminal_order.len() > RETAINED_TERMINAL_TASKS {
            if let Some(oldest) = self.terminal_order.pop_front() {
                self.entries.remove(&oldest);
            }
        }
        Some(snapshot)
    }

    pub fn snapshot(&self, id: &str, history_length: Option<u32>) -> Option<Task> {
        self.entries
            .get(id)
            .map(|entry| entry.snapshot(id, history_length, true))
    }

    /// The task's current snapshot and a receiver for every later frame.
    pub fn subscribe(
        &self,
        id: &str,
        history_length: Option<u32>,
    ) -> Result<(Task, broadcast::Receiver<StreamResponse>), SubscribeError> {
        let entry = self.entries.get(id).ok_or(SubscribeError::NotFound)?;
        if entry.state.is_terminal() {
            return Err(SubscribeError::Terminal);
        }
        Ok((
            entry.snapshot(id, history_length, true),
            entry
                .stream
                .as_ref()
                .expect("a live task streams")
                .subscribe(),
        ))
    }

    pub fn live_ids(&self) -> Vec<String> {
        self.entries
            .iter()
            .filter(|(_, entry)| !entry.state.is_terminal())
            .map(|(id, _)| id.clone())
            .collect()
    }

    fn live(&mut self, id: &str) -> Option<&mut TaskEntry> {
        self.entries
            .get_mut(id)
            .filter(|entry| !entry.state.is_terminal())
    }

    /// One `ListTasks` page of `client`'s tasks: newest update first (ties
    /// by id), resuming strictly after the page token's `updatedAt:id`
    /// boundary. `Err` names the invalid parameter.
    pub fn list(
        &self,
        client: &str,
        params: &ListTasksParams,
    ) -> Result<ListTasksResponse, &'static str> {
        let page_size = match params.page_size {
            None => DEFAULT_PAGE_SIZE,
            Some(size @ 1..=MAX_PAGE_SIZE) => size,
            Some(_) => return Err("pageSize"),
        };
        let after = match params.status_timestamp_after.as_deref() {
            None => None,
            Some(timestamp) => {
                Some(crate::util::iso_to_unix_ms(timestamp).ok_or("statusTimestampAfter")?)
            }
        };
        let boundary = match params
            .page_token
            .as_deref()
            .filter(|token| !token.is_empty())
        {
            None => None,
            Some(token) => {
                let (at, id) = token
                    .strip_prefix(self.run.as_str())
                    .and_then(|rest| rest.strip_prefix(':')?.split_once(':'))
                    .ok_or("pageToken")?;
                Some((at.parse::<u64>().map_err(|_| "pageToken")?, id))
            }
        };
        let context = params.context_id.as_deref().filter(|id| !id.is_empty());
        let mut rows: Vec<(&String, &TaskEntry)> = self
            .entries
            .iter()
            .filter(|(_, entry)| {
                entry.context.client == client
                    && context.is_none_or(|context| entry.context.id == context)
                    && params.status.is_none_or(|state| entry.state == state)
                    && after.is_none_or(|after| entry.updated_at >= after)
            })
            .collect();
        rows.sort_by(|a, b| (b.1.updated_at, b.0).cmp(&(a.1.updated_at, a.0)));
        let total_size = rows.len() as u32;
        let start = boundary.map_or(0, |(at, id)| {
            rows.partition_point(|(row_id, entry)| (entry.updated_at, row_id.as_str()) >= (at, id))
        });
        let page: Vec<_> = rows.iter().skip(start).take(page_size as usize).collect();
        let next_page_token = match page.last() {
            Some((id, entry)) if start + page.len() < rows.len() => {
                format!("{}:{}:{id}", self.run, entry.updated_at)
            }
            _ => String::new(),
        };
        Ok(ListTasksResponse {
            tasks: page
                .iter()
                .map(|(id, entry)| {
                    entry.snapshot(id, params.history_length, params.include_artifacts)
                })
                .collect(),
            next_page_token,
            page_size,
            total_size,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(context: &str) -> Message {
        Message {
            message_id: "m-1".into(),
            context_id: Some(context.into()),
            task_id: None,
            role: Role::User,
            parts: vec![Part::text("hi")],
            metadata: None,
        }
    }

    fn drain(rx: &mut broadcast::Receiver<StreamResponse>) -> Vec<serde_json::Value> {
        std::iter::from_fn(|| rx.try_recv().ok())
            .map(|frame| serde_json::to_value(frame).unwrap())
            .collect()
    }

    #[test]
    fn a_task_streams_chunks_then_its_final_artifact_and_terminal_status() {
        let mut tasks = Tasks::default();
        tasks.admit("t", "client", message("c"));
        let (first, mut rx) = tasks.subscribe("t", None).unwrap();
        assert_eq!(first.status.state, TaskState::Submitted);
        assert!(tasks.start("t"));
        tasks.assistant_message_start("t");
        tasks.text_delta("t", "Hel");
        tasks.text_delta("t", "lo");
        // A mid-stream subscriber's snapshot holds what the chunks built.
        let (mid, _) = tasks.subscribe("t", None).unwrap();
        assert_eq!(
            mid.artifacts.unwrap()[0].parts[0].text.as_deref(),
            Some("Hello")
        );
        tasks.assistant_message_end("t", "Hello");
        tasks.assistant_message_start("t");
        tasks.text_delta("t", "Done");
        tasks.assistant_message_end("t", "Done");
        let settled = tasks.settle("t", TaskState::Completed, None).unwrap();
        let frames = drain(&mut rx);
        let chunks: Vec<_> = frames
            .iter()
            .filter_map(|frame| frame.get("artifactUpdate"))
            .map(|update| {
                (
                    update["artifact"]["parts"][0]["text"]
                        .as_str()
                        .unwrap()
                        .to_string(),
                    update["append"].as_bool().unwrap(),
                    update["lastChunk"].as_bool().unwrap(),
                )
            })
            .collect();
        assert_eq!(
            chunks,
            [
                ("Hel".to_string(), false, false),
                ("lo".to_string(), true, false),
                ("\n\nDone".to_string(), true, false),
                ("Hello\n\nDone".to_string(), false, true),
            ]
        );
        assert_eq!(
            frames[0]["statusUpdate"]["status"]["state"],
            "TASK_STATE_WORKING"
        );
        assert_eq!(
            frames.last().unwrap()["statusUpdate"]["status"]["state"],
            "TASK_STATE_COMPLETED"
        );
        assert_eq!(settled.history.len(), 2);
        assert_eq!(
            settled.artifacts.unwrap()[0].parts[0].text.as_deref(),
            Some("Hello\n\nDone")
        );
        // The first verdict stands; late frames change nothing.
        assert!(tasks.settle("t", TaskState::Canceled, None).is_none());
        tasks.text_delta("t", "late");
        assert!(drain(&mut rx).is_empty());
        assert_eq!(
            tasks.subscribe("t", None).unwrap_err(),
            SubscribeError::Terminal
        );
    }

    #[test]
    fn a_failed_task_carries_its_own_status_message_and_history_trims() {
        let mut tasks = Tasks::default();
        tasks.admit("t", "client", message("c"));
        tasks.start("t");
        tasks.assistant_message_end("t", "partial");
        let failed = tasks
            .settle("t", TaskState::Failed, Some("model error".into()))
            .unwrap();
        let status = failed.status.message.unwrap();
        assert_eq!(status.parts[0].text.as_deref(), Some("model error"));
        assert_ne!(status.message_id, failed.history[1].message_id);
        assert_eq!(tasks.snapshot("t", Some(1)).unwrap().history.len(), 1);
        assert!(tasks.snapshot("t", Some(0)).unwrap().history.is_empty());
    }

    #[test]
    fn an_unfinished_message_stays_in_the_reply() {
        let mut tasks = Tasks::default();
        tasks.admit("t", "client", message("c"));
        tasks.start("t");
        assert_eq!(
            tasks.snapshot("t", None).unwrap().artifacts,
            Some(Vec::new())
        );
        tasks.assistant_message_start("t");
        tasks.text_delta("t", "half an ans");
        // A failure emits its own (empty) message instead of finishing it.
        tasks.assistant_message_start("t");
        tasks.assistant_message_end("t", "");
        let failed = tasks
            .settle("t", TaskState::Failed, Some("boom".into()))
            .unwrap();
        assert_eq!(
            failed.artifacts.unwrap()[0].parts[0].text.as_deref(),
            Some("half an ans")
        );
    }

    #[test]
    fn a_canceled_submitted_task_never_starts() {
        let mut tasks = Tasks::default();
        tasks.admit("t", "client", message("c"));
        let mut terminal = tasks.terminal_watch("t").unwrap();
        tasks.settle("t", TaskState::Canceled, None).unwrap();
        assert!(*terminal.borrow_and_update());
        assert!(!tasks.start("t"));
    }

    #[test]
    fn list_pages_newest_first_and_filters() {
        let mut tasks = Tasks::default();
        for (index, context) in ["a", "b", "a"].iter().enumerate() {
            let id = format!("t{index}");
            tasks.admit(&id, "client", message(context));
            tasks.entries.get_mut(&id).unwrap().updated_at = index as u64;
        }
        let page = |token: Option<String>| {
            tasks
                .list(
                    "client",
                    &ListTasksParams {
                        page_size: Some(2),
                        page_token: token,
                        ..Default::default()
                    },
                )
                .unwrap()
        };
        let first = page(None);
        let ids: Vec<_> = first.tasks.iter().map(|task| task.id.as_str()).collect();
        assert_eq!((ids, first.total_size), (vec!["t2", "t1"], 3));
        let second = page(Some(first.next_page_token));
        assert_eq!(second.tasks[0].id, "t0");
        assert_eq!(second.next_page_token, "");
        let filtered = tasks
            .list(
                "client",
                &ListTasksParams {
                    context_id: Some("a".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(filtered.total_size, 2);
        assert!(filtered.tasks.iter().all(|task| task.artifacts.is_none()));
        for bad in [
            ListTasksParams {
                page_size: Some(0),
                ..Default::default()
            },
            ListTasksParams {
                page_token: Some("x".into()),
                ..Default::default()
            },
            // A token minted by an earlier server run.
            ListTasksParams {
                page_token: Some("0badc0de:1:t1".into()),
                ..Default::default()
            },
            ListTasksParams {
                status_timestamp_after: Some("yesterday".into()),
                ..Default::default()
            },
        ] {
            assert!(tasks.list("client", &bad).is_err());
        }
    }
}
