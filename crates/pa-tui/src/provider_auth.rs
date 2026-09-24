//! Provider auth management (`/login`, `/logout`): the TS providers
//! selector (`OAuthSelectorComponent` in its inline mode — the panel the
//! configuration menu's Providers tab mounts) plus the command contract
//! the composition root implements (TS `ProviderAuthFlows`:
//! `getLoginProviderOptions` / `getLogoutProviderOptions` / the login
//! flows / `runLogout`). The TUI owns the panel, the search, and the
//! API-key prompt; credential storage and the OAuth flows live above this
//! crate.

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

/// The tab a provider row belongs to (TS `category`): model providers or
/// services (MCP integrations, web search).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthCategory {
    Provider,
    Service,
}

/// How the login runs: the TUI prompts for the key in the panel, or the
/// composition root runs the provider's flow on the plain terminal (the
/// TUI suspends for it). TS splits the same way (`showApiKeyLoginDialog`
/// vs the OAuth/Prime/Bedrock flows).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthFlow {
    /// Prompt for the key in the panel (TS `showPrompt("Enter API key:")`).
    ApiKeyPrompt,
    /// Hand the terminal to the composition root's flow (browser OAuth,
    /// the Prime login, the MCP device flow).
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

/// One provider row (TS `AuthSelectorProvider` plus its rendered status).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderRow {
    pub id: String,
    pub name: String,
    pub auth_type: AuthType,
    pub category: AuthCategory,
    /// The row's status indicator; `None` hides the trailing meta (TS's
    /// unconfigured non-stale inline case).
    pub status: Option<AuthStatusIndicator>,
    /// The login flow the row runs.
    pub flow: AuthFlow,
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
    /// TS `loginProvider`: store the key for `ApiKeyPrompt` rows; run the
    /// flow on the plain terminal for `TerminalFlow` rows (the TUI hands
    /// the terminal over before calling).
    fn login(&self, provider: &ProviderRow, api_key: Option<&str>) -> ProviderAuthFuture;
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

/// The TS list geometry (`PREFERRED_VISIBLE_PROVIDERS`).
const PREFERRED_VISIBLE_PROVIDERS: usize = 8;

/// The panel's search placeholder (TS `MenuSearchInput("Search
/// providers")`).
const SEARCH_PLACEHOLDER: &str = "Search providers";

/// One key press while the selector owns the frame.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthSelectorAction {
    /// Navigation or filter editing only.
    None,
    /// Esc, ctrl+c: close the selector.
    Cancel,
    /// Enter on a login row: run the provider's flow. `Some(key)` is the
    /// panel-prompted key; the terminal-suspending flows carry `None`.
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
    categories: Vec<AuthCategory>,
    active: AuthCategory,
    visible: usize,
}

impl ProviderAuthSelector {
    /// Build the selector over the hook's rows. Login rows default to the
    /// Provider tab; the empty list still opens (TS renders the empty
    /// message in the panel).
    pub fn new(kind: AuthSelectorKind, providers: Vec<ProviderRow>) -> Self {
        let categories: Vec<AuthCategory> = [AuthCategory::Provider, AuthCategory::Service]
            .into_iter()
            .filter(|category| {
                providers
                    .iter()
                    .any(|provider| provider.category == *category)
            })
            .collect();
        let active = categories
            .first()
            .copied()
            .unwrap_or(AuthCategory::Provider);
        let mut selector = ProviderAuthSelector {
            kind,
            mode: Mode::List,
            providers,
            filtered: Vec::new(),
            selected: 0,
            search: SearchInput::new(),
            categories,
            active,
            visible: PREFERRED_VISIBLE_PROVIDERS,
        };
        selector.refilter();
        selector
    }

    /// The panel title (TS `OAuthSelectorOptions.title`).
    fn title(&self) -> &'static str {
        match self.mode {
            Mode::List if self.is_logout() => "Saved Credentials",
            Mode::List => "Providers",
            Mode::Prompt { .. } => "Sign In",
        }
    }

    /// The panel subtitle (TS `MenuPanel` subtitle).
    fn subtitle(&self) -> &'static str {
        match self.mode {
            Mode::List if self.is_logout() => "Choose a credential to remove.",
            Mode::List => "Connect with a subscription or API key.",
            Mode::Prompt { .. } => "",
        }
    }

    fn refilter(&mut self) {
        let query = self.search.value().to_string();
        let in_category: Vec<usize> = self
            .providers
            .iter()
            .enumerate()
            .filter(|(_, provider)| provider.category == self.active)
            .map(|(index, _)| index)
            .collect();
        self.filtered = if query.is_empty() {
            in_category
        } else {
            fuzzy_filter(&in_category, &query, |index| {
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

    fn switch_category(&mut self, direction: isize) {
        if self.categories.len() < 2 {
            return;
        }
        let current = self
            .categories
            .iter()
            .position(|category| *category == self.active)
            .unwrap_or(0);
        let len = self.categories.len() as isize;
        let next = (current as isize + direction).rem_euclid(len) as usize;
        self.active = self.categories[next];
        self.search.set_value("");
        self.refilter();
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
                // Left/right switch tabs only while the search is empty
                // (TS keeps them for cursor editing otherwise).
                if self.categories.len() > 1 && self.search.value().is_empty() {
                    for (binding, direction) in
                        [("tui.editor.cursorLeft", -1), ("tui.editor.cursorRight", 1)]
                    {
                        if kb.matches(key, binding) {
                            self.switch_category(direction);
                            return AuthSelectorAction::None;
                        }
                    }
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
                                            provider: provider.clone(),
                                            input: SearchInput::new(),
                                        };
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
        lines.push(Vec::new());
        lines.push(vec![
            theme.fg_span(ThemeColor::Border, "─".repeat(width.max(1)))
        ]);
        lines.push(vec![crate::Span::raw(format!("  {}", self.title()))]);
        if !self.subtitle().is_empty() {
            lines.push(vec![
                theme.fg_span(ThemeColor::Muted, format!("  {}", self.subtitle()))
            ]);
        }
        match &self.mode {
            Mode::Prompt { input, .. } => {
                lines.push(Vec::new());
                let prompt = format!("  Enter API key: {}", input.value());
                lines.push(vec![crate::Span::raw(prompt)]);
                lines.push(vec![theme.fg_span(
                    ThemeColor::Muted,
                    "  enter submit  escape back".to_string(),
                )]);
                lines.push(vec![
                    theme.fg_span(ThemeColor::Border, "─".repeat(width.max(1)))
                ]);
                return lines;
            }
            Mode::List => {}
        }
        // The tab bar (TS `updateTabBar`): the active tab bold + accent,
        // the rest muted, joined by a muted "  ·  ".
        if self.categories.len() > 1 {
            let labels = [
                (AuthCategory::Provider, "Providers"),
                (AuthCategory::Service, "MCP Connections"),
            ];
            let mut spans: Line = Vec::new();
            let mut first = true;
            for (category, label) in labels {
                if !self.categories.contains(&category) {
                    continue;
                }
                if !first {
                    spans.push(theme.fg_span(ThemeColor::Muted, "  ·  ".to_string()));
                }
                first = false;
                if category == self.active {
                    spans.push(theme.fg_span(ThemeColor::Accent, label.to_string()));
                } else {
                    spans.push(theme.fg_span(ThemeColor::Muted, label.to_string()));
                }
            }
            spans.push(theme.fg_span(ThemeColor::Muted, "   ←/→ switch".to_string()));
            let mut line = vec![crate::Span::raw("  ")];
            line.extend(spans);
            lines.push(line);
            lines.push(Vec::new());
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
            let primary = vec![crate::Span::raw(format!(
                "{} · {}",
                provider.name,
                provider.auth_type.label()
            ))];
            let trailing: Vec<String> = provider
                .status
                .as_ref()
                .map(|status| vec![status.label.clone()])
                .unwrap_or_default();
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
            "  ↑↓ navigate  ←/→ tabs  enter select  escape cancel".to_string(),
        )]);
        lines.push(vec![
            theme.fg_span(ThemeColor::Border, "─".repeat(width.max(1)))
        ]);
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
            category: AuthCategory::Provider,
            status: None,
            flow: AuthFlow::TerminalFlow,
        }
    }

    fn openai() -> ProviderRow {
        ProviderRow {
            id: "openai".to_string(),
            name: "OpenAI".to_string(),
            auth_type: AuthType::ApiKey,
            category: AuthCategory::Provider,
            status: Some(AuthStatusIndicator {
                style: AuthStatusStyle::Success,
                label: "configured".to_string(),
            }),
            flow: AuthFlow::ApiKeyPrompt,
        }
    }

    fn linear() -> ProviderRow {
        ProviderRow {
            id: "mcp:linear".to_string(),
            name: "Linear".to_string(),
            auth_type: AuthType::Oauth,
            category: AuthCategory::Service,
            status: None,
            flow: AuthFlow::TerminalFlow,
        }
    }

    #[test]
    fn tabs_switch_only_while_the_search_is_empty() {
        let mut selector =
            ProviderAuthSelector::new(AuthSelectorKind::Login, vec![anthropic(), linear()]);
        // The service tab exists: right switches to it.
        selector.handle_key("right", &kb());
        assert_eq!(selector.active, AuthCategory::Service);
        // While filtering, right edits the query instead.
        selector.handle_key("l", &kb());
        selector.handle_key("right", &kb());
        assert_eq!(selector.active, AuthCategory::Service);
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
        let mut selector = ProviderAuthSelector::new(AuthSelectorKind::Login, vec![anthropic()]);
        assert_eq!(
            selector.handle_key("enter", &kb()),
            AuthSelectorAction::Login {
                provider: anthropic(),
                api_key: None,
            }
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
        assert!(text.iter().any(|row| row.contains("Providers")));
        assert!(text
            .iter()
            .any(|row| row.contains("Connect with a subscription or API key.")));
        assert!(text.iter().any(|row| row.contains("MCP Connections")));
        assert!(text.iter().any(|row| row.contains("OpenAI · api key")));
        assert!(text.iter().any(|row| row.contains("Search providers")));
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
