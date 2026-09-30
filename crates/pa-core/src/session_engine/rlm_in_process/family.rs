//! The in-process family surface: one controller per session (the parent
//! and every child) implementing `agent_message` and `agent_observe` over
//! the live family graph — no supervisor link, no wire route. Delivery
//! is the TS in-process shape: the rendered `[agent-message from ...]`
//! prompt as an `agent_message` custom row, admitted as its own turn on
//! an idle target (`prompt_injected_message`) or steered onto a busy
//! one (`queueIfBusy` + `streamingBehavior: "steer"`), with receipts.

use std::sync::Arc;

use serde_json::json;

use super::now_ms;
use super::registry::{record_matches, InProcessChildRecord};
use super::InProcessRlmHost;
use crate::kernel::shared::HostRequestHandlers;
use crate::session_engine::agent_messaging::{
    create_agent_session_message_id, create_agent_session_message_prompt,
    create_agent_session_message_row, register_agent_message_host_handlers,
    register_agent_observe_host_handlers, AgentFamilyMember, AgentFamilyRelationship,
    AgentMessageController, AgentMessageDeliveryStatus, AgentMessagePromptPayload,
    AgentMessageReceipt, AgentMessageSendInput, AgentObserveActivity, AgentObserveController,
    AgentObserveMessagePreview, AgentObserveSummary, AgentSessionMessageRowPayload,
    DEFAULT_AGENT_MESSAGE_MAX_PENDING_PER_SESSION,
};
use crate::session_engine::engine::SessionEngine;
use pa_types::session::{AgentMessage as SessionAgentMessage, CustomMessage, FileEntry};

/// The remote family surface a resident embedding composes into its root
/// host (the guest's supervisor-routed rows and sends): the family
/// members beyond the sandbox boundary — the guest root's cloud parent
/// and siblings — and the delivery route for messages that target them.
///
/// The standalone host runs local-only (`None`): its family is exactly
/// the in-process graph. The guest supplies the seam at composition
/// time; without it the guest root's remote parent/sibling messaging —
/// replies included — has no route, so adopting this host as the guest
/// root requires the seam (the module docs spell out the boundary).
pub trait RlmRemoteFamily: Send + Sync {
    /// The remote family members, in the roster shape the kernel's
    /// `agent_message.send` resolves selectors against.
    fn members(&self) -> super::super::rlm_host::RlmHostFuture<Vec<AgentFamilyMember>>;
    /// Deliver one agent message to a remote member; the receipt matches
    /// the local send's shape.
    fn send(
        &self,
        input: AgentMessageSendInput,
    ) -> super::super::rlm_host::RlmHostFuture<AgentMessageReceipt>;
    /// Remote rows for `agent_observe.list_agents`/`get_agent` (the
    /// guest's supervisor family roster). The default is empty — a seam
    /// that only routes messaging reports no remote observe rows — so
    /// extending the seam to observe is safe for every composer: supply
    /// it only when the embedding has remote status. `recent_messages`
    /// stays local-only either way (remote transcripts are the
    /// embedding's own surface, not this seam's).
    fn observe_summaries(&self) -> super::super::rlm_host::RlmHostFuture<Vec<AgentObserveSummary>> {
        Box::pin(async { Ok(Vec::new()) })
    }
}

/// Whether a selector addresses one member by id, name, or alias.
fn member_matches(member: &AgentFamilyMember, selector: &str) -> bool {
    member.id == selector
        || member.member_name() == selector
        || member.aliases.iter().any(|alias| alias == selector)
}

/// Which session a controller serves.
#[derive(Debug, Clone)]
pub enum FamilySelf {
    /// The resident root (the guest session).
    Root,
    /// One spawned child, by its `rlm_child_id`.
    Child { child_id: String },
}

impl FamilySelf {
    fn child_id(&self) -> Option<&str> {
        match self {
            FamilySelf::Root => None,
            FamilySelf::Child { child_id } => Some(child_id),
        }
    }
}

/// The host-handlers bundle for one session's family surface: merge it
/// into the engine's `extra_host_handlers`.
pub type FamilyHostHandlers = HostRequestHandlers;

/// Build one session's family handlers over `host` (the host that owns
/// that session's children): the parent engine's handlers serve the root,
/// a child's serve the child.
#[must_use]
pub fn family_host_handlers(
    host: &Arc<InProcessRlmHost>,
    served: FamilySelf,
) -> FamilyHostHandlers {
    let controller = InProcessFamilyController::new(Arc::clone(host), served);
    let mut handlers = HostRequestHandlers::new();
    register_agent_message_host_handlers(Arc::clone(&controller), &mut handlers);
    register_agent_observe_host_handlers(controller, &mut handlers);
    handlers
}

/// One addressable family member: its identity, its live engine, and the
/// child record behind it (present for child and sibling rows).
struct FamilyNode {
    relationship: AgentFamilyRelationship,
    /// The member's primary selector: the child id for spawned rows, the
    /// session id for the parent.
    id: String,
    session_id: String,
    session_name: Option<String>,
    engine: Arc<SessionEngine>,
    runtime_kind: String,
    record: Option<Arc<InProcessChildRecord>>,
}

impl FamilyNode {
    /// The roster member the `agent_message.send` handler resolves
    /// through (the daemon controller lists the RLM child id as the
    /// primary and the durable session id as an alias).
    fn member(&self) -> AgentFamilyMember {
        AgentFamilyMember {
            relationship: self.relationship,
            id: self.id.clone(),
            name: self.session_name.clone(),
            aliases: if self.record.is_some() {
                vec![self.session_id.clone()]
            } else {
                Vec::new()
            },
        }
    }

    /// Whether a selector addresses this node.
    fn matches(&self, selector: &str) -> bool {
        self.id == selector
            || self.session_id == selector
            || self.session_name.as_deref() == Some(selector)
            || self.record.as_ref().is_some_and(|record| {
                record_matches(record, selector) && self.id != record.session_id.as_str()
            })
    }
}

/// The runtime kind one session reports: the composed root kind for a
/// resident root, `subagent` for a spawned child.
fn session_kind(host: &InProcessRlmHost) -> String {
    if host.parent_host().is_some() {
        "subagent".to_string()
    } else {
        host.root_runtime_kind()
    }
}

/// The per-session family controller.
pub struct InProcessFamilyController {
    /// The host owning THIS session's children (its parent binding names
    /// this session itself: the root's host binds the root engine, a
    /// child's host binds the child engine).
    host: Arc<InProcessRlmHost>,
    served: FamilySelf,
}

impl InProcessFamilyController {
    /// Build one session's controller over its host (the handler
    /// registration is the kernel path; embeddings and tests may drive
    /// the controller directly).
    #[must_use]
    pub fn new(host: Arc<InProcessRlmHost>, served: FamilySelf) -> Arc<Self> {
        Arc::new(Self { host, served })
    }
}

impl InProcessFamilyController {
    /// This session's own engine (the host's parent binding).
    fn self_engine(&self) -> Option<Arc<SessionEngine>> {
        self.host.parent_engine()
    }

    /// This session's own runtime kind for its family rows (the composed
    /// root kind for the resident root, `subagent` for a child).
    fn self_runtime_kind(&self) -> String {
        match &self.served {
            FamilySelf::Root => self.host.root_runtime_kind(),
            FamilySelf::Child { .. } => "subagent".to_string(),
        }
    }

    /// The parent member (a child's controller only): the parent HOST's
    /// binding — the session that spawned this one. This host's own
    /// binding names THIS session (its children attribute and notify
    /// against it); the family parent lives one host up the tree.
    fn parent_node(&self) -> Option<FamilyNode> {
        let parent_host = self.host.parent_host()?;
        let engine = parent_host.parent_engine()?;
        let (session_id, session_name) = parent_host.parent_identity()?;
        Some(FamilyNode {
            relationship: AgentFamilyRelationship::Parent,
            id: session_id.clone(),
            session_id,
            session_name,
            engine,
            runtime_kind: session_kind(&parent_host),
            record: None,
        })
    }

    /// The child nodes a host's registry holds.
    async fn child_nodes(host: &InProcessRlmHost) -> Vec<FamilyNode> {
        host.children()
            .await
            .into_iter()
            .map(|record| FamilyNode {
                relationship: AgentFamilyRelationship::Child,
                id: record.rlm_child_id.clone(),
                session_id: record.session_id.clone(),
                session_name: Some(record.session_name.clone()),
                engine: Arc::clone(&record.engine),
                runtime_kind: "subagent".to_string(),
                record: Some(record),
            })
            .collect()
    }

    /// The sibling nodes (a child's controller): the parent host's other
    /// children.
    async fn sibling_nodes(&self) -> Vec<FamilyNode> {
        let Some(parent_host) = self.host.parent_host() else {
            return Vec::new();
        };
        let self_child_id = self.served.child_id();
        Self::child_nodes(&parent_host)
            .await
            .into_iter()
            .filter(|node| {
                node.record
                    .as_ref()
                    .is_none_or(|record| Some(record.rlm_child_id.as_str()) != self_child_id)
            })
            .map(|mut node| {
                node.relationship = AgentFamilyRelationship::Sibling;
                node
            })
            .collect()
    }

    /// Every family node (self excluded): the parent, the siblings, the
    /// children.
    async fn nodes(&self) -> Vec<FamilyNode> {
        let mut nodes = Vec::new();
        if !matches!(self.served, FamilySelf::Root) {
            if let Some(parent) = self.parent_node() {
                nodes.push(parent);
            }
            nodes.extend(self.sibling_nodes().await);
        }
        nodes.extend(Self::child_nodes(&self.host).await);
        nodes
    }

    /// The member list the `agent_message.send` handler resolves through:
    /// the in-process graph plus the composed remote family (the guest
    /// root's cloud parent/siblings; empty for a local-only host).
    async fn members(&self) -> anyhow::Result<Vec<AgentFamilyMember>> {
        let mut members: Vec<AgentFamilyMember> =
            self.nodes().await.iter().map(FamilyNode::member).collect();
        if let Some(remote) = self.host.remote_family() {
            members.extend(remote.members().await?);
        }
        Ok(members)
    }

    /// One observe summary (self or a family node), TS roster semantics.
    async fn summary(
        relationship: Option<AgentFamilyRelationship>,
        engine: &Arc<SessionEngine>,
        session_name: Option<String>,
        runtime_kind: &str,
        is_current: bool,
    ) -> AgentObserveSummary {
        let agent = engine.session.agent();
        let state = agent.state().await;
        let queued_count = agent.steering_previews().len() + agent.follow_up_previews().len();
        let busy = state.is_streaming || queued_count > 0;
        let activity = if state.is_streaming {
            AgentObserveActivity::Model
        } else if !state.pending_tool_calls.is_empty() {
            AgentObserveActivity::Tool
        } else {
            AgentObserveActivity::Idle
        };
        let session_id = engine.session.session_id().await;
        AgentObserveSummary {
            active_session_id: Some(session_id.clone()),
            session_id,
            session_name,
            relationship,
            runtime_kind: Some(runtime_kind.to_string()),
            status: if busy {
                crate::session_engine::agent_messaging::AgentFamilyStatus::Running
            } else {
                crate::session_engine::agent_messaging::AgentFamilyStatus::Idle
            },
            activity: Some(activity),
            is_current,
            is_streaming: state.is_streaming,
            is_compacting: false,
            attached_clients: 0,
            queued_count,
            is_session_active: true,
        }
    }

    /// The engine a target selector addresses: self first, then the
    /// family nodes.
    async fn engine_for(&self, target: &str) -> Option<Arc<SessionEngine>> {
        if let Some(engine) = self.self_engine() {
            if engine.session.session_id().await == target {
                return Some(engine);
            }
        }
        self.nodes()
            .await
            .into_iter()
            .find(|node| node.matches(target))
            .map(|node| node.engine)
    }
}

impl AgentMessageController for InProcessFamilyController {
    async fn family(&self) -> anyhow::Result<Vec<AgentFamilyMember>> {
        self.members().await
    }

    async fn send_agent_message(
        &self,
        input: AgentMessageSendInput,
    ) -> anyhow::Result<AgentMessageReceipt> {
        let message = crate::session_engine::agent_messaging::normalize_agent_session_message(
            &input.message,
        )?;
        let Some(self_engine) = self.self_engine() else {
            anyhow::bail!("the in-process family is not bound to a session yet");
        };
        let self_session_id = self_engine.session.session_id().await;
        let self_name = self_engine
            .session
            .shared_persistence()
            .lock()
            .await
            .get_session_name();
        let sender_name = self_name.clone().unwrap_or_else(|| self_session_id.clone());
        // The target node: resolved by selector over the live family. A
        // selector no local node answers routes through the composed
        // remote family (the guest root's cloud parent/siblings); a miss
        // there is a genuine unknown target.
        let Some(node) = self
            .nodes()
            .await
            .into_iter()
            .find(|node| node.matches(&input.target))
        else {
            return self.send_remote(input, &message).await;
        };
        // The sender's relationship to the receiver (the inverse of the
        // member's relationship): a child replying to its parent renders
        // "child:<name>".
        let from_relationship = match node.relationship {
            AgentFamilyRelationship::Parent => Some(AgentFamilyRelationship::Child),
            AgentFamilyRelationship::Child => Some(AgentFamilyRelationship::Parent),
            AgentFamilyRelationship::Sibling => Some(AgentFamilyRelationship::Sibling),
        };
        let prompt = create_agent_session_message_prompt(&AgentMessagePromptPayload {
            message: message.clone(),
            sender_name: sender_name.clone(),
            from_relationship,
        });
        let target_session_id = node.session_id.clone();
        let id = create_agent_session_message_id();
        let from = json!({
            "sessionId": self_session_id,
            "sessionName": self_name,
            "runtimeKind": self.self_runtime_kind(),
        });
        let target = json!({
            "activeSessionId": target_session_id,
            "sessionId": target_session_id,
            "sessionName": node.session_name,
            "runtimeKind": node.runtime_kind,
        });
        let row = create_agent_session_message_row(&AgentSessionMessageRowPayload {
            id: &id,
            prompt: &prompt,
            message: &message,
            from: &from,
            from_relationship,
            target: &target,
            timestamp: now_ms(),
        });
        let row: CustomMessage = serde_json::from_value(row)
            .map_err(|error| anyhow::anyhow!("agent message row conversion failed: {error}"))?;
        let session = &node.engine.session;
        let agent = session.agent();
        let pending = agent.steering_previews().len() + agent.follow_up_previews().len();
        crate::session_engine::agent_messaging::assert_agent_message_queue_capacity(
            pending,
            DEFAULT_AGENT_MESSAGE_MAX_PENDING_PER_SESSION,
        )?;
        // Reserve a child's explicit reply before admission so a racing
        // completion claims DoneReplied, never Done/no-reply. A failed
        // durable append leaves the original row pending for that claimant.
        let reply_record = if from_relationship == Some(AgentFamilyRelationship::Child) {
            match (self.served.child_id(), self.host.parent_host()) {
                (Some(child_id), Some(parent_host)) => parent_host
                    .children()
                    .await
                    .into_iter()
                    .find(|record| record.rlm_child_id == child_id),
                _ => None,
            }
        } else {
            None
        };
        if let Some(record) = &reply_record {
            record.begin_reply(row.clone()).await;
        }
        let admission = if reply_record.is_some() {
            session.admit_durable_reply(&row).await
        } else {
            session.admit_injected_or_steer(&row).await
        }?;
        if let Some(record) = &reply_record {
            record.reply_admitted(&id).await;
        }
        let delivery = match admission {
            pa_agent::admission::AdmitStatus::Admitted => AgentMessageDeliveryStatus::Delivered,
            pa_agent::admission::AdmitStatus::Busy => AgentMessageDeliveryStatus::Queued,
        };
        let delivered = matches!(delivery, AgentMessageDeliveryStatus::Delivered);
        Ok(AgentMessageReceipt {
            id,
            target: target_session_id,
            target_session_id: None,
            target_session_name: node.session_name.clone(),
            target_runtime_kind: Some(node.runtime_kind.clone()),
            message,
            delivery_status: delivery,
            delivery_mode: Some("steer"),
            receiver_role: input.receiver_role,
            delivered_at: delivered.then(crate::session::manager::format_iso_now),
            queued_at: (!delivered).then(crate::session::manager::format_iso_now),
        })
    }
}

impl InProcessFamilyController {
    /// Route one send through the composed remote family. A local-only
    /// host (no seam) answers with the unknown-target error, exactly like
    /// a send naming no family member.
    async fn send_remote(
        &self,
        input: AgentMessageSendInput,
        message: &str,
    ) -> anyhow::Result<AgentMessageReceipt> {
        let Some(remote) = self.host.remote_family() else {
            anyhow::bail!(
                "No agent message target matches \"{}\" in the current parent session",
                input.target
            );
        };
        let members = remote.members().await?;
        if !members
            .iter()
            .any(|member| member_matches(member, &input.target))
        {
            anyhow::bail!(
                "No agent message target matches \"{}\" in the current parent session",
                input.target
            );
        }
        let mut routed = input;
        routed.message = message.to_string();
        remote.send(routed).await
    }
}

impl AgentObserveController for InProcessFamilyController {
    async fn list_agents(&self) -> anyhow::Result<Vec<AgentObserveSummary>> {
        let mut summaries = Vec::new();
        if let Some(engine) = self.self_engine() {
            let session_name = engine
                .session
                .shared_persistence()
                .lock()
                .await
                .get_session_name();
            let self_kind = self.self_runtime_kind();
            summaries.push(Self::summary(None, &engine, session_name, &self_kind, true).await);
        }
        for node in self.nodes().await {
            summaries.push(
                Self::summary(
                    Some(node.relationship),
                    &node.engine,
                    node.session_name.clone(),
                    &node.runtime_kind,
                    false,
                )
                .await,
            );
        }
        // The composed remote family's observe rows ride the roster after
        // the local ones (empty when the seam reports none).
        if let Some(remote) = self.host.remote_family() {
            summaries.extend(remote.observe_summaries().await?);
        }
        Ok(summaries)
    }

    async fn get_agent(&self, target: &str) -> anyhow::Result<Option<AgentObserveSummary>> {
        Ok(self.list_agents().await?.into_iter().find(|summary| {
            summary.active_session_id.as_deref() == Some(target)
                || summary.session_id == target
                || summary.session_name.as_deref() == Some(target)
        }))
    }

    async fn recent_messages(
        &self,
        target: &str,
        limit: usize,
        max_chars: usize,
    ) -> anyhow::Result<Vec<AgentObserveMessagePreview>> {
        let Some(engine) = self.engine_for(target).await else {
            anyhow::bail!("No agent matches \"{target}\" in the current family");
        };
        let entries = {
            let session = engine.session.shared_persistence();
            let session = session.lock().await;
            session.get_entries()
        };
        let messages: Vec<&SessionAgentMessage> = entries
            .iter()
            .filter_map(|entry| match entry {
                FileEntry::Message { message, .. } => Some(message),
                _ => None,
            })
            .collect();
        let total = messages.len();
        let start = total.saturating_sub(limit);
        let mut previews = Vec::with_capacity(total - start);
        for (index, message) in messages.iter().enumerate().skip(start) {
            previews.push(
                crate::session_engine::agent_messaging::create_agent_observe_message_preview(
                    message, index, max_chars,
                ),
            );
        }
        Ok(previews)
    }
}
