//! The machines page's session surface: the page open (the activity
//! dock's machines group, `/factory`, and the agents view's factory line
//! and key all land here), the view's key loop, and the daemon
//! `factory_activity` lane the page's fetches ride (the `library` action:
//! the machine list on open, one machine's graph payload on the drill-in;
//! the runs nested under the machines come from the supervisor's
//! all-session `overview` reply — the page's own fetch and cache — plus
//! the attached session's own finished runs, retained from the dock's
//! scoped graph cache through the page's own seams alone).

use std::time::Duration;

use anyhow::Result;
use serde_json::{Map, Value};

use pa_types::daemon::DaemonCommand;

use super::AgentView;

use crate::factory_view::{
    overview_reply_lists_runs, parse_library_machines, parse_library_warnings, parse_overview_runs,
    parse_overview_warnings, FactoryRow, LibraryRun, LibraryView, LibraryViewAction,
    MALFORMED_LIBRARY_REPLY_ERROR, MALFORMED_OVERVIEW_REPLY_ERROR,
};
use crate::session_ui::{picker_viewport_rows, UI_REQUEST_TIMEOUT_MS};

/// One background library fetch's delivery: the session the request asked
/// about, the epoch it was issued under (an older response never
/// overwrites a newer open's fetch), and the reply (or the error that
/// replaced it). The machines pair carries the open path's list fetch;
/// the overview pair carries the page's all-session runs fetch.
pub(crate) enum LibraryUpdate {
    Machines {
        session: String,
        epoch: u64,
        data: Value,
    },
    Error {
        session: String,
        epoch: u64,
        message: String,
    },
    Overview {
        session: String,
        epoch: u64,
        data: Value,
    },
    OverviewError {
        session: String,
        epoch: u64,
        message: String,
    },
}

impl super::SessionUi {
    /// Open the machines page: every library machine, with every
    /// session's active runs nested under their machine. The keypress
    /// never waits on the daemon: the view mounts at once with the last
    /// overview reply's cached rows, merged with the scoped graph
    /// cache's own rows (the attached session's live and finished rows)
    /// — the list and overview fetches land through the fold, and the
    /// page-only cadence keeps the rows current; a daemon without the
    /// lane reports exactly that instead of mounting nothing silently.
    pub(crate) fn open_factory_page(&mut self, view: &mut AgentView, user_initiated: bool) {
        if !self.factory_activity_supported() {
            self.note(
                "The machines page needs a daemon that advertises the factory lane (turn it on with /factory on)",
                view,
            );
            return;
        }
        // Page-open adoption telemetry, fire-and-forget: the feature's
        // `initiated` counter (no names, ids, paths, or registry data
        // enter telemetry) — only a user-initiated open counts (the
        // dock's Enter, the bare command, the agents-view line); a
        // return from a state's child session reopens the page it
        // left, not a new adoption.
        if user_initiated {
            self.track_feature_outcome("factory", "initiated", None);
        }
        // The mounted view belongs to this session: the list epoch
        // guards drop a late list reply from a previous session's open.
        // The overview epoch does NOT bump here: a reopen while an
        // overview request is still in flight would strand that reply
        // under a bumped epoch (the in-flight guard then waits a whole
        // cadence tick for the next one, and the reopened page paints
        // its warm rows saved for that long). The overview reply is
        // all-session anyway: the fold's session check alone drops a
        // foreign session's reply, and the spawn bumps the epoch for
        // every request it issues.
        self.library_list_epoch += 1;
        // The page draws whole diagrams and node files, so it takes the
        // terminal's height (less the top bar), not a picker's 20.
        let rows = usize::from(view.terminal_rows())
            .saturating_sub(1)
            .max(picker_viewport_rows(view.terminal_rows()));
        let mut own_owner_ids = vec![self.session_id.clone()];
        if self.active_session_id != self.session_id {
            own_owner_ids.push(self.active_session_id.clone());
        }
        // The mount seed: the cached overview rows first — a WARM
        // cache's rows exist only from the page's previous lifetime, so
        // they mount SAVED (their live claims are as old as the
        // closed-page gap, and the daemon itself would no longer serve
        // them unqualified) — then the dock's scoped graph cache's own
        // rows fill every gap the batch does not already carry. A cold
        // cache starts empty (the overview fetch is still in flight —
        // the daemon's reply is never held by a busy resident, but a
        // cold cache's first reply carries only the durable rows), so
        // the page would paint nothing until the reply lands: the seed
        // paints the attached session's whole scoped list at once,
        // finished rows included — the retention, the active-only
        // overview never carries a finished run, and its post-mortem
        // run page must not wait for a reply that will not list it.
        let mut runs: Vec<LibraryRun> = parse_overview_runs(&self.factory_overview)
            .into_iter()
            .map(|mut run| {
                run.saved = true;
                run
            })
            .collect();
        self.append_uncarried_scoped_rows(&mut runs);
        view.library_view = Some(LibraryView::new(runs, own_owner_ids, rows));
        self.dirty = true;
        self.spawn_library_list_refresh();
        self.spawn_library_overview_refresh();
        self.spawn_factory_refresh();
    }

    /// One key press while the view is open: the view resolves the key;
    /// the drill-in rides the daemon lane (bounded, with the outcome on
    /// the view's error row), and Esc closes.
    pub(crate) async fn handle_library_view_key(
        &mut self,
        key: crossterm::event::KeyEvent,
        view: &mut AgentView,
    ) -> Result<()> {
        let Some(id) = super::key_event_to_id(&key) else {
            return Ok(());
        };
        let action = view
            .library_view
            .as_mut()
            .map(|library_view| library_view.handle_key(&id, view.editor.keybindings()));
        match action {
            Some(LibraryViewAction::None) | None => {}
            Some(LibraryViewAction::Close) => {
                view.library_view = None;
                self.close_panel_to_agents_view();
                self.dirty = true;
            }
            Some(LibraryViewAction::DrillIn { name }) => {
                self.fetch_library_graph(view, name).await?;
            }
            Some(LibraryViewAction::OpenRun { run_id }) => {
                self.open_factory_runs(view, Some(FactoryRow::header(&run_id)));
            }
            // This session's own row that no live read backs is
            // read-only: a durable record alone lists it, or its kernel
            // marked it still awaiting its re-arm — no confirmed loop
            // drives the run. The page's row-report slot names the
            // state instead — and never promises an automatic resume:
            // starting or arming a kernel does not resume a paused run
            // (only the explicit resume action does), so the notice
            // reports what the marker means and names the action,
            // nothing more. No run page mounts. The two backings each
            // get their own wording: a durable-only row has no live
            // read behind it at all, while the kernel's own read lists
            // a rehydrated run and only its re-arm is pending.
            Some(LibraryViewAction::SavedRun {
                run_id,
                rearm_pending,
            }) => {
                let backing = if rearm_pending {
                    "waiting for its kernel to re-arm it"
                } else {
                    "no live read backs it"
                };
                if let Some(library_view) = view.library_view.as_mut() {
                    library_view.set_row_notice(Some(format!(
                        "run {run_id} is saved — {backing}; a paused run resumes only through an explicit resume"
                    )));
                }
                self.dirty = true;
            }
            // A foreign owner's row is read-only: the page's row-report
            // slot names the owner to open for controls. No local run
            // page mounts and no stop/resume/watch or child-control
            // request leaves this session for a run it does not own.
            Some(LibraryViewAction::ForeignRun { owner }) => {
                if let Some(library_view) = view.library_view.as_mut() {
                    library_view.set_row_notice(Some(format!(
                        "run belongs to session {owner} — open that session to stop or resume it"
                    )));
                }
                self.dirty = true;
            }
        }
        Ok(())
    }

    /// Fetch one machine's graph payload over the lane (the drill-in's
    /// request, the run page's stop/resume pattern: one bounded
    /// request, the reply folds straight into the open view, and a
    /// failure surfaces on the view's error row).
    async fn fetch_library_graph(&mut self, view: &mut AgentView, name: String) -> Result<()> {
        let reply = self
            .bounded_request(
                Duration::from_millis(UI_REQUEST_TIMEOUT_MS),
                DaemonCommand::FactoryActivity {
                    id: None,
                    active_session_id: self.active_session_id.clone(),
                    action: "library".to_string(),
                    run_id: None,
                    spec_id: Some(name.clone()),
                    timeout_ms: None,
                    rest: Map::default(),
                },
            )
            .await;
        match reply {
            Ok(data) => {
                if let Some(library_view) = view.library_view.as_mut() {
                    library_view.apply_detail(&name, &data);
                }
            }
            Err(error) => {
                if let Some(library_view) = view.library_view.as_mut() {
                    library_view.set_error(Some(format!("{error:#}")));
                }
            }
        }
        self.dirty = true;
        Ok(())
    }

    /// Fire the open path's list fetch (the heartbeat refresh's shape,
    /// one-shot: the library changes only through `prime-agent factory
    /// import | export`, so an open refetches rather than a standing
    /// poll). The reply lands through the run loop's channel; a stale
    /// epoch (a later open already fired) drops at fold time.
    pub(crate) fn spawn_library_list_refresh(&mut self) {
        let client = self.client.clone();
        let active_session_id = self.active_session_id.clone();
        let epoch = self.library_list_epoch;
        let tx = self.library_updates.clone();
        tokio::spawn(async move {
            let fetched = client.request_ok(DaemonCommand::FactoryActivity {
                id: None,
                active_session_id: active_session_id.clone(),
                action: "library".to_string(),
                run_id: None,
                spec_id: None,
                timeout_ms: None,
                rest: Map::default(),
            });
            let fetched =
                tokio::time::timeout(Duration::from_millis(UI_REQUEST_TIMEOUT_MS), fetched).await;
            let update = match fetched {
                Ok(Ok(data)) => LibraryUpdate::Machines {
                    session: active_session_id,
                    epoch,
                    data,
                },
                Ok(Err(error)) => LibraryUpdate::Error {
                    session: active_session_id,
                    epoch,
                    message: format!("{error:#}"),
                },
                Err(_) => LibraryUpdate::Error {
                    session: active_session_id,
                    epoch,
                    message: "timed out waiting for the Prime Agent daemon response".to_string(),
                },
            };
            let _ = tx.send(update);
        });
    }

    /// Fire the page's overview fetch (the open path and the mounted
    /// page's cadence): one all-session `overview` request, bounded like
    /// every lane fetch, delivered through the library channel. At most
    /// one request runs in flight — a tick that fires while the fetch is
    /// still running waits for the next cadence instead of stacking a
    /// second request.
    pub(crate) fn spawn_library_overview_refresh(&mut self) {
        if self.library_overview_in_flight {
            return;
        }
        self.library_overview_in_flight = true;
        self.library_overview_epoch += 1;
        let epoch = self.library_overview_epoch;
        let client = self.client.clone();
        let active_session_id = self.active_session_id.clone();
        let tx = self.library_updates.clone();
        tokio::spawn(async move {
            let fetched = client.request_ok(DaemonCommand::FactoryActivity {
                id: None,
                active_session_id: active_session_id.clone(),
                action: "overview".to_string(),
                run_id: None,
                spec_id: None,
                timeout_ms: None,
                rest: Map::default(),
            });
            let fetched =
                tokio::time::timeout(Duration::from_millis(UI_REQUEST_TIMEOUT_MS), fetched).await;
            let update = match fetched {
                Ok(Ok(data)) => LibraryUpdate::Overview {
                    session: active_session_id,
                    epoch,
                    data,
                },
                Ok(Err(error)) => LibraryUpdate::OverviewError {
                    session: active_session_id,
                    epoch,
                    message: format!("{error:#}"),
                },
                Err(_) => LibraryUpdate::OverviewError {
                    session: active_session_id,
                    epoch,
                    message: "timed out waiting for the Prime Agent daemon response".to_string(),
                },
            };
            let _ = tx.send(update);
        });
    }

    /// The fold's cache decision for one overview reply (the scoped graph
    /// fold's malformed contract, on the page's own cache): a
    /// well-formed reply replaces the cache and parses; a malformed one
    /// keeps the last good snapshot, so the page never repaints an
    /// unreadable overview as an empty one.
    fn fold_overview_reply(
        cache: &mut Value,
        incoming: Value,
    ) -> Option<(Vec<LibraryRun>, Vec<String>)> {
        if !overview_reply_lists_runs(&incoming) {
            return None;
        }
        let rows = parse_overview_runs(&incoming);
        let warnings = parse_overview_warnings(&incoming);
        *cache = incoming;
        Some((rows, warnings))
    }

    /// The dock's scoped graph cache as the attached session's OWN
    /// `LibraryRun` rows: every cached run, live and finished alike
    /// (kept current by the dock's own poll), because that poll read
    /// each row — owned, carrying this session's id and name,
    /// live-backed, never saved, no re-arm pending — so an owned row
    /// keeps the run-page drill-in, a finished run's post-mortem page
    /// included. The page's seams that read it: the mount seed's
    /// merge, the uncarried-row fill on every overview fold, and the
    /// version-skew fallback (an older daemon forwards `overview` to
    /// the attached session's worker, which refuses the unknown
    /// action — the fallback answers these rows, the attached
    /// session's terminal window included, instead of an erroring
    /// empty page).
    fn scoped_graph_rows(&self) -> Vec<LibraryRun> {
        crate::factory_view::parse_factory_runs(&self.factory_graph)
            .into_iter()
            .map(|snapshot| LibraryRun {
                snapshot,
                owner_id: self.session_id.clone(),
                // This session's own name (the attach's), scrubbed
                // the way the overview scrubs the same owner name — a
                // name carrying control bytes (an OSC 8 pair rides the
                // attach) must never reach the row raw — so a retained
                // row paints the same owner label the overview gives
                // this session's live rows, never the raw session id
                // the unnamed fallback paints.
                owner_name: crate::menu_panel::scrub_controls(
                    self.session_name.as_deref().unwrap_or_default(),
                ),
                saved: false,
                live_backing: true,
                // The dock's own poll read this row: no re-arm is pending.
                rearm_pending: false,
            })
            .collect()
    }

    /// The retention merge the mount seed and the overview fold share:
    /// append the scoped graph cache's own rows that no own row in
    /// `runs` already carries, reconciled by the own-id set plus run
    /// id — never run id alone, so a foreign run with the same run id
    /// stays a separate row and a cached own row keeps its saved
    /// paint. The fresh batch keeps authority over every row it
    /// carries (each session's, the attached session's included — the
    /// overview is the page's source of truth for the rows it
    /// carries), and every own scoped row the batch does NOT carry
    /// rides in, live and finished alike: the active-only overview
    /// never carries a finished run, and a live row the batch dropped
    /// behind the two caches' freshness skew (the dock's scoped graph
    /// still reading a just-finished run live while the overview's
    /// newer peek already dropped it) must not vanish for a cadence —
    /// the row the user watches stays until the scoped cache itself
    /// turns it terminal and the next fold repaints it done. A
    /// foreign row is never touched.
    fn append_uncarried_scoped_rows(&self, runs: &mut Vec<LibraryRun>) {
        for scoped in self.scoped_graph_rows() {
            let carried = runs.iter().any(|run| {
                (run.owner_id == self.session_id || run.owner_id == self.active_session_id)
                    && run.snapshot.run_id == scoped.snapshot.run_id
            });
            if !carried {
                runs.push(scoped);
            }
        }
    }

    /// Fold one library fetch delivery into the session: a foreign session
    /// or a stale epoch (a later open already fired) drops; the open view
    /// absorbs the machines (a malformed reply keeps the rows and
    /// reports the lane instead of painting a fake empty state), and an
    /// error lands on the view's error row.
    pub(crate) fn apply_library_update(&mut self, update: LibraryUpdate, view: &mut AgentView) {
        match update {
            LibraryUpdate::Overview {
                session,
                epoch,
                data,
            } => {
                self.apply_overview_update(&session, epoch, Ok(data), view);
            }
            LibraryUpdate::OverviewError {
                session,
                epoch,
                message,
            } => {
                self.apply_overview_update(&session, epoch, Err(message), view);
            }
            LibraryUpdate::Machines {
                session,
                epoch,
                data,
            } => self.apply_machines_update(&session, epoch, Ok(data), view),
            LibraryUpdate::Error {
                session,
                epoch,
                message,
            } => self.apply_machines_update(&session, epoch, Err(message), view),
        }
    }

    /// The overview fold: the refresh slot frees whether the response
    /// landed, failed, or timed out; a foreign session or a stale epoch
    /// (a newer request already landed) drops. A well-formed reply
    /// replaces the page's cache and FILLS its rows — the fresh batch
    /// first, then the retention merge's uncarried scoped rows (the
    /// selection keeps its row; an anchored cursor still follows the
    /// page's first row); a malformed or failed
    /// response keeps the last good snapshot and reports on the
    /// overview's OWN error row — never a fake empty page, and never a
    /// wipe of the page's other errors (the foreign-row report, a
    /// drill-in failure, the machine list).
    fn apply_overview_update(
        &mut self,
        session: &str,
        epoch: u64,
        payload: Result<Value, String>,
        view: &mut AgentView,
    ) {
        self.library_overview_in_flight = false;
        if session != self.active_session_id || epoch != self.library_overview_epoch {
            return;
        }
        if let Some(library_view) = view.library_view.as_mut() {
            match payload {
                Ok(data) => match Self::fold_overview_reply(&mut self.factory_overview, data) {
                    Some((rows, warnings)) => {
                        library_view.set_overview_error(None);
                        // The successful fold FILLS, never erases: the
                        // fresh batch replaces the rows it carries, then
                        // the merge appends the attached session's
                        // scoped rows the batch does not — the finished
                        // ones the active-only reply dropped, and a live
                        // one the batch dropped behind the two caches'
                        // freshness skew. The watched row never
                        // vanishes between the caches.
                        let mut rows = rows;
                        self.append_uncarried_scoped_rows(&mut rows);
                        library_view.apply_overview(rows, warnings);
                    }
                    None => {
                        library_view
                            .set_overview_error(Some(MALFORMED_OVERVIEW_REPLY_ERROR.to_string()));
                    }
                },
                Err(message) => {
                    // An older daemon forwards `overview` to the attached
                    // session's worker, which refuses the unknown action —
                    // and the refusal would repeat on every cadence tick.
                    // Fall back to the scoped graph cache's rows (live and
                    // finished, refreshed by the dock's own poll) instead
                    // of an erroring empty page.
                    if message.contains("unknown factory activity action") {
                        library_view.apply_overview(Self::scoped_graph_rows(self), Vec::new());
                    } else {
                        library_view.set_overview_error(Some(message));
                    }
                }
            }
        } else {
            // The page is closed; the cache still absorbs the last good
            // reply (the next open mounts from it), never a malformed or
            // failed one.
            if let Ok(data) = payload {
                if overview_reply_lists_runs(&data) {
                    self.factory_overview = data;
                }
            }
        }
        self.dirty = true;
    }

    /// The machines-list fold: the open view absorbs the machines.
    fn apply_machines_update(
        &mut self,
        session: &str,
        epoch: u64,
        payload: Result<Value, String>,
        view: &mut AgentView,
    ) {
        if session != self.active_session_id || epoch != self.library_list_epoch {
            return;
        }
        if let Some(library_view) = view.library_view.as_mut() {
            match payload {
                Ok(data) => {
                    if crate::factory_view::library_reply_lists_machines(&data) {
                        library_view.set_error(None);
                        library_view.apply_machines(
                            parse_library_machines(&data),
                            parse_library_warnings(&data),
                        );
                    } else {
                        library_view.set_error(Some(MALFORMED_LIBRARY_REPLY_ERROR.to_string()));
                    }
                }
                Err(message) => {
                    library_view.set_error(Some(message));
                }
            }
        }
        self.dirty = true;
    }
}
