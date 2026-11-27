//! Two-way sync of the global harness state between the owner and a bot.
//!
//! The owner's global harness (`<agent_dir>/harness/harness_state.json`)
//! travels into the bot at spawn and wake, and the bot's own global
//! refinements merge back after each settled turn. A per-bot base file
//! records the entry versions of the guest file at its last sync, so the
//! three-way merge in `pa-core` can tell a bot's new entry from a stale
//! copy of one the owner deleted. Every step is best effort: a failed
//! sync logs one warning and never blocks a spawn, wake, or delivery
//! (the same contract as the relay wake-up sync).

use std::collections::BTreeMap;
use std::path::Path;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use pa_core::refinement::merge::{entry_versions, kind_from_key_name, merge_harness_states};
use pa_core::refinement::{
    empty_harness_state, get_global_harness_state_dir, get_harness_state_path,
    update_harness_state, HarnessScope, HarnessState, RefinementKind,
};
use serde::{Deserialize, Serialize};
use tokio::time::Instant;

use super::manager::check_exit;
use super::platform::PlatformError;
use super::{sha256_hex, BotManager, BotRecord};

/// The bot's global harness state file: the guest daemon's agent dir,
/// never a session-local one and never a credential.
pub(crate) const GUEST_HARNESS_STATE: &str = "/root/.prime/agent/harness/harness_state.json";
/// The temp path a push uploads to; it sits in the same directory, so the
/// move onto the state file is one atomic rename.
const GUEST_HARNESS_TMP: &str = "/root/.prime/agent/harness/.harness_state.json.sync";
/// What the probe prints when the bot has no state file yet.
pub(crate) const NO_STATE_MARKER: &str = "__NO_STATE__";
/// How long a post-settle pull may take end to end.
const PULL_BUDGET: Duration = Duration::from_mins(2);

/// The sha256 probe. It also creates the harness directory, so the
/// upload that follows it always has somewhere to land.
pub(crate) const HARNESS_PROBE_SCRIPT: &str = r#"p="$PA_HARNESS_STATE"
mkdir -p "$(dirname "$p")"
if [ -f "$p" ]; then sha256sum "$p" | cut -d' ' -f1; else echo __NO_STATE__; fi
"#;

/// Moves an uploaded temp file onto the state file and seals its mode.
pub(crate) const HARNESS_MOVE_SCRIPT: &str = r#"mkdir -p "$(dirname "$PA_HARNESS_STATE")"
mv -f "$PA_HARNESS_TMP" "$PA_HARNESS_STATE"
chmod 600 "$PA_HARNESS_STATE"
"#;

/// The per-bot sync base: the entry versions of the guest file at its
/// last sync, and that file's sha256. Written atomically next to the
/// registry; removed when the bot is deleted.
#[derive(Debug, Default, Serialize, Deserialize)]
struct SyncBase {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_synced_sha256: Option<String>,
    #[serde(default)]
    versions: BTreeMap<String, BTreeMap<String, u64>>,
}

impl SyncBase {
    fn load(agent_dir: &Path, bot_id: &str) -> Self {
        let path = base_path(agent_dir, bot_id);
        let text = match std::fs::read_to_string(&path) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Self::default();
            }
            Err(error) => {
                eprintln!(
                    "pa-daemon: bots: {bot_id}: the harness sync base is unreadable, resyncing: {error}"
                );
                return Self::default();
            }
        };
        serde_json::from_str(&text).unwrap_or_else(|error| {
            eprintln!(
                "pa-daemon: bots: {bot_id}: the harness sync base is unreadable, resyncing: {error}"
            );
            Self::default()
        })
    }

    fn save(&self, agent_dir: &Path, bot_id: &str) -> Result<()> {
        let path = base_path(agent_dir, bot_id);
        if let Some(parent) = path.parent() {
            pa_core::platform::perms::create_dir_all_private(parent)?;
        }
        crate::descriptor::write_file_atomic(&path, &serde_json::to_string(self)?)
    }

    /// Record `state` as the guest file's content, sealed by `sha256`.
    /// Entries the state no longer lists keep their last recorded
    /// version: that tombstone is what keeps an older checkpoint from
    /// resurrecting an entry the owner deleted.
    fn recorded_as(&mut self, state: &HarnessState, sha256: String) {
        self.last_synced_sha256 = Some(sha256);
        for ((kind, id), version) in entry_versions(state) {
            self.versions
                .entry(kind_key(kind).to_string())
                .or_default()
                .insert(id, version);
        }
    }

    /// The recorded versions as the merge's base map.
    fn version_map(&self) -> BTreeMap<(RefinementKind, String), u64> {
        self.versions
            .iter()
            .flat_map(|(kind, entries)| {
                entries
                    .iter()
                    .map(move |(id, version)| ((kind_from_key_name(kind), id.clone()), *version))
            })
            .collect()
    }
}

/// A sync base file lives under the agent dir, next to the spawns marker.
fn base_path(agent_dir: &Path, bot_id: &str) -> std::path::PathBuf {
    agent_dir
        .join("bots")
        .join("harness-sync")
        .join(format!("{bot_id}.json"))
}

/// Drop a bot's sync base. A missing file is success; a failed removal
/// only warns, so a delete never fails on it.
pub(crate) fn remove_base(agent_dir: &Path, bot_id: &str) {
    if let Err(error) = std::fs::remove_file(base_path(agent_dir, bot_id)) {
        if error.kind() != std::io::ErrorKind::NotFound {
            eprintln!("pa-daemon: bots: {bot_id}: the harness sync base removal failed: {error}");
        }
    }
}

/// The on-wire kind names, the ones the state file itself uses.
fn kind_key(kind: RefinementKind) -> &'static str {
    match kind {
        RefinementKind::Prompt => "prompt",
        RefinementKind::Memory => "memory",
        RefinementKind::Skill => "skill",
        RefinementKind::Subagent => "subagent",
        RefinementKind::Factory => "factory",
    }
}

/// The canonical bytes of a state: the exact form `save_harness_state`
/// writes, so both sides of a sync converge on one file.
fn canonical_bytes(state: &HarnessState) -> Result<Vec<u8>> {
    Ok(format!("{}\n", serde_json::to_string_pretty(state)?).into_bytes())
}

/// The owner's global state, read fallibly. A missing file is the empty
/// state, but an unreadable or malformed one is an error: a lenient read
/// here could push an empty state over the bot's valid one.
fn read_owner_state(harness_dir: &Path) -> Result<HarnessState> {
    let path = get_harness_state_path(harness_dir);
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text)
            .with_context(|| format!("the owner harness state at {} is malformed", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(empty_harness_state()),
        Err(error) => Err(anyhow!("the owner harness state cannot be read: {error}")),
    }
}

/// A state with no entries and no history.
fn is_empty(state: &HarnessState) -> bool {
    state.entries.values().all(BTreeMap::is_empty) && state.refinements.is_empty()
}

impl BotManager {
    /// Two-way sync at spawn and wake: the owner's global harness travels
    /// into the bot before its daemon reads it, and the bot's own global
    /// refinements merge back into the owner. Best effort by contract:
    /// callers log the error and continue.
    ///
    /// # Errors
    /// Returns an error when the guest probe, download, or upload fails,
    /// or the owner state cannot be read or written.
    pub async fn sync_global_harness(&self, record: &BotRecord, deadline: Instant) -> Result<()> {
        self.harness_sync(record, true, deadline).await
    }

    /// Post-settle pull: merge the bot's global harness changes into the
    /// owner's, never writing the guest (the next wake pushes).
    ///
    /// # Errors
    /// Returns an error when the guest probe or download fails, or the
    /// owner state cannot be read or written.
    pub async fn pull_global_harness(&self, record: &BotRecord) -> Result<()> {
        let deadline = Instant::now() + PULL_BUDGET;
        self.harness_sync(record, false, deadline).await
    }

    /// One sync round. `push` sends the merged state to the guest (spawn
    /// and wake); a settle pull only merges into the owner.
    async fn harness_sync(&self, record: &BotRecord, push: bool, deadline: Instant) -> Result<()> {
        let Some(sandbox_id) = record.sandbox_id.as_deref() else {
            return Ok(());
        };
        let agent_dir = self.agent_dir.clone();
        let bot_id = record.bot_id.clone();
        let (owner_state, mut base) =
            tokio::task::spawn_blocking(move || -> Result<(HarnessState, SyncBase)> {
                let dir = get_global_harness_state_dir(&agent_dir);
                let state = read_owner_state(&dir)?;
                Ok((state, SyncBase::load(&agent_dir, &bot_id)))
            })
            .await
            .context("the owner harness read failed")??;

        let guest_sha = self.probe_guest_harness_sha(sandbox_id, deadline).await?;
        let owner_sha = sha256_hex(&canonical_bytes(&owner_state)?);
        // Fast path: both sides still hold exactly the last-synced bytes.
        if base.last_synced_sha256.as_deref() == Some(owner_sha.as_str())
            && guest_sha.as_deref() == Some(owner_sha.as_str())
        {
            return Ok(());
        }
        let base_versions = base.version_map();
        // The owner can also roll an entry back below its base version
        // (an old harness backup restored wholesale); only the full merge
        // resolves that against the guest's newer copy.
        let owner_below_base = base_versions.iter().any(|((kind, id), version)| {
            owner_state
                .entries
                .get(kind)
                .and_then(|entries| entries.get(id))
                .is_some_and(|entry| entry.version < *version)
        });
        // A guest whose file still matches the last sync is at the base:
        // the merge reduces to the owner state, so nothing is downloaded.
        let guest_state = if guest_sha == base.last_synced_sha256 && !owner_below_base {
            None
        } else {
            Some(self.download_guest_state(sandbox_id, deadline).await?)
        };
        let mut merged = match &guest_state {
            Some(guest) => merge_harness_states(&owner_state, guest, &base_versions),
            None => owner_state.clone(),
        };
        // The owner file is rewritten only when the guest contributed a
        // change, and under the state lock: the merge reruns against the
        // freshly loaded owner state, so a concurrent owner edit rides in.
        if let Some(guest) = &guest_state {
            if merged != owner_state {
                let agent_dir = self.agent_dir.clone();
                let guest = guest.clone();
                let base_versions = base_versions.clone();
                merged = tokio::task::spawn_blocking(move || -> Result<HarnessState> {
                    let dir = get_global_harness_state_dir(&agent_dir);
                    let (merged, _) = update_harness_state(&dir, HarnessScope::Global, |state| {
                        let merged = merge_harness_states(state, &guest, &base_versions);
                        *state = merged.clone();
                        merged
                    })?;
                    Ok(merged)
                })
                .await
                .context("the owner harness write failed")??;
            }
        }

        // The push: upload to a temp file, then one atomic move.
        let final_bytes = canonical_bytes(&merged)?;
        let final_sha = sha256_hex(&final_bytes);
        let mut pushed = false;
        if push && !(is_empty(&merged) && guest_sha.is_none()) {
            let needed = match &guest_state {
                Some(guest) => *guest != merged,
                None => guest_sha.as_deref() != Some(final_sha.as_str()),
            };
            if needed {
                self.push_guest_harness(sandbox_id, &final_bytes, deadline)
                    .await?;
                pushed = true;
            }
        }

        // The base records the guest file as it stands now: the pushed
        // state, or the downloaded one a settle pull left in place. A
        // guest that lost its file records nothing — the stale base keeps
        // the next sync downloading, and the push then restores a file.
        if pushed {
            base.recorded_as(&merged, final_sha);
            base.save(&self.agent_dir, &record.bot_id)?;
        } else if let (Some(guest), Some(sha)) = (&guest_state, guest_sha) {
            base.recorded_as(guest, sha);
            base.save(&self.agent_dir, &record.bot_id)?;
        }
        Ok(())
    }

    /// The guest state file's sha256, or `None` when it does not exist.
    async fn probe_guest_harness_sha(
        &self,
        sandbox_id: &str,
        deadline: Instant,
    ) -> Result<Option<String>> {
        let env = BTreeMap::from([(
            "PA_HARNESS_STATE".to_string(),
            GUEST_HARNESS_STATE.to_string(),
        )]);
        let output = self
            .exec_ready(sandbox_id, HARNESS_PROBE_SCRIPT, &env, None, deadline)
            .await?;
        let digest = output.stdout.trim();
        if digest == NO_STATE_MARKER {
            return Ok(None);
        }
        if digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Ok(Some(digest.to_string()));
        }
        let exit_code = output.exit_code;
        bail!("the bot answered an unreadable harness digest (exit {exit_code})");
    }

    /// Download and parse the guest state. A guest that lost its file
    /// (an empty answer or a missing path) reads as the empty state, so
    /// the push that follows restores one.
    async fn download_guest_state(
        &self,
        sandbox_id: &str,
        deadline: Instant,
    ) -> Result<HarnessState> {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let downloaded = match tokio::time::timeout(
            remaining,
            self.platform.download(sandbox_id, GUEST_HARNESS_STATE),
        )
        .await
        {
            Err(_) => bail!("the harness download timed out"),
            Ok(Err(PlatformError::NotFound(_))) => Vec::new(),
            Ok(Err(error)) => return Err(anyhow!("the harness download failed: {error}")),
            Ok(Ok(bytes)) => bytes,
        };
        if downloaded.is_empty() {
            return Ok(empty_harness_state());
        }
        serde_json::from_slice(&downloaded).with_context(|| "the bot's harness state is malformed")
    }

    /// Upload the merged state to the temp path and move it into place.
    async fn push_guest_harness(
        &self,
        sandbox_id: &str,
        bytes: &[u8],
        deadline: Instant,
    ) -> Result<()> {
        self.platform
            .upload(sandbox_id, GUEST_HARNESS_TMP, bytes)
            .await
            .map_err(|error| anyhow!("the harness upload failed: {error}"))?;
        let env = BTreeMap::from([
            ("PA_HARNESS_TMP".to_string(), GUEST_HARNESS_TMP.to_string()),
            (
                "PA_HARNESS_STATE".to_string(),
                GUEST_HARNESS_STATE.to_string(),
            ),
        ]);
        let output = self
            .exec_ready(sandbox_id, HARNESS_MOVE_SCRIPT, &env, None, deadline)
            .await?;
        check_exit("install the synced harness in the bot", &output)
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::time::Duration;

    use super::super::tests::{setup, spec};
    use pa_core::refinement::HarnessEntry;

    use super::*;

    /// One owner or guest state holding these memory entries.
    fn state_with(entries: &[(&str, u64)]) -> HarnessState {
        let mut state = empty_harness_state();
        for (id, version) in entries {
            let entry = HarnessEntry {
                id: id.to_string(),
                kind: RefinementKind::Memory,
                title: format!("Entry {id}"),
                content: format!("content of {id}"),
                path: "general".to_string(),
                scope: Some(HarnessScope::Global),
                reference: serde_json::Map::default(),
                arguments: serde_json::Map::default(),
                metadata: serde_json::Map::default(),
                source: "test".to_string(),
                created_at: "2026-01-01T00:00:00.000Z".to_string(),
                updated_at: "2026-01-01T00:00:00.000Z".to_string(),
                version: *version,
            };
            state
                .entries
                .get_mut(&RefinementKind::Memory)
                .unwrap()
                .insert(id.to_string(), entry);
        }
        state
    }

    fn owner_dir(dir: &tempfile::TempDir) -> PathBuf {
        get_global_harness_state_dir(dir.path())
    }

    fn save_owner(dir: &tempfile::TempDir, state: &HarnessState) {
        pa_core::refinement::save_harness_state(&owner_dir(dir), state).unwrap();
    }

    fn load_owner(dir: &tempfile::TempDir) -> HarnessState {
        read_owner_state(&owner_dir(dir)).unwrap()
    }

    /// The bot's on-disk state, as the fake's guest file holds it.
    fn guest_state(platform: &crate::bots::tests::FakePlatform, sandbox_id: &str) -> HarnessState {
        let bytes = platform.state().harness_files[sandbox_id][GUEST_HARNESS_STATE].clone();
        serde_json::from_slice(&bytes).unwrap()
    }

    fn write_guest_state(
        platform: &crate::bots::tests::FakePlatform,
        sandbox_id: &str,
        state: &HarnessState,
    ) {
        platform
            .state()
            .harness_files
            .entry(sandbox_id.to_string())
            .or_default()
            .insert(
                GUEST_HARNESS_STATE.to_string(),
                canonical_bytes(state).unwrap(),
            );
    }

    fn deadline() -> Instant {
        Instant::now() + Duration::from_secs(60)
    }

    #[tokio::test(start_paused = true)]
    async fn a_spawn_pushes_the_owner_harness_into_the_bot() {
        let (dir, platform, manager) = setup();
        let owner = state_with(&[("owner-memory", 2)]);
        save_owner(&dir, &owner);

        let record = manager.spawn(&spec("bot-a")).await.unwrap();
        let sandbox_id = record.sandbox_id.clone().unwrap();

        // The bot's state file holds the owner's global harness, in the
        // canonical form, before its daemon ever reads it.
        let pushed = platform.state().harness_files[&sandbox_id][GUEST_HARNESS_STATE].clone();
        assert_eq!(pushed, canonical_bytes(&owner).unwrap());
        // The sync base records what the guest now holds.
        let base = SyncBase::load(dir.path(), &record.bot_id);
        assert_eq!(
            base.last_synced_sha256.as_deref(),
            Some(sha256_hex(&pushed).as_str())
        );
        assert!(base
            .version_map()
            .contains_key(&(RefinementKind::Memory, "owner-memory".to_string())));
    }

    #[tokio::test(start_paused = true)]
    async fn an_unchanged_bot_syncs_nothing() {
        let (dir, platform, manager) = setup();
        save_owner(&dir, &state_with(&[("owner-memory", 1)]));
        let record = manager.spawn(&spec("bot-a")).await.unwrap();

        let (uploads, downloads) = {
            let state = platform.state();
            (state.uploads.len(), state.harness_downloads)
        };
        assert_eq!(downloads, 0, "the spawn push uploads, never downloads");

        // Nothing changed on either side: the next sync stops after the
        // probe, transferring nothing.
        manager
            .sync_global_harness(&record, deadline())
            .await
            .unwrap();
        let state = platform.state();
        assert_eq!(state.uploads.len(), uploads);
        assert_eq!(state.harness_downloads, downloads);
    }

    #[tokio::test(start_paused = true)]
    async fn a_settle_pull_merges_a_new_bot_entry_without_clobbering() {
        let (dir, platform, manager) = setup();
        save_owner(&dir, &state_with(&[("owner-memory", 1)]));
        let record = manager.spawn(&spec("bot-a")).await.unwrap();
        let sandbox_id = record.sandbox_id.clone().unwrap();

        // The bot refines a new global memory of its own.
        let mut guest = guest_state(&platform, &sandbox_id);
        guest
            .entries
            .get_mut(&RefinementKind::Memory)
            .unwrap()
            .insert(
                "bot-memory".to_string(),
                HarnessEntry {
                    id: "bot-memory".to_string(),
                    kind: RefinementKind::Memory,
                    title: "Bot memory".to_string(),
                    content: "learned in the bot".to_string(),
                    path: "general".to_string(),
                    scope: Some(HarnessScope::Global),
                    reference: serde_json::Map::default(),
                    arguments: serde_json::Map::default(),
                    metadata: serde_json::Map::default(),
                    source: "refine".to_string(),
                    created_at: "2026-02-01T00:00:00.000Z".to_string(),
                    updated_at: "2026-02-01T00:00:00.000Z".to_string(),
                    version: 1,
                },
            );
        write_guest_state(&platform, &sandbox_id, &guest);

        // The post-settle pull: one download, the owner gains the bot's
        // entry, and the guest file is untouched.
        manager.pull_global_harness(&record).await.unwrap();
        let owner = load_owner(&dir);
        assert!(owner.entries[&RefinementKind::Memory].contains_key("bot-memory"));
        assert!(owner.entries[&RefinementKind::Memory].contains_key("owner-memory"));
        assert_eq!(platform.state().harness_downloads, 1);
        assert_eq!(
            platform.state().harness_files[&sandbox_id][GUEST_HARNESS_STATE],
            canonical_bytes(&guest).unwrap()
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_wake_merges_both_directions() {
        let (dir, platform, manager) = setup();
        save_owner(&dir, &state_with(&[("shared", 1)]));
        let record = manager.spawn(&spec("bot-a")).await.unwrap();
        let sandbox_id = record.sandbox_id.clone().unwrap();

        // The bot adds an entry while it ran; the owner adds another.
        let mut guest = guest_state(&platform, &sandbox_id);
        let entry = {
            let mut entry = guest.entries[&RefinementKind::Memory]["shared"].clone();
            entry.id = "bot-memory".to_string();
            entry.title = "Entry bot-memory".to_string();
            entry
        };
        guest
            .entries
            .get_mut(&RefinementKind::Memory)
            .unwrap()
            .insert("bot-memory".to_string(), entry);
        write_guest_state(&platform, &sandbox_id, &guest);
        let mut owner = state_with(&[("shared", 1), ("owner-new", 1)]);
        save_owner(&dir, &owner);

        // The wake syncs both ways: pause, then wake.
        manager.pause(&record.bot_id).await.unwrap();
        manager.ensure_running(&record.bot_id).await.unwrap();

        owner = load_owner(&dir);
        let guest = guest_state(&platform, &sandbox_id);
        for state in [&owner, &guest] {
            let memories = &state.entries[&RefinementKind::Memory];
            for id in ["shared", "owner-new", "bot-memory"] {
                assert!(memories.contains_key(id), "{id} must survive the wake sync");
            }
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_stale_checkpoint_restore_does_not_resurrect_an_owner_deleted_entry() {
        let (dir, platform, manager) = setup();
        save_owner(&dir, &state_with(&[("keep", 1), ("drop", 1)]));
        let record = manager.spawn(&spec("bot-a")).await.unwrap();
        let sandbox_id = record.sandbox_id.clone().unwrap();
        // The checkpoint freezes the bot holding both entries.
        assert!(
            guest_state(&platform, &sandbox_id).entries[&RefinementKind::Memory]
                .contains_key("drop")
        );

        // The owner deletes one while the bot is paused.
        save_owner(&dir, &state_with(&[("keep", 1)]));
        manager.pause(&record.bot_id).await.unwrap();
        manager.ensure_running(&record.bot_id).await.unwrap();

        // The wake pushed the deletion: neither side holds the entry again.
        assert!(!load_owner(&dir).entries[&RefinementKind::Memory].contains_key("drop"));
        assert!(
            !guest_state(&platform, &sandbox_id).entries[&RefinementKind::Memory]
                .contains_key("drop")
        );
        assert!(
            guest_state(&platform, &sandbox_id).entries[&RefinementKind::Memory]
                .contains_key("keep")
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_bot_that_lost_its_state_file_gets_it_restored() {
        let (dir, platform, manager) = setup();
        let owner = state_with(&[("owner-memory", 1)]);
        save_owner(&dir, &owner);
        let record = manager.spawn(&spec("bot-a")).await.unwrap();
        let sandbox_id = record.sandbox_id.clone().unwrap();

        // The guest loses its file (a restore from before the first sync).
        platform.state().harness_files.remove(&sandbox_id);
        manager
            .sync_global_harness(&record, deadline())
            .await
            .unwrap();
        assert_eq!(
            platform.state().harness_files[&sandbox_id][GUEST_HARNESS_STATE],
            canonical_bytes(&owner).unwrap()
        );
    }

    #[tokio::test(start_paused = true)]
    async fn delete_removes_the_sync_base() {
        let (dir, _platform, manager) = setup();
        save_owner(&dir, &state_with(&[("owner-memory", 1)]));
        let record = manager.spawn(&spec("bot-a")).await.unwrap();
        assert!(base_path(dir.path(), &record.bot_id).exists());

        manager.delete(&record.bot_id).await.unwrap();
        assert!(!base_path(dir.path(), &record.bot_id).exists());
    }

    #[tokio::test(start_paused = true)]
    async fn a_corrupt_owner_state_aborts_the_sync_without_touching_the_bot() {
        let (dir, platform, manager) = setup();
        save_owner(&dir, &state_with(&[("owner-memory", 1)]));
        let record = manager.spawn(&spec("bot-a")).await.unwrap();
        let sandbox_id = record.sandbox_id.clone().unwrap();
        let before = platform.state().harness_files[&sandbox_id][GUEST_HARNESS_STATE].clone();

        // A corrupt owner file must not degrade to an empty state that
        // wipes the bot's harness: the sync fails, nothing is pushed.
        std::fs::write(owner_dir(&dir).join("harness_state.json"), "not json").unwrap();
        let refused = manager
            .sync_global_harness(&record, deadline())
            .await
            .expect_err("a corrupt owner state refuses the sync");
        assert!(refused.to_string().contains("malformed"));
        assert_eq!(
            platform.state().harness_files[&sandbox_id][GUEST_HARNESS_STATE],
            before
        );
    }

    #[tokio::test(start_paused = true)]
    async fn an_old_checkpoint_after_a_deletion_push_does_not_resurrect_it() {
        let (dir, platform, manager) = setup();
        save_owner(&dir, &state_with(&[("keep", 1), ("drop", 1)]));
        let record = manager.spawn(&spec("bot-a")).await.unwrap();
        let sandbox_id = record.sandbox_id.clone().unwrap();

        // The owner deletes an entry; the wake pushes the deletion.
        save_owner(&dir, &state_with(&[("keep", 1)]));
        manager.pause(&record.bot_id).await.unwrap();
        manager.ensure_running(&record.bot_id).await.unwrap();
        assert!(
            !guest_state(&platform, &sandbox_id).entries[&RefinementKind::Memory]
                .contains_key("drop")
        );

        // An older checkpoint restores the pre-deletion file wholesale.
        write_guest_state(
            &platform,
            &sandbox_id,
            &state_with(&[("keep", 1), ("drop", 1)]),
        );
        manager
            .sync_global_harness(&record, deadline())
            .await
            .unwrap();

        // The tombstone in the sync base keeps the deletion: the entry
        // stays gone on both sides.
        assert!(!load_owner(&dir).entries[&RefinementKind::Memory].contains_key("drop"));
        assert!(
            !guest_state(&platform, &sandbox_id).entries[&RefinementKind::Memory]
                .contains_key("drop")
        );
        assert!(
            guest_state(&platform, &sandbox_id).entries[&RefinementKind::Memory]
                .contains_key("keep")
        );
    }

    #[tokio::test(start_paused = true)]
    async fn the_sync_touches_only_the_global_harness_paths() {
        let (dir, platform, manager) = setup();
        save_owner(&dir, &state_with(&[("owner-memory", 1)]));
        let record = manager.spawn(&spec("bot-a")).await.unwrap();
        let sandbox_id = record.sandbox_id.clone().unwrap();
        // A settle round too, so the pull path runs as well.
        manager.pull_global_harness(&record).await.unwrap();

        // The only guest path ever written is the global state file: the
        // temp is moved away, and no bot-local harness or credential is
        // named. One guard covers the whole read (a second `state()` on a
        // held guard would self-deadlock the fake).
        {
            let state = platform.state();
            let files = &state.harness_files[&sandbox_id];
            assert_eq!(files.len(), 1);
            assert!(files.contains_key(GUEST_HARNESS_STATE));
            for files in state.harness_files.values() {
                assert!(!files.contains_key("/root/.prime/agent/auth.json"));
                assert!(!files
                    .iter()
                    .any(|(path, _)| path.contains("session-artifacts")));
            }
        }
        // The owner side wrote only the global harness state.
        let harness_dir = std::fs::read_dir(owner_dir(&dir)).unwrap();
        let names: Vec<String> = harness_dir
            .filter_map(std::result::Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        assert!(names
            .iter()
            .all(|name| name.starts_with("harness_state.json")));
    }
}
