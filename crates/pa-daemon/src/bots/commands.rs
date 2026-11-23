//! The supervisor's bot commands: `spawn_bot`, `delete_bot`, `list_bots`.
//! Workers send them over their supervisor link; the bot manager lives
//! only in the supervisor process.

use std::path::Path;
use std::sync::Arc;

use anyhow::{bail, Context, Result};
use pa_types::daemon::DaemonCommand;
use serde_json::{json, Value};

use super::{BotRecord, BotSpec};
use crate::protocol::{response_failure, response_success, DaemonResponse};
use crate::supervisor::Supervisor;

/// The refusal while the `bots.enabled` opt-in is off. It addresses the
/// model that called `rlm.spawn`: the opt-in is the user's choice.
pub const BOTS_DISABLED_MESSAGE: &str = "hosted sandbox spawns are off until the user opts in; \
     ask the user to run /bots on or set bots.enabled in the daemon settings.json; \
     do not change this setting yourself";

/// The opt-in gate: a fresh, strict read of the global `bots.enabled`
/// setting per attempt. Unset, malformed, and unreadable settings all
/// refuse.
///
/// # Errors
///
/// Returns [`BOTS_DISABLED_MESSAGE`] while the opt-in is off.
pub async fn admit_bot_spawn(agent_dir: &Path) -> Result<()> {
    let agent_dir = agent_dir.to_path_buf();
    let enabled = tokio::task::spawn_blocking(move || {
        pa_core::settings::SettingsManager::create(&agent_dir, &agent_dir).get_bots_enabled()
    })
    .await
    .context("the bots.enabled gate read failed")?;
    if !enabled {
        bail!(BOTS_DISABLED_MESSAGE);
    }
    Ok(())
}

/// The supervisor's own deadline for a bot spawn or send, inside the
/// worker's wait, so work the worker gave up on never keeps running.
pub const BOT_DEADLINE: std::time::Duration = std::time::Duration::from_mins(13);

/// Owner and name pairs with a spawn in flight: two concurrent spawns
/// of one name for one owner never both provision.
static SPAWNING: std::sync::Mutex<std::collections::BTreeSet<(String, String)>> =
    std::sync::Mutex::new(std::collections::BTreeSet::new());

struct NameReservation((String, String));

impl NameReservation {
    fn take(owner_session_id: &str, name: &str) -> Result<Self> {
        let key = (owner_session_id.to_string(), name.to_string());
        let mut spawning = SPAWNING
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if !spawning.insert(key.clone()) {
            bail!("a bot named \"{name}\" is already starting for this session");
        }
        Ok(Self(key))
    }
}

impl Drop for NameReservation {
    fn drop(&mut self) {
        SPAWNING
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&self.0);
    }
}

/// One bot as a `list_bots` row.
#[must_use]
pub fn bot_row(record: &BotRecord, attached: bool) -> Value {
    json!({
        "botId": record.bot_id,
        "name": record.name,
        "ownerSessionId": record.owner_session_id,
        "sandboxId": record.sandbox_id,
        "status": record.status.as_str(),
        "model": record.model,
        "version": record.version,
        "checkpointId": record.checkpoint_id,
        "createdAt": record.created_at,
        "lastTurnAt": record.last_turn_at,
        "guestSessionId": record.guest_session_id,
        "attached": attached,
    })
}

impl Supervisor {
    /// `spawn_bot`: gate, provision, then hand the bot its first prompt.
    /// A first prompt that does not certainly arrive deletes the bot, so
    /// a failed spawn leaves nothing billing.
    pub(crate) async fn handle_spawn_bot(
        self: &Arc<Self>,
        command_id: &str,
        command: &DaemonCommand,
    ) -> DaemonResponse {
        let DaemonCommand::SpawnBot {
            name,
            owner_session_id,
            model,
            thinking,
            prompt,
            rlm_max_depth,
            ..
        } = command
        else {
            return response_failure(Some(command_id), "spawn_bot", "invalid command", None);
        };
        let spec = BotSpec {
            bot_id: uuid::Uuid::new_v4().to_string(),
            name: name.clone(),
            owner_session_id: owner_session_id.clone(),
            model: model.clone(),
            thinking: thinking.clone(),
            prompt: prompt.clone(),
        };
        match self.spawn_bot(&spec, *rlm_max_depth).await {
            Ok(record) => {
                response_success(Some(command_id), "spawn_bot", Some(bot_row(&record, false)))
            }
            Err(error) => {
                response_failure(Some(command_id), "spawn_bot", &format!("{error:#}"), None)
            }
        }
    }

    async fn spawn_bot(&self, spec: &BotSpec, rlm_max_depth: u64) -> Result<BotRecord> {
        let agent_dir = &self.options.agent_dir;
        admit_bot_spawn(agent_dir).await?;
        let manager = super::manager_for(agent_dir)?;
        let _reservation = NameReservation::take(&spec.owner_session_id, &spec.name)?;
        if manager
            .list()
            .iter()
            .any(|bot| bot.owner_session_id == spec.owner_session_id && bot.name == spec.name)
        {
            bail!(
                "a bot named \"{}\" already exists for this session",
                spec.name
            );
        }
        let started = tokio::time::timeout(BOT_DEADLINE, async {
            let record = manager.spawn(spec).await?;
            let mut client = super::guest::GuestClient::connect(&manager, &record)
                .await
                .context("the bot did not get its task")?;
            // The owner's depth limit holds inside the bot's own daemon.
            client
                .command(&DaemonCommand::SetRlmMaxDepth {
                    id: None,
                    active_session_id: record.guest_session_id.clone(),
                    max_depth: rlm_max_depth,
                    global: None,
                    rest: serde_json::Map::default(),
                })
                .await
                .map_err(|error| {
                    anyhow::anyhow!("the bot did not take its depth limit: {error}")
                })?;
            super::send::send_message(
                &super::ledger::BotLedger::new(agent_dir, &record.bot_id),
                &mut client,
                &record.guest_session_id,
                &format!("spawn-{}", record.bot_id),
                &spec.prompt,
                None,
            )
            .await
            .map_err(|error| anyhow::anyhow!("the bot did not get its task: {error}"))?;
            anyhow::Ok(record)
        })
        .await
        .unwrap_or_else(|_| {
            Err(anyhow::anyhow!(
                "the bot did not start within {BOT_DEADLINE:?}"
            ))
        });
        match started {
            // The bot now runs a turn; the reply path follows it from here.
            Ok(record) => Ok(record),
            // A failed spawn leaves nothing billing, whatever step it reached.
            Err(error) => match manager.delete(&spec.bot_id).await {
                Ok(()) => Err(error.context("the bot was deleted")),
                Err(delete_error) => {
                    Err(error.context(format!("deleting the bot failed: {delete_error:#}")))
                }
            },
        }
    }

    /// `delete_bot`: delete one bot its owner names.
    pub(crate) async fn handle_delete_bot(
        self: &Arc<Self>,
        command_id: &str,
        command: &DaemonCommand,
    ) -> DaemonResponse {
        let DaemonCommand::DeleteBot {
            bot_id,
            owner_session_id,
            ..
        } = command
        else {
            return response_failure(Some(command_id), "delete_bot", "invalid command", None);
        };
        let deleted = async {
            let manager = super::manager_for(&self.options.agent_dir)?;
            let record = manager
                .list()
                .into_iter()
                .find(|bot| &bot.bot_id == bot_id && &bot.owner_session_id == owner_session_id)
                .ok_or_else(|| anyhow::anyhow!("Unknown bot: {bot_id}"))?;
            manager.delete(&record.bot_id).await?;
            anyhow::Ok(record)
        }
        .await;
        match deleted {
            Ok(record) => response_success(
                Some(command_id),
                "delete_bot",
                Some(bot_row(&record, false)),
            ),
            Err(error) => {
                response_failure(Some(command_id), "delete_bot", &format!("{error:#}"), None)
            }
        }
    }

    /// `list_bots`: every bot, or one owner's.
    pub(crate) fn handle_list_bots(
        self: &Arc<Self>,
        command_id: &str,
        command: &DaemonCommand,
    ) -> DaemonResponse {
        let DaemonCommand::ListBots {
            owner_session_id, ..
        } = command
        else {
            return response_failure(Some(command_id), "list_bots", "invalid command", None);
        };
        // No registry: no bot was ever spawned here, so skip the credential read.
        if !super::registry::BotRegistry::path_in(&self.options.agent_dir).exists() {
            return response_success(Some(command_id), "list_bots", Some(json!({ "bots": [] })));
        }
        let manager = match super::manager_for(&self.options.agent_dir) {
            Ok(manager) => manager,
            Err(error) => {
                return response_failure(Some(command_id), "list_bots", &format!("{error:#}"), None)
            }
        };
        let rows: Vec<Value> = manager
            .list()
            .iter()
            .filter(|bot| {
                owner_session_id
                    .as_ref()
                    .is_none_or(|owner| &bot.owner_session_id == owner)
            })
            .map(|bot| bot_row(bot, manager.attached(&bot.bot_id)))
            .collect();
        response_success(Some(command_id), "list_bots", Some(json!({ "bots": rows })))
    }

    /// The bot a `send_message` target names, if any.
    pub(crate) fn bot_target(&self, target: &str) -> Option<BotRecord> {
        let agent_dir = &self.options.agent_dir;
        if !super::registry::BotRegistry::path_in(agent_dir).exists() {
            return None;
        }
        super::manager_for(agent_dir).ok()?.get(target)
    }
}
