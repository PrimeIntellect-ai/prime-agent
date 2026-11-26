//! The A2A server over daemon sessions. Each `contextId` owns one daemon
//! session, and its tasks run one at a time. A task is one `PromptAndWait`
//! turn, then the idle wait with RLM quiescence, so the follow-up turns of
//! the task's child agents and background cells belong to the task.
//!
//! Only runs whose `agent_start` carries the task's admission id or the
//! `continuation` tag reach the task.
//!
//! Between tasks the server detaches from the session, so the daemon's idle
//! passivation can reclaim the worker; the next task re-opens the session
//! file (a live worker is reused) and attaches again.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use pa_types::daemon::{DaemonCommand, DaemonResponse, PromptInput};
use serde_json::{json, Map, Value};
use tokio::sync::broadcast;

use super::jsonrpc::{self, A2aError};
use super::tasks::{SubscribeError, Tasks};
use super::types::{
    prompt_text, ListTasksParams, PartsError, Role, SendMessageRequest, StreamResponse, Task,
    TaskQuery, TaskState,
};
use crate::acp::daemon::{
    acquire_session_input_pause, attach_daemon_session, create_daemon_session,
    release_session_input_pause, stop_session_work, summary_str, DaemonLink, LinkFrame,
};

pub struct A2aOptions {
    pub socket_path: PathBuf,
    pub bind_host: String,
    pub bind_port: u16,
    pub bearer_token: String,
    /// Set when the token was minted for this run: the agent dir its
    /// owner-only token file is written to once the listener binds.
    pub minted_token_dir: Option<PathBuf>,
    /// The most contexts with a live worker or task; a new context beyond
    /// it is refused.
    pub max_contexts: usize,
    /// The public URL of a TLS front: the card advertises it and a
    /// loopback bind accepts its `Host`.
    pub public_url: Option<String>,
    pub product_version: String,
    /// The session create for new contexts, built from the CLI flags.
    pub create: DaemonCommand,
}

pub(crate) enum Reply {
    Json(Value),
    /// An SSE stream: the request id, the task snapshot that opens it, and
    /// the live frames until the task's terminal status.
    Stream(Value, Box<Task>, broadcast::Receiver<StreamResponse>),
}

struct Running {
    task_id: String,
    admission_id: String,
    /// `CancelTask` owns the verdict: the flow leaves the settle to it.
    cancel_requested: bool,
    /// The failure of the task's latest run (a failed goal or autonomous
    /// continuation fails the task).
    run_error: Option<String>,
    /// The task's own prompt run has started: continuations before it
    /// belong to whatever ran ahead of the task.
    started: bool,
}

struct Context {
    /// The daemon session hosting the conversation; empty until the first
    /// task creates it.
    active_session_id: String,
    /// The session file a later task re-opens (`None` for `--no-session`,
    /// whose client-owned worker never passivates).
    session_file: Option<String>,
    running: Option<Running>,
    /// Whether the session's current run counts toward the running task.
    crediting: bool,
    /// Held by the context's task flow for its whole turn.
    turn: Arc<tokio::sync::Mutex<()>>,
}

#[derive(Default)]
struct State {
    tasks: Tasks,
    contexts: HashMap<String, Context>,
    /// Daemon active session id -> context id (the event routing).
    sessions: HashMap<String, String>,
    shutting_down: bool,
}

pub(crate) struct Server {
    link: Arc<DaemonLink>,
    state: Mutex<State>,
    create: DaemonCommand,
    max_contexts: usize,
    /// Held while a new context is counted against the cap and admitted.
    new_contexts: tokio::sync::Mutex<()>,
}

impl Server {
    pub(crate) fn new(
        link: Arc<DaemonLink>,
        create: DaemonCommand,
        max_contexts: usize,
    ) -> Arc<Self> {
        Arc::new(Self {
            link,
            state: Mutex::new(State::default()),
            create,
            max_contexts,
            new_contexts: tokio::sync::Mutex::new(()),
        })
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Route the link's frames until the daemon connection closes.
    pub(crate) async fn pump_events(&self) {
        while let Some(frame) = self.link.next_frame().await {
            match frame {
                LinkFrame::Event(frame) => self.on_session_event(&frame),
                LinkFrame::SessionBinding(binding) => self.on_session_binding(&binding),
                LinkFrame::HeartbeatsChanged => {}
            }
        }
    }

    /// A worker re-host moved a context's session to a new active id: route
    /// its events under the new id and attach to it.
    fn on_session_binding(&self, binding: &Value) {
        let field = |key: &str| binding.get(key).and_then(Value::as_str).unwrap_or_default();
        let (previous, current) = (field("previousActiveSessionId"), field("activeSessionId"));
        let mut state = self.state();
        let Some(context_id) = state.sessions.remove(previous) else {
            return;
        };
        state
            .sessions
            .insert(current.to_string(), context_id.clone());
        if let Some(context) = state.contexts.get_mut(&context_id) {
            context.active_session_id = current.to_string();
        }
        let link = Arc::clone(&self.link);
        let current = current.to_string();
        tokio::spawn(async move {
            if let Err(error) = attach_daemon_session(&link, &current).await {
                eprintln!("a2a: re-attaching session {current}: {error:#}");
            }
        });
    }

    /// Only runs that count toward the running task reach it.
    fn on_session_event(&self, frame: &Value) {
        let session = frame
            .get("activeSessionId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let event = frame.get("event").unwrap_or(&Value::Null);
        let message = event.get("message");
        let assistant = message
            .and_then(|message| message.get("role"))
            .and_then(Value::as_str)
            == Some("assistant");
        let mut state = self.state();
        let state = &mut *state;
        let Some(context) = state
            .sessions
            .get(session)
            .and_then(|context_id| state.contexts.get_mut(context_id))
        else {
            return;
        };
        let Some(running) = context.running.as_mut() else {
            return;
        };
        match event.get("type").and_then(Value::as_str) {
            Some("agent_start") => {
                let own = event.get("clientAdmissionId").and_then(Value::as_str)
                    == Some(running.admission_id.as_str());
                running.started |= own;
                context.crediting = own
                    || running.started
                        && event.get("continuation").and_then(Value::as_bool) == Some(true);
                if context.crediting {
                    running.run_error = None;
                }
                return;
            }
            Some("agent_end") => {
                context.crediting = false;
                return;
            }
            _ if !context.crediting => return,
            _ => {}
        }
        let task_id = running.task_id.as_str();
        match event.get("type").and_then(Value::as_str) {
            Some("turn_end") => {
                let failed = message
                    .filter(|message| {
                        message.get("stopReason").and_then(Value::as_str) == Some("error")
                    })
                    .map(|message| {
                        message
                            .get("errorMessage")
                            .and_then(Value::as_str)
                            .unwrap_or("the turn failed")
                    });
                if let Some(error) = event.get("error").and_then(Value::as_str).or(failed) {
                    running.run_error = Some(error.to_string());
                }
            }
            Some("message_start") if assistant => state.tasks.assistant_message_start(task_id),
            Some("message_update") => {
                let stream = event.get("assistantMessageEvent");
                if stream
                    .and_then(|stream| stream.get("type"))
                    .and_then(Value::as_str)
                    == Some("text_delta")
                {
                    if let Some(delta) = stream
                        .and_then(|stream| stream.get("delta"))
                        .and_then(Value::as_str)
                        .filter(|delta| !delta.is_empty())
                    {
                        state.tasks.text_delta(task_id, delta);
                    }
                }
            }
            Some("message_end") if assistant => {
                let text: String = message
                    .and_then(|message| message.get("content"))
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
                    .filter_map(|block| block.get("text").and_then(Value::as_str))
                    .collect();
                state.tasks.assistant_message_end(task_id, &text);
            }
            _ => {}
        }
    }

    pub(crate) async fn dispatch(self: &Arc<Self>, request: jsonrpc::Request) -> Reply {
        let jsonrpc::Request { id, method, params } = request;
        match method.as_str() {
            "SendMessage" => self.send_message(id, params, false).await,
            "SendStreamingMessage" => self.send_message(id, params, true).await,
            "GetTask" => Reply::Json(match parse::<TaskQuery>(&id, params) {
                Ok(query) => match self.state().tasks.snapshot(&query.id, query.history_length) {
                    Some(task) => task_reply(&id, &task),
                    None => task_not_found(&id, &query.id),
                },
                Err(reply) => reply,
            }),
            "ListTasks" => Reply::Json(match parse::<ListTasksParams>(&id, params) {
                Ok(params) => match self.state().tasks.list(&params) {
                    Ok(page) => jsonrpc::response(&id, &to_json(&page)),
                    Err(field) => jsonrpc::invalid_params(&id, field, "invalid value"),
                },
                Err(reply) => reply,
            }),
            "CancelTask" => Reply::Json(match parse::<TaskQuery>(&id, params) {
                Ok(query) => match self.cancel_task(&query.id).await {
                    Ok(task) => task_reply(&id, &task),
                    Err(error) => {
                        jsonrpc::a2a_error(&id, error, Some(json!({ "taskId": query.id })))
                    }
                },
                Err(reply) => reply,
            }),
            "SubscribeToTask" => match parse::<TaskQuery>(&id, params) {
                Ok(query) => match self
                    .state()
                    .tasks
                    .subscribe(&query.id, query.history_length)
                {
                    Ok((task, frames)) => Reply::Stream(id, Box::new(task), frames),
                    Err(SubscribeError::NotFound) => Reply::Json(task_not_found(&id, &query.id)),
                    Err(SubscribeError::Terminal) => Reply::Json(jsonrpc::a2a_error(
                        &id,
                        A2aError::UnsupportedOperation,
                        Some(json!({ "taskId": query.id, "reason": "the task is terminal" })),
                    )),
                },
                Err(reply) => Reply::Json(reply),
            },
            "CreateTaskPushNotificationConfig"
            | "GetTaskPushNotificationConfig"
            | "ListTaskPushNotificationConfigs"
            | "DeleteTaskPushNotificationConfig" => Reply::Json(jsonrpc::a2a_error(
                &id,
                A2aError::PushNotificationNotSupported,
                None,
            )),
            "GetExtendedAgentCard" => Reply::Json(jsonrpc::a2a_error(
                &id,
                A2aError::UnsupportedOperation,
                None,
            )),
            _ => Reply::Json(jsonrpc::error_response(
                &id,
                jsonrpc::METHOD_NOT_FOUND,
                "Method not found",
                None,
            )),
        }
    }

    /// The task runs detached from the HTTP request, so a client disconnect
    /// never strands it.
    async fn send_message(self: &Arc<Self>, id: Value, params: Value, streaming: bool) -> Reply {
        let request = match parse::<SendMessageRequest>(&id, params) {
            Ok(request) => request,
            Err(reply) => return Reply::Json(reply),
        };
        let mut message = request.message;
        let config = request.configuration.unwrap_or_default();
        if message.role != Role::User {
            return Reply::Json(jsonrpc::invalid_params(
                &id,
                "message.role",
                "a client message has the user role",
            ));
        }
        let text = match prompt_text(&message.parts) {
            Ok(text) => text,
            Err(PartsError::Invalid(reason)) => {
                return Reply::Json(jsonrpc::invalid_params(&id, "message.parts", reason))
            }
            Err(PartsError::NotText) => {
                return Reply::Json(jsonrpc::a2a_error(
                    &id,
                    A2aError::ContentTypeNotSupported,
                    Some(json!({ "supported": super::http::INPUT_MODE })),
                ))
            }
        };
        if config.task_push_notification_config.is_some() {
            return Reply::Json(jsonrpc::a2a_error(
                &id,
                A2aError::PushNotificationNotSupported,
                None,
            ));
        }
        message.context_id = message.context_id.filter(|context| !context.is_empty());
        if let Some(referenced) = message.task_id.as_deref().filter(|task| !task.is_empty()) {
            return Reply::Json(self.refuse_task_message(
                &id,
                referenced,
                message.context_id.as_deref(),
            ));
        }
        let context_id = message
            .context_id
            .clone()
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        // New contexts are admitted one at a time, so the count and the
        // admission cannot interleave with another new context's.
        let new_context_gate = if self.state().contexts.contains_key(&context_id) {
            None
        } else {
            Some(self.new_contexts.lock().await)
        };
        if new_context_gate.is_some()
            && !self.state().contexts.contains_key(&context_id)
            && self.live_contexts().await >= self.max_contexts
        {
            return Reply::Json(server_error(
                &id,
                "CONTEXT_LIMIT_REACHED",
                &format!(
                    "The server already serves its limit of {} live contexts; retry later or send on an existing contextId",
                    self.max_contexts
                ),
            ));
        }
        let task_id = uuid::Uuid::new_v4().to_string();
        let (first, frames, mut terminal) = {
            let mut state = self.state();
            if state.shutting_down {
                return Reply::Json(server_error(
                    &id,
                    "SHUTTING_DOWN",
                    "The server is shutting down",
                ));
            }
            message.task_id = Some(task_id.clone());
            message.context_id = Some(context_id.clone());
            state
                .contexts
                .entry(context_id.clone())
                .or_insert_with(|| Context {
                    active_session_id: String::new(),
                    session_file: None,
                    running: None,
                    crediting: false,
                    turn: Arc::default(),
                });
            state.tasks.admit(&task_id, message);
            let (first, frames) = state
                .tasks
                .subscribe(&task_id, config.history_length)
                .expect("an admitted task is live");
            let terminal = state.tasks.terminal_watch(&task_id).expect("admitted");
            (first, frames, terminal)
        };
        drop(new_context_gate);
        tokio::spawn(Arc::clone(self).run_task(task_id.clone(), context_id, text));
        if streaming {
            return Reply::Stream(id, Box::new(first), frames);
        }
        if !config.return_immediately {
            let _ = terminal.wait_for(|terminal| *terminal).await;
        }
        let snapshot = self.state().tasks.snapshot(&task_id, config.history_length);
        Reply::Json(match snapshot {
            Some(task) => jsonrpc::response(&id, &json!({ "task": task })),
            None => task_not_found(&id, &task_id),
        })
    }

    /// A message naming a `taskId`. Its context is the task's;
    /// a different `contextId` is rejected. A task is one turn here, so
    /// continuing one is refused: a terminal task takes no more messages,
    /// and a running one has no mid-turn input surface.
    fn refuse_task_message(&self, id: &Value, task_id: &str, context_id: Option<&str>) -> Value {
        let state = self.state();
        let (Some(task_state), Some(task_context)) =
            (state.tasks.state(task_id), state.tasks.context_id(task_id))
        else {
            return task_not_found(id, task_id);
        };
        if context_id.is_some_and(|context_id| context_id != task_context) {
            return jsonrpc::invalid_params(
                id,
                "message.contextId",
                "the contextId does not match the task's context",
            );
        }
        let reason = if task_state.is_terminal() {
            "the task is terminal; send a new message on its context"
        } else {
            "the task is running and takes no more input; send a new message on its context"
        };
        jsonrpc::a2a_error(
            id,
            A2aError::UnsupportedOperation,
            Some(json!({ "taskId": task_id, "contextId": task_context, "reason": reason })),
        )
    }

    /// The contexts that hold a worker or a live task.
    async fn live_contexts(&self) -> usize {
        let resident: HashSet<String> = self
            .link
            .request(DaemonCommand::List {
                id: None,
                all: None,
                cwd: None,
                session_dir: None,
                include_client_owned: Some(true),
                rest: Map::default(),
            })
            .await
            .ok()
            .and_then(|response| response.data)
            .and_then(|data| data.get("sessions").and_then(Value::as_array).cloned())
            .into_iter()
            .flatten()
            .filter_map(|row| {
                row.get("activeSessionId")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .collect();
        let state = self.state();
        let busy: HashSet<&str> = state
            .tasks
            .live_ids()
            .iter()
            .filter_map(|task_id| state.tasks.context_id(task_id))
            .collect();
        state
            .contexts
            .iter()
            .filter(|(context_id, context)| {
                busy.contains(context_id.as_str()) || resident.contains(&context.active_session_id)
            })
            .count()
    }

    /// One task's flow: wait for the context's turn, run the prompt, and
    /// settle, unless `CancelTask` took the verdict.
    async fn run_task(self: Arc<Self>, task_id: String, context_id: String, text: String) {
        let turn = Arc::clone(&self.state().contexts[&context_id].turn);
        let _turn = turn.lock().await;
        let Some(mut terminal) = self.state().tasks.terminal_watch(&task_id) else {
            return;
        };
        if *terminal.borrow() {
            return;
        }
        let outcome = self
            .run_turn(&task_id, &context_id, text, &mut terminal)
            .await;
        {
            let mut state = self.state();
            let state = &mut *state;
            let running = state.contexts[&context_id].running.as_ref();
            if !running.is_some_and(|running| running.cancel_requested) {
                match outcome.and_then(|()| {
                    running
                        .and_then(|running| running.run_error.clone())
                        .map_or(Ok(()), Err)
                }) {
                    Ok(()) => state.tasks.settle(&task_id, TaskState::Completed, None),
                    Err(error) => state.tasks.settle(&task_id, TaskState::Failed, Some(error)),
                };
            }
        }
        // A cancel that took the verdict settles once its stop finished;
        // the detach and the next task wait for that.
        let _ = terminal.wait_for(|terminal| *terminal).await;
        let session = self.current_session(&context_id);
        if !session.is_empty() {
            let _ = self
                .link
                .request(DaemonCommand::Detach {
                    id: None,
                    active_session_id: Some(session),
                    rest: Map::default(),
                })
                .await;
        }
        let mut state = self.state();
        let context = state.contexts.get_mut(&context_id).expect("contexts stay");
        context.running = None;
        context.crediting = false;
    }

    /// The context's current daemon session id (a worker re-host moves it).
    fn current_session(&self, context_id: &str) -> String {
        self.state().contexts[context_id].active_session_id.clone()
    }

    /// Host the session, send the prompt, and wait for the run to settle.
    /// `Ok` once the turn and its child-agent work finished (or a cancel
    /// settled the task); `Err` is the FAILED status text.
    async fn run_turn(
        &self,
        task_id: &str,
        context_id: &str,
        text: String,
        terminal: &mut tokio::sync::watch::Receiver<bool>,
    ) -> Result<(), String> {
        let session = self.host_session(context_id).await?;
        let admission_id = format!("a2a-admission:{}", uuid::Uuid::new_v4());
        let prompt = {
            let mut state = self.state();
            if !state.tasks.start(task_id) {
                return Ok(());
            }
            let context = state.contexts.get_mut(context_id).expect("contexts stay");
            context.running = Some(Running {
                task_id: task_id.to_string(),
                admission_id: admission_id.clone(),
                cancel_requested: false,
                run_error: None,
                started: false,
            });
            // Queued under the lock: a cancel that sees the task running
            // sends its stop after this prompt.
            self.link
                .dispatch(prompt_command(&session, text, admission_id))
                .map_err(|error| error.to_string())?
                .1
        };
        let response = tokio::select! {
            response = prompt => response,
            _ = terminal.wait_for(|terminal| *terminal) => return Ok(()),
        };
        settled_ok(response)?;
        // The child-settle barrier: idle, every child agent settled, and
        // every background-cell notice delivered.
        let quiescent = self
            .link
            .dispatch(DaemonCommand::WaitForIdle {
                id: None,
                active_session_id: self.current_session(context_id),
                wait_for_rlm_quiescence: Some(true),
                timeout_ms: None,
                rest: Map::default(),
            })
            .map_err(|error| error.to_string())?
            .1;
        tokio::select! {
            response = quiescent => settled_ok(response),
            _ = terminal.wait_for(|terminal| *terminal) => Ok(()),
        }
    }

    /// Make the context's session live and attached: the first task creates
    /// it; later tasks re-open its file (the daemon reuses a live worker and
    /// revives a passivated one) and attach.
    async fn host_session(&self, context_id: &str) -> Result<String, String> {
        let (mut active, file) = {
            let state = self.state();
            let context = &state.contexts[context_id];
            (
                context.active_session_id.clone(),
                context.session_file.clone(),
            )
        };
        if active.is_empty() || file.is_some() {
            let mut create = self.create.clone();
            if let DaemonCommand::Create { session_path, .. } = &mut create {
                session_path.clone_from(&file);
            }
            let summary = create_daemon_session(&self.link, create)
                .await
                .map_err(|error| format!("{error:#}"))?;
            let created = summary_str(&summary, "activeSessionId");
            let session_file = summary_str(&summary, "sessionFile");
            let mut state = self.state();
            state.sessions.remove(&active);
            state
                .sessions
                .insert(created.clone(), context_id.to_string());
            let context = state.contexts.get_mut(context_id).expect("contexts stay");
            context.active_session_id.clone_from(&created);
            context.session_file = (!session_file.is_empty()).then_some(session_file);
            active = created;
        }
        attach_daemon_session(&self.link, &active)
            .await
            .map_err(|error| format!("{error:#}"))?;
        Ok(active)
    }

    /// `CancelTask`: a queued task settles CANCELED at once. A running one
    /// gets its session stopped and settles CANCELED, or FAILED when the
    /// stop failed. A repeated cancel while the stop runs waits for it and
    /// answers the same task.
    async fn cancel_task(self: &Arc<Self>, task_id: &str) -> Result<Task, A2aError> {
        let stop = {
            let mut guard = self.state();
            let state = &mut *guard;
            match state.tasks.state(task_id) {
                None => return Err(A2aError::TaskNotFound),
                Some(task_state) if task_state.is_terminal() => {
                    return Err(A2aError::TaskNotCancelable)
                }
                Some(_) => {}
            }
            let context_id = state.tasks.context_id(task_id).unwrap_or_default();
            let context = state.contexts.get_mut(context_id).expect("contexts stay");
            match context
                .running
                .as_mut()
                .filter(|running| running.task_id == task_id)
            {
                Some(running) if running.cancel_requested => None,
                Some(running) => {
                    running.cancel_requested = true;
                    Some((
                        context.active_session_id.clone(),
                        running.admission_id.clone(),
                    ))
                }
                None => {
                    return state
                        .tasks
                        .settle(task_id, TaskState::Canceled, None)
                        .ok_or(A2aError::TaskNotCancelable)
                }
            }
        };
        let Some((session, admission_id)) = stop else {
            // A stop is already running: answer the task it settles.
            let mut terminal = self
                .state()
                .tasks
                .terminal_watch(task_id)
                .ok_or(A2aError::TaskNotFound)?;
            let _ = terminal.wait_for(|terminal| *terminal).await;
            return self
                .state()
                .tasks
                .snapshot(task_id, None)
                .ok_or(A2aError::TaskNotFound);
        };
        // Detached, so a client that drops the request cannot drop the verdict
        // the task flow is waiting for.
        let server = Arc::clone(self);
        let task = task_id.to_string();
        let stop = tokio::spawn(async move {
            let (state, error) = match stop_task_work(&server.link, &session, &admission_id).await {
                Ok(()) => (TaskState::Canceled, None),
                Err(error) => (
                    TaskState::Failed,
                    Some(format!("the cancel did not complete: {error:#}")),
                ),
            };
            server.state().tasks.settle(&task, state, error)
        });
        stop.await.ok().flatten().ok_or(A2aError::TaskNotCancelable)
    }

    /// Refuse new tasks, then stop every live task and wait until each
    /// settled (the server is exiting).
    pub(crate) async fn cancel_all(self: &Arc<Self>) {
        let live = {
            let mut state = self.state();
            state.shutting_down = true;
            state.tasks.live_ids()
        };
        futures::future::join_all(live.iter().map(|task_id| self.cancel_task(task_id))).await;
    }
}

/// Runs under an input pause, so notices that arrive meanwhile cannot hold
/// the idle wait or start a turn.
async fn stop_task_work(
    link: &Arc<DaemonLink>,
    session: &str,
    admission_id: &str,
) -> anyhow::Result<()> {
    link.request_ok(DaemonCommand::RetireContinuations {
        id: None,
        active_session_id: session.to_string(),
        rest: Map::default(),
    })
    .await?;
    let lease_key = uuid::Uuid::new_v4().to_string();
    let pause_id = acquire_session_input_pause(link, session, &lease_key).await?;
    let stopped = async {
        stop_session_work(link, session, Some(admission_id)).await?;
        link.request_ok(DaemonCommand::WaitForHeadlessCompletion {
            id: None,
            active_session_id: session.to_string(),
            wait_for_rlm_quiescence: Some(true),
            rest: Map::default(),
        })
        .await?;
        link.request_ok(DaemonCommand::ClearQueue {
            id: None,
            active_session_id: session.to_string(),
            rest: Map::default(),
        })
        .await
    }
    .await;
    let released = release_session_input_pause(link, session, &pause_id).await;
    stopped.and(released)
}

fn prompt_command(session: &str, text: String, admission_id: String) -> DaemonCommand {
    DaemonCommand::PromptAndWait {
        id: None,
        active_session_id: session.to_string(),
        message: text,
        input: PromptInput {
            content: None,
            images: None,
            // A follow-up never joins a run already going (another client's
            // turn, a scheduled fire); it runs as its own delivery and still
            // resumes a post-abort queue suspension.
            streaming_behavior: Some(pa_types::daemon::StreamingBehavior::FollowUp),
            queue_if_busy: Some(true),
            expand_prompt_templates: None,
            source: None,
            agent_message_id: None,
            custom_message: None,
            queue_key: None,
            prefix_messages: None,
            admission_id: Some(admission_id),
            rlm_notice_nonce: None,
        },
        rest: Map::default(),
    }
}

/// A daemon answer as the task's outcome: the failure text on error.
fn settled_ok(
    response: Result<DaemonResponse, tokio::sync::oneshot::error::RecvError>,
) -> Result<(), String> {
    let response = response.map_err(|_| "the daemon connection closed".to_string())?;
    if response.success {
        Ok(())
    } else {
        Err(response
            .error
            .unwrap_or_else(|| "the turn failed".to_string()))
    }
}

fn parse<T: serde::de::DeserializeOwned>(id: &Value, params: Value) -> Result<T, Value> {
    serde_json::from_value(params)
        .map_err(|error| jsonrpc::invalid_params(id, "params", &error.to_string()))
}

fn to_json(value: &impl serde::Serialize) -> Value {
    serde_json::to_value(value).expect("wire types serialize")
}

fn task_reply(id: &Value, task: &Task) -> Value {
    jsonrpc::response(id, &to_json(task))
}

/// A server-side refusal (JSON-RPC internal error) with an `ErrorInfo`
/// detail naming the reason.
fn server_error(id: &Value, reason: &str, message: &str) -> Value {
    jsonrpc::error_response(
        id,
        jsonrpc::INTERNAL_ERROR,
        message,
        Some(json!([{
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            "reason": reason,
            "domain": "prime-agent",
        }])),
    )
}

fn task_not_found(id: &Value, task_id: &str) -> Value {
    jsonrpc::a2a_error(
        id,
        A2aError::TaskNotFound,
        Some(json!({ "taskId": task_id })),
    )
}

/// Serve `--mode a2a` until SIGINT/SIGTERM or the daemon connection closes.
///
/// # Errors
///
/// Fails before serving when the daemon connect, the bind, or the minted
/// token file write fails, and when the daemon connection closes.
pub async fn run_daemon_attached_a2a_mode(options: A2aOptions) -> anyhow::Result<i32> {
    let link = Arc::new(DaemonLink::connect(&options.socket_path, "a2a").await?);
    let server = Server::new(link, options.create, options.max_contexts);
    let listener =
        tokio::net::TcpListener::bind((options.bind_host.as_str(), options.bind_port)).await?;
    let bound = listener.local_addr()?;
    if !bound.ip().is_loopback() {
        eprintln!(
            "Warning: --mode a2a is listening on {bound}: the bearer token authenticates but does not encrypt; put TLS in front of it."
        );
    }
    // Written only once this run owns the address, named for it, and
    // removed at every graceful exit.
    let token_file = options.minted_token_dir.map(|dir| {
        let address = bound.ip().to_string().replace([':', '.'], "-");
        dir.join(format!("a2a-token-{}-{address}", bound.port()))
    });
    if let Some(path) = &token_file {
        write_private_file(path, &options.bearer_token)?;
        eprintln!(
            "a2a: minted a bearer token for this run in {} (send \"Authorization: Bearer <token>\")",
            path.display()
        );
    }
    eprintln!("a2a: listening on http://{bound}");
    let serve = super::http::serve(
        listener,
        Arc::clone(&server),
        options.bearer_token,
        options.product_version,
        options.public_url,
    );
    // The pump outlives the select: the exit's cancels need its responses.
    let mut pump = tokio::spawn({
        let server = Arc::clone(&server);
        async move { server.pump_events().await }
    });
    let outcome = tokio::select! {
        result = serve => result,
        _ = &mut pump => Err(anyhow::anyhow!("the daemon connection closed")),
        () = shutdown_signal() => Ok(()),
    };
    server.cancel_all().await;
    if let Some(path) = &token_file {
        let _ = std::fs::remove_file(path);
    }
    outcome.map(|()| 0)
}

#[cfg(unix)]
async fn shutdown_signal() {
    use tokio::signal::unix::{signal, SignalKind};
    match signal(SignalKind::terminate()) {
        Ok(mut terminate) => tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = terminate.recv() => {}
        },
        Err(_) => {
            let _ = tokio::signal::ctrl_c().await;
        }
    }
}

#[cfg(not(unix))]
async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}

/// Write `token` to an owner-only file (created private, never widened).
fn write_private_file(path: &std::path::Path, token: &str) -> anyhow::Result<()> {
    use std::io::Write;
    if let Some(parent) = path.parent() {
        pa_core::platform::perms::create_dir_all_private(parent)?;
    }
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    pa_core::platform::perms::set_private_mode(&mut options);
    let mut file = options.open(path)?;
    pa_core::platform::perms::restrict_open_file(&file)?;
    file.write_all(format!("{token}\n").as_bytes())?;
    Ok(())
}
