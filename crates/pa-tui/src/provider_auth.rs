//! Provider auth management (`/login`, `/logout`): the providers selector and the command contract
//! the composition root implements; credential storage and the OAuth flows live above this crate.
//! Menu rule: a row whose login flow this build does not carry is marked inline BEFORE selection
//! (dimmed, the "not available" annotation) and Enter is inert — no row dead-ends in an
//! after-selection error wall.

use std::pin::Pin;

use crate::fuzzy::fuzzy_filter;
use crate::keybindings::KeybindingsManager;
use crate::menu_panel::{key_hint, menu_row, search_field_lines};
use crate::search_input::SearchInput;
use crate::theme::{Theme, ThemeColor};
use crate::Line;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthType {
    Oauth,
    ApiKey,
}

impl AuthType {
    #[must_use]
    pub fn label(self) -> &'static str {
        match self {
            AuthType::Oauth => "subscription",
            AuthType::ApiKey => "api key",
        }
    }
}

/// How the login runs: the TUI prompts for the key in the panel, or the
/// composition root runs the provider's flow against the inline auth panel.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthFlow {
    ApiKeyPrompt,
    /// Run the flow through the inline auth panel (browser OAuth, the
    /// Prime login, the MCP device flow).
    TerminalFlow,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthStatusIndicator {
    pub style: AuthStatusStyle,
    pub label: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthStatusStyle {
    Success,
    Warning,
    Muted,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderRow {
    pub id: String,
    pub name: String,
    pub auth_type: AuthType,
    /// The row's status indicator; `None` hides the trailing meta.
    pub status: Option<AuthStatusIndicator>,
    pub flow: AuthFlow,
    /// Whether a usable credential exists: the onboarding picker's connected check, distinct from
    /// the display indicator.
    pub configured: bool,
    /// Whether this build carries the row's login flow (the menu rule:
    /// unavailable rows are dimmed and Enter is inert).
    pub available: bool,
}

/// The outcome of one login/logout flow: the status row to show, the error row, or a silent cancel.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProviderAuthOutcome {
    Status(String),
    Error(String),
    /// The flow was cancelled: silent — no status row, no error row.
    Cancelled,
}

pub type ProviderRowsFuture = Pin<Box<dyn std::future::Future<Output = Vec<ProviderRow>> + Send>>;
pub type ProviderAuthFuture =
    Pin<Box<dyn std::future::Future<Output = ProviderAuthOutcome> + Send>>;

/// `/login` + `/logout` provider auth, implemented by the composition root
/// (credential storage, OAuth flows, and the provider catalog stay above this crate).
pub trait ProviderAuthCommands: Send + Sync {
    /// The login provider rows sorted TS-style (configured first,
    /// prime-inference first among them, oauth before api key, then by name).
    fn login_options(&self) -> ProviderRowsFuture;
    /// One row per stored credential, sorted by name.
    fn logout_options(&self) -> ProviderRowsFuture;
    /// Store the key for `ApiKeyPrompt` rows; an OAuth row arriving here
    /// answers the silent cancel, never an error wall (unavailable rows never reach this).
    fn login(&self, provider: &ProviderRow, api_key: Option<&str>) -> ProviderAuthFuture;
    /// The panel-driven flows (the MCP OAuth login, the Prime Inference login): the TUI mounts the
    /// inline auth panel ([`crate::auth_panel`]) and services the flow's requests.
    fn login_on_panel(
        &self,
        provider: &ProviderRow,
        panel: crate::auth_panel::AuthPanelHandle,
    ) -> ProviderAuthFuture;
    fn logout(&self, provider: &ProviderRow) -> ProviderAuthFuture;
    /// The subscription-auth warning text when the stored Anthropic credential is an OAuth login or
    /// the resolved key is a subscription token (`sk-ant-oat...`); `None` when it is not.
    fn anthropic_subscription_warning(&self) -> ProviderWarningFuture;
}

pub type ProviderWarningFuture =
    Pin<Box<dyn std::future::Future<Output = Option<&'static str>> + Send>>;

#[derive(Clone)]
pub struct ProviderAuthCommandsHandle(pub std::sync::Arc<dyn ProviderAuthCommands>);

impl std::fmt::Debug for ProviderAuthCommandsHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProviderAuthCommandsHandle").finish()
    }
}

/// The Prime Inference provider's id (pa-core's `PRIME_INFERENCE_PROVIDER_ID`).
pub const PRIME_INFERENCE_PROVIDER_ID: &str = "prime-inference";
/// The Prime Inference default model's id: the model the onboarding flow
/// applies after the sign-in when the home has no current model.
pub const PRIME_INFERENCE_DEFAULT_MODEL_ID: &str = "z-ai/glm-5.3";

/// The Codex Subscription provider's id (the wire identifier pa-core's
/// auth exports; carried here because the TUI does not link the session engine).
pub const OPENAI_CODEX_PROVIDER_ID: &str = "openai-codex";

/// The other subscription providers' ids (the same wire identifiers, carried the same way).
pub const ANTHROPIC_PROVIDER_ID: &str = "anthropic";
pub const GITHUB_COPILOT_PROVIDER_ID: &str = "github-copilot";
pub const XAI_PROVIDER_ID: &str = "xai";

/// The subscription rows whose logins run on the panel; every flow checks the cooperative cancel
/// flag.
pub const SUBSCRIPTION_PROVIDER_IDS: [&str; 4] = [
    ANTHROPIC_PROVIDER_ID,
    GITHUB_COPILOT_PROVIDER_ID,
    OPENAI_CODEX_PROVIDER_ID,
    XAI_PROVIDER_ID,
];
const PREFERRED_VISIBLE_PROVIDERS: usize = 8;

const SEARCH_PLACEHOLDER: &str = "Search providers";

/// The unavailable row's trailing annotation (the menu rule).
const NOT_AVAILABLE_LABEL: &str = "not available";

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
    Prompt {
        provider: ProviderRow,
        input: SearchInput,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthSelectorKind {
    Login,
    Logout,
}

pub struct ProviderAuthSelector {
    kind: AuthSelectorKind,
    mode: Mode,
    providers: Vec<ProviderRow>,
    filtered: Vec<usize>,
    selected: usize,
    search: SearchInput,
    visible: usize,
}

impl ProviderAuthSelector {
    /// Build the selector over the hook's rows; the empty list still opens
    /// (the panel renders the empty message).
    #[must_use]
    pub fn new(kind: AuthSelectorKind, providers: Vec<ProviderRow>) -> Self {
        let mut selector = ProviderAuthSelector {
            kind,
            mode: Mode::List,
            providers,
            filtered: Vec::new(),
            selected: 0,
            search: SearchInput::new(),
            visible: PREFERRED_VISIBLE_PROVIDERS,
        };
        selector.refilter();
        selector
    }

    /// Preselect a provider's row (the model-picker sign-in route mounts the selector on the row
    /// the picked model needs); a provider without a row keeps the top selection.
    pub fn preselect_provider(&mut self, provider_id: &str) {
        if let Some(position) = self
            .filtered
            .iter()
            .position(|index| self.providers[*index].id == provider_id)
        {
            self.selected = position;
        }
    }

    /// The panel title (the API-key prompt uses `Login to {provider}`).
    fn title(&self) -> String {
        match &self.mode {
            Mode::Prompt { provider, .. } => format!("Login to {}", provider.name),
            Mode::List if self.is_logout() => "Saved Credentials".to_string(),
            Mode::List => "Providers".to_string(),
        }
    }

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

    /// One bracketed paste (TS routes the raw data to the open input):
    /// the API-key prompt takes it, the provider search filters with it.
    pub fn paste(&mut self, text: &str) {
        match &mut self.mode {
            Mode::Prompt { input, .. } => input.paste(text),
            Mode::List => {
                let previous = self.search.value().to_string();
                self.search.paste(text);
                if self.search.value() != previous {
                    self.refilter();
                }
            }
        }
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
                                    // The menu rule: an unavailable row never starts a flow.
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
                let previous = self.search.value().to_string();
                self.search.handle_key(key, kb);
                if self.search.value() != previous {
                    self.refilter();
                }
                AuthSelectorAction::None
            }
        }
    }

    fn is_logout(&self) -> bool {
        self.kind == AuthSelectorKind::Logout
    }

    /// The panel's rendered rows. The hint rows render the effective bindings,
    /// so a user `keybindings.json` override moves the hint with the handler.
    pub fn render(&mut self, theme: &Theme, width: usize, kb: &KeybindingsManager) -> Vec<Line> {
        let mut lines: Vec<Line> = Vec::new();
        // The logout selector and the API-key prompt keep their framed header; the login menu
        // matches the /model and /mcp pickers (operator directive 2026-09-25): the search bar is
        // the frame's first row — no header block, no leading blank.
        let framed = self.is_logout() || !matches!(self.mode, Mode::List);
        if framed {
            // `MenuPanel` inline chrome: the borderMuted rule and the muted
            // one-space title (the content's own `startContent` blank opens the body).
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
            // The API-key prompt: the section-title prompt, the plain `> ` field, the blank between
            // field and actions, and the auth-actions row last — no bottom rule.
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
                    theme, width, kb, true, None,
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
            // An unavailable row renders dimmed (the menu rule).
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
        let hints = [
            key_hint(kb, &["tui.select.up", "tui.select.down"], "navigate"),
            key_hint(kb, &["tui.select.confirm"], "select"),
            key_hint(kb, &["tui.select.cancel"], "cancel"),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<String>>()
        .join("  ");
        lines.push(vec![theme.fg_span(ThemeColor::Muted, format!("  {hints}"))]);
        if framed {
            lines.push(vec![
                theme.fg_span(ThemeColor::Border, "─".repeat(width.max(1)))
            ]);
        } else {
            // One blank line below the hint (the pickers' grammar).
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

    /// Left and right over the filter: inert over an empty query; the row
    /// set never changes on either press.
    #[test]
    fn left_and_right_always_edit_the_search() {
        let mut selector =
            ProviderAuthSelector::new(AuthSelectorKind::Login, vec![anthropic(), linear()]);
        // An empty query: both presses keep it empty and keep every row.
        assert_eq!(selector.search.value(), "");
        selector.handle_key("right", &kb());
        selector.handle_key("left", &kb());
        assert_eq!(selector.search.value(), "", "the empty filter stays empty");
        assert_eq!(
            selector.filtered.len(),
            2,
            "every row stays in the one list"
        );
        selector.handle_key("l", &kb());
        selector.handle_key("right", &kb());
        assert_eq!(selector.search.value(), "l");
    }

    /// A paste in the list filters the providers (the search takes it).
    #[test]
    fn a_paste_filters_the_provider_list() {
        let mut selector =
            ProviderAuthSelector::new(AuthSelectorKind::Login, vec![openai(), anthropic()]);
        selector.paste("open");
        assert_eq!(selector.search.value(), "open");
        assert_eq!(selector.filtered.len(), 1);
    }

    /// A paste lands in the API-key prompt (the key reaches the auth
    /// field, not the hidden composer behind).
    #[test]
    fn a_paste_types_into_the_api_key_prompt() {
        let mut selector = ProviderAuthSelector::new(AuthSelectorKind::Login, vec![openai()]);
        assert_eq!(
            selector.handle_key("enter", &kb()),
            AuthSelectorAction::None
        );
        selector.paste("sk-secret");
        match selector.handle_key("enter", &kb()) {
            AuthSelectorAction::Login { api_key, .. } => {
                assert_eq!(api_key.as_deref(), Some("sk-secret"));
            }
            other => panic!("expected a login submit, got {other:?}"),
        }
    }

    #[test]
    fn enter_on_an_api_key_row_opens_the_prompt() {
        let mut selector =
            ProviderAuthSelector::new(AuthSelectorKind::Login, vec![openai(), anthropic()]);
        assert_eq!(
            selector.handle_key("enter", &kb()),
            AuthSelectorAction::None
        );
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

    /// The menu rule's render: an unavailable row is dimmed and carries the
    /// "not available" annotation; a signed-in row keeps the TS row shape.
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
        let rows = selector.render(&theme(), 80, &kb());
        let plain = |line: &crate::Line| {
            line.iter()
                .map(|span| span.content.clone())
                .collect::<String>()
        };
        let text: Vec<String> = rows.iter().map(plain).collect();
        assert!(text.iter().any(|row| {
            row.contains("ChatGPT Plus/Pro (Codex Subscription) · subscription")
                && row.contains("configured")
                && !row.contains("not available")
        }));
        // The unavailable row: the dimmed primary (a themed span) plus the annotation.
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
        // The login menu matches the /model and /mcp pickers (operator directive 2026-09-25): the
        // frame opens with the search field itself — no header block, no leading blank — the rows
        // follow, and the hint is the last content row with one blank under it.
        let mut selector =
            ProviderAuthSelector::new(AuthSelectorKind::Login, vec![openai(), linear()]);
        selector.render(&theme(), 80, &kb());
        let rows = selector.render(&theme(), 80, &kb());
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
            .position(|row| row.contains("\u{2191}/\u{2193} navigate"))
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
        let rows = selector.render(&theme(), 80, &kb());
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
        assert_eq!(
            selector.handle_key("enter", &kb()),
            AuthSelectorAction::Logout { provider: openai() }
        );
    }

    /// The API-key prompt frame (operator addendum: the /login prompt aligns with the TS login
    /// dialog): the borderMuted rule, the muted `Login to {provider}` title, the `Enter API key:`
    /// section title, the plain `> ` field, and the auth-actions row last — no bottom rule.
    #[test]
    fn the_api_key_prompt_renders_the_ts_login_dialog_frame() {
        let mut selector = ProviderAuthSelector::new(AuthSelectorKind::Login, vec![openai()]);
        selector.handle_key("enter", &kb());
        let rows = selector.render(&theme(), 80, &kb());
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
        let rows = selector.render(&theme(), 80, &kb());
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
