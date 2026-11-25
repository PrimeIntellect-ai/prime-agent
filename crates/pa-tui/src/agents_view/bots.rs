//! The bot rows: the sandbox bots from `list_bots`, merged as top-level rows into their
//! section, and Enter on one, which attaches through `attach_bot` like the `/bots` page.

use serde_json::{json, Value};
use tokio::sync::mpsc;

use super::status::StatusTone;
use super::{parse_search_query, AgentsViewMode, AgentsViewRow, RowKind, UiInput};
use crate::agents_view_search::SessionSearchText;
use crate::agents_view_state::{now_ms, relative_age, section_rank};
use crate::bots_view::{parse_bots, BotRow, BotsCatalog};
use crate::daemon_client::DaemonClient;
use crate::interactive::SessionSelection;

/// A bot row's identity prefix.
const ROW_PREFIX: &str = "bot:";
/// The bots fetch's wait (the session view's request bound).
const FETCH_TIMEOUT_MS: u64 = 10_000;

/// Fetch the bots once, as the view mounts; the answer lands as `BotsLoaded`.
pub(super) fn spawn_bots_fetch(client: &DaemonClient, ui_tx: mpsc::UnboundedSender<UiInput>) {
    let client = client.clone();
    tokio::spawn(async move {
        let result = client
            .request_ok_with_timeout(
                pa_types::daemon::DaemonCommand::ListBots {
                    id: None,
                    owner_session_id: None,
                    rest: serde_json::Map::default(),
                },
                FETCH_TIMEOUT_MS,
            )
            .await
            .map_err(|error| format!("{error:#}"))
            .and_then(|data| parse_bots(&data));
        let _ = ui_tx.send(UiInput::BotsLoaded(result));
    });
}

/// Run the selected bot row's attach; the outcome lands as `BotAttached`.
pub(super) fn spawn_bot_attach(
    client: &DaemonClient,
    ui_tx: mpsc::UnboundedSender<UiInput>,
    row: &AgentsViewRow,
) {
    let client = client.clone();
    let bot_id = row
        .summary
        .get("botId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let name = row.title.clone();
    tokio::spawn(async move {
        let result = crate::session_ui::request_bot_attach(&client, bot_id, name).await;
        let _ = ui_tx.send(UiInput::BotAttached(result));
    });
}

fn bot_row(bot: &BotRow, now: u64) -> AgentsViewRow {
    AgentsViewRow {
        kind: RowKind::Bot,
        section: bot.section(),
        identity: format!("{ROW_PREFIX}{}", bot.bot_id),
        parent_identity: None,
        summary: json!({ "botId": bot.bot_id }),
        title: bot.name.clone(),
        // The model column's bare id, like the session rows.
        model: crate::agents_view_forest::session_model(&json!({ "model": bot.model })),
        cost: bot.cost_usd,
        age: relative_age(Some(bot.last_activity_at.as_str()), now),
        depth: 0,
        descendant_count: 0,
        running_subagent_count: 0,
        expanded: false,
        has_spawn_code: false,
    }
}

impl AgentsViewMode {
    /// Fold the bots fetch. A daemon without bots support answers with an error: the view then
    /// lists no bot rows, and the `/bots` page reports the error.
    pub(super) fn apply_bots_loaded(&mut self, result: Result<BotsCatalog, String>) {
        if let Ok(catalog) = result {
            self.bots = catalog.rows;
            self.rebuild_rows();
        }
    }

    /// Merge the bot rows into `rows`. Unsearched, each bot closes its section (the bots come
    /// ordered by section); a name search keeps the matching bots after the ranked hits. A
    /// scoped view and a message-content search list no bots.
    pub(super) fn merge_bot_rows(&self, rows: &mut Vec<AgentsViewRow>) {
        if self.scope_active {
            return;
        }
        let now = now_ms();
        let query = self.query.trim();
        // A message-content search lists only sessions whose messages match: a bot's messages
        // live in its sandbox, so no bot row matches.
        if !query.is_empty() && self.content_search.enabled {
            return;
        }
        if !query.is_empty() {
            let parsed = parse_search_query(query);
            rows.extend(
                self.bots
                    .iter()
                    .filter(|bot| {
                        let targets = SessionSearchText {
                            name: bot.name.clone(),
                            id: bot.bot_id.clone(),
                            cwd: String::new(),
                        };
                        crate::agents_view_search::score_search(&targets, &parsed).is_some()
                    })
                    .map(|bot| bot_row(bot, now)),
            );
            return;
        }
        for bot in &self.bots {
            let rank = section_rank(bot.section());
            let at = rows
                .iter()
                .position(|row| {
                    row.depth == 0 && row.kind == RowKind::Agent && section_rank(row.section) > rank
                })
                .unwrap_or(rows.len());
            rows.insert(at, bot_row(bot, now));
        }
    }

    /// Enter on a bot row: one attach at a time.
    pub(super) fn open_bot_row(&mut self, row: &AgentsViewRow) {
        if self.attaching_bot.is_some() {
            return;
        }
        self.set_status(&format!("Attaching to the bot {}...", row.title));
        self.attaching_bot = Some(row.clone());
        self.pending_bot_attach = Some(row.clone());
    }

    /// The attach outcome: success opens the bot's session view, a failure (a version
    /// mismatch's upgrade message included) shows on the status line.
    pub(super) fn bot_attached(&mut self, result: Result<crate::interactive::BotAttach, String>) {
        let Some(row) = self.attaching_bot.take() else {
            return;
        };
        match result {
            Ok(bot) => {
                self.actions.push("bot_attached");
                self.finish_open(SessionSelection::Bot(bot), &row, Vec::new(), None, None);
            }
            Err(error) => self.set_status_tone(&error, StatusTone::Error),
        }
    }
}
