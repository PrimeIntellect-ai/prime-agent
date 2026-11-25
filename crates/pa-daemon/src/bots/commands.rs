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

/// The refusal inside a bot that was not spawned with `bots=True`.
pub const BOT_MAY_NOT_SPAWN_MESSAGE: &str = "this bot may not spawn bots: its owner spawned it \
     without bots=True, and bots nest two levels deep (owner -> bot -> bot). Ask the owner to \
     respawn it with rlm.spawn(..., target=\"sandbox\", bots=True), or to run \
     `prime-agent bots allow-spawns <bot>` on it";

/// The spawn gate. Inside a bot, the nested-spawn context decides (see
/// [`admit_nested_spawn`]); everywhere else, a fresh, strict read of the
/// global `bots.enabled` setting per attempt (unset, malformed, and
/// unreadable settings all refuse).
///
/// # Errors
///
/// Returns [`BOT_MAY_NOT_SPAWN_MESSAGE`] inside a bot that may not spawn
/// bots, and [`BOTS_DISABLED_MESSAGE`] while the opt-in is off.
pub async fn admit_bot_spawn(agent_dir: &Path, bots: bool) -> Result<()> {
    if super::remote_parent::remote_parent_name().is_some() {
        return admit_nested_spawn(agent_dir, bots).await;
    }
    admit_owner_bot_spawn(agent_dir).await
}

/// The gate inside a bot: the nested-spawn context decides.
///
/// # Errors
///
/// Returns [`BOT_MAY_NOT_SPAWN_MESSAGE`] for a bot without the context,
/// and the depth-cap refusals past it.
pub async fn admit_nested_spawn(agent_dir: &Path, bots: bool) -> Result<()> {
    let agent_dir = agent_dir.to_path_buf();
    let nested =
        tokio::task::spawn_blocking(move || super::nested::NestedContext::read(&agent_dir))
            .await
            .context("the nested-spawn gate read failed")?;
    let Some(context) = nested else {
        bail!(BOT_MAY_NOT_SPAWN_MESSAGE);
    };
    if !context.may_spawn() {
        bail!(
            "bots nest at most two levels deep (owner -> bot -> bot); this bot is at \
             level {} and cannot spawn another one",
            context.depth
        );
    }
    if bots {
        bail!(
            "a bot cannot pass bots=True on: bots nest two levels deep \
             (owner -> bot -> bot), so a bot's children never spawn bots"
        );
    }
    Ok(())
}

/// The `bots.enabled` opt-in gate outside a bot.
async fn admit_owner_bot_spawn(agent_dir: &Path) -> Result<()> {
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

/// The supervisor's own deadline for a bot spawn, send, or delete, inside the
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

/// Owner ids with a spawn in flight. Held with [`SPAWNING`] under one
/// lock, so the `bots.maxBots` cap counts existing bots plus creates that
/// have not landed in the registry yet: two concurrent spawns under
/// different names cannot both pass the cap.
static SPAWNING_OWNERS: std::sync::Mutex<std::collections::BTreeSet<String>> =
    std::sync::Mutex::new(std::collections::BTreeSet::new());

/// Reserve one in-flight create for `owner_session_id`.
///
/// # Errors
///
/// Returns an error when the owner already holds a reservation.
fn reserve_owner_slot(owner_session_id: &str) -> Result<OwnerSlot> {
    let mut owners = SPAWNING_OWNERS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if !owners.insert(owner_session_id.to_string()) {
        bail!("this session already has a bot starting; wait for it to finish");
    }
    Ok(OwnerSlot(owner_session_id.to_string()))
}

/// One reserved in-flight create; dropping it frees the slot.
struct OwnerSlot(String);

impl Drop for OwnerSlot {
    fn drop(&mut self) {
        SPAWNING_OWNERS
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&self.0);
    }
}

/// One bot as a `list_bots` row. `login_stale` names the owner logins
/// whose refresh failed or that expired.
#[must_use]
pub fn bot_row(
    record: &BotRecord,
    attached: bool,
    login_stale: &[String],
    spawns_bots: bool,
) -> Value {
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
        "github": record.github,
        "loginStale": login_stale,
        // The bot may spawn its own bots, or already has children.
        "spawnsBots": spawns_bots,
        "parentBotId": record.parent_bot_id,
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
            github,
            bots,
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
            github: false,
            git_identity: None,
            bots: *bots,
        };
        match self.spawn_bot(spec, *github, *rlm_max_depth).await {
            Ok(record) => response_success(
                Some(command_id),
                "spawn_bot",
                Some(bot_row(&record, false, &[], record.bots)),
            ),
            Err(error) => {
                response_failure(Some(command_id), "spawn_bot", &format!("{error:#}"), None)
            }
        }
    }

    async fn spawn_bot(
        self: &Arc<Self>,
        mut spec: BotSpec,
        github: Option<bool>,
        rlm_max_depth: u64,
    ) -> Result<BotRecord> {
        let agent_dir = &self.options.agent_dir;
        admit_bot_spawn(agent_dir, spec.bots).await?;
        let dir = agent_dir.clone();
        let nested = tokio::task::spawn_blocking({
            let dir = dir.clone();
            move || super::nested::NestedContext::read(&dir)
        })
        .await
        .context("the nested-spawn context read failed")?;
        let nested_for_github = nested.clone();
        (spec.github, spec.git_identity) = tokio::task::spawn_blocking(move || {
            // Inside a bot, GitHub access is what the bot's own sandbox
            // rule can pass on, not this daemon's settings.
            if let Some(context) = nested_for_github.as_ref() {
                let inherited = context.network_rules.contains_key(super::github::GIT_HOST);
                return match github {
                    Some(true) if !inherited => Err(anyhow::anyhow!(
                        "this bot has no GitHub access to pass on: its sandbox has no \
                         GitHub header rule. Spawn the child without github."
                    )),
                    Some(true) => Ok((true, super::github::git_identity(&dir))),
                    Some(false) => Ok((false, super::github::git_identity(&dir))),
                    None => Ok((inherited, super::github::git_identity(&dir))),
                };
            }
            super::github::for_spawn(&dir, github)
        })
        .await
        .context("the GitHub settings read failed")??;
        let spec = &spec;
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
        // The owner's bot list cap, children included. Inside a bot, the
        // context's owner label names every bot of the same owner, so the
        // count covers the owner's own bots too.
        let (count_owner, max_bots) = if let Some(context) = nested.as_ref() {
            (context.owner_session_id.clone(), context.max_bots)
        } else {
            let dir = agent_dir.clone();
            let owner = spec.owner_session_id.clone();
            let max = tokio::task::spawn_blocking(move || {
                pa_core::settings::SettingsManager::create(&dir, &dir).get_bots_max_bots() as usize
            })
            .await
            .context("the bots.maxBots read failed")?;
            (owner, max)
        };
        let owned = manager.owner_bot_ids(&count_owner).await?;
        if owned.len() >= max_bots {
            bail!(
                "the owner's bot list is full: {} of bots.maxBots {} (children a bot spawned \
                 count too). Delete a bot or raise bots.maxBots in the daemon settings.json.",
                owned.len(),
                max_bots
            );
        }
        // The cap also counts this owner's in-flight creates, so concurrent
        // spawns under different names cannot both pass it.
        let _owner_slot = reserve_owner_slot(&count_owner)?;
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
            super::send::send_task(
                &super::ledger::BotLedger::new(agent_dir, &record.bot_id),
                &mut client,
                &record.guest_session_id,
                &format!("spawn-{}", record.bot_id),
                &spec.prompt,
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
            // The bot now runs a turn; follow it to deliver its reply.
            Ok(record) => {
                self.follow_bot(&record.bot_id);
                Ok(record)
            }
            // A failed spawn leaves nothing billing, whatever step it reached.
            Err(error) => {
                let cleanup = match manager.delete(&spec.bot_id).await {
                    Ok(()) => "the failed bot was deleted".to_string(),
                    Err(delete_error) => {
                        let same = error.chain().last().map(ToString::to_string)
                            == delete_error.chain().last().map(ToString::to_string);
                        if same {
                            "the failed bot could not be deleted (the same error)".to_string()
                        } else {
                            format!("the failed bot could not be deleted: {delete_error:#}")
                        }
                    }
                };
                Err(anyhow::anyhow!(
                    "the bot did not start: {error:#}; {cleanup}"
                ))
            }
        }
    }

    /// `allow_bot_spawns`: give one running bot the ability to spawn bots.
    /// The daemon owns the registry, so the grant lands in the same writer
    /// the lifecycle uses (`prime-agent bots allow-spawns` routes here).
    pub(crate) async fn handle_allow_bot_spawns(
        self: &Arc<Self>,
        command_id: &str,
        command: &DaemonCommand,
    ) -> DaemonResponse {
        let DaemonCommand::AllowBotSpawns { bot, .. } = command else {
            return response_failure(
                Some(command_id),
                "allow_bot_spawns",
                "invalid command",
                None,
            );
        };
        let granted = async {
            let manager = super::manager_for(&self.options.agent_dir)?;
            let bot_id = manager
                .list()
                .into_iter()
                .find(|record| &record.bot_id == bot)
                .or_else(|| {
                    let named: Vec<_> = manager
                        .list()
                        .into_iter()
                        .filter(|record| &record.name == bot)
                        .collect();
                    (named.len() == 1).then(|| named[0].clone())
                })
                .map(|record| record.bot_id)
                .ok_or_else(|| anyhow::anyhow!("No bot named {bot:?}."))?;
            let record = tokio::time::timeout(BOT_DEADLINE, manager.allow_spawns(&bot_id))
                .await
                .map_err(|_| {
                    anyhow::anyhow!("the bot was not granted spawns within {BOT_DEADLINE:?}")
                })??;
            anyhow::Ok(record)
        }
        .await;
        match granted {
            Ok(record) => response_success(
                Some(command_id),
                "allow_bot_spawns",
                Some(bot_row(&record, false, &[], record.bots)),
            ),
            Err(error) => response_failure(
                Some(command_id),
                "allow_bot_spawns",
                &format!("{error:#}"),
                None,
            ),
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
            tokio::time::timeout(BOT_DEADLINE, manager.delete(&record.bot_id))
                .await
                .map_err(|_| {
                    anyhow::anyhow!("the bot was not deleted within {BOT_DEADLINE:?}")
                })??;
            anyhow::Ok(record)
        }
        .await;
        match deleted {
            Ok(record) => response_success(
                Some(command_id),
                "delete_bot",
                Some(bot_row(&record, false, &[], record.bots)),
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
        let bots = manager.list();
        // The bots that have children (a merged child row names its parent).
        let parents: std::collections::BTreeSet<&str> = bots
            .iter()
            .filter_map(|bot| bot.parent_bot_id.as_deref())
            .collect();
        let rows: Vec<Value> = bots
            .iter()
            .filter(|bot| {
                owner_session_id
                    .as_ref()
                    .is_none_or(|owner| &bot.owner_session_id == owner)
            })
            .map(|bot| {
                bot_row(
                    bot,
                    manager.attached(&bot.bot_id),
                    &manager.login_stale(bot),
                    bot.bots || parents.contains(bot.bot_id.as_str()),
                )
            })
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

impl Supervisor {
    /// The `/secrets` commands. Each answers with the current list; a
    /// change also sends running and paused bots their new header rules
    /// in the background.
    pub(crate) async fn handle_bot_secrets(
        self: &Arc<Self>,
        command_id: &str,
        command: &DaemonCommand,
    ) -> DaemonResponse {
        let type_name = crate::protocol::command_type_name(command);
        let agent_dir = self.options.agent_dir.clone();
        let changed = !matches!(command, DaemonCommand::ListBotSecrets { .. });
        // One change at a time: each one reads the settings and the auth
        // storage fresh, so no change saves over another one's.
        let _change = SECRETS_CHANGE.lock().await;
        let result = match command {
            DaemonCommand::ListBotSecrets { .. } => Ok(()),
            DaemonCommand::SetBotSecretInject { name, inject, .. } => {
                let (name, inject) = (name.clone(), *inject);
                let dir = agent_dir.clone();
                blocking(move || {
                    pa_core::settings::SettingsManager::create(&dir, &dir)
                        .set_bots_inject(&name, inject)
                })
                .await
            }
            DaemonCommand::AddBotSecret {
                name,
                host,
                header,
                scheme,
                value,
                ..
            } => {
                let new = super::secrets::NewSecret {
                    name: name.clone(),
                    host: host.clone(),
                    header: header.clone(),
                    scheme: scheme.clone(),
                    value: value.clone(),
                };
                let dir = agent_dir.clone();
                blocking(move || super::secrets::add(&dir, &new)).await
            }
            DaemonCommand::RemoveBotSecret { name, .. } => {
                super::secrets::remove(&agent_dir, name).await
            }
            _ => Err(anyhow::anyhow!("invalid command")),
        };
        if let Err(error) = result {
            return response_failure(Some(command_id), type_name, &format!("{error:#}"), None);
        }
        if changed && super::registry::BotRegistry::path_in(&agent_dir).exists() {
            tokio::spawn(refresh_bot_rules(agent_dir.clone()));
        }
        let dir = agent_dir.clone();
        match blocking(move || {
            Ok(super::secrets::view_rows(&super::secrets::view_plan(
                &dir,
                &owner_of(&dir),
            )))
        })
        .await
        {
            Ok(mut rows) => {
                rows["staleBots"] = json!(*lock_failures());
                response_success(Some(command_id), type_name, Some(rows))
            }
            Err(error) => {
                response_failure(Some(command_id), type_name, &format!("{error:#}"), None)
            }
        }
    }
}

/// Serializes the `/secrets` changes.
static SECRETS_CHANGE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
/// Serializes the rules refreshes: the last one to finish is current.
static RULES_REFRESH: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
/// The bots that kept old header rules after the last refresh, with why.
static RULES_FAILURES: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

/// How long the refresh waits before each retry of a failed bot.
const RULES_RETRY_DELAYS: [std::time::Duration; 2] = [
    std::time::Duration::from_secs(15),
    std::time::Duration::from_secs(60),
];

fn lock_failures() -> std::sync::MutexGuard<'static, Vec<String>> {
    RULES_FAILURES
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Send every bot its new header rules; retry while some bot kept its old
/// ones. The bots still failing after the retries are listed by `/secrets`.
async fn refresh_bot_rules(agent_dir: std::path::PathBuf) {
    let _refresh = RULES_REFRESH.lock().await;
    let manager = match super::manager_for(&agent_dir) {
        Ok(manager) => manager,
        Err(error) => {
            *lock_failures() = vec![format!("all bots: {error:#}")];
            return;
        }
    };
    let mut failures = manager.refresh_network_rules().await;
    for delay in RULES_RETRY_DELAYS {
        if failures.is_empty() {
            break;
        }
        *lock_failures() = failures;
        tokio::time::sleep(delay).await;
        failures = manager.refresh_network_rules().await;
    }
    for failure in &failures {
        eprintln!("bot secrets: kept the old header rules for {failure}");
    }
    *lock_failures() = failures;
}

/// The Prime account fingerprint that names its GitHub secrets; empty
/// without a Prime credential (the view then lists no GitHub secret names).
fn owner_of(agent_dir: &Path) -> String {
    super::prime_client(agent_dir)
        .map(|(_, owner)| owner)
        .unwrap_or_default()
}

/// Run blocking settings and auth storage work off the runtime.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tokio::task::spawn_blocking(work)
        .await
        .context("the secrets task failed")?
}
