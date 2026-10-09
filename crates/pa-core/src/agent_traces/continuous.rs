//! Consent-gated automatic delivery. The detached process-wide runtime owns all
//! reads, recovery and delivery; hosts only record bounded intent and wake it.
use super::*;
use std::io::Read;
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
        let retry = matches!(
            result,
            TraceUploadResult::Disabled | TraceUploadResult::MissingCredentials
        ) || matches!(result, TraceUploadResult::Failed { status_code, .. }
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

// The generation captures a snapshot so a poisoned metadata read fails closed
// at persist time; a changed settings generation only re-arms delivery, and
// parsing/reloading (the consent verdict) stays in the worker.
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
    agent_dir: Arc<PathBuf>,
    consent: Mutex<(bool, ConsentGeneration)>,
    // The path is passed by the writer: forks/rebindings cannot upload a stale path.
    pending: Mutex<Option<(PathBuf, Schedule)>>,
    wake: Arc<tokio::sync::Notify>,
    cancel: TraceUploadCancel,
    started: AtomicBool,
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

    fn consent_for(&self, cwd: &Path) -> TraceConsentSnapshot {
        let Ok(consent) = self.consent.lock() else {
            return TraceConsentSnapshot {
                enabled: false,
                generation: ConsentGeneration::read(cwd, &self.agent_dir),
            };
        };
        TraceConsentSnapshot {
            enabled: cwd == self.cwd && consent.0,
            generation: if cwd == self.cwd {
                consent.1.clone()
            } else {
                ConsentGeneration::read(cwd, &self.agent_dir)
            },
        }
    }

    /// Retire this installation and bind its registry slot to a replacement.
    /// A cwd change starts with consent off until background verification.
    #[must_use]
    pub fn rebind(&self, cwd: &Path, path: &Path) -> Option<Arc<Self>> {
        let controller =
            Self::unregistered(cwd, &self.agent_dir, Some(path), self.consent_for(cwd));
        if service().replace(self, &controller) {
            Some(controller)
        } else {
            tracing::warn!("trace replacement rejected: source registration unavailable");
            None
        }
    }

    /// Fork within this installation's cwd, admitting a distinct installation.
    #[must_use]
    pub fn forked(&self, path: &Path) -> Option<Arc<Self>> {
        Self::install(
            &self.cwd,
            &self.agent_dir,
            Some(path),
            self.consent_for(&self.cwd),
        )
    }

    fn unregistered(
        cwd: &Path,
        agent_dir: &Path,
        session_file: Option<&Path>,
        consent: TraceConsentSnapshot,
    ) -> Arc<Self> {
        Arc::new(Self {
            cwd: cwd.to_path_buf(),
            agent_dir: Arc::new(agent_dir.to_path_buf()),
            consent: Mutex::new((consent.enabled, consent.generation)),
            pending: Mutex::new(session_file.map(|p| (p.to_path_buf(), Schedule::default()))),
            wake: Arc::new(tokio::sync::Notify::new()),
            cancel: TraceUploadCancel::new(),
            started: AtomicBool::new(false),
        })
    }

    /// Install without scanning the outbox or waiting for networking. Consent
    /// is captured around the host's existing settings load.
    /// Returns `None` when the bounded registry cannot admit this installation.
    /// No persist hook may be attached to a rejected installation.
    #[must_use]
    pub fn install(
        cwd: &Path,
        agent_dir: &Path,
        session_file: Option<&Path>,
        consent: TraceConsentSnapshot,
    ) -> Option<Arc<Self>> {
        let controller = Self::unregistered(cwd, agent_dir, session_file, consent);
        let service = service();
        if service.register(&controller) {
            Some(controller)
        } else {
            tracing::warn!("trace installation rejected: registry unavailable or at capacity");
            None
        }
    }

    /// Called only after a successful transcript write. This performs no
    /// transcript read, settings parse, directory scan or network. Only the small
    /// pending record is serialized synchronously.
    pub fn persisted(&self, session_file: &Path) {
        if session_file.as_os_str().is_empty() || self.cancel.is_cancelled() {
            return;
        }
        let Ok(consent) = self.consent.lock() else {
            return;
        };
        if !consent.0 || consent.1 .0.iter().any(Result::is_err) {
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
        let Ok(mut pending) = self.pending.lock() else {
            return;
        };
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
    let primary = agent_trace_outbox_entry_path(agent_dir, session_file);
    let mutation = outbox_mutation_lock(&primary)?;
    // Never wait behind a pruner or cursor writer on the host thread. A stable
    // fallback marker retains intent even if the primary is about to be pruned.
    let acquired = crate::platform::try_lock_exclusive(&mutation).is_ok();
    let entry = if acquired {
        primary
    } else {
        primary.with_extension("pending.json")
    };
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

fn prune_entry(entry: &Path, observed: &str, missing_session: Option<&Path>) {
    // Fallback markers are deliberately retained: another process can publish
    // intent there without waiting while the primary's short lease is held.
    if entry
        .file_name()
        .is_some_and(|name| name.to_string_lossy().ends_with(".pending.json"))
    {
        return;
    }
    let Ok(mutation) = outbox_mutation_lock(entry) else {
        return;
    };
    if crate::platform::try_lock_exclusive(&mutation).is_err() {
        return;
    }
    let mut current = String::new();
    let Ok(file) = std::fs::File::open(entry) else {
        return;
    };
    if file
        .take(64 * 1024 + 1)
        .read_to_string(&mut current)
        .is_err()
        || current != observed
    {
        return;
    }
    if let Some(session) = missing_session {
        match std::fs::metadata(session) {
            Ok(meta) if meta.is_file() => return,
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return,
        }
    }
    if let Err(error) = std::fs::remove_file(entry) {
        tracing::debug!(%error, "trace stale marker pruning failed");
    }
}

fn delivery_lease(agent_dir: &Path, path: &Path) -> Option<std::fs::File> {
    let lock = agent_trace_outbox_entry_path(agent_dir, path).with_extension("lock");
    std::fs::create_dir_all(agent_trace_outbox_dir(agent_dir)).ok()?;
    let mut options = std::fs::OpenOptions::new();
    options.create(true).read(true).write(true).truncate(false);
    crate::platform::perms::set_private_mode(&mut options);
    let file = options.open(lock).ok()?;
    crate::platform::try_lock_exclusive(&file).ok()?;
    Some(file)
}

#[derive(Clone)]
struct Registration {
    controller: Weak<ContinuousTraceUpload>,
    agent_dir: Arc<PathBuf>,
    retired_predecessor: bool,
}

impl Registration {
    fn of(controller: &Arc<ContinuousTraceUpload>) -> Self {
        Self {
            controller: Arc::downgrade(controller),
            agent_dir: controller.agent_dir.clone(),
            retired_predecessor: false,
        }
    }
}

struct Service {
    controllers: Mutex<Vec<Registration>>,
    wake: tokio::sync::Notify,
}

impl Service {
    fn register(&self, controller: &Arc<ContinuousTraceUpload>) -> bool {
        let Ok(mut registrations) = self.controllers.lock() else {
            return false;
        };
        // Only the background service acknowledges dead descriptors, preserving
        // retirements between ticks. Rejection never returns a usable controller.
        if registrations.len() >= MAX_CONTROLLERS {
            return false;
        }
        registrations.push(Registration::of(controller));
        self.wake.notify_one();
        true
    }

    fn replace(
        &self,
        source: &ContinuousTraceUpload,
        controller: &Arc<ContinuousTraceUpload>,
    ) -> bool {
        let Ok(mut registrations) = self.controllers.lock() else {
            return false;
        };
        let Some(slot) = registrations
            .iter_mut()
            .find(|registration| std::ptr::eq(registration.controller.as_ptr(), source))
        else {
            return false;
        };
        // Reuse exactly one slot. The flag retains retirement even when neither
        // predecessor nor replacement survives until the next service tick.
        *slot = Registration::of(controller);
        slot.retired_predecessor = true;
        source.cancel.cancel();
        source.wake.notify_one();
        self.wake.notify_one();
        true
    }
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

// Recovery phases: 0 pending, 1 running/cooling down, 2 completed.
struct RecoveryRun {
    cancel: TraceUploadCancel,
    state: Arc<std::sync::atomic::AtomicU8>,
    replay_needed: Arc<AtomicBool>,
    not_before: Arc<Mutex<Option<Instant>>>,
    // Weak identities pin allocations, so retirement detection cannot reuse addresses.
    hosts: Vec<Weak<ContinuousTraceUpload>>,
}

impl RecoveryRun {
    fn new(hosts: Vec<Weak<ContinuousTraceUpload>>) -> Self {
        Self {
            cancel: TraceUploadCancel::new(),
            state: Arc::new(std::sync::atomic::AtomicU8::new(0)),
            replay_needed: Arc::new(AtomicBool::new(false)),
            not_before: Arc::new(Mutex::new(None)),
            hosts,
        }
    }
}

type RecoveryRuns = std::collections::HashMap<PathBuf, RecoveryRun>;

fn retain_live_recoveries(
    recovered: &mut RecoveryRuns,
    registrations: &[Registration],
) -> Vec<Weak<ContinuousTraceUpload>> {
    let mut live: std::collections::HashMap<PathBuf, Vec<Weak<ContinuousTraceUpload>>> =
        std::collections::HashMap::new();
    let mut retired_directories = std::collections::HashSet::new();
    let mut retired = Vec::new();
    for registration in registrations {
        if registration.retired_predecessor {
            retired_directories.insert(registration.agent_dir.as_ref().clone());
        }
        if let Some(controller) = registration.controller.upgrade() {
            live.entry(controller.agent_dir.as_ref().clone())
                .or_default()
                .push(registration.controller.clone());
        } else {
            retired_directories.insert(registration.agent_dir.as_ref().clone());
            retired.push(registration.controller.clone());
        }
    }
    recovered.retain(|directory, run| {
        let Some(hosts) = live.get(directory) else {
            run.cancel.cancel();
            return false;
        };
        if retired_directories.contains(directory)
            || run
                .hosts
                .iter()
                .any(|old| !hosts.iter().any(|new| old.ptr_eq(new)))
        {
            run.replay_needed.store(true, Ordering::Release);
        }
        run.hosts.clone_from(hosts);
        true
    });
    retired
}

fn acknowledge_retired_registrations(
    registrations: &mut Vec<Registration>,
    retired: &[Weak<ContinuousTraceUpload>],
) {
    // The retained Weak handles pin allocations until acknowledgement finishes.
    // Hosts retiring after the snapshot remain registered for the next tick.
    let identities: std::collections::HashSet<_> =
        retired.iter().map(|weak| weak.as_ptr() as usize).collect();
    registrations
        .retain(|registration| !identities.contains(&(registration.controller.as_ptr() as usize)));
}

fn acknowledge_replacements(registrations: &mut [Registration], snapshot: &[Registration]) {
    let identities: std::collections::HashSet<_> = snapshot
        .iter()
        .filter(|registration| registration.retired_predecessor)
        .map(|registration| registration.controller.as_ptr() as usize)
        .collect();
    // Snapshot Weak handles pin identity; a later replacement keeps its flag.
    for registration in registrations {
        if identities.contains(&(registration.controller.as_ptr() as usize)) {
            registration.retired_predecessor = false;
        }
    }
}

fn rearm_retired_recovery(run: &RecoveryRun) {
    if run.replay_needed.load(Ordering::Acquire)
        && run
            .state
            .compare_exchange(2, 1, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    {
        let state = run.state.clone();
        let cancel = run.cancel.clone();
        let not_before = *run.not_before.lock().unwrap();
        tokio::spawn(async move {
            settle_recovery_run(&state, false, not_before, &cancel).await;
        });
    }
}

async fn run_service() {
    let service = service();
    let permits = Arc::new(tokio::sync::Semaphore::new(4));
    // Recovery belongs to all live hosts sharing this directory, not its first host.
    let mut recovered = RecoveryRuns::new();
    loop {
        let registrations = service.controllers.lock().unwrap().clone();
        let retired = retain_live_recoveries(&mut recovered, &registrations);
        {
            let mut current = service.controllers.lock().unwrap();
            acknowledge_retired_registrations(&mut current, &retired);
            acknowledge_replacements(&mut current, &registrations);
        }
        for registration in registrations {
            let weak = registration.controller;
            if let Some(controller) = weak.upgrade() {
                if controller.consent.lock().unwrap().0
                    && (recovered.contains_key(controller.agent_dir.as_ref())
                        || recovered.len() < MAX_CONTROLLERS)
                {
                    let run = recovered
                        .entry(controller.agent_dir.as_ref().clone())
                        .or_insert_with(|| RecoveryRun::new(vec![weak.clone()]));
                    rearm_retired_recovery(run);
                    if run
                        .state
                        .compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire)
                        .is_ok()
                    {
                        let cwd = controller.cwd.clone();
                        let agent_dir = controller.agent_dir.as_ref().clone();
                        // Clear only on admission: retirement during completion must survive.
                        run.replay_needed.store(false, Ordering::Release);
                        let cancel = run.cancel.clone();
                        let state = run.state.clone();
                        let replay_needed = run.replay_needed.clone();
                        let saved_deadline = run.not_before.clone();
                        let permits = permits.clone();
                        tokio::spawn(async move {
                            let (complete, not_before) = recover_with_backoff(
                                cwd,
                                agent_dir,
                                permits,
                                Arc::new(ReqwestTraceHttp),
                                None,
                                cancel.clone(),
                                None,
                            )
                            .await;
                            *saved_deadline.lock().unwrap() = not_before;
                            let complete = complete && !replay_needed.load(Ordering::Acquire);
                            settle_recovery_run(&state, complete, not_before, &cancel).await;
                        });
                    }
                }
                if !controller.started.swap(true, Ordering::AcqRel) {
                    tokio::spawn(run_controller(
                        weak,
                        permits.clone(),
                        Arc::new(ReqwestTraceHttp),
                        None,
                    ));
                }
            }
        }
        tokio::select! { () = service.wake.notified() => {}, () = tokio::time::sleep(DEBOUNCE) => {} }
    }
}

async fn settle_recovery_run(
    state: &std::sync::atomic::AtomicU8,
    complete: bool,
    not_before: Option<Instant>,
    cancel: &TraceUploadCancel,
) {
    if !complete {
        // Mixed-consent directories may need another background sweep. Keep its
        // state running during cooldown; the service rechecks consent before rearm.
        let due = (Instant::now() + MIN_INTERVAL).max(not_before.unwrap_or_else(Instant::now));
        tokio::select! {
            () = tokio::time::sleep_until(due) => {},
            () = cancel.wait() => {},
        }
    }
    state.store(if complete { 2 } else { 0 }, Ordering::Release);
}

async fn run_controller(
    weak: Weak<ContinuousTraceUpload>,
    permits: Arc<tokio::sync::Semaphore>,
    http: Arc<dyn TraceHttp>,
    base_url: Option<String>,
) {
    if let Some(controller) = weak.upgrade() {
        let path = controller
            .pending
            .lock()
            .unwrap()
            .as_ref()
            .map(|(p, _)| p.clone());
        if let Some(path) = path {
            let entry = agent_trace_outbox_entry_path(&controller.agent_dir, &path);
            let pending_on_disk = entry.is_file() || entry.with_extension("pending.json").is_file();
            if pending_on_disk {
                let mut pending = controller.pending.lock().unwrap();
                if let Some((current, schedule)) = pending.as_mut() {
                    if current == &path {
                        schedule.persist(Instant::now());
                    }
                }
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
            let settings = crate::settings::SettingsManager::create(
                &controller.cwd,
                controller.agent_dir.as_ref(),
            );
            let unchanged =
                generation == ConsentGeneration::read(&controller.cwd, &controller.agent_dir);
            *controller.consent.lock().unwrap() = (
                unchanged && settings.errors().is_empty() && settings.get_agent_traces_enabled(),
                generation,
            );
            initialized = true;
        }
        let enabled = controller.consent.lock().unwrap().0;
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
        if !enabled || due.is_none_or(|due| due > Instant::now()) {
            // Overdue work must not spin or acquire capacity while consent is off.
            let wait = if enabled {
                due.map_or(DEBOUNCE, |due| {
                    due.saturating_duration_since(Instant::now()).min(DEBOUNCE)
                })
            } else {
                DEBOUNCE
            };
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
            // A busy lease must not hold delivery capacity while waiting.
            drop(permit);
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
        let result = deliver_with_consent(
            &TraceUploadOptions {
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
            },
            None,
        )
        .await;
        log_agent_trace_outcome(&agent_dir, Some(&path), &result);
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

async fn deliver_with_consent(
    options: &TraceUploadOptions<'_>,
    gate: Option<&TraceRequestGate>,
) -> TraceUploadResult {
    let mut initial = ConsentGeneration::read(options.cwd, options.agent_dir);
    let request_cancel = TraceUploadCancel::new();
    let guarded = TraceUploadOptions {
        cancel: Some(&request_cancel),
        on_upload_delay: options.on_upload_delay.clone(),
        ..*options
    };
    let request = perform_agent_trace_upload(&guarded, gate);
    tokio::pin!(request);
    loop {
        tokio::select! {
            result = &mut request => return result,
            () = async { if let Some(cancel) = options.cancel { cancel.wait().await; } else { std::future::pending::<()>().await; } } => {
                request_cancel.cancel();
                return request.await;
            }
            () = tokio::time::sleep(DEBOUNCE) => {
                let current = ConsentGeneration::read(options.cwd, options.agent_dir);
                if initial != current {
                    let settings = crate::settings::SettingsManager::create(options.cwd, options.agent_dir);
                    if settings.errors().is_empty() && settings.get_agent_traces_enabled()
                        && current == ConsentGeneration::read(options.cwd, options.agent_dir) {
                        initial = current;
                    } else {
                        request_cancel.cancel();
                        let _ = request.await;
                        return TraceUploadResult::Disabled;
                    }
                }
            }
        }
    }
}

async fn recover_with_backoff(
    cwd: PathBuf,
    agent_dir: PathBuf,
    permits: Arc<tokio::sync::Semaphore>,
    http: Arc<dyn TraceHttp>,
    base_url: Option<String>,
    cancel: TraceUploadCancel,
    live_controllers: Option<Vec<Weak<ContinuousTraceUpload>>>,
) -> (bool, Option<Instant>) {
    recover_with_io(
        cwd,
        agent_dir,
        permits,
        http,
        base_url,
        cancel,
        live_controllers,
        |_, _| Ok(()),
    )
    .await
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum RecoveryRead {
    Directory,
    Iteration,
    RecordMetadata,
    Record,
    SessionMetadata,
    Header,
}

// Keep fault injection at the I/O boundary so deterministic recovery tests can
// exercise transient failures without changing filesystem permissions or users.
#[allow(clippy::too_many_arguments)]
async fn recover_with_io(
    cwd: PathBuf,
    agent_dir: PathBuf,
    permits: Arc<tokio::sync::Semaphore>,
    http: Arc<dyn TraceHttp>,
    base_url: Option<String>,
    cancel: TraceUploadCancel,
    live_controllers: Option<Vec<Weak<ContinuousTraceUpload>>>,
    before_read: impl Fn(RecoveryRead, &Path) -> std::io::Result<()> + Send + Sync,
) -> (bool, Option<Instant>) {
    let settings = crate::settings::SettingsManager::create(&cwd, &agent_dir);
    if !settings.errors().is_empty() || !settings.get_agent_traces_enabled() {
        return (false, None);
    }
    // Workers share an agent directory: only one startup sweep may deliver it
    // at a time. OS locks release on crashes without stale-directory retries.
    let Some(_recovery_lease) = delivery_lease(&agent_dir, &agent_dir.join("catch-up")) else {
        return (false, None);
    };
    let outbox = agent_trace_outbox_dir(&agent_dir);
    let read_directory = async {
        before_read(RecoveryRead::Directory, &outbox)?;
        tokio::fs::read_dir(&outbox).await
    };
    let mut entries = match read_directory.await {
        Ok(entries) => entries,
        Err(error) => return (error.kind() == std::io::ErrorKind::NotFound, None),
    };
    let gate = TraceRequestGate::new();
    let mut complete = true;
    let mut not_before: Option<Instant> = None;
    loop {
        let next = async {
            before_read(RecoveryRead::Iteration, &outbox)?;
            entries.next_entry().await
        };
        let entry = match next.await {
            Ok(Some(entry)) => entry,
            Ok(None) => break,
            Err(error) => {
                // A transient directory-iteration failure must not let the
                // sweep complete: unexamined markers stay eligible and the
                // bounded cooldown re-arms another sweep.
                tracing::warn!(%error, "trace outbox iteration failed");
                complete = false;
                break;
            }
        };
        if cancel.is_cancelled() {
            return (false, None);
        }
        if entry.path().extension().is_none_or(|ext| ext != "json") {
            continue;
        }
        // Outbox records contain only a path/cursor; bound corrupt record reads.
        let record_metadata = async {
            before_read(RecoveryRead::RecordMetadata, &entry.path())?;
            entry.metadata().await
        };
        match record_metadata.await {
            Ok(metadata) if metadata.len() > 64 * 1024 => continue,
            Ok(_) => {}
            Err(_) => {
                complete = false;
                continue;
            }
        }
        let read_entry = async {
            use tokio::io::AsyncReadExt;
            before_read(RecoveryRead::Record, &entry.path())?;
            let file = tokio::fs::File::open(entry.path()).await?;
            let mut raw = String::new();
            file.take(64 * 1024 + 1).read_to_string(&mut raw).await?;
            Ok::<_, std::io::Error>(raw)
        };
        let raw = match read_entry.await {
            Ok(raw) => raw,
            Err(error) => {
                // Invalid UTF-8 is terminal data, not a transient filesystem fault.
                complete &= error.kind() == std::io::ErrorKind::InvalidData;
                continue;
            }
        };
        if raw.len() > 64 * 1024 {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&raw) else {
            prune_entry(&entry.path(), &raw, None);
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
            prune_entry(&entry.path(), &raw, None);
            continue;
        };
        // Fulfilled cursor entries owe no bytes even when their owner opted out.
        if TraceUploadSignature::of(&path).is_some_and(|signature| {
            read_agent_trace_outbox_entry(&agent_dir, &path) == Some(signature)
        }) {
            continue;
        }
        let registered = live_controllers.clone().unwrap_or_else(|| {
            service()
                .controllers
                .lock()
                .unwrap()
                .iter()
                .map(|registration| registration.controller.clone())
                .collect()
        });
        let live = registered.iter().filter_map(Weak::upgrade).any(|c| {
            c.pending
                .lock()
                .unwrap()
                .as_ref()
                .is_some_and(|(p, _)| p == &path)
        });
        if live {
            complete = false;
            continue;
        }
        let session_metadata = async {
            before_read(RecoveryRead::SessionMetadata, &path)?;
            tokio::fs::metadata(&path).await
        };
        match session_metadata.await {
            Ok(meta) if meta.is_file() => {}
            Ok(_) => {
                prune_entry(&entry.path(), &raw, Some(&path));
                continue;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                prune_entry(&entry.path(), &raw, Some(&path));
                continue;
            }
            // A transient metadata error must not let the sweep complete.
            Err(_) => {
                complete = false;
                continue;
            }
        }
        let Some(_delivery_lease) = delivery_lease(&agent_dir, &path) else {
            // Another process owns this delivery; a skipped marker must not
            // complete the sweep or it strands when that process fails.
            complete = false;
            continue;
        };
        let header = before_read(RecoveryRead::Header, &path)
            .and_then(|()| read_trace_session_header_checked(&path));
        let header = match header {
            Ok(Some(header)) => header,
            Ok(None) => continue,
            Err(_) => {
                complete = false;
                continue;
            }
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
        // Bound catch-up retries per entry; exhaustion leaves its durable marker.
        let mut schedule = Schedule::default();
        for attempt in 0..3 {
            let permit = tokio::select! { p = permits.clone().acquire_owned() => p.unwrap(), () = cancel.wait() => return (false, None) };
            let generation = schedule.start(Instant::now());
            let result = deliver_with_consent(&options, Some(&gate)).await;
            log_agent_trace_outcome(&agent_dir, Some(&path), &result);
            drop(permit);
            if matches!(
                result,
                TraceUploadResult::Disabled | TraceUploadResult::MissingCredentials
            ) {
                // A revoked project must not block other opted-in projects, and
                // missing credentials may arrive later. Retain the marker and
                // rearm the shared sweep at a bounded rate.
                complete = false;
                break;
            }
            schedule.settle(Instant::now(), generation, &result);
            if let Some(deadline) = schedule.not_before {
                not_before = Some(not_before.map_or(deadline, |old| old.max(deadline)));
            }
            let Some(due) = schedule.due else {
                break;
            };
            if attempt == 2 {
                // Exhausted per-entry retries with work still due: the durable
                // marker is retained, so the sweep must rearm, not complete.
                complete = false;
                break;
            }
            tokio::select! { () = tokio::time::sleep_until(due) => {}, () = cancel.wait() => return (false, None) }
        }
    }
    (complete && !cancel.is_cancelled(), not_before)
}

#[cfg(test)]
mod tests;
