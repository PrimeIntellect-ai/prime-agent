//! The `/bots` page's session surface: the page open, its background `list_bots` fetch, its
//! key loop, and the attach (`attach_bot`, then the normal session view over the bot's link).

use std::path::PathBuf;

use anyhow::{Context, Result};
use serde_json::{Map, Value};

use pa_types::daemon::DaemonCommand;

use super::{picker_viewport_rows, AgentView, Overlay, SessionUi, UI_REQUEST_TIMEOUT_MS};

use crate::bots_view::{parse_bots, BotsAction, BotsView};
use crate::daemon_client::LONG_RUNNING_REQUEST_TIMEOUT_MS;
use crate::interactive::reconnect::ConnectionEvent;
use crate::interactive::{BotAttach, SelectionOrigin, SessionPanel, SessionSelection};

/// One background `/bots` delivery: a fetched `list_bots` answer, or an attach outcome.
pub(crate) enum BotsUpdate {
    Catalog(Result<Value, String>),
    Attached(Result<BotAttach, String>),
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

/// The slash commands that act on this Mac, never on a bot: an attached bot view refuses them.
const LOCAL_ONLY_COMMANDS: &[&str] = &[
    "bots",
    "clone",
    "export",
    "fork",
    "import",
    "login",
    "logout",
    "logs",
    "mcp",
    "new",
    "nightly",
    "plugins",
    "share",
    "telemetry",
    "traces",
    "update",
];

impl SessionUi {
    /// Open the `/bots` page and fetch its rows in the background.
    pub(crate) fn open_bots_page(&mut self, view: &mut AgentView) {
        view.overlay = Some(Overlay::Bots(BotsView::new(picker_viewport_rows(
            view.terminal_rows(),
        ))));
        self.dirty = true;
        self.spawn_bots_refresh();
    }

    fn spawn_bots_refresh(&self) {
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
            let _ = tx.send(BotsUpdate::Catalog(result));
        });
    }

    /// The attach runs in the background: the daemon may resume a paused sandbox first.
    fn spawn_bot_attach(&self, bot_id: String, name: String) {
        let client = self.client.clone();
        let tx = self.bots_updates.clone();
        tokio::spawn(async move {
            let result = client
                .request_ok_with_timeout(
                    DaemonCommand::AttachBot {
                        id: None,
                        bot_id: bot_id.clone(),
                        rest: Map::default(),
                    },
                    LONG_RUNNING_REQUEST_TIMEOUT_MS,
                )
                .await
                .map_err(|error| page_error(&error))
                .and_then(|data| {
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
                });
            let _ = tx.send(BotsUpdate::Attached(result));
        });
    }

    /// Fold one background delivery into the open page. A delivery for a closed page drops (an
    /// unused attach endpoint expires in the daemon).
    pub(crate) fn apply_bots_update(&mut self, update: BotsUpdate, view: &mut AgentView) {
        let Some(Overlay::Bots(page)) = view.overlay.as_mut() else {
            return;
        };
        match update {
            BotsUpdate::Catalog(result) => match result.and_then(|data| parse_bots(&data)) {
                Ok(catalog) => page.apply_catalog(catalog),
                Err(error) => page.set_fetch_error(Some(error)),
            },
            BotsUpdate::Attached(Ok(bot)) => {
                self.pending_selection = Some(SessionSelection::Bot(bot));
                self.pending_selection_origin = Some(SelectionOrigin {
                    panel: SessionPanel::Bots,
                    closes_to_agents_view: self.panel_returns_to_agents_view,
                });
                self.exit_requested = true;
            }
            BotsUpdate::Attached(Err(error)) => {
                page.set_attaching(None);
                page.set_fetch_error(Some(error));
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
            BotsAction::Refresh => self.spawn_bots_refresh(),
            BotsAction::Attach { bot_id, name } => {
                page.set_fetch_error(None);
                page.set_attaching(Some(name.clone()));
                self.spawn_bot_attach(bot_id, name);
            }
            BotsAction::Close => {
                view.overlay = None;
                self.close_panel_to_agents_view();
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
