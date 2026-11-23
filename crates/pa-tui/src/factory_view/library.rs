//! The machines page: every machine the library resolves (bundled,
//! personal, team; MACHINE.md files and machine directories), each with
//! every session's active runs of it nested underneath — the daemon's
//! all-session overview, plus the attached session's own finished runs
//! retained from its scoped graph cache — the way the agents view
//! nests subagents under their agent. Runs whose spec is not
//! a library machine (stored factory entries) list in their own group.
//!
//! The page is pure presentation and selection on the activity pages'
//! picker keyset (arrows + Enter + Esc): the arrows walk the rows, Enter
//! on a machine drills into it (its diagram, params, and mermaid
//! rendered as a diagram), Enter on a run opens the run page on it, and
//! Esc backs out of the drill-in before it closes the page. The session
//! UI owns the daemon
//! lane (the `library` action over the `factory_activity` bridge, and the
//! run graph cache it already polls) and folds the replies in.
//!
//! The drill-in reuses the run page's diagram renderer over the graph
//! payload (the same snapshot shape the active-run graph lane answers),
//! and the machine's mermaid renders below it through the same renderer
//! (`spec_to_mermaid` output for GitHub stays plain text on the wire; the
//! page draws it, and a mermaid fence in a node's Markdown draws the
//! same way — types the renderer cannot draw collapse to a placeholder).

use std::fmt::Write as _;

use serde_json::Value;

use super::{format_duration, parse_run, run_state_color, FactoryRunSnapshot};
use crate::keybindings::{format_key_text, KeybindingsManager};
use crate::theme::{Theme, ThemeColor};
use crate::width::{str_width, truncate_line, truncate_to_width};
use crate::{Line, Span};

/// The page's malformed-lane error: a reply without the machines list is
/// a malformed lane, never an empty library.
pub const MALFORMED_LIBRARY_REPLY_ERROR: &str = "malformed machine reply (no machines list)";

/// The overview's malformed-lane error: a reply without the runs list is
/// a malformed lane, never zero runs — the last good snapshot stays.
pub const MALFORMED_OVERVIEW_REPLY_ERROR: &str = "malformed machine reply (no runs list)";

/// One library machine row (the `library` list action's reply): the name
/// the drill-in asks for, the description, the source level (`repo` for
/// the bundled or team library, `user` for the personal one), and the
/// kind (`file` for a MACHINE.md, `directory` for a machine directory).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LibraryMachine {
    pub name: String,
    pub description: String,
    pub source: String,
    pub kind: String,
}

impl LibraryMachine {
    fn parse(value: &Value) -> Option<Self> {
        // Every daemon-provided display string scrubs its control bytes
        // at this parse seam (the bash activity lane's rule): wire text
        // never reaches a styled span.
        let scrub = |text: &str| crate::menu_panel::scrub_controls(text);
        Some(Self {
            name: scrub(value.get("name")?.as_str()?),
            description: scrub(value.get("description")?.as_str()?),
            source: scrub(value.get("source")?.as_str()?),
            kind: value
                .get("kind")
                .and_then(Value::as_str)
                .map_or_else(|| "file".to_string(), scrub),
        })
        .filter(|machine| !machine.name.trim().is_empty())
    }
}

/// Parse the `library` list reply (`{"machines": [...]}`): every row that
/// carries a name, description, and source; malformed rows drop.
#[must_use]
pub fn parse_library_machines(data: &Value) -> Vec<LibraryMachine> {
    data.get("machines")
        .and_then(Value::as_array)
        .map(|machines| machines.iter().filter_map(LibraryMachine::parse).collect())
        .unwrap_or_default()
}

/// The list reply's warnings: machines that failed to load, by path.
#[must_use]
pub fn parse_library_warnings(data: &Value) -> Vec<String> {
    data.get("warnings")
        .and_then(Value::as_array)
        .map(|warnings| {
            warnings
                .iter()
                .filter_map(Value::as_str)
                .map(crate::menu_panel::scrub_controls)
                .collect()
        })
        .unwrap_or_default()
}

/// Whether a reply is the library list shape at all: a reply without the
/// `machines` LIST is a malformed lane, not an empty library.
#[must_use]
pub fn library_reply_lists_machines(data: &Value) -> bool {
    data.get("machines").is_some_and(Value::is_array)
}

/// The machines page's owner/source wrapper: the run's owner identity
/// (the durable session id, the active id for a memory-only owner) and
/// display name, plus the row's backing (a live read or a durable
/// record). Two producers build these rows — the overview parse here,
/// the session UI's scoped rows — and the run payload itself stays the
/// graph snapshot the run parser reads: the owner metadata rides this
/// small wrapper, never the executor.
#[derive(Debug, Clone, PartialEq)]
pub struct LibraryRun {
    pub snapshot: FactoryRunSnapshot,
    /// The owner's identity: the durable session id, or the active id
    /// when the owner session has no file. Raw identity: it never rides
    /// a display string, and every producer scrubs the name it stores
    /// beside it — the overview parse scrubs the daemon's ownerName
    /// here, the session UI's scoped rows scrub the attached session's
    /// name at their own seam. When the owner has no name the owner
    /// label falls back to this id SCRUBBED: the identity itself stays
    /// raw for the row key and the ownership checks, and its control
    /// bytes never reach a painted row (a session header id may carry
    /// them; the id validator rejects path separators alone).
    pub owner_id: String,
    /// The owner's display name, scrubbed by every producer — the
    /// overview parse scrubs the daemon's ownerName here, the session
    /// UI's scoped rows scrub the attached session's name at their own
    /// seam — so control bytes never reach a painted row; empty when
    /// the owner has none.
    pub owner_name: String,
    /// Whether the row shows as a saved snapshot: a durable record alone
    /// backs it, its live read marked the run still awaiting its
    /// re-arm, or its read aged past the freshness bound. The marker
    /// claims no confirmed live read — never that the owner's kernel is
    /// down (an aged row's run may still be executing behind its
    /// owner's pending read) — so the page paints the marker, never a
    /// ticking age.
    pub saved: bool,
    /// Whether a live read backs the row: the daemon's live cache
    /// sourced it (the row carries the peek lane's `armed` marker —
    /// armed, or merely aged behind its owner's pending read), against
    /// a durable-only row (no marker at all) and a still-unarmed
    /// rehydrated run (`armed: false`). Enter routes by this: a row
    /// with live backing keeps its run page even when its snapshot is
    /// aged, a row without it reports saved instead.
    pub live_backing: bool,
    /// Whether the row's live read marked it still awaiting its re-arm
    /// (the peek lane's `armed: false` on a rehydrated run): the
    /// kernel listed the run, but no loop drives it yet — the saved
    /// report names the re-arm, never a claim that no live read listed
    /// the row.
    pub rearm_pending: bool,
}

impl LibraryRun {
    /// The owner's display label: the name, else the identity — both
    /// scrubbed before any paint measures or renders them, the same
    /// rule the parse applies to every display string: the
    /// unnamed-owner fallback paints the id's printable copy, never
    /// its raw bytes.
    #[must_use]
    pub fn owner_label(&self) -> String {
        if self.owner_name.is_empty() {
            crate::menu_panel::scrub_controls(&self.owner_id)
        } else {
            self.owner_name.clone()
        }
    }
}

/// Whether a reply is the overview shape at all: a reply without the
/// `runs` LIST is a malformed lane, never zero runs.
#[must_use]
pub fn overview_reply_lists_runs(data: &Value) -> bool {
    data.get("runs").is_some_and(Value::is_array)
}

/// Whether a live read backs one overview row: the daemon's live cache
/// sourced it, so the row carries the peek lane's `armed` marker (null
/// for an executing run, false while it still awaits its re-arm) — the
/// marker's presence is the live cache's own provenance. A durable-only
/// row carries no marker at all, and a `false` marker means no loop
/// drives the run yet.
fn row_has_live_backing(row: &Value) -> bool {
    row.get("armed")
        .is_some_and(|armed| *armed != Value::Bool(false))
}

/// Parse the `overview` reply's run rows: each row is the graph snapshot
/// the run parser reads, plus the owner/source wrapper. Malformed rows
/// drop (a foreign run's row never renders half-built).
#[must_use]
pub fn parse_overview_runs(data: &Value) -> Vec<LibraryRun> {
    data.get("runs")
        .and_then(Value::as_array)
        .map(|runs| {
            runs.iter()
                .filter_map(|row| {
                    let snapshot = parse_run(row)?;
                    // An overview row without a run id has no owner/run
                    // identity: it never renders half-built.
                    if snapshot.run_id.is_empty() {
                        return None;
                    }
                    Some(LibraryRun {
                        snapshot,
                        owner_id: row
                            .get("ownerId")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        owner_name: row
                            .get("ownerName")
                            .and_then(Value::as_str)
                            .map(crate::menu_panel::scrub_controls)
                            .filter(|name| !name.is_empty())
                            .unwrap_or_default(),
                        saved: row.get("saved").and_then(Value::as_bool).unwrap_or(false),
                        live_backing: row_has_live_backing(row),
                        rearm_pending: row.get("armed") == Some(&Value::Bool(false)),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The overview reply's warnings: owners whose records or live graphs
/// stayed unreadable, by identity.
#[must_use]
pub fn parse_overview_warnings(data: &Value) -> Vec<String> {
    data.get("warnings")
        .and_then(Value::as_array)
        .map(|warnings| {
            warnings
                .iter()
                .filter_map(Value::as_str)
                .map(crate::menu_panel::scrub_controls)
                .collect()
        })
        .unwrap_or_default()
}

/// One selectable row, by identity: a machine, or one run — an
/// owner/run pair, so a foreign owner's run and an owned run never share
/// a row identity.
#[derive(Debug, Clone, PartialEq, Eq)]
enum RowKey {
    Machine(String),
    Run { owner: String, run_id: String },
}

/// One key press while the machines page is open, resolved by the view's
/// own key loop (the session UI executes the returned action).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LibraryViewAction {
    /// Navigation only.
    None,
    /// Enter on a machine: the session UI fetches the machine's graph
    /// payload over the lane and folds it back in.
    DrillIn { name: String },
    /// Enter on a run this session owns: the session UI opens the local
    /// run page on it.
    OpenRun { run_id: String },
    /// Enter on this session's own row that no live read backs: a
    /// durable record alone lists it (no kernel read confirms the run),
    /// or its kernel marked it still awaiting its re-arm — either way no
    /// confirmed loop drives the run, so the session UI reports the
    /// read-only state instead; no run page mounts. `rearm_pending`
    /// separates the two backings: the kernel listed the rehydrated
    /// run (its re-arm alone is pending), against a durable record no
    /// live read ever confirmed. An AGED cache row — saved only because
    /// its owner's read is behind — is NOT this action: its run may
    /// still be executing behind the pending read, so it keeps the
    /// run-page drill-in.
    SavedRun { run_id: String, rearm_pending: bool },
    /// Enter on a foreign owner's run: read-only — the session UI reports
    /// which owner to open for controls; no local run page mounts.
    ForeignRun { owner: String },
    /// Esc on the list (or ctrl+c anywhere): close the page.
    Close,
}

/// The machines page: every library machine, every session's active runs
/// nested under their machine (the overview lane's rows, plus the
/// attached session's finished runs retained from its scoped graph
/// cache), the selection, the open drill-in, and the fetch/error state
/// the session UI folds in.
#[derive(Debug)]
pub struct LibraryView {
    machines: Vec<LibraryMachine>,
    /// The page's runs: every session's, from the overview reply (the
    /// attached session's included), in reply order, plus the attached
    /// session's finished runs the session UI retains from the scoped
    /// graph cache.
    runs: Vec<LibraryRun>,
    /// The attached session's own identities (durable and active): a run
    /// row owned by one of them keeps the local run-page drill-in; every
    /// other owner's rows stay read-only.
    own_owner_ids: Vec<String>,
    warnings: Vec<String>,
    /// The overview reply's warnings (owners whose records or live graphs
    /// stayed unreadable), shown while other owners remain listed.
    overview_warnings: Vec<String>,
    /// The overview fetch's OWN failure slot: a failed or malformed
    /// overview reply reports here and a later successful refresh clears
    /// only this slot — the page's other errors (the foreign-row report,
    /// a drill-in failure, the machine list's failure) are not the
    /// cadence's to wipe.
    overview_error: Option<String>,
    /// Whether the first list reply landed (the empty library and the
    /// fetch in flight read differently).
    loaded: bool,
    selected: Option<RowKey>,
    /// The open drill-in; `None` is the list mode.
    detail: Option<DetailView>,
    /// The page's fetch/lane failures (the machine list's failure, a
    /// drill-in failure): errors the page must keep until their own
    /// retry or success clears them — never a selection move.
    error: Option<String>,
    /// The row report's OWN slot: Enter on a foreign or saved row
    /// reports the row it names — and that Enter takes the selection,
    /// so a report never exists while the cursor is still anchored.
    /// The report belongs to its row, so it retires with its row — an
    /// arrow key (a clamped one included), a refresh that moves the
    /// selection, a refresh that flips the selected OWNED row's backing,
    /// and a refresh that renames the selected row's displayed owner
    /// label each retire it — and it never shares the page's fetch
    /// errors, which all of them must preserve.
    row_notice: Option<String>,
    viewport_rows: usize,
    /// Whether the cursor still follows the page's first row: true
    /// from the mount until the user takes the selection — the first
    /// arrow that moves it, or Enter acting on the selected row. While
    /// anchored, every fold re-picks the first row — the page opens
    /// (and stays) on the first LIVE machine whatever order the
    /// replies land in — and afterwards every refresh keeps their row
    /// instead (the identity-stable selection).
    cursor_anchored: bool,
}

/// One rendered list row: the run or machine's identity key when the
/// row is selectable. A wrapped run's continuation lines carry their
/// run's key too — they are rows of that run, so the selection window
/// can hold the whole rendered block; the group separators (the
/// live/quiet separator, the stored-specs heading, and its blank
/// line) carry none.
type ListRow = (Option<RowKey>, Line);

impl LibraryView {
    /// Mount the page with the rows the session UI seeded: the last
    /// overview reply's cached runs (empty until the first fetch lands)
    /// merged with the attached session's scoped graph rows (its
    /// finished runs included — the retention). The machine list lands
    /// through [`Self::apply_machines`] when the open's fetch answers.
    /// `own_owner_ids` carries the attached session's identities, so the
    /// page can tell its own rows from other sessions'.
    #[must_use]
    pub fn new(runs: Vec<LibraryRun>, own_owner_ids: Vec<String>, viewport_rows: usize) -> Self {
        let mut view = Self {
            machines: Vec::new(),
            runs,
            own_owner_ids,
            warnings: Vec::new(),
            overview_warnings: Vec::new(),
            overview_error: None,
            loaded: false,
            selected: None,
            detail: None,
            error: None,
            row_notice: None,
            viewport_rows,
            cursor_anchored: true,
        };
        view.selected = view.rows().into_iter().next();
        view
    }

    pub fn set_viewport_rows(&mut self, rows: usize) {
        self.viewport_rows = rows;
    }

    /// The selectable rows in display order: the machines with a
    /// backed-live run first, then the quiet machines (each machine,
    /// then its runs — each run row an owner/run pair); then the runs
    /// of specs that are not library machines.
    fn rows(&self) -> Vec<RowKey> {
        let (live, quiet) = self.machine_partition();
        let mut rows = Vec::new();
        for machine in live.into_iter().chain(quiet) {
            rows.push(RowKey::Machine(machine.name.clone()));
            rows.extend(self.runs_of(Some(&machine.name)).map(|run| RowKey::Run {
                owner: run.owner_id.clone(),
                run_id: run.snapshot.run_id.clone(),
            }));
        }
        rows.extend(self.runs_of(None).map(|run| RowKey::Run {
            owner: run.owner_id.clone(),
            run_id: run.snapshot.run_id.clone(),
        }));
        rows
    }

    /// The roster's live-first partition, the ONE order the arrows'
    /// walk and the paint both consume: machines with a backed-live
    /// run first, then the quiet ones, reply order inside each group —
    /// so the cursor and the painted rows can never desync.
    fn machine_partition(&self) -> (Vec<&LibraryMachine>, Vec<&LibraryMachine>) {
        self.machines
            .iter()
            .partition(|machine| self.backed_live_run_count(&machine.name) > 0)
    }

    /// The machine's backed-live run count — the badge's exact rule:
    /// a run with `!saved && is_live()`, never a saved snapshot in a
    /// live state (a durable record, an unarmed or stale cached row).
    /// Distinct from the free [`crate::factory_view::live_run_count`]
    /// (the `/machine` gate's plain `is_live()` count over a graph
    /// reply).
    fn backed_live_run_count(&self, machine: &str) -> usize {
        self.runs_of(Some(machine))
            .filter(|run| !run.saved && run.snapshot.is_live())
            .count()
    }

    /// The runs of one machine, or (`None`) the runs whose spec is no
    /// library machine, in reply order.
    fn runs_of<'a>(
        &'a self,
        machine: Option<&'a str>,
    ) -> impl Iterator<Item = &'a LibraryRun> + 'a {
        self.runs.iter().filter(move |run| match machine {
            Some(name) => run.snapshot.spec_id == name,
            None => !self
                .machines
                .iter()
                .any(|machine| machine.name == run.snapshot.spec_id),
        })
    }

    /// Whether an owner identity is the attached session's own — the
    /// owner check behind the run row's drill-in: an owned row opens the
    /// local run page, a foreign row stays read-only.
    fn owns(&self, owner: &str) -> bool {
        self.own_owner_ids.iter().any(|id| id == owner)
    }

    /// The selected machine, when a machine row is selected.
    #[must_use]
    pub fn selected_machine(&self) -> Option<&LibraryMachine> {
        match &self.selected {
            Some(RowKey::Machine(name)) => {
                self.machines.iter().find(|machine| &machine.name == name)
            }
            Some(RowKey::Run { .. }) | None => None,
        }
    }

    /// Record one fetch/lane failure from the session UI (the machine
    /// list's failure, a drill-in failure — daemon-provided text painted
    /// on the view's error row, so it scrubs). Only its own success or
    /// retry clears it, never a selection move.
    pub fn set_error(&mut self, error: Option<String>) {
        self.error = error.map(|text| crate::menu_panel::scrub_controls(&text));
    }

    /// Record the ROW REPORT (Enter on a foreign or saved row): the
    /// notice belongs to the row it names, so it retires with its row —
    /// an arrow key (a clamped one included), a refresh that moves the
    /// selection, a refresh that flips the selected OWNED row's backing,
    /// and a refresh that renames the selected row's displayed owner
    /// label each retire it. It never shares the page's fetch errors —
    /// those the report's retirements must preserve.
    pub fn set_row_notice(&mut self, notice: Option<String>) {
        self.row_notice = notice.map(|text| crate::menu_panel::scrub_controls(&text));
    }

    /// Record the overview fetch's own failure (the cadence's slot, cleared
    /// only by a later successful overview refresh — the page's other
    /// errors are not the cadence's to wipe).
    pub fn set_overview_error(&mut self, error: Option<String>) {
        self.overview_error = error.map(|text| crate::menu_panel::scrub_controls(&text));
    }

    /// Apply one list reply: the machines and warnings replace the old
    /// ones, and the selection follows the anchor — the first row while
    /// the cursor is still anchored, the same row identity afterwards
    /// (a row that left falls back to the first row).
    pub fn apply_machines(&mut self, machines: Vec<LibraryMachine>, warnings: Vec<String>) {
        self.machines = machines;
        self.warnings = warnings;
        self.loaded = true;
        self.keep_selection();
    }

    /// Apply one refreshed overview batch: the rows replace the old ones
    /// and the reply's warnings replace the old ones (the selection
    /// follows the anchor — the first row while the cursor is still
    /// anchored, its own row afterwards). A successful batch clears the
    /// overview's OWN error slot only — never the page's other errors.
    /// A same-row refresh that flips the selected OWNED row's backing
    /// retires its row report with it: the saved-row report claims no
    /// live read backs the row, and a refresh that restores (or
    /// withdraws) the backing makes that claim false. The report's two
    /// saved wordings — no live read at all, against a kernel-listed
    /// run awaiting its re-arm — share the saved marker, so the re-arm
    /// marker belongs to the fingerprint a flip retires on. A same-row
    /// refresh that renames the row's displayed owner label retires
    /// the report too: the guidance names the label, and a rename
    /// leaves the report naming a label the row no longer carries.
    pub fn apply_overview(&mut self, runs: Vec<LibraryRun>, warnings: Vec<String>) {
        let backing_before = self.selected_owned_run_backing();
        let label_before = self.selected_row_owner_label();
        self.runs = runs;
        self.overview_warnings = warnings;
        self.overview_error = None;
        self.keep_selection();
        if backing_before.is_some_and(|before| self.selected_owned_run_backing() != Some(before)) {
            self.row_notice = None;
        }
        if label_before.is_some_and(|before| {
            self.selected_row_owner_label().as_deref() != Some(before.as_str())
        }) {
            self.row_notice = None;
        }
    }

    /// The selected OWNED run row's backing fingerprint — its saved
    /// marker, its live-backing flag, and its re-arm marker, the three
    /// flags a same-row refresh may flip (a durable-only row and a
    /// kernel-listed unarmed row share the first two; only the re-arm
    /// marker tells the report's two saved wordings apart). `None`
    /// when no run row is selected, the selected row is another
    /// owner's (its report is owner guidance, which a backing flip
    /// does not falsify), or the row left the batch.
    fn selected_owned_run_backing(&self) -> Option<(bool, bool, bool)> {
        let RowKey::Run { owner, run_id } = self.selected.as_ref()? else {
            return None;
        };
        if !self.owns(owner) {
            return None;
        }
        self.runs
            .iter()
            .find(|run| &run.owner_id == owner && &run.snapshot.run_id == run_id)
            .map(|run| (run.saved, run.live_backing, run.rearm_pending))
    }

    /// The selected run row's DISPLAYED owner label (the name, else the
    /// identity) — what a row report names when it names the row's
    /// owner. `None` when no run row is selected or the row left the
    /// batch.
    fn selected_row_owner_label(&self) -> Option<String> {
        let RowKey::Run { owner, run_id } = self.selected.as_ref()? else {
            return None;
        };
        self.runs
            .iter()
            .find(|run| &run.owner_id == owner && &run.snapshot.run_id == run_id)
            .map(LibraryRun::owner_label)
    }

    fn keep_selection(&mut self) {
        let rows = self.rows();
        if self.cursor_anchored {
            // The cursor still follows the page's first row, so the
            // opening promise holds for EVERY reply order: the machines
            // may fold before the live runs (the cursor rides the
            // reply-first quiet machine until its live runs arrive) or
            // after them, and either way the page opens — and stays —
            // on the first LIVE machine until the user takes the
            // selection (the first arrow that moves the cursor, or
            // Enter acting on the selected row).
            self.selected = rows.into_iter().next();
            return;
        }
        if self.selected.as_ref().is_none_or(|key| !rows.contains(key)) {
            // The selected row left, so the fallback picks another:
            // the row report belongs to the row it names, so it retires
            // with the identity change — a same-row refresh keeps it,
            // and the page's fetch errors are never this fallback's to
            // touch.
            self.selected = rows.into_iter().next();
            self.row_notice = None;
        }
    }

    /// Fold one drill-in reply: the machine's detail mounts and the window
    /// resets to the document's top; a reply that cannot parse reports the
    /// lane error on the view's error row instead.
    pub fn apply_detail(&mut self, name: &str, data: &Value) {
        match LibraryDetail::parse(data) {
            Some(detail) => {
                self.detail = Some(DetailView::new(detail));
                self.error = None;
            }
            None => {
                self.set_error(Some(format!("malformed machine reply for machine {name}")));
            }
        }
    }

    /// One key press on the activity pages' picker keyset: the arrows walk
    /// the rows (or scroll the open drill-in), Enter drills into a machine
    /// or opens a run, and Esc backs out of the drill-in before it closes
    /// the page.
    #[must_use]
    pub fn handle_key(&mut self, key: &str, kb: &KeybindingsManager) -> LibraryViewAction {
        if let Some(detail) = self.detail.as_mut() {
            if detail.handle_key(key, kb, self.viewport_rows, self.error.is_some())
                == DetailKey::Leave
            {
                self.detail = None;
            }
            return LibraryViewAction::None;
        }
        if key == "ctrl+c" || kb.matches(key, "tui.select.cancel") {
            return LibraryViewAction::Close;
        }
        if kb.matches(key, "tui.select.up") || kb.matches(key, "tui.select.down") {
            let delta: isize = if kb.matches(key, "tui.select.up") {
                -1
            } else {
                1
            };
            self.move_selection(delta);
            return LibraryViewAction::None;
        }
        if kb.matches(key, "tui.select.confirm") {
            // Enter acts on the selected row, so the mount's anchoring
            // ends with the act — the same release an arrow's move
            // grants. The overview cadence keeps folding behind an
            // open drill-in or run page, and an anchored fold would
            // re-pick the first row behind the user's back: Esc would
            // return to a row they never chose, and an anchored
            // identity change would retire the row report Enter just
            // raised. Enter with no selection acts on nothing and
            // keeps the anchor.
            if self.selected.is_some() {
                self.cursor_anchored = false;
            }
            match &self.selected {
                Some(RowKey::Machine(name)) => {
                    return LibraryViewAction::DrillIn { name: name.clone() };
                }
                Some(RowKey::Run { owner, run_id }) => {
                    // The owner check: only this session's own rows keep
                    // the local run-page drill-in. A foreign owner's row
                    // reports itself instead — no local run page mounts
                    // and no control request leaves this session.
                    let owned = self.owns(owner);
                    let run = self
                        .runs
                        .iter()
                        .find(|run| &run.owner_id == owner && &run.snapshot.run_id == run_id);
                    return if !owned {
                        LibraryViewAction::ForeignRun {
                            // The report names the row's owner: the
                            // row's label scrubbed (the identity's
                            // printable copy when the owner has no
                            // name), and the report's own slot scrubs
                            // again — a raw id never rides the notice.
                            owner: run.map_or_else(|| owner.clone(), LibraryRun::owner_label),
                        }
                    } else if run.is_some_and(|run| !run.live_backing) {
                        // An owned row no live read backs (a durable
                        // record alone, or a run still awaiting its
                        // re-arm) has no confirmed loop driving it. Report
                        // the read-only state, exactly as a foreign row
                        // reports its owner — an AGED row (its owner's
                        // read merely behind) keeps the drill-in below.
                        LibraryViewAction::SavedRun {
                            run_id: run_id.clone(),
                            rearm_pending: run.is_some_and(|run| run.rearm_pending),
                        }
                    } else {
                        LibraryViewAction::OpenRun {
                            run_id: run_id.clone(),
                        }
                    };
                }
                None => {}
            }
        }
        LibraryViewAction::None
    }

    fn move_selection(&mut self, delta: isize) {
        let rows = self.rows();
        if rows.is_empty() {
            return;
        }
        let at = self
            .selected
            .as_ref()
            .and_then(|key| rows.iter().position(|row| row == key))
            .unwrap_or(0);
        let next = (at as isize + delta).clamp(0, rows.len() as isize - 1) as usize;
        let before = self.selected.clone();
        self.selected = rows.into_iter().nth(next);
        // The clamp can hold the cursor in place (Up on the top row):
        // nothing moved, so the anchor holds — the opening promise
        // still binds the next fold.
        if self.selected != before {
            // The user has moved the cursor: the mount's anchoring ends
            // here, so every later refresh keeps their row (the
            // identity-stable selection) instead of re-picking the first.
            self.cursor_anchored = false;
        }
        // Every arrow key retires the row report (a foreign row's owner
        // notice, an owned saved row's state): the report belongs to the
        // row it names, never a sticky notice the cursor leaves behind —
        // a clamped arrow included, the unclamped move's own rule. The
        // page's fetch errors and the overview's own slot are not the
        // move's to touch — a failed machine-list fetch must survive the
        // move that makes the list walkable again.
        self.row_notice = None;
    }

    /// Render the page: the list, or the open drill-in's document, with
    /// the error row and the key hint pinned at the frame's end.
    #[must_use]
    pub fn render(&self, theme: &Theme, width: usize, kb: &KeybindingsManager) -> Vec<Line> {
        match &self.detail {
            Some(detail) => {
                detail.render(theme, width, kb, self.viewport_rows, self.error.as_deref())
            }
            None => self.render_list(theme, width, kb),
        }
    }

    /// One run row: its name, owner, state, active state ids, and
    /// progress, nested under its machine — a live row's age, a saved
    /// snapshot's marker (a durable record never fabricates an elapsed
    /// time). The name and owner label truncate to the space the frame
    /// leaves after the state and the qualifier, so the marker — the
    /// only visible difference between a stale snapshot and a live one
    /// — never clips off behind long labels. The active ids and
    /// progress counters ride the identity line when the whole segment
    /// fits; a frame too narrow for identity and progress both wraps
    /// the progress under the identity, whole units per continuation
    /// line, so the counters never clip behind the state ids — a
    /// foreign row has no drill-in, so the list is the only place its
    /// progress paints, and labels crowding the frame never clip it
    /// off entirely.
    fn run_rows(theme: &Theme, run: &LibraryRun, selected: bool, width: usize) -> Vec<Line> {
        let mut row: Line = vec![Span::raw(if selected { "    ▸ " } else { "      " })];
        row.push(theme.fg_span(ThemeColor::Dim, "↳ "));
        let state = run
            .snapshot
            .state
            .clone()
            .unwrap_or_else(|| "unknown".to_string());
        let qualifier = if run.saved {
            " · saved".to_string()
        } else {
            format!(" · {}", format_duration(run.snapshot.elapsed_ms))
        };
        // The row's fixed tail — the state and the saved/live qualifier
        // — always paints inside the frame: the two variable-width
        // labels before it truncate to what the frame leaves after the
        // tail (8 columns of cursor and glyph, the tail's separator,
        // the state, and the qualifier, then the labels' own " · "),
        // splitting that space fairly — each label keeps at least half
        // of it, and a short label's half goes to the other.
        let budget = width.saturating_sub(8 + 3 + str_width(&state) + str_width(&qualifier));
        let labels = budget.saturating_sub(3);
        let half = labels / 2;
        let name = run.snapshot.display_name();
        let owner = run.owner_label();
        let name_cap = if str_width(&owner) > half {
            half
        } else {
            labels.saturating_sub(str_width(&owner))
        };
        let owner_cap = if str_width(&name) > half {
            half
        } else {
            labels.saturating_sub(str_width(&name))
        };
        let name = truncate_to_width(&name, name_cap, "…");
        let owner = truncate_to_width(&owner, owner_cap, "…");
        // The identity's painted width — the prefix, both labels with
        // their separators, the state, and the qualifier — computed
        // before the spans take the strings: whatever the frame leaves
        // beyond it is the progress segment's room.
        let used = 8
            + str_width(&name)
            + 3
            + str_width(&owner)
            + 3
            + str_width(&state)
            + str_width(&qualifier);
        row.push(theme.fg_span(
            if selected {
                ThemeColor::Text
            } else {
                ThemeColor::Muted
            },
            name,
        ));
        row.push(theme.fg_span(ThemeColor::Muted, format!(" · {owner}")));
        row.push(theme.fg_span(
            run_state_color(run.snapshot.state.as_deref()),
            format!(" · {state}"),
        ));
        // The saved/live qualifier rides directly after the state,
        // BEFORE the variable-width fields (active ids, counters): the
        // list truncates every row at the frame width, so a TRAILING
        // qualifier clips off exactly the rows that carry progress —
        // and the marker is the only visible difference between a
        // stale snapshot and a live one.
        row.push(theme.fg_span(
            if run.saved {
                ThemeColor::Muted
            } else {
                ThemeColor::Dim
            },
            qualifier,
        ));
        // The active state ids and the progress counters, live or
        // persisted: no completion percentage — machines can loop, and
        // child counts are not a fixed number of remaining states. The
        // ids and the three counters are the segment's units: they ride
        // the identity line when the whole segment fits, and a frame too
        // narrow for it wraps the units under the identity across as
        // many continuation lines as they need — packing whole units per
        // line — so the counters never clip behind the ids. A foreign
        // row has no drill-in, so the list is the only place its
        // progress paints; labels crowding the frame never cut it off.
        let active = run.snapshot.active_state_ids();
        let mut units: Vec<String> = Vec::new();
        if !active.is_empty() {
            units.push(active.join("+"));
        }
        if let Some(usage) = &run.snapshot.usage {
            if usage.spawns > 0
                || usage.settled > 0
                || usage.running > 0
                || usage.transitions_fired > 0
            {
                units.push(format!("{} spawns", usage.spawns));
                units.push(format!("{} running", usage.running));
                units.push(format!("{} transitions", usage.transitions_fired));
            }
        }
        if units.is_empty() {
            return vec![row];
        }
        let joined = units.join(" · ");
        if 3 + str_width(&joined) <= width.saturating_sub(used) {
            row.push(theme.fg_span(ThemeColor::Dim, format!(" · {joined}")));
            return vec![row];
        }
        let room = width.saturating_sub(8);
        let mut lines = vec![row];
        let mut current = String::new();
        for unit in units {
            if !current.is_empty()
                && str_width(&current) + str_width(" · ") + str_width(&unit) > room
            {
                lines.push(vec![
                    Span::raw(" ".repeat(8)),
                    theme.fg_span(ThemeColor::Dim, current),
                ]);
                current = unit;
            } else {
                let _ = write!(
                    current,
                    "{}{unit}",
                    if current.is_empty() { "" } else { " · " }
                );
            }
        }
        if !current.is_empty() {
            lines.push(vec![
                Span::raw(" ".repeat(8)),
                theme.fg_span(ThemeColor::Dim, current),
            ]);
        }
        lines
    }

    fn machine_row(&self, theme: &Theme, machine: &LibraryMachine, selected: bool) -> Line {
        let mut row: Line = vec![Span::raw(if selected { "  ▸ " } else { "    " })];
        // The status glyph rides between the cursor and the name: the
        // badge's exact rule decides its color, so a machine with a
        // backed-live run reads live while a quiet one stays dim. The
        // glyph is static — the page's own cadence repaints it, never
        // a new timer.
        let live = self.backed_live_run_count(&machine.name);
        row.push(theme.fg_span(
            if live > 0 {
                ThemeColor::Success
            } else {
                ThemeColor::Dim
            },
            if live > 0 { "◈ " } else { "• " },
        ));
        row.push(theme.fg_span(
            if selected {
                ThemeColor::Text
            } else {
                ThemeColor::Muted
            },
            machine.name.clone(),
        ));
        let kind = if machine.kind == "directory" {
            " dir"
        } else {
            ""
        };
        row.push(theme.fg_span(ThemeColor::Dim, format!(" [{}{kind}]", machine.source)));
        // The badge counts BACKED-LIVE rows only: a saved snapshot in a
        // live state (a durable record, an unarmed or stale cached row)
        // stays visible below but never inflates the live count.
        if live > 0 {
            row.push(theme.fg_span(ThemeColor::Success, format!(" ● {live} live")));
        }
        row.push(theme.fg_span(ThemeColor::Muted, format!(" — {}", machine.description)));
        row
    }

    /// One machine's painted block: its row, then its runs nested
    /// under it — the same rows [`Self::rows()`] yields for the
    /// machine, in the same order.
    fn push_machine_block(
        &self,
        body: &mut Vec<ListRow>,
        theme: &Theme,
        machine: &LibraryMachine,
        width: usize,
    ) {
        let key = RowKey::Machine(machine.name.clone());
        let selected = self.selected.as_ref() == Some(&key);
        let row = self.machine_row(theme, machine, selected);
        body.push((Some(key), row));
        self.push_run_rows(body, theme, Some(&machine.name), width);
    }

    /// One group's run rows — a machine's nested runs, or (`None`) the
    /// runs of specs no library machine carries — each row carrying
    /// its key through its wrapped continuation lines.
    fn push_run_rows(
        &self,
        body: &mut Vec<ListRow>,
        theme: &Theme,
        machine: Option<&str>,
        width: usize,
    ) {
        for run in self.runs_of(machine) {
            let key = RowKey::Run {
                owner: run.owner_id.clone(),
                run_id: run.snapshot.run_id.clone(),
            };
            let selected = self.selected.as_ref() == Some(&key);
            let mut lines = Self::run_rows(theme, run, selected, width).into_iter();
            body.push((
                Some(key.clone()),
                lines.next().expect("the run's identity line"),
            ));
            for line in lines {
                body.push((Some(key.clone()), line));
            }
        }
    }

    /// The list body: machines with their runs nested under them — the
    /// live-first partition, one blank non-selectable separator row
    /// between the live and the quiet groups while both paint — then
    /// the runs of stored specs under their own heading. One order rules
    /// both the arrows' walk and the paint (the same partition as
    /// [`Self::rows()`], the reply's own order inside each group), so
    /// the cursor and the painted rows can never desync.
    fn list_rows(&self, theme: &Theme, width: usize) -> Vec<ListRow> {
        let mut body: Vec<ListRow> = Vec::new();
        let (live, quiet) = self.machine_partition();
        for machine in &live {
            self.push_machine_block(&mut body, theme, machine, width);
        }
        // The separator sits between the two groups, never around one.
        if !live.is_empty() && !quiet.is_empty() {
            body.push((None, vec![Span::raw("")]));
        }
        for machine in &quiet {
            self.push_machine_block(&mut body, theme, machine, width);
        }
        if self.runs_of(None).next().is_some() {
            body.push((None, vec![Span::raw("")]));
            body.push((
                None,
                vec![
                    Span::raw("  "),
                    theme.fg_span(ThemeColor::Dim, "runs of stored specs"),
                ],
            ));
            self.push_run_rows(&mut body, theme, /*machine*/ None, width);
        }
        body
    }

    /// The list mode: the header, the rows (the selected one marked), the
    /// empty or loading state, the warnings, the error row, and the hint —
    /// the window following the selection over a long list.
    fn render_list(&self, theme: &Theme, width: usize, kb: &KeybindingsManager) -> Vec<Line> {
        // The title's live count matches the badge's rule: BACKED-LIVE
        // rows only (`is_live` alone would count every saved snapshot in
        // a live state — rows whose owner's kernel is not confirming
        // them now).
        let live = self
            .runs
            .iter()
            .filter(|run| !run.saved && run.snapshot.is_live())
            .count();
        let mut title = if self.loaded {
            format!("machines · {}", self.machines.len())
        } else {
            "machines".to_string()
        };
        if live > 0 {
            let _ = write!(
                title,
                " · {live} live run{}",
                if live == 1 { "" } else { "s" }
            );
        }
        let mut header = vec![vec![
            Span::raw("  "),
            theme.fg_span(ThemeColor::ToolTitle, title),
        ]];
        header.push(vec![Span::raw("")]);
        let body = self.list_rows(theme, width);
        let mut tail: Vec<Line> = Vec::new();
        if self.machines.is_empty() {
            let note = if self.loaded {
                "No machines in the library (add one with prime-agent machine import, or a machine directory under ~/.prime/agent/machines)."
            } else {
                "Loading the machine library…"
            };
            tail.push(vec![
                Span::raw("  "),
                theme.fg_span(ThemeColor::Muted, note),
            ]);
        }
        if let Some(first) = self.warnings.first() {
            tail.push(vec![Span::raw("")]);
            let count = self.warnings.len();
            tail.push(vec![
                Span::raw("  "),
                theme.fg_span(
                    ThemeColor::Warning,
                    format!(
                        "{count} machine{} failed to load: {first}",
                        if count == 1 { "" } else { "s" }
                    ),
                ),
            ]);
        }
        // The overview's partial-failure contract: an unreadable owner or
        // record warns while every other owner stays listed. The count is
        // of warnings, not sessions (one session can warn twice), so the
        // line says exactly that.
        if let Some(first) = self.overview_warnings.first() {
            tail.push(vec![Span::raw("")]);
            let count = self.overview_warnings.len();
            tail.push(vec![
                Span::raw("  "),
                theme.fg_span(
                    ThemeColor::Warning,
                    format!(
                        "{count} overview warning{}: {first}",
                        if count == 1 { "" } else { "s" }
                    ),
                ),
            ]);
        }
        if let Some(error) = &self.overview_error {
            tail.push(vec![Span::raw("")]);
            tail.push(vec![
                Span::raw("  "),
                theme.fg_span(ThemeColor::Error, format!("Error: {error}")),
            ]);
        }
        if let Some(error) = &self.error {
            tail.push(vec![Span::raw("")]);
            tail.push(vec![
                Span::raw("  "),
                theme.fg_span(ThemeColor::Error, format!("Error: {error}")),
            ]);
        }
        // The row report (a foreign row's owner notice, an owned saved
        // row's state): a report, not an error — painted without the
        // error prefix, retired by the next arrow key.
        if let Some(notice) = &self.row_notice {
            tail.push(vec![Span::raw("")]);
            tail.push(vec![
                Span::raw("  "),
                theme.fg_span(ThemeColor::Warning, notice.clone()),
            ]);
        }
        tail.push(vec![Span::raw("")]);
        tail.push(vec![
            Span::raw("  "),
            theme.fg_span(ThemeColor::Dim, list_hint(kb, "move", "close")),
        ]);
        // The window follows the selection: the header and the tail stay
        // pinned, and the body keeps the selected row's whole rendered
        // block in view — the keyed identity line plus the continuation
        // lines that share its key (a wrapped progress segment). A
        // window anchored on the identity line alone parks it on the
        // body's last line and cuts the continuation, so a long list
        // never paints the selected run's state and progress.
        let budget = self.viewport_rows.max(header.len() + tail.len() + 1);
        let body_budget = budget.saturating_sub(header.len() + tail.len()).max(1);
        let selected_at = body
            .iter()
            .position(|(key, _)| key.is_some() && key.as_ref() == self.selected.as_ref())
            .unwrap_or(0);
        let block_end = selected_at
            + body[selected_at..]
                .iter()
                .position(|(key, _)| key.as_ref() != self.selected.as_ref())
                .unwrap_or(body.len() - selected_at);
        let start = if body.len() > body_budget {
            // Anchor the block's LAST line on the body's last line
            // (the one-line-row case reduces to the identity anchor);
            // a block taller than the budget keeps its identity line
            // instead — the selectable row never leaves the window.
            block_end.saturating_sub(body_budget).min(selected_at)
        } else {
            0
        };
        header.extend(
            body.into_iter()
                .skip(start)
                .take(body_budget)
                .map(|(_, row)| row),
        );
        while header.len() < budget.saturating_sub(tail.len()) {
            header.push(vec![]);
        }
        header.extend(tail);
        header
            .into_iter()
            .map(|row| truncate_line(&row, width, ""))
            .collect()
    }
}

/// The page's key hint: the arrows, Enter, and Esc, with the middle action
/// named by the mode (move on the list, scroll on the drill-in) and the
/// close named by it too (close on the list, back out of the drill-in).
fn list_hint(kb: &KeybindingsManager, middle: &str, close: &str) -> String {
    let key = |binding: &str, fallback: &str| {
        kb.first_key(binding)
            .map_or_else(|| fallback.to_string(), |key| format_key_text(&key))
    };
    format!(
        "{}/{} {middle} · {} open · {} {close}",
        key("tui.select.up", "\u{2191}"),
        key("tui.select.down", "\u{2193}"),
        key("tui.select.confirm", "Enter"),
        key("tui.select.cancel", "Esc"),
    )
}

mod detail;
#[cfg(test)]
mod tests;

pub use detail::LibraryDetail;
use detail::{DetailKey, DetailView};
