//! The `/bots` page's session surface: the page open, its background `list_bots` fetch, its
//! key loop, and the attach (`attach_bot`, then the normal session view over the bot's link).

use std::path::PathBuf;

use anyhow::{Context, Result};
use serde_json::{Map, Value};

use pa_types::daemon::DaemonCommand;

use super::{AgentView, Overlay, SessionUi, UI_REQUEST_TIMEOUT_MS};

use crate::bots_view::{parse_bots, BotsAction, BotsView};
use crate::interactive::reconnect::ConnectionEvent;
use crate::interactive::{BotAttach, SelectionOrigin, SessionPanel, SessionSelection};

/// The attach wait: longer than the daemon's 15-minute budget to resume a paused sandbox.
const ATTACH_TIMEOUT_MS: u64 = 16 * 60 * 1000;

/// One background `/bots` delivery: a fetched `list_bots` answer, or an attach outcome.
pub(crate) enum BotsUpdate {
    /// One `list_bots` outcome, tagged with the request number it answers.
    Catalog {
        request: u64,
        result: Result<Value, String>,
    },
    /// One attach outcome, tagged with the request number it answers.
    Attached {
        request: u64,
        result: Result<BotAttach, String>,
    },
    /// One `pause_bot`/`resume_bot` outcome, tagged with the request number it answers.
    Toggled {
        request: u64,
        result: Result<(), String>,
    },
}

/// The page's error line: a daemon refusal shows its own message (a version mismatch's
/// upgrade message reads first), any other failure its full chain.
fn page_error(error: &anyhow::Error) -> String {
    error
        .chain()
        .find_map(|cause| cause.downcast_ref::<crate::daemon_client::RequestRejected>())
        .map_or_else(
            || format!("{error:#}"),
            |rejection| crate::menu_panel::scrub_controls(&rejection.message),
        )
}

/// Connect to a bot's guest daemon through the single-use endpoint `attach_bot` answered.
///
/// # Errors
///
/// Returns `Err` when the endpoint is gone or the guest daemon handshake fails.
pub(crate) async fn connect_bot(
    bot: &BotAttach,
) -> Result<(
    crate::daemon_client::DaemonClient,
    tokio::sync::mpsc::UnboundedReceiver<crate::daemon_client::DaemonClientEvent>,
)> {
    let stream = pa_types::platform::transport::connect_transport(&bot.endpoint)
        .await
        .with_context(|| format!("could not open the link to the bot {}", bot.name))?;
    crate::daemon_client::DaemonClient::connect_stream(stream).await
}

/// Ask the local daemon to attach `bot_id` (`attach_bot`): the daemon resumes a paused sandbox
/// first, then answers the single-use endpoint the view connects through.
pub(crate) async fn request_bot_attach(
    client: &crate::daemon_client::DaemonClient,
    bot_id: String,
    name: String,
) -> Result<BotAttach, String> {
    let data = client
        .request_ok_with_timeout(
            DaemonCommand::AttachBot {
                id: None,
                bot_id: bot_id.clone(),
                rest: Map::default(),
            },
            ATTACH_TIMEOUT_MS,
        )
        .await
        .map_err(|error| page_error(&error))?;
    let field = |key: &str| {
        data.get(key)
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .map(str::to_string)
            .ok_or_else(|| format!("the attach_bot answer carries no {key}"))
    };
    Ok(BotAttach {
        bot_id,
        name,
        endpoint: PathBuf::from(field("endpoint")?),
        guest_session_id: field("guestSessionId")?,
    })
}

/// The slash commands that act on this Mac, never on a bot: an attached bot view refuses them.
const LOCAL_ONLY_COMMANDS: &[&str] = &[
    "bots",
    "clone",
    "export",
    "factory",
    "fork",
    "import",
    "login",
    "logout",
    "logs",
    "mcp",
    "new",
    "nightly",
    "plugins",
    "resume",
    "secrets",
    "settings",
    "share",
    "telemetry",
    "traces",
    "update",
];

impl SessionUi {
    /// Open the `/bots` page and fetch its rows in the background.
    pub(crate) fn open_bots_page(&mut self, view: &mut AgentView) {
        // The page owns the frame: a focused dock under it would take the page's keys. The dock
        // selection moves to the bots group, so the page's exit lands there.
        self.activity_group = crate::chrome::ActivityGroup::Bots;
        self.subagents_focused = false;
        self.update_subagent_summary(view);
        let mut page = BotsView::default();
        self.spawn_bots_refresh(&mut page);
        view.overlay = Some(Overlay::Bots(page));
        self.dirty = true;
    }

    /// Fetch the page's rows; the page keeps the request number and applies only its answer.
    fn spawn_bots_refresh(&mut self, page: &mut BotsView) {
        page.set_catalog_request(self.spawn_bots_fetch());
    }

    /// The dock's `list_bots` poll: one request at a time, and none in a bot view (the client
    /// talks to the bot's guest daemon there).
    pub(crate) fn spawn_bots_dock_refresh(&mut self) {
        if self.bot.is_none() && self.bots_dock_request.is_none() {
            self.bots_dock_request = Some(self.spawn_bots_fetch());
        }
    }

    /// One background `list_bots` request; returns its request number.
    fn spawn_bots_fetch(&mut self) -> u64 {
        self.bots_requests += 1;
        let request = self.bots_requests;
        let client = self.client.clone();
        let tx = self.bots_updates.clone();
        tokio::spawn(async move {
            let result = client
                .request_ok_with_timeout(
                    DaemonCommand::ListBots {
                        id: None,
                        owner_session_id: None,
                        rest: Map::default(),
                    },
                    UI_REQUEST_TIMEOUT_MS,
                )
                .await
                .map_err(|error| page_error(&error));
            let _ = tx.send(BotsUpdate::Catalog { request, result });
        });
        request
    }

    /// The attach runs in the background: the daemon may resume a paused sandbox first.
    fn spawn_bot_attach(&self, request: u64, bot_id: String, name: String) {
        let client = self.client.clone();
        let tx = self.bots_updates.clone();
        tokio::spawn(async move {
            let result = request_bot_attach(&client, bot_id, name).await;
            let _ = tx.send(BotsUpdate::Attached { request, result });
        });
    }

    /// The pause or resume runs in the background: a pause checkpoints the sandbox first.
    fn spawn_bot_toggle(&self, request: u64, bot_id: String, pause: bool) {
        let client = self.client.clone();
        let tx = self.bots_updates.clone();
        tokio::spawn(async move {
            let command = if pause {
                DaemonCommand::PauseBot {
                    id: None,
                    bot_id,
                    rest: Map::default(),
                }
            } else {
                DaemonCommand::ResumeBot {
                    id: None,
                    bot_id,
                    rest: Map::default(),
                }
            };
            let result = client
                .request_ok_with_timeout(command, ATTACH_TIMEOUT_MS)
                .await
                .map(|_| ())
                .map_err(|error| page_error(&error));
            let _ = tx.send(BotsUpdate::Toggled { request, result });
        });
    }

    /// Fold one background delivery. A newer `list_bots` answer feeds the dock; the open page
    /// applies only the answer it waits for. An attach result for a closed page drops (an
    /// unused attach endpoint expires in the daemon).
    pub(crate) fn apply_bots_update(&mut self, update: BotsUpdate, view: &mut AgentView) {
        match update {
            BotsUpdate::Catalog { request, result } => {
                if self.bots_dock_request == Some(request) {
                    self.bots_dock_request = None;
                }
                let result = result.and_then(|data| parse_bots(&data));
                if let Ok(catalog) = &result {
                    if request > self.bots_catalog_request {
                        self.bots_catalog_request = request;
                        self.bots_catalog.clone_from(&catalog.rows);
                        self.update_subagent_summary(view);
                        self.dirty = true;
                    }
                }
                let Some(Overlay::Bots(page)) = view.overlay.as_mut() else {
                    return;
                };
                // The page's own fetch applies, and so does a newer dock poll's rows (the pause
                // timer and the status stay live); an older answer does not.
                match result {
                    Ok(catalog) if page.takes_catalog(request) => {
                        page.set_catalog_request(request);
                        page.apply_catalog(catalog);
                    }
                    Err(error) if page.awaits_catalog(request) => {
                        page.set_fetch_error(Some(error));
                    }
                    _ => {}
                }
            }
            BotsUpdate::Attached { request, result } => {
                // A result for an attach this page is not waiting for (an earlier request, or
                // one from a closed page) drops.
                let Some(Overlay::Bots(page)) = view.overlay.as_mut() else {
                    return;
                };
                if !page.is_attaching(request) {
                    return;
                }
                match result {
                    Ok(bot) => {
                        self.pending_selection = Some(SessionSelection::Bot(bot));
                        self.pending_selection_origin = Some(SelectionOrigin {
                            panel: SessionPanel::Bots { error: None },
                            closes_to_agents_view: self.panel_returns_to_agents_view,
                        });
                        self.exit_requested = true;
                    }
                    Err(error) => {
                        page.set_attaching(None);
                        page.set_attach_error(Some(error));
                    }
                }
            }
            BotsUpdate::Toggled { request, result } => {
                let Some(Overlay::Bots(page)) = view.overlay.as_mut() else {
                    return;
                };
                if !page.is_toggling(request) {
                    return;
                }
                page.set_toggling(None);
                if let Err(error) = result {
                    page.set_attach_error(Some(error));
                }
                self.spawn_bots_refresh(page);
            }
        }
        self.dirty = true;
    }

    /// One key press while the page is open.
    pub(crate) fn handle_bots_view_key(
        &mut self,
        key: crossterm::event::KeyEvent,
        view: &mut AgentView,
    ) -> Result<()> {
        let Some(id) = super::key_event_to_id(&key) else {
            return Ok(());
        };
        let Some(Overlay::Bots(page)) = view.overlay.as_mut() else {
            return Ok(());
        };
        match page.handle_key(&id, view.editor.keybindings()) {
            BotsAction::None | BotsAction::ToggleDetail => {}
            BotsAction::Refresh => self.spawn_bots_refresh(page),
            BotsAction::TogglePause {
                bot_id,
                name,
                pause,
            } => {
                page.set_attach_error(None);
                self.bots_requests += 1;
                let note = if pause {
                    format!("Pausing {name}. The sandbox saves a checkpoint first.")
                } else {
                    format!("Resuming {name}. This takes a moment.")
                };
                page.set_toggling(Some((self.bots_requests, note)));
                self.spawn_bot_toggle(self.bots_requests, bot_id, pause);
            }
            BotsAction::Attach { bot_id, name } => {
                page.set_attach_error(None);
                self.bots_requests += 1;
                page.set_attaching(Some((self.bots_requests, name.clone())));
                self.spawn_bot_attach(self.bots_requests, bot_id, name);
            }
            // The exit restores the dock's own group, like the sibling dock pages.
            BotsAction::Close => {
                view.overlay = None;
                if !self.close_panel_to_agents_view() {
                    self.focus_activity_dock(view);
                }
            }
        }
        self.dirty = true;
        Ok(())
    }

    /// The refusal for a command that acts on this Mac, when this view is attached to a bot.
    pub(super) fn bot_refusal(&self, command: &str) -> Option<String> {
        let bot = self.bot.as_ref()?;
        LOCAL_ONLY_COMMANDS.contains(&command).then(|| {
            format!(
                "/{command} runs on this Mac, not in the bot {}. Leave the bot view to use it.",
                bot.name
            )
        })
    }

    /// Whether `event` is a lost link of this bot view. A bot view never reconnects: the
    /// endpoint was single-use, and the reconnect driver would dial this Mac's daemon. The
    /// first loss shows one error row.
    pub(crate) fn bot_link_lost(&mut self, event: &ConnectionEvent, view: &mut AgentView) -> bool {
        let Some(bot) = &self.bot else {
            return false;
        };
        if !matches!(
            event,
            ConnectionEvent::UpdateNotice { .. }
                | ConnectionEvent::ShutdownNotice
                | ConnectionEvent::ConnectionLost
                | ConnectionEvent::SupervisorDied { .. }
                | ConnectionEvent::DirectLinkLost { .. }
        ) {
            return false;
        }
        if !std::mem::replace(&mut self.bot_link_closed, true) {
            let message = format!(
                "The link to the bot {} closed. Leave this view and attach again.",
                bot.name
            );
            self.error_row(&message, view);
        }
        true
    }
}
