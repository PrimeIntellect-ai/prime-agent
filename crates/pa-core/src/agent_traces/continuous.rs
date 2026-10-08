//! Consent-gated automatic delivery. The detached process-wide runtime owns all
//! reads, recovery and delivery; hosts only record bounded intent and wake it.
use super::*;
use std::sync::{Mutex, OnceLock, Weak};
use std::time::Duration;
use tokio::time::Instant;

const DEBOUNCE: Duration = Duration::from_secs(1);
const MIN_INTERVAL: Duration = Duration::from_secs(60);
const MAX_CONTROLLERS: usize = 256;

#[derive(Default, Debug)]
struct Schedule {
    due: Option<Instant>,
    last_start: Option<Instant>,
    not_before: Option<Instant>,
    generation: u64,
}

impl Schedule {
    fn persist(&mut self, now: Instant) {
        self.generation = self.generation.wrapping_add(1);
        self.due = Some(self.deadline(now));
    }

    fn deadline(&self, now: Instant) -> Instant {
        let mut due = now + DEBOUNCE;
        if let Some(start) = self.last_start {
            due = due.max(start + MIN_INTERVAL);
        }
        if let Some(not_before) = self.not_before {
            due = due.max(not_before);
        }
        due
    }

    fn start(&mut self, now: Instant) -> u64 {
        self.due = None;
        self.last_start = Some(now);
        self.generation
    }

    fn settle(&mut self, now: Instant, started_generation: u64, result: &TraceUploadResult) {
        let retry = matches!(result, TraceUploadResult::Failed { status_code, .. }
            if status_code.is_none_or(|status| status == 429 || RETRIABLE_HTTP_STATUSES.contains(&status)));
        if let TraceUploadResult::Failed {
            retry_after_ms: Some(ms),
            ..
        } = result
        {
            self.not_before = Some(now + Duration::from_millis(*ms));
        }
        if retry || self.generation != started_generation {
            self.due = Some(self.deadline(now));
        }
    }
}

// A changed settings generation fails closed at persist time, including changes
// made by a different client process. Parsing/reloading happens only in the worker.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ConsentGeneration(Vec<Result<Option<(u64, SystemTime)>, std::io::ErrorKind>>);

impl ConsentGeneration {
    fn read(cwd: &Path, agent_dir: &Path) -> Self {
        Self(
            [
                agent_dir.join("settings.json"),
                cwd.join(crate::settings::storage::CONFIG_DIR_NAME)
                    .join("settings.json"),
            ]
            .iter()
            .map(|path| match std::fs::metadata(path) {
                Ok(m) => m
                    .modified()
                    .map(|mtime| Some((m.len(), mtime)))
                    .map_err(|e| e.kind()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
                Err(error) => Err(error.kind()),
            })
            .collect(),
        )
    }
}

/// Consent captured around the host's settings load. The generation must be
/// captured before parsing so a concurrent settings change fails closed.
#[derive(Clone)]
pub struct TraceConsentSnapshot {
    enabled: bool,
    generation: ConsentGeneration,
}

/// Session-owned installation. Dropping the last host reference cancels delivery;
/// no host shutdown awaits this worker or its retry timers.
pub struct ContinuousTraceUpload {
    cwd: PathBuf,
    agent_dir: PathBuf,
    consent: Mutex<(bool, ConsentGeneration)>,
    // The path is passed by the writer: forks/rebindings cannot upload a stale path.
    pending: Mutex<Option<(PathBuf, Schedule)>>,
    wake: Arc<tokio::sync::Notify>,
    cancel: TraceUploadCancel,
}

impl std::fmt::Debug for ContinuousTraceUpload {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ContinuousTraceUpload")
            .finish_non_exhaustive()
    }
}

impl Drop for ContinuousTraceUpload {
    fn drop(&mut self) {
        self.cancel.cancel();
        self.wake.notify_one();
    }
}

impl ContinuousTraceUpload {
    /// Reuse this settings load for the host's other settings. Only two bounded
    /// metadata reads are added; parsing is the existing host configuration load.
    #[must_use]
    pub fn load_settings(
        cwd: &Path,
        agent_dir: &Path,
    ) -> (crate::settings::SettingsManager, TraceConsentSnapshot) {
        let generation = ConsentGeneration::read(cwd, agent_dir);
        let settings = crate::settings::SettingsManager::create(cwd, agent_dir);
        let consent = TraceConsentSnapshot {
            enabled: settings.errors().is_empty() && settings.get_agent_traces_enabled(),
            generation,
        };
        (settings, consent)
    }

    /// Bind a replacement session without parsing settings or awaiting delivery.
    /// A cwd change starts with consent off until the background reader verifies it.
    #[must_use]
    pub fn rebind(&self, cwd: &Path, path: &Path) -> Arc<Self> {
        let consent = self.consent.lock().unwrap();
        let snapshot = TraceConsentSnapshot {
            enabled: cwd == self.cwd && consent.0,
            generation: if cwd == self.cwd {
                consent.1.clone()
            } else {
                ConsentGeneration::read(cwd, &self.agent_dir)
            },
        };
        drop(consent);
        Self::install(cwd, &self.agent_dir, Some(path), snapshot)
    }

    /// Fork within this installation's effective working directory.
    #[must_use]
    pub fn forked(&self, path: &Path) -> Arc<Self> {
        self.rebind(&self.cwd, path)
    }

    /// Install without scanning the outbox or waiting for networking. Consent
    /// is captured around the host's existing settings load.
    #[must_use]
    pub fn install(
        cwd: &Path,
        agent_dir: &Path,
        session_file: Option<&Path>,
        consent: TraceConsentSnapshot,
    ) -> Arc<Self> {
        let controller = Arc::new(Self {
            cwd: cwd.to_path_buf(),
            agent_dir: agent_dir.to_path_buf(),
            consent: Mutex::new((consent.enabled, consent.generation)),
            pending: Mutex::new(session_file.map(|p| (p.to_path_buf(), Schedule::default()))),
            wake: Arc::new(tokio::sync::Notify::new()),
            cancel: TraceUploadCancel::new(),
        });
        let service = service();
        let mut registrations = service.controllers.lock().unwrap();
        registrations.retain(|item| item.strong_count() > 0);
        if registrations.len() < MAX_CONTROLLERS {
            registrations.push(Arc::downgrade(&controller));
            service.wake.notify_one();
        } else {
            tracing::warn!(
                "trace controller capacity reached; durable intent retained for recovery"
            );
        }
        controller
    }

    /// Called only after a successful transcript write. This performs no
    /// transcript read, settings parse, directory scan or network. Only the small
    /// pending record is serialized synchronously.
    pub fn persisted(&self, session_file: &Path) {
        if session_file.as_os_str().is_empty() {
            return;
        }
        let consent = self.consent.lock().unwrap();
        if !consent.0
            || consent.1 .0.iter().any(Result::is_err)
            || consent.1 != ConsentGeneration::read(&self.cwd, &self.agent_dir)
        {
            return;
        }
        drop(consent);
        let began = std::time::Instant::now();
        if let Err(error) = mark_pending(&self.agent_dir, session_file) {
            tracing::warn!(%error, "trace pending marker failed");
        }
        tracing::trace!(
            elapsed_us = began.elapsed().as_micros() as u64,
            "trace pending marker duration"
        );
        let mut pending = self.pending.lock().unwrap();
        let (path, schedule) =
            pending.get_or_insert_with(|| (session_file.to_path_buf(), Schedule::default()));
        if path != session_file {
            *path = session_file.to_path_buf();
            *schedule = Schedule::default();
        }
        schedule.persist(Instant::now());
        drop(pending);
        self.wake.notify_one();
    }
}

fn mark_pending(agent_dir: &Path, session_file: &Path) -> std::io::Result<()> {
    let entry = agent_trace_outbox_entry_path(agent_dir, session_file);
    if entry.exists() {
        return Ok(());
    }
    std::fs::create_dir_all(agent_trace_outbox_dir(agent_dir))?;
    // Publish a complete record without replacing a racing successful cursor.
    let temp = entry.with_extension(format!(
        "{}.{}.tmp",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let result = (|| {
        use std::io::Write;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        crate::platform::perms::set_private_mode(&mut options);
        let mut file = options.open(&temp)?;
        writeln!(
            file,
            "{}",
            json!({"sessionFile": session_file.to_string_lossy()})
        )?;
        match std::fs::hard_link(&temp, &entry) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
            Err(error) => Err(error),
        }
    })();
    let _ = std::fs::remove_file(temp);
    result
}

fn delivery_lease(agent_dir: &Path, path: &Path) -> Option<std::fs::File> {
    let lock = agent_trace_outbox_entry_path(agent_dir, path).with_extension("lock");
    std::fs::create_dir_all(agent_trace_outbox_dir(agent_dir)).ok()?;
    let mut options = std::fs::OpenOptions::new();
    options.create(true).read(true).write(true).truncate(false);
    crate::platform::perms::set_private_mode(&mut options);
    let file = options.open(lock).ok()?;
    file.try_lock().ok()?;
    Some(file)
}

struct Service {
    controllers: Mutex<Vec<Weak<ContinuousTraceUpload>>>,
    wake: tokio::sync::Notify,
}

fn service() -> &'static Service {
    static SERVICE: OnceLock<Service> = OnceLock::new();
    SERVICE.get_or_init(|| {
        let service = Service {
            controllers: Mutex::new(Vec::new()),
            wake: tokio::sync::Notify::new(),
        };
        // Detached OS threads do not extend process lifetime. The host's Tokio
        // blocking pool is never used by uploads or outbox recovery.
        if let Err(error) = std::thread::Builder::new()
            .name("trace-upload".into())
            .spawn(|| {
                let runtime = match tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    Ok(runtime) => runtime,
                    Err(error) => {
                        tracing::warn!(%error, "trace runtime failed");
                        return;
                    }
                };
                runtime.block_on(run_service());
            })
        {
            tracing::warn!(%error, "trace thread failed");
        }
        service
    })
}

async fn run_service() {
    let service = service();
    let permits = Arc::new(tokio::sync::Semaphore::new(4));
    let mut active = std::collections::HashSet::new();
    let mut recovered = std::collections::HashSet::new();
    loop {
        let controllers = service.controllers.lock().unwrap().clone();
        active.retain(|key| {
            controllers
                .iter()
                .any(|weak| weak.as_ptr() as usize == *key && weak.strong_count() > 0)
        });
        for weak in controllers {
            let key = weak.as_ptr() as usize;
            if let Some(controller) = weak.upgrade() {
                if recovered.len() < MAX_CONTROLLERS
                    && recovered.insert(controller.agent_dir.clone())
                {
                    tokio::spawn(recover(
                        Arc::downgrade(&controller),
                        permits.clone(),
                        Arc::new(ReqwestTraceHttp),
                        None,
                    ));
                }
                if active.insert(key) {
                    tokio::spawn(run_controller(
                        weak,
                        permits.clone(),
                        Arc::new(ReqwestTraceHttp),
                        None,
                    ));
                }
            }
        }
        service.wake.notified().await;
    }
}

async fn run_controller(
    weak: Weak<ContinuousTraceUpload>,
    permits: Arc<tokio::sync::Semaphore>,
    http: Arc<dyn TraceHttp>,
    base_url: Option<String>,
) {
    if let Some(controller) = weak.upgrade() {
        let mut pending = controller.pending.lock().unwrap();
        if let Some((path, schedule)) = pending.as_mut() {
            if agent_trace_outbox_entry_path(&controller.agent_dir, path).is_file() {
                schedule.persist(Instant::now());
            }
        }
    }
    let mut initialized = false;
    loop {
        let Some(controller) = weak.upgrade() else {
            return;
        };
        let generation = ConsentGeneration::read(&controller.cwd, &controller.agent_dir);
        if controller.consent.lock().unwrap().1 != generation || !initialized {
            let settings =
                crate::settings::SettingsManager::create(&controller.cwd, &controller.agent_dir);
            let unchanged =
                generation == ConsentGeneration::read(&controller.cwd, &controller.agent_dir);
            *controller.consent.lock().unwrap() = (
                unchanged && settings.errors().is_empty() && settings.get_agent_traces_enabled(),
                generation,
            );
            initialized = true;
        }
        let due = controller
            .pending
            .lock()
            .unwrap()
            .as_ref()
            .and_then(|(_, s)| s.due);
        let wake = controller.wake.clone();
        let cancel = controller.cancel.clone();
        // Weak ownership during waits is essential: timers cannot keep a session alive.
        drop(controller);
        if due.is_none_or(|due| due > Instant::now()) {
            let wait = due.map_or(DEBOUNCE, |due| {
                due.saturating_duration_since(Instant::now()).min(DEBOUNCE)
            });
            tokio::select! { () = wake.notified() => {}, () = tokio::time::sleep(wait) => {}, () = cancel.wait() => return }
            continue;
        }
        let permit = tokio::select! { p = permits.clone().acquire_owned() => p.unwrap(), () = cancel.wait() => return };
        let Some(controller) = weak.upgrade() else {
            return;
        };
        let path = controller
            .pending
            .lock()
            .unwrap()
            .as_ref()
            .map(|(path, _)| path.clone());
        let Some(path) = path else {
            continue;
        };
        let Some(_delivery_lease) = delivery_lease(&controller.agent_dir, &path) else {
            drop(controller);
            tokio::select! { () = tokio::time::sleep(DEBOUNCE) => {}, () = cancel.wait() => return }
            continue;
        };
        let leased_path = path;
        let (path, generation) = {
            let mut pending = controller.pending.lock().unwrap();
            let Some((path, schedule)) = pending.as_mut() else {
                continue;
            };
            if path != &leased_path || schedule.due.is_none_or(|due| due > Instant::now()) {
                continue;
            }
            (path.clone(), schedule.start(Instant::now()))
        };
        let cwd = controller.cwd.clone();
        let agent_dir = controller.agent_dir.clone();
        drop(controller);
        let result = upload_trace_file(&TraceUploadOptions {
            session_file: Some(&path),
            cwd: &cwd,
            agent_dir: &agent_dir,
            require_enabled: true,
            reload_config: true,
            base_url: base_url.as_deref(),
            http: http.as_ref(),
            request_timeout_ms: DEFAULT_REQUEST_TIMEOUT_MS,
            cancel: Some(&cancel),
            on_upload_delay: None,
        })
        .await;
        drop(permit);
        if let Some(controller) = weak.upgrade() {
            let mut pending = controller.pending.lock().unwrap();
            if let Some((current, schedule)) = pending.as_mut() {
                if current == &path {
                    schedule.settle(Instant::now(), generation, &result);
                }
            }
        }
    }
}

async fn recover(
    weak: Weak<ContinuousTraceUpload>,
    permits: Arc<tokio::sync::Semaphore>,
    http: Arc<dyn TraceHttp>,
    base_url: Option<String>,
) {
    let Some(controller) = weak.upgrade() else {
        return;
    };
    let cwd = controller.cwd.clone();
    let agent_dir = controller.agent_dir.clone();
    let cancel = TraceUploadCancel::new();
    drop(controller);
    // Workers share an agent directory: only one startup sweep may deliver it
    // at a time. OS locks release on crashes without stale-directory retries.
    let Some(_recovery_lease) = delivery_lease(&agent_dir, &agent_dir.join("catch-up")) else {
        return;
    };
    let settings = crate::settings::SettingsManager::create(&cwd, &agent_dir);
    if !settings.get_agent_traces_enabled() {
        return;
    }
    let Ok(mut entries) = tokio::fs::read_dir(agent_trace_outbox_dir(&agent_dir)).await else {
        return;
    };
    let gate = TraceRequestGate::new();
    while let Ok(Some(entry)) = entries.next_entry().await {
        if cancel.is_cancelled() {
            return;
        }
        if entry.path().extension().is_none_or(|ext| ext != "json") {
            continue;
        }
        // Outbox records contain only a path/cursor; bound corrupt record reads.
        if entry.metadata().await.is_ok_and(|m| m.len() > 64 * 1024) {
            continue;
        }
        let read_entry = async {
            use tokio::io::AsyncReadExt;
            let file = tokio::fs::File::open(entry.path()).await?;
            let mut raw = String::new();
            file.take(64 * 1024 + 1).read_to_string(&mut raw).await?;
            Ok::<_, std::io::Error>(raw)
        };
        let Ok(raw) = read_entry.await else {
            continue;
        };
        if raw.len() > 64 * 1024 {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&raw) else {
            let _ = tokio::fs::remove_file(entry.path()).await;
            continue;
        };
        if value.get("kind").is_some() {
            continue;
        }
        let Some(path) = value
            .get("sessionFile")
            .and_then(Value::as_str)
            .map(PathBuf::from)
        else {
            let _ = tokio::fs::remove_file(entry.path()).await;
            continue;
        };
        let live = service()
            .controllers
            .lock()
            .unwrap()
            .iter()
            .filter_map(Weak::upgrade)
            .any(|c| {
                c.pending
                    .lock()
                    .unwrap()
                    .as_ref()
                    .is_some_and(|(p, _)| p == &path)
            });
        if live {
            continue;
        }
        match tokio::fs::metadata(&path).await {
            Ok(meta) if meta.is_file() => {}
            Ok(_) => {
                let _ = tokio::fs::remove_file(entry.path()).await;
                continue;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let _ = tokio::fs::remove_file(entry.path()).await;
                continue;
            }
            Err(_) => continue,
        }
        let permit = tokio::select! { p = permits.clone().acquire_owned() => p.unwrap(), () = cancel.wait() => return };
        let Some(_delivery_lease) = delivery_lease(&agent_dir, &path) else {
            continue;
        };
        let Some(header) = read_trace_session_header(&path) else {
            continue;
        };
        let session_cwd = PathBuf::from(&header.cwd);
        let options = TraceUploadOptions {
            session_file: Some(&path),
            cwd: &session_cwd,
            agent_dir: &agent_dir,
            require_enabled: true,
            reload_config: true,
            base_url: base_url.as_deref(),
            http: http.as_ref(),
            request_timeout_ms: DEFAULT_REQUEST_TIMEOUT_MS,
            cancel: Some(&cancel),
            on_upload_delay: None,
        };
        let result = perform_agent_trace_upload(&options, Some(&gate)).await;
        log_agent_trace_outcome(&agent_dir, Some(&path), &result);
        drop(permit);
    }
}

#[cfg(test)]
mod tests;
