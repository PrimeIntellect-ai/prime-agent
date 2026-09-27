//! The shared login-UI shapes of the subscription OAuth flows (TS
//! `packages/ai/src/utils/oauth/types.ts`: the callbacks interface one
//! login drives). The TUI renders the inline auth panel behind it and
//! tests script the answers; the flows themselves stay
//! surface-agnostic (TS `auth-flows.ts` mounts the login dialog).

use std::future::Future;
use std::pin::Pin;

/// One prompt a login asks (TS `OAuthPrompt`): the message, an optional
/// example placeholder, and whether an empty answer is a valid submit
/// (TS the Copilot domain prompt's `allowEmpty`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OAuthPrompt {
    pub message: String,
    pub placeholder: Option<String>,
    pub allow_empty: bool,
}

/// The interactive surface one login drives (TS
/// `OAuthLoginCallbacks`): the browser URL block, the prompts, the
/// progress lines, and the manual paste racing a local callback
/// server. `None` answers cancel (TS the dialog's abort signal; the
/// port's cooperative cancel answers the same way).
pub trait OAuthLoginUi: Send + Sync {
    /// TS `onAuth`: the authorization URL to open, plus the flow's
    /// instructions line.
    fn on_auth(&self, url: &str, instructions: Option<&str>);
    /// TS `onPrompt`: one prompt; `None` cancels the login.
    fn on_prompt(
        &self,
        prompt: &OAuthPrompt,
    ) -> Pin<Box<dyn Future<Output = Option<String>> + Send + '_>>;
    /// TS `onProgress` (fire-and-forget narration).
    fn on_progress(&self, message: &str);
    /// TS `onManualCodeInput`: the paste racing the browser callback;
    /// `None` when the surface offers none. Resolving `None` cancels
    /// the login.
    fn on_manual_code_input(
        &self,
    ) -> Option<Pin<Box<dyn Future<Output = Option<String>> + Send + '_>>>;
    /// The driving surface's cooperative cancel state (#2770): the
    /// pane that mounted the login marks it on exit and the flow
    /// checks it between its poll steps and before its network steps.
    /// The default (`false`) serves the surfaces that never cancel
    /// mid-flow.
    fn is_cancelled(&self) -> bool {
        false
    }
}
