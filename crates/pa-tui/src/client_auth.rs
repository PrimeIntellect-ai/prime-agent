//! Client-side MCP auth commands: the interactive surface behind
//! `/mcp login <name>` and `/mcp logout <name>` (the TS interactive
//! client's MCP login/logout branches, which run the OAuth flow in the
//! client process and persist through the shared auth store) plus the
//! `/mcp` view's api-key credential flow (`key <id>`, the view's stored
//! keys such as the web-search one). The TUI owns the command UX and the
//! inline auth panel; the composition root runs the flow against it
//! (pa-core owns the flow — this crate stays pa-types-only).

use std::pin::Pin;
use std::sync::Arc;

/// The boxed-future shape of [`ClientAuthCommands`] methods (the same
/// contract the pa-core login UI uses for dyn dispatch across crates).
pub type AuthFuture = Pin<Box<dyn std::future::Future<Output = anyhow::Result<String>> + Send>>;

/// `/mcp login` and `/mcp logout`, implemented by the composition root.
pub trait ClientAuthCommands: Send + Sync {
    /// Run one interactive MCP OAuth login against the inline auth panel
    /// (the flow's progress, URL block, and prompts render there).
    /// Resolves with the status line to show or the error to surface.
    fn login(&self, server: &str, panel: crate::auth_panel::AuthPanelHandle) -> AuthFuture;
    /// The inline paste panel's client surface: prompt for one pasted
    /// static token, store it bound to the service endpoint, and verify.
    /// Resolves with the status line to show.
    fn paste_token(&self, server: &str, panel: crate::auth_panel::AuthPanelHandle) -> AuthFuture;
    /// The api-key credential flow (the `/mcp` view's stored keys, e.g.
    /// the web-search one): prompt (masked) for one pasted key and store
    /// it in the credential's auth slot — the slot the runtime reads.
    /// Resolves with the status line to show.
    fn api_key(&self, credential: &str, panel: crate::auth_panel::AuthPanelHandle) -> AuthFuture;
    /// Remove a stored MCP credential. Resolves with the status line
    /// (TS: `<name> is not connected.` / `Disconnected <name>.`).
    fn logout(&self, server: &str) -> AuthFuture;
}

/// The handle the interactive options carry (a manual `Debug`: the hook
/// is opaque to the options printer).
#[derive(Clone)]
pub struct ClientAuthCommandsHandle(pub Arc<dyn ClientAuthCommands>);

impl std::fmt::Debug for ClientAuthCommandsHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ClientAuthCommandsHandle").finish()
    }
}

/// Run `/mcp login` / `/mcp key` / `/mcp logout` against the hook and
/// return the note line to show (status, surfaced error, or the TS usage
/// wording). Argument shapes and wording follow the TS interactive
/// client's `handleMcpCommand` login/logout branches. The login, paste,
/// and key flows drive the inline auth `panel` (the TUI mounts it before
/// spawning the flow).
pub async fn run_mcp_auth_command(
    auth: &dyn ClientAuthCommands,
    args: &str,
    panel: crate::auth_panel::AuthPanelHandle,
) -> String {
    let parts: Vec<&str> = args.split_whitespace().collect();
    let sub = parts.first().copied();
    let server = parts.get(1).copied();
    match (sub, server, parts.len() == 2) {
        (Some("login"), Some(server), true) => match auth.login(server, panel).await {
            Ok(status) => status,
            Err(error) => format!("{error:#}"),
        },
        (Some("paste"), Some(server), true) => match auth.paste_token(server, panel).await {
            Ok(status) => status,
            Err(error) => format!("{error:#}"),
        },
        (Some("key"), Some(credential), true) => match auth.api_key(credential, panel).await {
            Ok(status) => status,
            Err(error) => format!("{error:#}"),
        },
        (Some("logout"), Some(server), true) => match auth.logout(server).await {
            Ok(status) => status,
            Err(error) => format!("{error:#}"),
        },
        (Some("login"), _, false) | (Some("login"), None, true) => {
            "Usage: /mcp login <name> (e.g. /mcp login linear)".to_string()
        }
        (Some("paste"), _, false) | (Some("paste"), None, true) => {
            "Usage: /mcp paste <name> (a requires-setup token service)".to_string()
        }
        (Some("key"), _, false) | (Some("key"), None, true) => {
            "Usage: /mcp key <name> (an api-key credential)".to_string()
        }
        (Some("logout"), _, false) | (Some("logout"), None, true) => {
            "Usage: /mcp logout <name>".to_string()
        }
        _ => "Usage: /mcp login <name> | /mcp paste <name> | /mcp key <name> | /mcp logout <name>"
            .to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// A panel handle over a dead channel: the dispatch tests script the
    /// hook, so no request ever crosses the channel.
    fn panel() -> crate::auth_panel::AuthPanelHandle {
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        crate::auth_panel::AuthPanelHandle::new(tx)
    }

    /// A scripted hook recording the calls it served.
    struct ScriptedAuth {
        log: Arc<Mutex<Vec<(String, String)>>>,
    }

    impl ClientAuthCommands for ScriptedAuth {
        fn login(&self, server: &str, _panel: crate::auth_panel::AuthPanelHandle) -> AuthFuture {
            self.log
                .lock()
                .unwrap()
                .push(("login".to_string(), server.to_string()));
            let answer = format!("Connected {server}.");
            Box::pin(async move { Ok(answer) })
        }

        fn paste_token(
            &self,
            server: &str,
            _panel: crate::auth_panel::AuthPanelHandle,
        ) -> AuthFuture {
            self.log
                .lock()
                .unwrap()
                .push(("paste".to_string(), server.to_string()));
            let answer = format!("Connected {server}.");
            Box::pin(async move { Ok(answer) })
        }

        fn api_key(
            &self,
            credential: &str,
            _panel: crate::auth_panel::AuthPanelHandle,
        ) -> AuthFuture {
            self.log
                .lock()
                .unwrap()
                .push(("key".to_string(), credential.to_string()));
            let answer = format!("Saved API key for {credential}.");
            Box::pin(async move { Ok(answer) })
        }

        fn logout(&self, server: &str) -> AuthFuture {
            self.log
                .lock()
                .unwrap()
                .push(("logout".to_string(), server.to_string()));
            let answer = format!("Disconnected {server}.");
            Box::pin(async move { Ok(answer) })
        }
    }

    /// A hook that fails, to cover the error surfacing.
    struct FailingAuth;

    impl ClientAuthCommands for FailingAuth {
        fn login(&self, server: &str, _panel: crate::auth_panel::AuthPanelHandle) -> AuthFuture {
            let error = anyhow::anyhow!("Unknown MCP integration: {server}");
            Box::pin(async move { Err(error) })
        }

        fn paste_token(
            &self,
            server: &str,
            _panel: crate::auth_panel::AuthPanelHandle,
        ) -> AuthFuture {
            let error = anyhow::anyhow!("Unknown MCP integration: {server}");
            Box::pin(async move { Err(error) })
        }

        fn api_key(
            &self,
            credential: &str,
            _panel: crate::auth_panel::AuthPanelHandle,
        ) -> AuthFuture {
            let error = anyhow::anyhow!("Unknown api-key credential: {credential}");
            Box::pin(async move { Err(error) })
        }

        fn logout(&self, _server: &str) -> AuthFuture {
            Box::pin(async move { Err(anyhow::anyhow!("boom")) })
        }
    }

    #[tokio::test]
    async fn login_and_logout_dispatch_with_ts_wording() {
        let log = Arc::new(Mutex::new(Vec::new()));
        let auth = ScriptedAuth {
            log: Arc::clone(&log),
        };
        assert_eq!(
            run_mcp_auth_command(&auth, "login linear", panel()).await,
            "Connected linear."
        );
        assert_eq!(
            run_mcp_auth_command(&auth, "logout notion", panel()).await,
            "Disconnected notion."
        );
        assert_eq!(
            log.lock().unwrap().clone(),
            vec![
                ("login".to_string(), "linear".to_string()),
                ("logout".to_string(), "notion".to_string()),
            ]
        );
        // The api-key credential dispatch (the `/mcp` view's key rows).
        assert_eq!(
            run_mcp_auth_command(&auth, "key serper", panel()).await,
            "Saved API key for serper."
        );
        assert_eq!(
            run_mcp_auth_command(&auth, "key", panel()).await,
            "Usage: /mcp key <name> (an api-key credential)"
        );
        assert_eq!(
            run_mcp_auth_command(&auth, "key a b", panel()).await,
            "Usage: /mcp key <name> (an api-key credential)"
        );
        // TS usage wording: missing server, extra args, unknown subcommand.
        assert_eq!(
            run_mcp_auth_command(&auth, "login", panel()).await,
            "Usage: /mcp login <name> (e.g. /mcp login linear)"
        );
        assert_eq!(
            run_mcp_auth_command(&auth, "login a b", panel()).await,
            "Usage: /mcp login <name> (e.g. /mcp login linear)"
        );
        assert_eq!(
            run_mcp_auth_command(&auth, "logout", panel()).await,
            "Usage: /mcp logout <name>"
        );
        assert_eq!(
            run_mcp_auth_command(&auth, "", panel()).await,
            "Usage: /mcp login <name> | /mcp paste <name> | /mcp key <name> | /mcp logout <name>"
        );
        assert_eq!(
            run_mcp_auth_command(&auth, "add http://x", panel()).await,
            "Usage: /mcp login <name> | /mcp paste <name> | /mcp key <name> | /mcp logout <name>"
        );
        // Errors surface with their chain.
        assert_eq!(
            run_mcp_auth_command(&FailingAuth, "login nope", panel()).await,
            "Unknown MCP integration: nope"
        );
        assert_eq!(
            run_mcp_auth_command(&FailingAuth, "key nope", panel()).await,
            "Unknown api-key credential: nope"
        );
    }
}
