//! Opt-in command hooks, owned by the session engine. No discovery or execution on startup.
mod config;
mod output;
mod process;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use futures::future::join_all;
use pa_agent::abort::{AbortController, AbortSignal};
use serde_json::Value;
use tokio::sync::{watch, OnceCell, Semaphore};

use config::{ConfiguredHook, Event};

/// Supported lifecycle effects; callers apply them at the appropriate runtime boundary.
#[derive(Default, Debug, PartialEq, Eq)]
pub(crate) struct HookOutcome {
    pub deny: Option<String>,
    pub stop: Option<String>,
    pub continuation: Option<String>,
    pub message: Option<String>,
    /// Non-fatal diagnostics about ignored output, shown once to the user.
    pub notices: Vec<String>,
}

/// Delivers one user-facing hook diagnostic. The session engine renders it as a
/// display-only transcript row; implementations must not block on the session.
pub(crate) type HookNoticeSink = Arc<dyn Fn(String) -> pa_agent::BoxFut<'static, ()> + Send + Sync>;

const INPUT_LIMIT: usize = 1024 * 1024;
// Distinct diagnostics surfaced per session; repeats of the same text are dropped.
const NOTICE_LIMIT: usize = 32;
const COMMAND_PREVIEW_CHARS: usize = 120;
const MESSAGE_PREVIEW_CHARS: usize = 1000;
struct State {
    cwd: PathBuf,
    agent_dir: PathBuf,
    config: OnceCell<Vec<ConfiguredHook>>,
    execution_cwd: OnceLock<PathBuf>,
    disabled: bool,
    executed: AtomicBool,
    on_execute: OnceLock<Arc<dyn Fn() + Send + Sync>>,
    on_notice: OnceLock<HookNoticeSink>,
    notices: Mutex<Vec<String>>,
    shutdown: AbortController,
    active: watch::Sender<usize>,
}

/// A session's snapshot and bounded background ownership; callbacks never retain the session.
pub(crate) struct HookRuntime {
    state: Arc<State>,
    observers: Mutex<Vec<tokio::task::JoinHandle<()>>>,
    observer_slots: Arc<Semaphore>,
    ending: AtomicBool,
    finished: OnceCell<watch::Receiver<bool>>,
}

impl HookRuntime {
    pub(crate) fn new(cwd: PathBuf, agent_dir: PathBuf) -> Self {
        Self {
            state: Arc::new(State {
                cwd,
                agent_dir,
                config: OnceCell::new(),
                execution_cwd: OnceLock::new(),
                disabled: std::env::var_os("PRIME_AGENT_HOOK_ACTIVE").is_some(),
                executed: AtomicBool::new(false),
                on_execute: OnceLock::new(),
                on_notice: OnceLock::new(),
                notices: Mutex::new(Vec::new()),
                shutdown: AbortController::new(),
                active: watch::channel(0).0,
            }),
            observers: Mutex::new(Vec::new()),
            observer_slots: Arc::new(Semaphore::new(8)),
            ending: AtomicBool::new(false),
            finished: OnceCell::new(),
        }
    }

    pub(crate) fn might_run(&self, event: &str) -> bool {
        !self.state.disabled
            && !self.ending.load(Ordering::Acquire)
            && self
                .state
                .config
                .get()
                .is_none_or(|hooks| hooks.iter().any(|hook| hook.event.name() == event))
    }

    pub(crate) fn set_on_execute(&self, callback: Arc<dyn Fn() + Send + Sync>) {
        let _ = self.state.on_execute.set(callback);
    }

    pub(crate) fn set_on_notice(&self, sink: HookNoticeSink) {
        let _ = self.state.on_notice.set(sink);
    }

    /// Show a hook decision to the user. Unlike diagnostics, decisions are
    /// never deduplicated: every rejected submission is reported.
    pub(crate) async fn report(&self, text: String) {
        if let Some(sink) = self.state.on_notice.get() {
            sink(text).await;
        }
    }

    pub(crate) async fn evaluate(&self, input: Value, signal: AbortSignal) -> Option<String> {
        self.dispatch(input, signal).await.deny
    }

    pub(crate) async fn dispatch(&self, input: Value, signal: AbortSignal) -> HookOutcome {
        if self.state.disabled || signal.is_aborted() {
            return HookOutcome::default();
        }
        let Some(Ok(event)) = input
            .get("hook_event_name")
            .and_then(Value::as_str)
            .map(Event::parse)
        else {
            tracing::warn!("unsupported hook dispatch event");
            return HookOutcome::default();
        };
        if event == Event::SessionEnd {
            self.finish(input).await;
            return HookOutcome::default();
        }
        if self.ending.load(Ordering::Acquire) {
            return HookOutcome::default();
        }
        if event == Event::PostToolUse {
            self.observe(&input);
            return HookOutcome::default();
        }
        tokio::select! {
            biased;
            () = signal.aborted() => HookOutcome::default(),
            outcome = self.state.dispatch(event, input, signal.clone()) => outcome,
        }
    }

    /// Join one shared, bounded close operation. Dropping one waiter cannot restart
    /// hooks or let another close path exit while the first callback is running.
    pub(crate) async fn finish(&self, input: Value) {
        let receiver = self
            .finished
            .get_or_init(|| async {
                self.ending.store(true, Ordering::Release);
                self.state.shutdown.abort();
                let tasks: Vec<_> = self.observers.lock().unwrap().drain(..).collect();
                for task in &tasks {
                    task.abort();
                }
                let state = Arc::clone(&self.state);
                let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(3);
                let (sender, receiver) = watch::channel(false);
                tokio::spawn(async move {
                    let close = async {
                        // Canceled observers release their process groups and slots first.
                        for task in tasks {
                            let _ = task.await;
                        }
                        let mut active = state.active.subscribe();
                        while *active.borrow_and_update() != 0 {
                            if active.changed().await.is_err() {
                                break;
                            }
                        }
                        state
                            .dispatch(Event::SessionEnd, input, AbortSignal::default())
                            .await;
                    };
                    if tokio::time::timeout_at(deadline, close).await.is_err() {
                        tracing::warn!("SessionEnd total deadline exceeded");
                    }
                    let _ = sender.send(true);
                });
                receiver
            })
            .await;
        let mut receiver = receiver.clone();
        while !*receiver.borrow_and_update() {
            if receiver.changed().await.is_err() {
                break;
            }
        }
    }

    pub(crate) fn observe(&self, input: &Value) {
        if self.state.disabled || self.ending.load(Ordering::Acquire) {
            return;
        }
        // Fast no-hooks path after lazy discovery, no task or serialization per tool.
        if self
            .state
            .config
            .get()
            .is_some_and(|hooks| !hooks.iter().any(|hook| hook.event == Event::PostToolUse))
        {
            return;
        }
        let Ok(slot) = self.observer_slots.clone().try_acquire_owned() else {
            tracing::warn!("PostToolUse observer queue full; observation dropped");
            self.state.notify_detached(
                "PostToolUse hook observation dropped: at most 8 observations may be pending per session.".into(),
            );
            return;
        };
        let input = match bounded_input(input) {
            Ok(input) => Arc::new(input),
            Err(error) => {
                tracing::warn!(%error, "hook observation rejected");
                self.state
                    .notify_detached(format!("PostToolUse hook observation dropped: {error:#}."));
                return;
            }
        };
        let state = self.state.clone();
        // Serialize admission with finish's drain; no external work is awaited here.
        let mut tasks = self.observers.lock().unwrap();
        if self.ending.load(Ordering::Acquire) {
            return;
        }
        let task = tokio::spawn(async move {
            let _slot = slot;
            let hooks = state.config().await;
            let name = serde_json::from_slice::<Value>(&input)
                .ok()
                .and_then(|v| {
                    v.get("tool_name")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                })
                .unwrap_or_default();
            // One bounded observation task owns its hooks; pending observations
            // are bounded per session by `observer_slots`.
            let matching = hooks
                .iter()
                .filter(|hook| hook.matches(Event::PostToolUse, &name));
            join_all(matching.map(|hook| state.run(hook, input.clone(), AbortSignal::default())))
                .await;
        });
        tasks.retain(|task| !task.is_finished());
        tasks.push(task);
    }
}

impl Drop for HookRuntime {
    fn drop(&mut self) {
        for task in self.observers.get_mut().unwrap().drain(..) {
            task.abort();
        }
    }
}

impl State {
    async fn dispatch(&self, event: Event, input: Value, signal: AbortSignal) -> HookOutcome {
        let hooks = self.config().await;
        if signal.is_aborted() {
            return HookOutcome::default();
        }
        let key = match event {
            Event::PreToolUse | Event::PostToolUse => "tool_name",
            Event::SessionStart => "source",
            Event::PreCompact => "trigger",
            Event::SessionEnd => "reason",
            Event::UserPromptSubmit | Event::Stop => "",
        };
        let value = input.get(key).and_then(Value::as_str).unwrap_or_default();
        let matching: Vec<_> = hooks
            .iter()
            .filter(|hook| hook.matches(event, value))
            .collect();
        if matching.is_empty() {
            return HookOutcome::default();
        }
        let input = match bounded_input(&input) {
            Ok(input) => Arc::new(input),
            Err(error) => {
                tracing::warn!(%error, "hook input rejected");
                self.notify(format!(
                    "{} hooks skipped, operation unchanged: {error:#}.",
                    event.name()
                ))
                .await;
                return HookOutcome::default();
            }
        };
        let outcomes = join_all(
            matching
                .into_iter()
                .map(|hook| self.run(hook, input.clone(), signal.clone())),
        )
        .await;
        let mut outcome = HookOutcome::default();
        for result in outcomes.into_iter().flatten() {
            if outcome.deny.is_none() {
                outcome.deny = result.deny;
            }
            if outcome.stop.is_none() {
                outcome.stop = result.stop;
            }
            if let Some(reason) = result.continuation {
                append_bounded(&mut outcome.continuation, &reason);
            }
            if let Some(message) = result.message {
                append_bounded(&mut outcome.message, &message);
            }
        }
        if outcome.stop.is_some() {
            outcome.continuation = None;
            outcome.deny = None;
        }
        outcome
    }

    async fn config(&self) -> &[ConfiguredHook] {
        self.config
            .get_or_init(|| async {
                if self.disabled {
                    return Vec::new();
                }
                let cwd = self.cwd.clone();
                let agent_dir = self.agent_dir.clone();
                // Diagnostics surface once: the snapshot initializes once per session.
                match tokio::task::spawn_blocking(move || -> anyhow::Result<_> {
                    let cwd = cwd.canonicalize()?;
                    let loaded = config::load(&cwd, &agent_dir)?;
                    Ok((cwd, loaded))
                })
                .await
                {
                    Ok(Ok((cwd, loaded))) => {
                        let _ = self.execution_cwd.set(cwd);
                        for diagnostic in loaded.diagnostics {
                            self.notify(diagnostic).await;
                        }
                        loaded.hooks
                    }
                    Ok(Err(error)) => {
                        tracing::warn!(%error, "hooks disabled: invalid configuration or trust");
                        self.notify(format!(
                            "Hooks disabled for this session: {error:#}. See docs/hooks.md."
                        ))
                        .await;
                        Vec::new()
                    }
                    Err(error) => {
                        tracing::warn!(%error, "hook discovery failed");
                        self.notify(format!(
                            "Hooks disabled for this session: discovery failed: {error}."
                        ))
                        .await;
                        Vec::new()
                    }
                }
            })
            .await
    }

    /// Surface one diagnostic to the session's user, once per distinct text.
    async fn notify(&self, text: String) {
        if let Some((sink, text)) = self.admit_notice(text) {
            sink(text).await;
        }
    }

    /// The synchronous observer path cannot await the session; delivery is detached.
    fn notify_detached(&self, text: String) {
        if let Some((sink, text)) = self.admit_notice(text) {
            tokio::spawn(sink(text));
        }
    }

    fn admit_notice(&self, text: String) -> Option<(HookNoticeSink, String)> {
        let sink = self.on_notice.get()?;
        let mut seen = self
            .notices
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if seen.contains(&text) || seen.len() > NOTICE_LIMIT {
            return None;
        }
        let text = if seen.len() == NOTICE_LIMIT {
            "Further hook diagnostics in this session are suppressed.".to_string()
        } else {
            text
        };
        seen.push(text.clone());
        Some((Arc::clone(sink), text))
    }

    async fn run(
        &self,
        hook: &ConfiguredHook,
        input: Arc<Vec<u8>>,
        signal: AbortSignal,
    ) -> Option<HookOutcome> {
        let _active = if hook.event == Event::SessionEnd {
            None
        } else {
            let mut admitted = false;
            self.active.send_modify(|count| {
                if !self.shutdown.is_aborted() {
                    *count += 1;
                    admitted = true;
                }
            });
            if !admitted {
                return None;
            }
            Some(ActiveCommand(self))
        };
        let shutdown = self.shutdown.signal();
        let operation = async {
            if !self.executed.swap(true, Ordering::Relaxed) {
                if let Some(callback) = self.on_execute.get() {
                    callback();
                }
            }
            let output = process::run(
                &hook.command,
                self.execution_cwd.get().unwrap_or(&self.cwd),
                (*input).clone(),
                hook.timeout,
                signal.clone(),
            )
            .await?;
            output::parse(hook.event, output)
        };
        let result = tokio::select! {
            biased;
            () = signal.aborted() => return None,
            () = shutdown.aborted(), if hook.event != Event::SessionEnd => return None,
            result = tokio::time::timeout(hook.timeout, operation) => result,
        };
        let event = hook.event.name();
        let command = preview(
            &hook
                .command
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" "),
            COMMAND_PREVIEW_CHARS,
        );
        match result {
            Ok(Ok(mut outcome)) => {
                for notice in std::mem::take(&mut outcome.notices) {
                    self.notify(format!("{notice}\ncommand: {command}")).await;
                }
                if let Some(message) = &outcome.message {
                    tracing::warn!(%message, event, %command, "hook systemMessage");
                    let message = preview(message, MESSAGE_PREVIEW_CHARS);
                    self.notify(format!("{event} hook message: {message}"))
                        .await;
                }
                Some(outcome)
            }
            // The runner's own deadline (stdin, pipes and exit) is the same timeout.
            Ok(Err(error))
                if error
                    .downcast_ref::<tokio::time::error::Elapsed>()
                    .is_none() =>
            {
                tracing::warn!(%error, event, %command, "hook failed; operation unchanged");
                self.notify(format!(
                    "{event} hook failed, operation unchanged: {error:#}\ncommand: {command}"
                ))
                .await;
                None
            }
            Ok(Err(_)) | Err(_) => {
                tracing::warn!(event, %command, "hook deadline exceeded; operation unchanged");
                self.notify(format!(
                    "{event} hook timed out after {}s, operation unchanged\ncommand: {command}",
                    hook.timeout.as_secs()
                ))
                .await;
                None
            }
        }
    }
}

// Declared before command futures, so their process-group guards are dropped
// before shutdown observers see the active count return to zero.
struct ActiveCommand<'a>(&'a State);

impl Drop for ActiveCommand<'_> {
    fn drop(&mut self) {
        self.0.active.send_modify(|count| *count -= 1);
    }
}

/// Hook-supplied text bounded for a diagnostic row.
fn preview(text: &str, limit: usize) -> String {
    let text = text.trim();
    let mut preview: String = text.chars().take(limit).collect();
    if preview.len() < text.len() {
        preview.push('…');
    }
    preview
}

fn append_bounded(target: &mut Option<String>, text: &str) {
    const LIMIT: usize = 64 * 1024;
    let output = target.get_or_insert_with(String::new);
    if !output.is_empty() && output.len() < LIMIT {
        output.push('\n');
    }
    let mut remaining = LIMIT.saturating_sub(output.len()).min(text.len());
    while !text.is_char_boundary(remaining) {
        remaining -= 1;
    }
    output.push_str(&text[..remaining]);
    if remaining < text.len() {
        tracing::warn!("combined hook feedback truncated to 64 KiB");
    }
}

fn bounded_input(input: &Value) -> anyhow::Result<Vec<u8>> {
    use std::io::Write;
    struct Limited(Vec<u8>);
    impl Write for Limited {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if bytes.len() > INPUT_LIMIT.saturating_sub(self.0.len()) {
                return Err(std::io::Error::other("hook input exceeds 1 MiB"));
            }
            self.0.extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut writer = Limited(Vec::new());
    serde_json::to_writer(&mut writer, input)?;
    Ok(writer.0)
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
