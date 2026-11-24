//! Every session the daemon knows, from one set of rules: the saved
//! catalog of a sessions directory, the file-backed residents, the
//! roster-known top-level sessions outside the default directory (a
//! passivated owner opened from a custom `sessionDir`), and the passive
//! RLM children of all of them. `list` with `all` and the factory overview
//! both read it.

use std::collections::{BTreeMap, HashSet};

use super::{paths, Arc, PathBuf, Result, Supervisor, Value};
use crate::lease::canonical_session_path;
use crate::rlm_ledger::RlmSpawnLedger;
use crate::rlm_roster::{walk_passive_rlm_children, PassiveRlmChild, RosterWalkRoot};
use crate::session_store::{read_session_info, SessionInfo};

/// One file-backed resident: its session file and live active id.
pub(super) struct ResidentFile {
    pub(super) session_file: PathBuf,
    pub(super) active_session_id: String,
}

/// The catalog's inputs, gathered under the supervisor's locks.
pub(super) struct KnownSessionRoots {
    /// The directory whose saved sessions list.
    pub(super) catalog_dir: PathBuf,
    pub(super) residents: Vec<ResidentFile>,
    /// Roster-known top-level session files outside the default directory.
    pub(super) roster_files: Vec<PathBuf>,
    /// One spawn ledger per directory a root lives in, the default one
    /// included.
    pub(super) ledgers: BTreeMap<PathBuf, Arc<RlmSpawnLedger>>,
}

/// The catalog.
pub(super) struct KnownSessions {
    /// The catalog directory's saved sessions, then the roster-known roots,
    /// each with the index (into the residents passed in) of the resident
    /// hosting its file.
    pub(super) saved: Vec<(SessionInfo, Option<usize>)>,
    /// Residents whose file has no saved row.
    pub(super) resident_only: Vec<usize>,
    /// The passive RLM children of every root, each once.
    pub(super) children: Vec<PassiveRlmChild>,
    /// Partial failures: an unreadable catalog, a failed ledger walk.
    pub(super) warnings: Vec<String>,
}

impl Supervisor {
    /// Gather the catalog's inputs for `catalog_dir` (the default sessions
    /// directory unless a command names another).
    pub(super) async fn known_session_roots(
        self: &Arc<Self>,
        catalog_dir: PathBuf,
        residents: Vec<ResidentFile>,
    ) -> Result<KnownSessionRoots> {
        let default_dir = paths::sessions_dir(&self.options.agent_dir)?;
        let resident_files: HashSet<PathBuf> = residents
            .iter()
            .map(|resident| canonical_session_path(&resident.session_file))
            .collect();
        let mut roster_files = Vec::new();
        {
            let roster = self.roster.lock().unwrap();
            let mut seen = HashSet::new();
            for entry in roster.entries() {
                let summary = &entry.summary;
                // A subagent joins through its parent's ledger walk.
                if summary.get("runtimeKind").and_then(Value::as_str) == Some("subagent") {
                    continue;
                }
                let Some(file) = summary
                    .get("sessionFile")
                    .and_then(Value::as_str)
                    .filter(|file| !file.is_empty())
                else {
                    continue;
                };
                let path = PathBuf::from(file);
                if path.parent() == Some(default_dir.as_path()) {
                    continue;
                }
                let canonical = canonical_session_path(&path);
                if resident_files.contains(&canonical) || !seen.insert(canonical) {
                    continue;
                }
                roster_files.push(path);
            }
        }
        // Production admission writes every spawn edge to the default
        // ledger whatever `sessionDir` the create carried, while a custom
        // directory's own ledger holds older edges: the walk reads the
        // default ledger and the ledger of every directory a root lives in.
        let mut ledgers = BTreeMap::new();
        ledgers.insert(default_dir.clone(), self.rlm_spawn_ledger_for(None).await?);
        let mut dirs: Vec<PathBuf> = std::iter::once(catalog_dir.clone())
            .chain(
                residents
                    .iter()
                    .map(|resident| resident.session_file.clone())
                    .chain(roster_files.iter().cloned())
                    .filter_map(|file| file.parent().map(PathBuf::from)),
            )
            .collect();
        dirs.sort();
        dirs.dedup();
        for dir in dirs {
            if let std::collections::btree_map::Entry::Vacant(slot) = ledgers.entry(dir) {
                let ledger = self
                    .rlm_spawn_ledger_for(Some(&slot.key().to_string_lossy()))
                    .await?;
                slot.insert(ledger);
            }
        }
        Ok(KnownSessionRoots {
            catalog_dir,
            residents,
            roster_files,
            ledgers,
        })
    }
}

/// Read the catalog: pure filesystem reads, no worker. `cwd` keeps only the
/// saved and roster-known sessions of that working directory.
pub(super) fn scan_known_sessions(roots: &KnownSessionRoots, cwd: Option<&str>) -> KnownSessions {
    let mut warnings = Vec::new();
    // `list_sessions` folds a failed `read_dir` into an empty list, so an
    // unreadable (not missing) directory is probed first and warns.
    let mut infos = match std::fs::read_dir(&roots.catalog_dir) {
        Ok(_) => crate::session_store::list_sessions(&roots.catalog_dir),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(error) => {
            warnings.push(format!("the sessions catalog is unreadable: {error}"));
            Vec::new()
        }
    };
    let listed: HashSet<PathBuf> = infos
        .iter()
        .map(|info| canonical_session_path(&info.path))
        .collect();
    infos.extend(
        roots
            .roster_files
            .iter()
            .filter(|file| !listed.contains(&canonical_session_path(file)))
            .filter_map(|file| read_session_info(file)),
    );
    if let Some(cwd) = cwd {
        infos.retain(|info| info.cwd == cwd);
    }
    let resident_files: Vec<PathBuf> = roots
        .residents
        .iter()
        .map(|resident| canonical_session_path(&resident.session_file))
        .collect();
    let mut hosted = vec![false; resident_files.len()];
    let mut walk_roots: Vec<RosterWalkRoot> = Vec::new();
    let saved: Vec<(SessionInfo, Option<usize>)> = infos
        .into_iter()
        .map(|info| {
            let canonical = canonical_session_path(&info.path);
            let resident = resident_files.iter().position(|file| *file == canonical);
            if let Some(index) = resident {
                hosted[index] = true;
            }
            walk_roots.push(RosterWalkRoot {
                session_file: info.path.clone(),
                active_session_id: resident
                    .map(|index| roots.residents[index].active_session_id.clone()),
            });
            (info, resident)
        })
        .collect();
    let resident_only: Vec<usize> = (0..roots.residents.len())
        .filter(|index| !hosted[*index])
        .collect();
    for &index in &resident_only {
        let resident = &roots.residents[index];
        walk_roots.push(RosterWalkRoot {
            session_file: resident.session_file.clone(),
            active_session_id: Some(resident.active_session_id.clone()),
        });
    }
    // Every ledger walks with every root, so a resident (a root) never
    // reads as another root's passive child.
    let mut children: Vec<PassiveRlmChild> = Vec::new();
    let mut seen_children = HashSet::new();
    for ledger in roots.ledgers.values() {
        match walk_passive_rlm_children(ledger, &walk_roots) {
            Ok(walked) => children.extend(walked.into_iter().filter(|child| {
                seen_children.insert(canonical_session_path(&child.info.path))
            })),
            Err(error) => {
                warnings.push(format!("Could not walk passive RLM children: {error:#}"));
            }
        }
    }
    KnownSessions {
        saved,
        resident_only,
        children,
        warnings,
    }
}
