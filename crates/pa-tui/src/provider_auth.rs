//! Provider auth management (`/login`, `/logout`): the TS providers
//! selector (`OAuthSelectorComponent` in its inline mode) plus the
//! command contract
//! the composition root implements (TS `ProviderAuthFlows`:
//! `getLoginProviderOptions` / `getLogoutProviderOptions` / the login
//! flows / `runLogout`). The TUI owns the panel, the search, and the
//! API-key prompt; credential storage and the OAuth flows live above this
//! crate.
//!
//! The menu rule: a row whose login flow this build does not carry is
//! marked inline BEFORE selection (dimmed, the "not available"
//! annotation) and Enter is inert — no row dead-ends in an
//! after-selection error wall.

use std::pin::Pin;

use crate::fuzzy::fuzzy_filter;
use crate::keybindings::KeybindingsManager;
use crate::menu_panel::{menu_row, search_field_lines};
use crate::search_input::SearchInput;
use crate::theme::{Theme, ThemeColor};
use crate::Line;

/// The credential type a provider row logs in with (TS `authType`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthType {
    Oauth,
    ApiKey,
}

impl AuthType {
    /// The row's auth label (TS `authLabel`).
    pub fn label(self) -> &'static str {
        match self {
            AuthType::Oauth => "subscription",
            AuthType::ApiKey => "api key",
        }
    }
}

/// How the login runs: the TUI prompts for the key in the panel, or the
/// composition root runs the provider's flow against the inline auth
/// panel (TS splits the same way: `showApiKeyLoginDialog` vs the
/// OAuth/Prime/Bedrock login dialogs).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthFlow {
    /// Prompt for the key in the panel (TS `showPrompt("Enter API key:")`).
    ApiKeyPrompt,
    /// Run the flow through the inline auth panel (browser OAuth, the
    /// Prime login, the MCP device flow).
    TerminalFlow,
}

/// The status indicator of one row (TS `formatStatusIndicator`: the label
/// plus its theme color).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthStatusIndicator {
    pub style: AuthStatusStyle,
    pub label: String,
}

/// The status label's color (TS `theme.fg` kinds).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthStatusStyle {
    Success,
    Warning,
    Muted,
}

/// One provider row (TS `AuthSelectorProvider` plus its rendered
/// status).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderRow {
    pub id: String,
    pub name: String,
    pub auth_type: AuthType,
    /// The row's status indicator; `None` hides the trailing meta (TS's
    /// unconfigured non-stale inline case).
    pub status: Option<AuthStatusIndicator>,
    /// The login flow the row runs.
    pub flow: AuthFlow,
    /// Whether a usable credential exists (TS
    /// `getProviderAuthStatus(id).configured`): the onboarding picker's
    /// connected check, distinct from the display indicator.
    pub configured: bool,
    /// Whether this build carries the row's login flow (the codex
    /// subscription row does; the not-yet-ported subscription providers
    /// do not). An unavailable row renders dimmed with the "not
    /// available" annotation and Enter is inert — the menu states the
    /// dead-end BEFORE selection instead of error-walling after it.
    pub available: bool,
}

/// The outcome of one login/logout flow: the status row to show, the
/// error row, or a silent cancel.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProviderAuthOutcome {
    Status(String),
    Error(String),
    /// The flow was cancelled (TS `AuthenticationResult`'s `cancelled`
    /// state): silent — no status row, no error row.
    Cancelled,
}

/// The boxed-future shape of the hook's methods.
pub type ProviderRowsFuture = Pin<Box<dyn std::future::Future<Output = Vec<ProviderRow>> + Send>>;
pub type ProviderAuthFuture =
    Pin<Box<dyn std::future::Future<Output = ProviderAuthOutcome> + Send>>;

/// `/login` + `/logout` provider auth, implemented by the composition
/// root (credential storage, OAuth flows, and the provider catalog stay
/// above this crate).
pub trait ProviderAuthCommands: Send + Sync {
    /// TS `getLoginProviderOptions`: the provider rows sorted TS-style
    /// (configured first, prime-inference first among them, oauth before
    /// api key, then by name).
    fn login_options(&self) -> ProviderRowsFuture;
    /// TS `getLogoutProviderOptions`: one row per stored credential,
    /// sorted by name.
    fn logout_options(&self) -> ProviderRowsFuture;
    /// TS `loginProvider`: store the key for `ApiKeyPrompt` rows. The
    /// unavailable rows never reach this (the menu marks them before
    /// selection); an OAuth row arriving here answers the silent
    /// cancel, never an error wall.
    fn login(&self, provider: &ProviderRow, api_key: Option<&str>) -> ProviderAuthFuture;
    /// TS `loginProvider` for the panel-driven flows (the MCP OAuth
    /// login, the Prime Inference login): the TUI mounts the inline auth
    /// panel ([`crate::auth_panel`]) and services the flow's requests
    /// while it runs in the background; the future settles the flow's
    /// outcome (the session sends it back through the panel channel).
    fn login_on_panel(
        &self,
        provider: &ProviderRow,
        panel: crate::auth_panel::AuthPanelHandle,
    ) -> ProviderAuthFuture;
    /// TS `runLogout`: remove the stored credential.
    fn logout(&self, provider: &ProviderRow) -> ProviderAuthFuture;
}

/// The handle the interactive options carry.
#[derive(Clone)]
pub struct ProviderAuthCommandsHandle(pub std::sync::Arc<dyn ProviderAuthCommands>);

impl std::fmt::Debug for ProviderAuthCommandsHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProviderAuthCommandsHandle").finish()
    }
}

/// The Prime Inference provider's id (pa-core's
/// `PRIME_INFERENCE_PROVIDER_ID`: the row the panel-driven login
/// serves).
pub const PRIME_INFERENCE_PROVIDER_ID: &str = "prime-inference";
/// The Prime Inference default model's id (pa-core's
/// `PRIME_INFERENCE_DEFAULT_MODEL_ID` = TS `PRIME_INFERENCE_DEFAULT_MODEL_ID`):
/// the model the onboarding flow applies after the sign-in when the home
/// has no current model.
pub const PRIME_INFERENCE_DEFAULT_MODEL_ID: &str = "z-ai/glm-5.3";

/// The Codex Subscription provider's id (the wire identifier pa-core's
/// auth exports; carried here too because the TUI does not link the
/// session engine).
pub const OPENAI_CODEX_PROVIDER_ID: &str = "openai-codex";

/// The other subscription providers' ids (the same wire identifiers,
/// carried the same way).
pub const ANTHROPIC_PROVIDER_ID: &str = "anthropic";
pub const GITHUB_COPILOT_PROVIDER_ID: &str = "github-copilot";
pub const XAI_PROVIDER_ID: &str = "xai";

/// The subscription rows whose logins run on the panel (TS
/// `loginProvider`'s oauth dispatch): every flow checks the
/// cooperative cancel flag (#2770).
pub const SUBSCRIPTION_PROVIDER_IDS: [&str; 4] = [
    ANTHROPIC_PROVIDER_ID,
    GITHUB_COPILOT_PROVIDER_ID,
    OPENAI_CODEX_PROVIDER_ID,
    XAI_PROVIDER_ID,
];
/// The TS list geometry (`PREFERRED_VISIBLE_PROVIDERS`).
const PREFERRED_VISIBLE_PROVIDERS: usize = 8;

/// The panel's search placeholder (TS `MenuSearchInput("Search
/// providers")`).
const SEARCH_PLACEHOLDER: &str = "Search providers";

/// The unavailable row's trailing annotation (the menu rule: a row
/// without a login flow in this build states it BEFORE selection).
const NOT_AVAILABLE_LABEL: &str = "not available";

/// One key press while the selector owns the frame.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthSelectorAction {
    /// Navigation or filter editing only.
    None,
    /// Esc, ctrl+c: close the selector.
    Cancel,
    /// Enter on a login row: run the provider's flow. `Some(key)` is the
    /// panel-prompted key; the panel-driven flows carry `None`.
    Login {
        provider: ProviderRow,
        api_key: Option<String>,
    },
    /// The prompted key was empty: the TS error row.
    LoginError { message: String },
    /// Enter on a logout row: remove the credential.
    Logout { provider: ProviderRow },
}

enum Mode {
    List,
    /// The API-key prompt (TS `LoginDialogComponent.showPrompt`).
    Prompt {
        provider: ProviderRow,
        input: SearchInput,
    },
}

/// Which command the selector serves.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthSelectorKind {
    /// `/login`: the provider catalog.
    Login,
    /// `/logout`: the stored credentials.
    Logout,
}

/// The providers selector (`/login` and `/logout` panels).
pub struct ProviderAuthSelector {
    kind: AuthSelectorKind,
    mode: Mode,
    providers: Vec<ProviderRow>,
    filtered: Vec<usize>,
    selected: usize,
    search: SearchInput,
    visible: usize,
    /// The resolved keybindings the prompt frame's actions row renders
    /// (TS reads `getKeybindings()` live; the view syncs its manager at
    /// render).
    keybindings: KeybindingsManager,
}

impl ProviderAuthSelector {
    /// Build the selector over the hook's rows. Login rows default to the
    /// Provider tab; the empty list still opens (TS renders the empty
    /// message in the panel).
    pub fn new(kind: AuthSelectorKind, providers: Vec<ProviderRow>) -> Self {
        let mut selector = ProviderAuthSelector {
            kind,
            mode: Mode::List,
            providers,
            filtered: Vec::new(),
            selected: 0,
            search: SearchInput::new(),
            visible: PREFERRED_VISIBLE_PROVIDERS,
            keybindings: KeybindingsManager::new(),
        };
        selector.refilter();
        selector
    }

    /// Sync the keybinding labels the prompt frame's actions row renders
    /// (the view's render carries its resolved manager).
    pub fn set_keybindings(&mut self, keybindings: KeybindingsManager) {
        self.keybindings = keybindings;
    }

    /// Preselect a provider's row (the model-picker sign-in route mounts
    /// the selector on the row the picked model needs; TS
    /// `ensureModelProviderConfigured` runs the same provider's flow).
    /// A provider without a row keeps the top selection.
    pub fn preselect_provider(&mut self, provider_id: &str) {
        if let Some(position) = self
            .filtered
            .iter()
            .position(|index| self.providers[*index].id == provider_id)
        {
            self.selected = position;
        }
    }

    /// The panel title (TS `OAuthSelectorOptions.title`; the API-key
    /// prompt is TS `showApiKeyLoginDialog`'s `Login to {provider}`).
    fn title(&self) -> String {
        match &self.mode {
            Mode::Prompt { provider, .. } => format!("Login to {}", provider.name),
            Mode::List if self.is_logout() => "Saved Credentials".to_string(),
            Mode::List => "Providers".to_string(),
        }
    }

    /// The panel subtitle (TS `MenuPanel` subtitle).
    fn subtitle(&self) -> String {
        if self.is_logout() && matches!(self.mode, Mode::List) {
            return "Choose a credential to remove.".to_string();
        }
        String::new()
    }

    fn refilter(&mut self) {
        let query = self.search.value().to_string();
        let rows: Vec<usize> = self
            .providers
            .iter()
            .enumerate()
            .map(|(index, _)| index)
            .collect();
        self.filtered = if query.is_empty() {
            rows
        } else {
            fuzzy_filter(&rows, &query, |index| {
                let provider = &self.providers[*index];
                format!(
                    "{} {} {}",
                    provider.name,
                    provider.id,
                    provider.auth_type.label()
                )
            })
        };
        self.selected = 0;
    }

    fn selected_row(&self) -> Option<ProviderRow> {
        self.filtered
            .get(self.selected)
            .map(|index| self.providers[*index].clone())
    }

    /// One key id (TS `handleInput`).
    pub fn handle_key(&mut self, key: &str, kb: &KeybindingsManager) -> AuthSelectorAction {
        if key == "ctrl+c" {
            return AuthSelectorAction::Cancel;
        }
        match &mut self.mode {
            Mode::Prompt { provider, input } => {
                if kb.matches(key, "tui.select.cancel") {
                    self.mode = Mode::List;
                    return AuthSelectorAction::None;
                }
                if kb.matches(key, "tui.select.confirm") {
                    let key_text = input.value().trim().to_string();
                    let provider = provider.clone();
                    if key_text.is_empty() {
                        return AuthSelectorAction::LoginError {
                            message: format!(
                                "Failed to save API key for {}: API key cannot be empty.",
                                provider.name
                            ),
                        };
                    }
                    self.mode = Mode::List;
                    return AuthSelectorAction::Login {
                        provider,
                        api_key: Some(key_text),
                    };
                }
                input.handle_key(key, kb);
                AuthSelectorAction::None
            }
            Mode::List => {
                if kb.matches(key, "tui.select.cancel") {
                    return AuthSelectorAction::Cancel;
                }
                if kb.matches(key, "tui.select.up") {
                    let count = self.filtered.len();
                    if count > 0 {
                        self.selected = if self.selected == 0 {
                            count - 1
                        } else {
                            self.selected - 1
                        };
                    }
                    return AuthSelectorAction::None;
                }
                if kb.matches(key, "tui.select.down") {
                    let count = self.filtered.len();
                    if count > 0 {
                        self.selected = (self.selected + 1) % count;
                    }
                    return AuthSelectorAction::None;
                }
                if kb.matches(key, "tui.select.pageUp") || kb.matches(key, "tui.select.pageDown") {
                    let direction = if kb.matches(key, "tui.select.pageUp") {
                        -(self.visible as isize)
                    } else {
                        self.visible as isize
                    };
                    if !self.filtered.is_empty() {
                        let target = self.selected as isize + direction;
                        self.selected = target.clamp(0, self.filtered.len() as isize - 1) as usize;
                    }
                    return AuthSelectorAction::None;
                }
                if kb.matches(key, "tui.select.confirm") {
                    return match self.selected_row() {
                        Some(provider) => {
                            if self.is_logout() {
                                AuthSelectorAction::Logout { provider }
                            } else {
                                match provider.flow {
                                    AuthFlow::ApiKeyPrompt => {
                                        self.mode = Mode::Prompt {
                                            provider,
                                            input: SearchInput::new(),
                                        };
                                        AuthSelectorAction::None
                                    }
                                    // The menu rule: an unavailable row
                                    // shows its dead-end state inline and
                                    // Enter never starts a flow that
                                    // would error-wall after selection.
                                    AuthFlow::TerminalFlow if !provider.available => {
                                        AuthSelectorAction::None
                                    }
                                    AuthFlow::TerminalFlow => AuthSelectorAction::Login {
                                        provider,
                                        api_key: None,
                                    },
                                }
                            }
                        }
                        None => AuthSelectorAction::None,
                    };
                }
                // Everything else edits the search field.
                let previous = self.search.value().to_string();
                self.search.handle_key(key, kb);
                if self.search.value() != previous {
                    self.refilter();
                }
                AuthSelectorAction::None
            }
        }
    }

    /// Whether the selector serves `/logout`.
    fn is_logout(&self) -> bool {
        self.kind == AuthSelectorKind::Logout
    }

    /// The panel's rendered rows.
    pub fn render(&mut self, theme: &Theme, width: usize) -> Vec<Line> {
        let mut lines: Vec<Line> = Vec::new();
        // The logout selector and the API-key prompt keep their framed
        // header (the rule, the title, the subtitle); the login menu
        // matches the /model and /mcp pickers (the operator's
        // 2026-09-25 directive): the search bar is the frame's first
        // row — no header block, no leading blank.
        let framed = self.is_logout() || !matches!(self.mode, Mode::List);
        if framed {
            // TS `MenuPanel` inline chrome: the borderMuted rule and the
            // muted one-space title (no leading blank — the content's own
            // `startContent` blank opens the body).
            lines.push(vec![
                theme.fg_span(ThemeColor::BorderMuted, "─".repeat(width.max(1)))
            ]);
            lines.push(vec![
                theme.fg_span(ThemeColor::Muted, format!(" {}", self.title()))
            ]);
            if !self.subtitle().is_empty() {
                lines.push(vec![
                    theme.fg_span(ThemeColor::Muted, format!(" {}", self.subtitle()))
                ]);
            }
        }
        match &self.mode {
            // TS `showApiKeyLoginDialog` -> `showPrompt("Enter API key:")`:
            // the section-title prompt, the plain `> ` field, the blank
            // between field and actions, and the auth-actions row last —
            // no bottom rule.
            Mode::Prompt { input, .. } => {
                lines.push(Vec::new());
                lines.push(vec![
                    crate::Span::raw(" ".to_string()),
                    theme.fg_span(ThemeColor::Text, "Enter API key:".to_string()),
                ]);
                lines.push(crate::menu_panel::login_field_row(
                    theme,
                    width,
                    input.value(),
                    input.cursor(),
                    true,
                    crate::auth_panel::PASTE_PLACEHOLDER,
                ));
                lines.push(Vec::new());
                lines.push(crate::auth_panel::auth_actions_row(
                    theme,
                    width,
                    &self.keybindings,
                    true,
                    None,
                ));
                return lines;
            }
            Mode::List => {}
        }
        let mut search = search_field_lines(
            theme,
            width,
            self.search.value(),
            self.search.cursor(),
            false,
            SEARCH_PLACEHOLDER,
        );
        lines.append(&mut search);
        // The list window, centered on the selection (TS `updateList`).
        let count = self.filtered.len();
        let visible = self.visible.min(count.max(1));
        let start = if count > visible {
            self.selected
                .saturating_sub(visible / 2)
                .min(count - visible)
        } else {
            0
        };
        let end = (start + visible).min(count);
        for index in start..end {
            let Some(provider) = self.filtered.get(index).map(|i| &self.providers[*i]) else {
                continue;
            };
            let selected = index == self.selected;
            // An unavailable row renders dimmed (the menu rule: the
            // missing flow is stated inline, not answered after
            // selection).
            let label = format!("{} · {}", provider.name, provider.auth_type.label());
            let primary = if provider.available {
                vec![crate::Span::raw(label)]
            } else {
                vec![theme.fg_span(ThemeColor::Muted, label)]
            };
            let mut trailing: Vec<String> = provider
                .status
                .as_ref()
                .map(|status| vec![status.label.clone()])
                .unwrap_or_default();
            if !provider.available {
                trailing.push(NOT_AVAILABLE_LABEL.to_string());
            }
            let trailing_refs: Vec<crate::menu_panel::MenuSegment> = trailing
                .iter()
                .map(|segment| crate::menu_panel::MenuSegment::muted(segment))
                .collect();
            let row = menu_row(theme, width, primary, &trailing_refs, selected);
            lines.push(row);
        }
        if start > 0 || end < count {
            lines.push(vec![theme.fg_span(
                ThemeColor::Muted,
                format!("  ({}/{})", self.selected + 1, count),
            )]);
        }
        if count == 0 {
            let message = if self.providers.is_empty() {
                if self.is_logout() {
                    "No providers logged in. Use /login first."
                } else {
                    "No providers available"
                }
            } else {
                "No matching providers"
            };
            lines.push(vec![theme.fg_span(ThemeColor::Muted, message.to_string())]);
        }
        // The selected row's status detail (TS's inline detail row).
        if count > 0 {
            if let Some(provider) = self.selected_row() {
                if let Some(status) = provider.status {
                    lines.push(Vec::new());
                    lines.push(vec![
                        theme.fg_span(ThemeColor::Muted, format!(" {}", status.label))
                    ]);
                }
            }
        }
        lines.push(vec![theme.fg_span(
            ThemeColor::Muted,
            "  ↑↓ navigate  enter select  escape cancel".to_string(),
        )]);
        if framed {
            lines.push(vec![
                theme.fg_span(ThemeColor::Border, "─".repeat(width.max(1)))
            ]);
        } else {
            // One blank line of spacing below the shortcuts (the pickers'
            // grammar): the hint is the frame's last content row, never
            // a rule.
            lines.push(Vec::new());
        }
        lines
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kb() -> KeybindingsManager {
        KeybindingsManager::new()
    }

    fn theme() -> Theme {
        crate::theme::Theme::builtin("prime", crate::theme::ColorMode::TrueColor)
    }

    fn anthropic() -> ProviderRow {
        ProviderRow {
            id: "anthropic".to_string(),
            name: "Anthropic".to_string(),
            auth_type: AuthType::Oauth,
            status: None,
            flow: AuthFlow::TerminalFlow,
            configured: false,
            available: false,
        }
    }

    /// The ported codex subscription row: available, driven through the
    /// panel.
    fn codex() -> ProviderRow {
        ProviderRow {
            id: "openai-codex".to_string(),
            name: "ChatGPT Plus/Pro (Codex Subscription)".to_string(),
            auth_type: AuthType::Oauth,
            status: None,
            flow: AuthFlow::TerminalFlow,
            configured: false,
            available: true,
        }
    }

    fn openai() -> ProviderRow {
        ProviderRow {
            id: "openai".to_string(),
            name: "OpenAI".to_string(),
            auth_type: AuthType::ApiKey,
            status: Some(AuthStatusIndicator {
                style: AuthStatusStyle::Success,
                label: "configured".to_string(),
            }),
            flow: AuthFlow::ApiKeyPrompt,
            configured: true,
            available: true,
        }
    }

    fn linear() -> ProviderRow {
        ProviderRow {
            id: "mcp:linear".to_string(),
            name: "Linear".to_string(),
            auth_type: AuthType::Oauth,
            status: None,
            flow: AuthFlow::TerminalFlow,
            configured: false,
            available: true,
        }
    }

    /// Left and right over the filter: inert over an empty query (there
    /// is nothing to move the caret across), and caret-moving edits with
    /// text in it. The row set never changes on either press.
    #[test]
    fn left_and_right_always_edit_the_search() {
        let mut selector =
            ProviderAuthSelector::new(AuthSelectorKind::Login, vec![anthropic(), linear()]);
        // An empty query: both presses keep it empty and keep every row
        // in the one list.
        assert_eq!(selector.search.value(), "");
        selector.handle_key("right", &kb());
        selector.handle_key("left", &kb());
        assert_eq!(selector.search.value(), "", "the empty filter stays empty");
        assert_eq!(
            selector.filtered.len(),
            2,
            "every row stays in the one list"
        );
        // With text: the keys move the filter caret.
        selector.handle_key("l", &kb());
        selector.handle_key("right", &kb());
        assert_eq!(selector.search.value(), "l");
    }

    #[test]
    fn enter_on_an_api_key_row_opens_the_prompt() {
        let mut selector =
            ProviderAuthSelector::new(AuthSelectorKind::Login, vec![openai(), anthropic()]);
        assert_eq!(
            selector.handle_key("enter", &kb()),
            AuthSelectorAction::None
        );
        // The prompt is open: typing edits the key, enter submits it.
        selector.handle_key("k", &kb());
        selector.handle_key("e", &kb());
        selector.handle_key("y", &kb());
        match selector.handle_key("enter", &kb()) {
            AuthSelectorAction::Login { api_key, provider } => {
                assert_eq!(api_key.as_deref(), Some("key"));
                assert_eq!(provider.id, "openai");
            }
            other => panic!("expected a login submit, got {other:?}"),
        }
    }

    #[test]
    fn an_empty_prompted_key_answers_the_ts_error() {
        let mut selector = ProviderAuthSelector::new(AuthSelectorKind::Login, vec![openai()]);
        selector.handle_key("enter", &kb());
        assert_eq!(
            selector.handle_key("enter", &kb()),
            AuthSelectorAction::LoginError {
                message: "Failed to save API key for OpenAI: API key cannot be empty.".to_string()
            }
        );
    }

    #[test]
    fn enter_on_a_terminal_flow_row_hands_the_flow_over() {
        let mut selector = ProviderAuthSelector::new(AuthSelectorKind::Login, vec![linear()]);
        assert_eq!(
            selector.handle_key("enter", &kb()),
            AuthSelectorAction::Login {
                provider: linear(),
                api_key: None,
            }
        );
    }

    /// The menu rule: an unavailable row never starts a flow (no
    /// after-selection error wall).
    #[test]
    fn enter_on_an_unavailable_row_is_inert() {
        let mut selector = ProviderAuthSelector::new(AuthSelectorKind::Login, vec![anthropic()]);
        assert_eq!(
            selector.handle_key("enter", &kb()),
            AuthSelectorAction::None
        );
        assert_eq!(
            selector.handle_key("ctrl+c", &kb()),
            AuthSelectorAction::Cancel,
            "the cancel keys still close the selector"
        );
    }

    /// The menu rule's render: an unavailable row is dimmed and carries
    /// the "not available" annotation; a signed-in row keeps the TS row
    /// shape with its configured status.
    #[test]
    fn the_panel_marks_unavailable_rows_before_selection() {
        let codex_signed_in = ProviderRow {
            status: Some(AuthStatusIndicator {
                style: AuthStatusStyle::Success,
                label: "configured".to_string(),
            }),
            ..codex()
        };
        let mut selector =
            ProviderAuthSelector::new(AuthSelectorKind::Login, vec![codex_signed_in, anthropic()]);
        let rows = selector.render(&theme(), 80);
        let plain = |line: &crate::Line| {
            line.iter()
                .map(|span| span.content.clone())
                .collect::<String>()
        };
        let text: Vec<String> = rows.iter().map(plain).collect();
        // The signed-in row: the TS row shape with its configured status.
        assert!(text.iter().any(|row| {
            row.contains("ChatGPT Plus/Pro (Codex Subscription) · subscription")
                && row.contains("configured")
                && !row.contains("not available")
        }));
        // The unavailable row: the dimmed primary (a themed span, not a
        // raw one) plus the annotation.
        let unavailable_row = rows
            .iter()
            .find(|line| plain(line).contains("Anthropic · subscription"))
            .expect("the unavailable row renders");
        assert!(
            plain(unavailable_row).contains("not available"),
            "the annotation rides the trailing cluster: {:?}",
            plain(unavailable_row)
        );
        let name_span = unavailable_row
            .iter()
            .find(|span| span.content.contains("Anthropic"))
            .expect("the unavailable primary carries the name");
        assert!(
            name_span.style.fg.is_some(),
            "the unavailable primary is dimmed (themed), not raw"
        );
        // The available row's primary stays raw (no dimming).
        let available_row = rows
            .iter()
            .find(|line| {
                plain(line).contains("ChatGPT Plus/Pro (Codex Subscription) · subscription")
            })
            .expect("the signed-in row renders");
        let name_span = available_row
            .iter()
            .find(|span| span.content.contains("Codex Subscription"))
            .expect("the available primary carries the name");
        assert!(
            name_span.style.fg.is_none(),
            "the available primary is not dimmed"
        );
    }

    #[test]
    fn the_search_filters_over_name_id_and_type() {
        let mut selector =
            ProviderAuthSelector::new(AuthSelectorKind::Login, vec![openai(), anthropic()]);
        for ch in "linear".chars() {
            selector.handle_key(ch.to_string().as_str(), &kb());
        }
        assert!(selector.filtered.is_empty(), "no provider matches");
        // Clear the query and filter on a real provider's id.
        for _ in 0.."linear".len() {
            selector.handle_key("backspace", &kb());
        }
        for ch in "openai".chars() {
            selector.handle_key(ch.to_string().as_str(), &kb());
        }
        assert_eq!(selector.filtered.len(), 1);
        assert_eq!(
            selector.handle_key("enter", &kb()),
            AuthSelectorAction::None,
            "the prompt opens on the api-key row"
        );
    }

    #[test]
    fn the_panel_renders_the_ts_chrome() {
        // The login menu matches the /model and /mcp pickers (the
        // operator's 2026-09-25 directive): the frame opens with the
        // search field itself (its top rule, the placeholder row, its
        // bottom rule) — no header block, no leading blank — the rows
        // follow, and the hint is the last content row with one blank
        // under it.
        let mut selector =
            ProviderAuthSelector::new(AuthSelectorKind::Login, vec![openai(), linear()]);
        selector.render(&theme(), 80);
        let rows = selector.render(&theme(), 80);
        let text = rows
            .iter()
            .map(|line| {
                line.iter()
                    .map(|span| span.content.clone())
                    .collect::<String>()
            })
            .collect::<Vec<_>>();
        assert!(
            text[0].starts_with('─'),
            "the search field's top rule opens the frame: {text:?}"
        );
        assert!(
            text[1].contains("Search providers"),
            "the placeholder row rides directly under the top rule: {text:?}"
        );
        assert!(
            text[2].starts_with('─'),
            "the search field's bottom rule follows: {text:?}"
        );
        assert!(
            !text.iter().any(|row| row.trim() == "Providers"),
            "no title row rides the login menu: {text:?}"
        );
        assert!(!text
            .iter()
            .any(|row| row.contains("Connect with a subscription or API key.")));
        assert!(!text.iter().any(|row| row.contains("MCP Connections")));
        assert!(text.iter().any(|row| row.contains("OpenAI · api key")));
        assert!(
            !text.iter().any(|row| row.contains("tabs")),
            "no tab hint rides the panel: {text:?}"
        );
        assert_eq!(rows.last(), Some(&Vec::new()), "one blank under the hint");
        let hint_index = text
            .iter()
            .position(|row| row.contains("↑↓ navigate"))
            .expect("the hint row");
        assert_eq!(
            hint_index,
            text.len() - 2,
            "the hint is the last content row: {text:?}"
        );
    }

    #[test]
    fn the_logout_selector_renders_the_ts_chrome() {
        let mut selector = ProviderAuthSelector::new(AuthSelectorKind::Logout, vec![openai()]);
        let rows = selector.render(&theme(), 80);
        let text = rows
            .iter()
            .map(|line| {
                line.iter()
                    .map(|span| span.content.clone())
                    .collect::<String>()
            })
            .collect::<Vec<_>>();
        assert!(text.iter().any(|row| row.contains("Saved Credentials")));
        assert!(text
            .iter()
            .any(|row| row.contains("Choose a credential to remove.")));
        // Enter on a logout row removes the credential.
        assert_eq!(
            selector.handle_key("enter", &kb()),
            AuthSelectorAction::Logout { provider: openai() }
        );
    }

    /// TS `showApiKeyLoginDialog`'s prompt frame (the operator addendum:
    /// the /login API-key prompt aligns with the TS login dialog): the
    /// borderMuted rule, the muted `Login to {provider}` title, the
    /// `startContent` blank, the text-coloured `Enter API key:` section
    /// title, the plain `> ` field, the blank between field and actions,
    /// and the auth-actions row last — no bottom rule, no "Sign In"
    /// header, no combined prompt-and-value row.
    #[test]
    fn the_api_key_prompt_renders_the_ts_login_dialog_frame() {
        let mut selector = ProviderAuthSelector::new(AuthSelectorKind::Login, vec![openai()]);
        selector.handle_key("enter", &kb());
        let rows = selector.render(&theme(), 80);
        let text = rows
            .iter()
            .map(|line| {
                line.iter()
                    .map(|span| span.content.clone())
                    .collect::<String>()
            })
            .collect::<Vec<_>>();
        assert!(
            text[0].chars().all(|c| c == '\u{2500}'),
            "the borderMuted rule opens the prompt: {text:?}"
        );
        assert_eq!(text[1], " Login to OpenAI", "the muted one-space title");
        assert_eq!(text[2], "", "the startContent blank");
        assert_eq!(
            text[3], " Enter API key:",
            "the text-coloured section title"
        );
        assert!(
            text[4].starts_with(" > "),
            "the plain `> ` field rides its own row: {text:?}"
        );
        assert!(text[4].contains("Paste value"));
        assert_eq!(text[5], "", "the blank between the field and the actions");
        assert_eq!(
            text[6], " Enter submit  Alt+C copy  Esc/Ctrl+C cancel",
            "the TS auth-actions row: {text:?}"
        );
        assert_eq!(text.len(), 7, "no bottom rule rides the prompt: {text:?}");
        assert!(
            !text.iter().any(|row| row.contains("Sign In")),
            "no raw Sign In title: {text:?}"
        );
    }

    #[test]
    fn the_empty_login_list_renders_the_ts_empty_message() {
        let mut selector = ProviderAuthSelector::new(AuthSelectorKind::Login, Vec::new());
        let rows = selector.render(&theme(), 80);
        let text = rows
            .iter()
            .map(|line| {
                line.iter()
                    .map(|span| span.content.clone())
                    .collect::<String>()
            })
            .collect::<Vec<_>>();
        assert!(text
            .iter()
            .any(|row| row.contains("No providers available")));
    }
}
