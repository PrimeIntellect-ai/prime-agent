//! In-process RLM child sessions: the standalone [`RlmSubagentHost`]
//! implementation a resident embedding (the cloud guest) installs into a
//! session engine. The daemon's supervisor-backed host gives every child
//! its own supervised worker process through the supervisor link; this
//! host runs each child as a full pa-core [`SessionEngine`] inside the
//! parent's own process — no supervisor, no worker processes, no nested
//! daemons — which is the TS guest daemon's hosting model
//! (`createRlmSubagentRuntime` + the session-host core, ported to the
//! Rust engine).
//!
//! Kernel-visible parity with the daemon host: the same
//! [`RlmSpawnHandle`] shape, the same roster/collect/delete envelopes and
//! selector errors, spawn-name reservation across admission, deleted-child
//! tombstones, terminal notices, child usage attribution, and the
//! local-family surface (`agent_message`/`agent_observe` over the
//! in-process parent/siblings/children). Divergences are documented on
//! each seam.
//!
//! Terminal-notice contract: a first-wins claim fixes both verdict and notice
//! obligation. The parent `AgentSession` inbox durably admits the one JSONL row
//! and registers live delivery before publication. Its coalesced queue pump
//! drives a notice-only turn if the running turn missed its last steering
//! poll. On reopen, unconsumed synced rows replay from the original file row;
//! delivery to the model is at least once, not exactly once.
//!
//! Remote family boundary: a resident embedding that adopts this host as
//! its ROOT must supply the [`RlmRemoteFamily`] seam at composition time
//! — the guest root's cloud parent/siblings live beyond the sandbox, and
//! without the seam their messaging (replies included) has no route. The
//! standalone host is local-only and makes no remote-family parity claim;
//! adopting it as a guest root without the seam blocks adoption.
//!
//! Composition contract: the embedding owns the parent engine's lifetime.
//! Drop the parent engine and the whole subtree follows on its own — each
//! child's detached run task races its task prompt and settle wait
//! against the parent binding (a weak edge), notices the teardown within
//! one settle slice even mid-stream, aborts its own run, closes its
//! descendant subtree, settles, and releases its event listener, so the
//! engines and kernels tear down with the tasks' exits (every strong
//! edge points down the tree: parent engine → host → child records →
//! child engines → child hosts; every edge back up is weak). A session
//! CLOSE or replacement — where the parent engine stays alive — must
//! call [`InProcessRlmHost::close_children`] explicitly, the same
//! teardown the run tasks perform on an engine drop.

mod family;
mod model;
mod notices;
mod registry;
mod run;
mod spawn;

#[cfg(test)]
mod tests;

pub use family::{
    family_host_handlers, FamilyHostHandlers, FamilySelf, InProcessFamilyController,
    RlmRemoteFamily,
};
pub use model::{assert_thinking_supported, resolve_child_model, ResolvedChildModel};
pub use registry::{ChildIdentity, InProcessChildRecord};

use std::path::PathBuf;
use std::sync::{Arc, Weak};

use pa_agent::stream::StreamFn;
use pa_agent::types::Model as AgentModel;
use tokio::sync::Mutex;

use super::engine::SessionEngine;
use super::rlm_host::RlmSubagentHost;
use crate::models::registry::ModelRegistry;

/// The default recursion bound (TS `resolveRlmMaxDepth`).
pub const DEFAULT_RLM_MAX_DEPTH: u32 = 2;

/// The stream seam every child session runs on: given the resolved child
/// model, produce the session's `stream_fn`. The resident guest closes
/// over its live provider-target slot (one seam reading per call, like
/// the headless runtime's switchable stream); hermetic embeddings supply
/// a scripted stream.
pub type StreamFnFactory = Arc<dyn Fn(&AgentModel) -> StreamFn + Send + Sync>;

/// Everything the host needs to admit children for one parent session.
pub struct InProcessRlmHostConfig {
    /// The agent dir children resolve settings, skills, and the kernel
    /// Python-skill inventory from (the parent's own agent dir).
    pub agent_dir: PathBuf,
    /// The model catalog child references resolve against.
    pub registry: Arc<ModelRegistry>,
    /// The per-child stream seam (see [`StreamFnFactory`]).
    pub stream_fn_factory: StreamFnFactory,
    /// The parent session's RLM depth (0 for a resident root).
    pub rlm_depth: u32,
    /// The recursion bound; `0` adopts [`DEFAULT_RLM_MAX_DEPTH`].
    pub rlm_max_depth: u32,
    /// The thinking level children inherit when neither the spawn request
    /// nor the parent's live level supplies one.
    pub default_thinking: Option<String>,
    /// The remote family surface a resident embedding composes in (the
    /// guest's supervisor-routed rows and sends beyond the sandbox
    /// boundary). `None` — the standalone default — keeps the host
    /// local-only; the guest's root supplies the seam at composition
    /// time (see [`RlmRemoteFamily`]). Child hosts never carry it.
    pub remote_family: Option<Arc<dyn family::RlmRemoteFamily>>,
    /// The root session's own runtime kind for its family/observe rows
    /// (`None` reports `top-level`; a guest root that is itself a cloud
    /// child reports its actual kind).
    pub root_runtime_kind: Option<String>,
}

#[cfg(test)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ChildGatePoint {
    Claimed { child_id: String },
    BeforePublish { child_id: String },
}

#[cfg(test)]
pub(crate) type ChildTestGate = Arc<
    dyn Fn(ChildGatePoint) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>
        + Send
        + Sync,
>;

/// The parent engine a host is bound to (all weak: the parent engine owns
/// the host through its kernel handlers, and a strong edge back would
/// keep a released session's kernel alive forever).
struct ParentBinding {
    engine: Weak<SessionEngine>,
    /// The parent session's durable id (the artifacts tree children live
    /// under).
    session_id: String,
    /// The parent session's name (the family roster's parent row).
    session_name: Option<String>,
    /// The parent session file (the child headers' parent edge).
    session_file: Option<String>,
    /// The working directory children inherit.
    cwd: PathBuf,
}

/// Identity facts children derive from the bound parent.
pub(crate) struct ParentFacts {
    pub(crate) session_id: String,
    pub(crate) session_file: Option<String>,
    pub(crate) cwd: PathBuf,
}

struct HostInner {
    config: InProcessRlmHostConfig,
    /// This parent session's children, admission order.
    children: Mutex<Vec<Arc<InProcessChildRecord>>>,
    /// Bind and logical close are one generation transition.
    rebinding: Mutex<()>,
    /// Requested-name reservations held until admission is durable (TS
    /// #2396): two parallel same-name spawns cannot both admit.
    pending_spawn_names: std::sync::Mutex<std::collections::HashSet<String>>,
    /// Delete-receipt tombstones (TS `_deletedRlmChildRuns`): a deleted
    /// child's identity stays behind the registry so `rlm.collect` can
    /// answer a just-deleted selector with its settled cancelled envelope.
    deleted_children: std::sync::Mutex<std::collections::HashMap<String, registry::DeletedChild>>,
    parent: std::sync::RwLock<Option<ParentBinding>>,
    closing: std::sync::atomic::AtomicBool,
    #[cfg(test)]
    child_test_gate: std::sync::RwLock<Option<ChildTestGate>>,
    /// The host of the parent this one spawns under (`None` for the
    /// resident root's host): the sibling roster resolves through it.
    parent_host: std::sync::Mutex<Option<Weak<HostInner>>>,
}

/// The in-process children host. Cheap to clone (one shared handle); pass
/// the same clone into `SessionEngineConfig::rlm_subagent_host` and
/// [`InProcessRlmHost::bind_parent`].
#[derive(Clone)]
pub struct InProcessRlmHost {
    inner: Arc<HostInner>,
}

impl InProcessRlmHost {
    /// Build the host for one parent session. Call
    /// [`InProcessRlmHost::bind_parent`] once the parent engine exists.
    #[must_use]
    pub fn new(config: InProcessRlmHostConfig) -> Self {
        let config = if config.rlm_max_depth == 0 {
            InProcessRlmHostConfig {
                rlm_max_depth: DEFAULT_RLM_MAX_DEPTH,
                ..config
            }
        } else {
            config
        };
        Self {
            inner: Arc::new(HostInner {
                config,
                children: Mutex::new(Vec::new()),
                rebinding: Mutex::new(()),
                pending_spawn_names: std::sync::Mutex::new(std::collections::HashSet::new()),
                deleted_children: std::sync::Mutex::new(std::collections::HashMap::new()),
                parent: std::sync::RwLock::new(None),
                closing: std::sync::atomic::AtomicBool::new(false),
                #[cfg(test)]
                child_test_gate: std::sync::RwLock::new(None),
                parent_host: std::sync::Mutex::new(None),
            }),
        }
    }

    #[cfg(test)]
    pub(crate) fn set_child_test_gate(&self, gate: Option<ChildTestGate>) {
        *self
            .inner
            .child_test_gate
            .write()
            .expect("child test gate lock") = gate;
    }

    #[cfg(test)]
    pub(crate) async fn pause_child_gate(&self, point: ChildGatePoint) {
        let gate = self
            .inner
            .child_test_gate
            .read()
            .expect("child test gate lock")
            .clone();
        if let Some(gate) = gate {
            gate(point).await;
        }
    }

    /// The parent session's depth (children sit one level below it).
    pub(crate) fn rlm_depth(&self) -> u32 {
        self.inner.config.rlm_depth
    }

    /// The recursion bound.
    pub(crate) fn max_depth(&self) -> u32 {
        self.inner.config.rlm_max_depth
    }

    /// The host config (registry, agent dir, stream seam, defaults).
    pub(crate) fn config(&self) -> &InProcessRlmHostConfig {
        &self.inner.config
    }

    /// Bind the host to its parent engine. Subscribes the parent agent's
    /// turn boundary (the host owns the bump, no embedding wiring), and
    /// captures the identity children derive their session dir and family
    /// membership from. Binding is idempotent: a second call replaces the
    /// previous binding (a rebuilt parent session re-binds like the
    /// daemon's `set_identity`).
    ///
    /// # Errors
    ///
    /// Returns a recovery error if the original parent file cannot be read
    /// or an unconsumed terminal row cannot be re-admitted.
    ///
    /// # Panics
    ///
    /// Panics when a host lock is poisoned.
    pub async fn bind_parent(&self, engine: Arc<SessionEngine>) -> anyhow::Result<()> {
        let _binding = self.inner.rebinding.lock().await;
        let previous = self.parent_engine();
        if previous
            .as_ref()
            .is_some_and(|old| !Arc::ptr_eq(old, &engine))
        {
            self.close_children_inner().await;
            if let Some(previous) = previous {
                previous.session.close_terminal_inbox().await;
            }
        }
        let persistence = engine.session.shared_persistence();
        let (session_id, session_name, session_file, cwd) = {
            let session = persistence.lock().await;
            (
                session.get_session_id().to_string(),
                session.get_session_name(),
                session
                    .get_session_file()
                    .map(|path| path.display().to_string()),
                session.get_cwd().to_path_buf(),
            )
        };
        *self.inner.parent.write().expect("parent binding lock") = Some(ParentBinding {
            engine: Arc::downgrade(&engine),
            session_id,
            session_name,
            session_file,
            cwd,
        });
        engine.session.replay_terminal_notices().await?;
        self.inner
            .closing
            .store(false, std::sync::atomic::Ordering::Release);
        Ok(())
    }

    /// The parent binding, split into its weak engine and the identity
    /// facts (an unbound host fails the spawn admission with a precise
    /// error).
    pub(crate) fn parent(&self) -> anyhow::Result<(Weak<SessionEngine>, ParentFacts)> {
        let guard = self.inner.parent.read().expect("parent binding lock");
        let binding = guard.as_ref().ok_or_else(|| {
            anyhow::anyhow!("the in-process RLM host has no parent session bound yet")
        })?;
        Ok((
            binding.engine.clone(),
            ParentFacts {
                session_id: binding.session_id.clone(),
                session_file: binding.session_file.clone(),
                cwd: binding.cwd.clone(),
            },
        ))
    }

    /// The parent engine, when bound and still alive.
    pub(crate) fn parent_engine(&self) -> Option<Arc<SessionEngine>> {
        self.inner
            .parent
            .read()
            .expect("parent binding lock")
            .as_ref()
            .and_then(|binding| binding.engine.upgrade())
    }

    /// Record the host of the parent this session spawns under (the
    /// spawned child's host gets the parent host's handle for sibling
    /// enumeration).
    pub(crate) fn set_parent_host(&self, parent_host: &InProcessRlmHost) {
        *self.inner.parent_host.lock().expect("parent host lock") =
            Some(Arc::downgrade(&parent_host.inner));
    }

    /// The host of the parent this session spawns under, when the parent
    /// is itself an in-process child (`None` for a resident root).
    pub(crate) fn parent_host(&self) -> Option<InProcessRlmHost> {
        self.inner
            .parent_host
            .lock()
            .expect("parent host lock")
            .as_ref()
            .and_then(Weak::upgrade)
            .map(|inner| InProcessRlmHost { inner })
    }

    /// The parent binding's identity (the family roster's parent row):
    /// its session id and name.
    pub(crate) fn parent_identity(&self) -> Option<(String, Option<String>)> {
        let guard = self.inner.parent.read().expect("parent binding lock");
        guard
            .as_ref()
            .map(|binding| (binding.session_id.clone(), binding.session_name.clone()))
    }

    /// Whether any tracked child run is still unsettled (TS
    /// `_hasUnsettledRlmQuiescenceWork`'s child-run arm): the guest's
    /// status record and a child's own task-settle both read it.
    pub async fn any_running(&self) -> bool {
        let children = self.children().await;
        for record in &children {
            if record.is_running().await {
                return true;
            }
        }
        false
    }

    /// The live child records (admission order).
    pub(crate) async fn children(&self) -> Vec<Arc<InProcessChildRecord>> {
        self.inner.children.lock().await.clone()
    }

    /// Register an admitted child.
    pub(crate) async fn push_child(&self, record: Arc<InProcessChildRecord>) -> bool {
        let mut children = self.inner.children.lock().await;
        if self
            .inner
            .closing
            .load(std::sync::atomic::Ordering::Acquire)
            || !self
                .inner
                .parent
                .read()
                .expect("parent binding lock")
                .as_ref()
                .is_some_and(|binding| {
                    binding.session_id == record.parent_session_id
                        && Weak::ptr_eq(&binding.engine, &record.parent_engine)
                })
        {
            return false;
        }
        children.push(record);
        true
    }

    /// Remove one child from the registry (delete or close).
    pub(crate) async fn remove_child(&self, record: &Arc<InProcessChildRecord>) {
        self.inner
            .children
            .lock()
            .await
            .retain(|candidate| !Arc::ptr_eq(candidate, record));
    }

    /// The resident child identities (the family roster's child join): id,
    /// session id, and name per child, without status refreshes.
    pub async fn child_identities(&self) -> Vec<registry::ChildIdentity> {
        let children = self.children().await;
        let mut identities = Vec::with_capacity(children.len());
        for record in children {
            identities.push(registry::ChildIdentity {
                rlm_child_id: record.rlm_child_id.clone(),
                session_id: record.session_id.clone(),
                session_name: record.session_name(),
            });
        }
        identities
    }

    /// The in-process family handlers for THIS session (the parent's own
    /// `agent_message`/`agent_observe` surface): merge the result into
    /// the parent engine's `SessionEngineConfig::extra_host_handlers`.
    /// The host registers the children's own handlers at spawn.
    #[must_use]
    pub fn family_host_handlers(self: &Arc<Self>) -> FamilyHostHandlers {
        family_host_handlers(self, FamilySelf::Root)
    }

    /// Close every tracked child with the parent session (TS
    /// `closeChildSessions`): abort the runs, owe no terminal notices (the
    /// parent is going away), and drop the child engines — each child's
    /// kernel tears down with its engine, and each child's own children
    /// close through the same walk. Not a delete: no tombstones, no
    /// ledger markers.
    pub async fn close_children(&self) {
        let _binding = self.inner.rebinding.lock().await;
        self.close_children_inner().await;
    }

    async fn close_children_inner(&self) {
        self.inner
            .closing
            .store(true, std::sync::atomic::Ordering::Release);
        let children = self.children().await;
        for record in &children {
            let won = record.claim_notice(registry::NoticeKind::Closed).await;
            if won {
                #[cfg(test)]
                self.pause_child_gate(ChildGatePoint::Claimed {
                    child_id: record.rlm_child_id.clone(),
                })
                .await;
                record.mark_closed().await;
                record.engine.session.agent().abort();
                // The subtree closes eagerly, including independently running
                // grandchildren; no detached child task is needed to reach it.
                Box::pin(record.child_host.close_children()).await;
                #[cfg(test)]
                self.pause_child_gate(ChildGatePoint::BeforePublish {
                    child_id: record.rlm_child_id.clone(),
                })
                .await;
                record
                    .publish_verdict(
                        registry::NoticeKind::Closed,
                        Some("Closed with parent session".to_string()),
                    )
                    .await;
            } else {
                // Freeze the actual state under the retry gate before any
                // descendant await. The 5s parked wake cannot reactivate
                // a notice after this generation begins closing.
                if record.freeze_for_close().await {
                    if let Some(error) = record.parked_error().await {
                        tracing::error!(child_id = %record.rlm_child_id, %error,
                            "closing parent with a parked terminal notice");
                    }
                }
                Box::pin(record.child_host.close_children()).await;
                record.engine.session.agent().abort();
            }
            record.unsubscribe_listener().await;
        }
        self.inner.children.lock().await.clear();
        if let Some(parent) = self.parent_engine() {
            parent.session.close_terminal_inbox().await;
        }
    }

    /// The composed remote family surface, when the embedding supplied
    /// one (the guest's supervisor-routed rows and sends).
    pub(crate) fn remote_family(&self) -> Option<Arc<dyn family::RlmRemoteFamily>> {
        self.inner.config.remote_family.clone()
    }

    /// The root session's runtime kind for its own family/observe rows.
    pub(crate) fn root_runtime_kind(&self) -> String {
        self.inner
            .config
            .root_runtime_kind
            .clone()
            .unwrap_or_else(|| "top-level".to_string())
    }
}

/// Wall-clock ms since the epoch (the roster's clock).
pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis() as u64)
}

impl RlmSubagentHost for InProcessRlmHost {
    fn spawn(
        &self,
        request: super::rlm_host::RlmSpawnRequest,
    ) -> super::rlm_host::RlmHostFuture<super::rlm_host::RlmSpawnHandle> {
        spawn::spawn(self.clone(), request)
    }

    fn create_session(
        &self,
        _request: super::rlm_host::RlmCreateSessionRequest,
    ) -> super::rlm_host::RlmHostFuture<super::rlm_host::RlmCreateSessionHandle> {
        // A resident depth-0 session is the guest's own composition (the
        // guest daemon owns the one resident root), not something a
        // session's kernel may mint; the TS-parity refusal stands.
        Box::pin(async {
            anyhow::bail!("rlm.create_session requires a daemon-backed depth-0 session");
        })
    }

    fn list_subagents(
        &self,
    ) -> super::rlm_host::RlmHostFuture<Vec<super::rlm_host::RlmSubagentEntry>> {
        run::list_subagents(self.clone())
    }

    fn delete_subagent(
        &self,
        target: String,
    ) -> super::rlm_host::RlmHostFuture<super::rlm_host::RlmDeleteSubagentResult> {
        run::delete_subagent(self.clone(), target)
    }

    fn collect(
        &self,
        targets: Vec<String>,
        timeout_ms: u64,
    ) -> super::rlm_host::RlmHostFuture<Vec<super::rlm_host::RlmChildResult>> {
        run::collect(self.clone(), targets, timeout_ms)
    }

    fn rename(
        &self,
        name: String,
        session_id: Option<String>,
    ) -> super::rlm_host::RlmHostFuture<String> {
        run::rename(self.clone(), name, session_id)
    }
}
