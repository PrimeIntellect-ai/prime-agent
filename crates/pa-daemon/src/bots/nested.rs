//! The nested-spawn context: what a bot that may spawn bots knows.
//!
//! The owner's daemon provisions a platform header rule that injects its
//! sandbox API key on the sandbox API host into the bot's sandbox (the key
//! value never enters the VM), and writes this context into the guest's
//! agent dir as `bots/nested.json`. The guest reads the file fresh at every
//! use, so `prime-agent bots allow-spawns` can add it to a running bot. A
//! bot without the file may not spawn bots: its `rlm.spawn(target =
//! "sandbox")` fails fast instead of calling the platform without a key.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::MAX_BOT_DEPTH;

/// One bot's nested-spawn context.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NestedContext {
    /// This bot's id.
    pub bot_id: String,
    /// The owner's durable session id: the bot's children carry its owner
    /// label, so the owner's bot list and `bots.maxBots` count them.
    pub owner_session_id: String,
    /// This bot's nesting level: the owner is 0, its bots 1.
    pub depth: u32,
    /// `bots.maxBots` from the owner's settings.
    pub max_bots: usize,
    /// The sandbox's header rules, which the bot's children inherit minus
    /// the sandbox API rule.
    #[serde(default)]
    pub network_rules: BTreeMap<String, pa_sandbox::HeaderRule>,
}

impl NestedContext {
    /// The context file under `agent_dir`.
    #[must_use]
    pub fn path_in(agent_dir: &Path) -> PathBuf {
        agent_dir.join("bots").join("nested.json")
    }

    /// The context of the daemon running in `agent_dir`; `None` when it is
    /// not a bot that may spawn bots. A malformed file reads as absent (with
    /// a warning), so a torn write cannot wedge the spawn gate.
    #[must_use]
    pub fn read(agent_dir: &Path) -> Option<Self> {
        let path = Self::path_in(agent_dir);
        let text = match std::fs::read_to_string(&path) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
            Err(error) => {
                eprintln!(
                    "pa-daemon: bots: could not read {}: {error}",
                    path.display()
                );
                return None;
            }
        };
        match serde_json::from_str(&text) {
            Ok(context) => Some(context),
            Err(error) => {
                eprintln!(
                    "pa-daemon: bots: could not parse {}: {error}",
                    path.display()
                );
                None
            }
        }
    }

    /// Whether this bot may spawn another one: bots nest at most
    /// [`MAX_BOT_DEPTH`] levels deep.
    #[must_use]
    pub fn may_spawn(&self) -> bool {
        self.depth < MAX_BOT_DEPTH
    }

    /// The rules the bot's children get: its own rules minus the sandbox
    /// API rule, so a child cannot call the platform as the owner.
    #[must_use]
    pub fn child_rules(&self) -> BTreeMap<String, pa_sandbox::HeaderRule> {
        self.network_rules
            .iter()
            .filter(|(host, _)| host.as_str() != super::credentials::sandbox_api_host())
            .map(|(host, rule)| (host.clone(), rule.clone()))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(secret: &str) -> pa_sandbox::HeaderRule {
        pa_sandbox::HeaderRule {
            headers: BTreeMap::from([("Authorization".to_string(), secret.to_string())]),
        }
    }

    fn context(depth: u32) -> NestedContext {
        NestedContext {
            bot_id: "bot-a".into(),
            owner_session_id: "owner-1".into(),
            depth,
            max_bots: 10,
            network_rules: BTreeMap::from([
                (
                    super::super::credentials::sandbox_api_host(),
                    rule("sandbox-api"),
                ),
                ("api.example.com".into(), rule("example")),
            ]),
        }
    }

    #[test]
    fn a_child_inherits_the_rules_but_not_the_sandbox_api_one() {
        let rules = context(1).child_rules();
        assert!(rules.contains_key("api.example.com"));
        assert!(!rules.contains_key(&super::super::credentials::sandbox_api_host()));
    }

    #[test]
    fn a_bot_at_the_depth_cap_may_not_spawn() {
        assert!(!context(MAX_BOT_DEPTH).may_spawn());
        assert!(context(MAX_BOT_DEPTH - 1).may_spawn());
    }

    #[test]
    fn a_context_round_trips_through_the_file() {
        let dir = tempfile::tempdir().unwrap();
        assert!(NestedContext::read(dir.path()).is_none());
        let path = NestedContext::path_in(dir.path());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, serde_json::to_string(&context(1)).unwrap()).unwrap();
        assert_eq!(NestedContext::read(dir.path()), Some(context(1)));
    }

    #[test]
    fn a_torn_file_reads_as_absent() {
        let dir = tempfile::tempdir().unwrap();
        let path = NestedContext::path_in(dir.path());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{ torn").unwrap();
        assert!(NestedContext::read(dir.path()).is_none());
    }
}
