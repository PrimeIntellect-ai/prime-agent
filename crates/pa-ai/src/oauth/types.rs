//! The shared login-UI shapes of the subscription OAuth flows. The
//! TUI renders the inline auth panel behind them, tests script the
//! answers; the flows stay surface-agnostic.

use std::future::Future;
use std::pin::Pin;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OAuthPrompt {
    pub message: String,
    pub placeholder: Option<String>,
    pub allow_empty: bool,
}

/// The interactive surface one login drives: the auth URL block, the prompts, the progress lines,
/// and the manual paste racing a local callback server. `None` answers cancel the login.
pub trait OAuthLoginUi: Send + Sync {
    fn on_auth(&self, url: &str, instructions: Option<&str>);
    /// One prompt; `None` cancels the login.
    fn on_prompt(
        &self,
        prompt: &OAuthPrompt,
    ) -> Pin<Box<dyn Future<Output = Option<String>> + Send + '_>>;
    /// Fire-and-forget narration.
    fn on_progress(&self, message: &str);
    /// The paste racing the browser callback; resolving `None` cancels
    /// the login.
    fn on_manual_code_input(
        &self,
    ) -> Option<Pin<Box<dyn Future<Output = Option<String>> + Send + '_>>>;
    /// `true` once the pane that mounted the login exited: the flow
    /// checks it between poll steps and before network steps.
    fn is_cancelled(&self) -> bool {
        false
    }
}
