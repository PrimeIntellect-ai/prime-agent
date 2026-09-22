//! The composition root's `/traces` state (TS `getAgentTracesEnabled` /
//! `setAgentTracesEnabled` + `getPrimeAgentTraceCredential`): the settings
//! flag and the resolved credential label the TUI's trace-sharing command
//! surfaces. The upload subsystem itself (TS `core/agent-traces.ts`) is not
//! ported yet.

use std::path::PathBuf;

use pa_tui::traces::{TracesCommands, TracesFuture};

/// The trace-sharing state against one daemon's shared directories.
#[derive(Clone)]
pub struct ClientTraces {
    cwd: PathBuf,
    agent_dir: PathBuf,
}

impl ClientTraces {
    pub fn new(cwd: impl Into<PathBuf>, agent_dir: impl Into<PathBuf>) -> Self {
        ClientTraces {
            cwd: cwd.into(),
            agent_dir: agent_dir.into(),
        }
    }

    fn settings(&self) -> pa_core::settings::SettingsManager {
        pa_core::settings::SettingsManager::create(&self.cwd, &self.agent_dir)
    }

    /// TS `getPrimeAgentTraceCredential` precedence: the traces env key,
    /// the stored `prime-agent-traces` credential, the Prime env key, and
    /// the stored prime-inference credential.
    fn credential_inner(&self) -> Option<String> {
        if std::env::var("PRIME_AGENT_TRACES_API_KEY")
            .ok()
            .filter(|value| !value.is_empty())
            .is_some()
        {
            return Some("PRIME_AGENT_TRACES_API_KEY".to_string());
        }
        let mut auth = pa_core::auth::AuthStorage::create(&self.agent_dir);
        if auth
            .get_api_key("prime-agent-traces")
            .filter(|key| !key.is_empty())
            .is_some()
        {
            return Some("Prime Agent Traces credential".to_string());
        }
        if std::env::var("PRIME_API_KEY")
            .ok()
            .filter(|value| !value.is_empty())
            .is_some()
        {
            return Some("PRIME_API_KEY".to_string());
        }
        if auth
            .get_api_key("prime-inference")
            .filter(|key| !key.is_empty())
            .is_some()
        {
            return Some("Prime Inference credential".to_string());
        }
        None
    }
}

impl TracesCommands for ClientTraces {
    fn enabled(&self) -> TracesFuture<bool> {
        let settings = self.settings();
        Box::pin(async move { settings.get_agent_traces_enabled() })
    }

    fn set_enabled(&self, enabled: bool) -> TracesFuture<anyhow::Result<()>> {
        let provider = self.clone();
        // The settings write is file IO; keep it off the async workers.
        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                let mut settings = provider.settings();
                settings.set_agent_traces_enabled(enabled)
            })
            .await
            .expect("the settings write task ran")
        })
    }

    fn credential(&self) -> TracesFuture<Option<String>> {
        let provider = self.clone();
        // The auth store's credential resolution locks (and may refresh an
        // OAuth credential); keep it off the async workers.
        Box::pin(async move {
            tokio::task::spawn_blocking(move || provider.credential_inner())
                .await
                .expect("the credential task ran")
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_agent_dir() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().expect("temp dir");
        let agent = dir.path().join("agent");
        std::fs::create_dir_all(&agent).expect("agent dir");
        (dir, agent)
    }

    #[tokio::test]
    async fn the_setting_writes_and_reads_the_agent_traces_flag() {
        let (_dir, agent) = temp_agent_dir();
        let traces = ClientTraces::new("/tmp", agent.clone());
        assert!(!traces.enabled().await, "the default is off");
        traces
            .set_enabled(true)
            .await
            .expect("the enable write persists");
        // A fresh manager over the same directories reads the write (TS
        // reloads settings before reporting the flag).
        let traces = ClientTraces::new("/tmp", agent.clone());
        assert!(traces.enabled().await, "the flag persisted");
        let settings = std::fs::read_to_string(agent.join("settings.json")).expect("settings");
        assert!(
            settings.contains("\"agentTraces\""),
            "the settings file names the trace section: {settings}"
        );
    }

    #[tokio::test]
    async fn a_stored_traces_key_labels_the_credential() {
        let (_dir, agent) = temp_agent_dir();
        let mut auth = pa_core::auth::AuthStorage::create(&agent);
        auth.set(
            "prime-agent-traces",
            pa_core::auth::AuthCredential::ApiKey {
                key: "traces-key".to_string(),
                prime_team: None,
            },
        );
        assert_eq!(auth.drain_errors().pop(), None);
        let traces = ClientTraces::new("/tmp", agent);
        // The env keys of the dev box must not mask the stored-path check.
        std::env::remove_var("PRIME_AGENT_TRACES_API_KEY");
        std::env::remove_var("PRIME_API_KEY");
        assert_eq!(
            traces.credential().await.as_deref(),
            Some("Prime Agent Traces credential")
        );
    }

    #[tokio::test]
    async fn a_stored_prime_inference_credential_labels_the_fallback() {
        let (_dir, agent) = temp_agent_dir();
        let mut auth = pa_core::auth::AuthStorage::create(&agent);
        auth.set(
            "prime-inference",
            pa_core::auth::AuthCredential::ApiKey {
                key: "prime-key".to_string(),
                prime_team: None,
            },
        );
        assert_eq!(auth.drain_errors().pop(), None);
        let traces = ClientTraces::new("/tmp", agent);
        std::env::remove_var("PRIME_AGENT_TRACES_API_KEY");
        std::env::remove_var("PRIME_API_KEY");
        assert_eq!(
            traces.credential().await.as_deref(),
            Some("Prime Inference credential")
        );
    }
}
