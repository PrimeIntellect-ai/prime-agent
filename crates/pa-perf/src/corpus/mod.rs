//! The deterministic corpus generator: one `generate` pass writes the full
//! agent-state layout under an isolated `--out` dir and returns the manifest
//! the bench harness needles read.

pub(crate) mod artifacts;
pub(crate) mod rows;

use std::path::{Path, PathBuf};

use anyhow::Context;
use clap::ValueEnum;
use pa_daemon::rlm_ledger::RlmSpawnLedger;
use serde::{Deserialize, Serialize};

use crate::rng::Rng;
use artifacts::SubagentTree;
use rows::SessionSpec;

/// The named corpus profiles (sizes overridable knob by knob).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ValueEnum)]
#[serde(rename_all = "lowercase")]
pub enum Profile {
    Small,
    Medium,
    Large,
    Xl,
}

impl Profile {
    /// The profile's knob defaults.
    #[must_use]
    pub fn defaults(self) -> CorpusOptions {
        let (sessions, rows, child_rows, fanout, depth, tree_parents, wide, archive, cwd_files) =
            match self {
                Self::Small => (10, 100, 40, 2, 2, 2, 0, 3, 200),
                Self::Medium => (100, 2_000, 100, 3, 2, 5, 0, 20, 2_000),
                Self::Large => (1_000, 10_000, 150, 3, 3, 8, 110, 200, 4_000),
                Self::Xl => (2_500, 400, 80, 2, 2, 10, 0, 500, 2_000),
            };
        CorpusOptions {
            profile: self,
            out: PathBuf::new(),
            seed: 7,
            sessions,
            rows,
            child_rows,
            huge_rows: rows.saturating_mul(2).max(2_000),
            fanout,
            depth,
            tree_parents,
            wide_children: wide,
            archive,
            cwd_files,
            artifacts: true,
            cache: CacheMode::Cold,
        }
    }
}

/// Whether the warm-up pass runs the product's window-store open over the
/// generated session files (writing their window-cache sidecars).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ValueEnum)]
#[serde(rename_all = "lowercase")]
pub enum CacheMode {
    Cold,
    Warm,
}

/// Every corpus knob; all overridable from the CLI (README.md documents each).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CorpusOptions {
    pub profile: Profile,
    pub out: PathBuf,
    pub seed: u64,
    /// Top-level sessions in the sessions dir.
    pub sessions: usize,
    /// Rows per session (the huge session gets `huge_rows`).
    pub rows: usize,
    /// Rows per subagent child session.
    pub child_rows: usize,
    /// Rows of the one huge session (the open-session scenario's target).
    pub huge_rows: usize,
    /// Subagent children per parent per level.
    pub fanout: usize,
    /// Subagent tree depth (levels below the parent session).
    pub depth: u32,
    /// How many sessions grow a subagent tree.
    pub tree_parents: usize,
    /// One parent grows this many direct children (the operator's ~110-wide
    /// real parent); 0 disables.
    pub wide_children: usize,
    /// Sessions in sessions-archive/.
    pub archive: usize,
    /// Files in the generated project dir (the sessions' cwd, the
    /// @-completion walk's tree).
    pub cwd_files: usize,
    /// Write the per-session artifact partitions.
    pub artifacts: bool,
    pub cache: CacheMode,
}

/// The session-name task bank (roster rows carry these as `session_info`).
const TASKS: [&str; 16] = [
    "ship the bench harness",
    "review the corpus generator",
    "fix the roster scan",
    "port the window cache",
    "audit the ledger replay",
    "write the CI workflow",
    "profile the daemon boot",
    "tune the pty harness",
    "split the scan fold",
    "measure first paint",
    "repair the lease release",
    "seed the archive sweep",
    "draft the README",
    "run the regression gates",
    "bisect the paint delay",
    "close the perf budget",
];

/// A fixed generation base (unix ms): sessions spread back from it, so the
/// tree is seed-deterministic — never wall-clock dependent. (The RLM ledger's
/// own `at` stamps come from the product writer; see README's determinism
/// note.)
const BASE_MS: u64 = 1_790_000_000_000;
/// The mtime step between sessions (roster order is mtime-desc; the
/// spread is realism only).
const MTIME_STEP_MS: u64 = 720_000;
/// The header-timestamp hour step (a session's rows spread over an hour).
const HOUR_MS: u64 = 3_600_000;

/// The corpus manifest: what the bench reads (needles are DATA, never
/// layout-position), and the file-set baseline the per-run restore uses.
#[derive(Debug, Serialize, Deserialize)]
pub struct Manifest {
    pub schema: u32,
    pub profile: Profile,
    pub seed: u64,
    pub paths: ManifestPaths,
    pub counts: ManifestCounts,
    /// Every generated file under the corpus root (the restore baseline:
    /// the bench deletes anything else the product wrote between runs).
    pub files: Vec<String>,
    pub markers: ManifestMarkers,
}

/// The corpus's on-disk anchor paths (absolute, canonical).
#[derive(Debug, Serialize, Deserialize)]
pub struct ManifestPaths {
    pub agent_dir: PathBuf,
    pub sessions_dir: PathBuf,
    pub archive_dir: PathBuf,
    pub project_dir: PathBuf,
    pub manifest_file: PathBuf,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ManifestCounts {
    pub sessions: usize,
    pub archive: usize,
    pub child_sessions: usize,
    pub total_rows: usize,
    pub subagent_edges: usize,
    pub cwd_files: usize,
}

/// The bench needles: marker strings and expected rendered counts, all
/// recorded by the generator.
#[derive(Debug, Serialize, Deserialize)]
pub struct ManifestMarkers {
    pub huge: MarkerSession,
    pub switch_a: MarkerSession,
    pub switch_b: MarkerSession,
    /// The corpus sessions the agents view lists as inactive (loaded under
    /// the `Inactive (N)` heading or counted in its not-yet-loaded footer).
    pub roster_inactive: usize,
    /// The session-switch search query (uniquely matches the switch-b row).
    pub switch_query: String,
    /// The switch-b row's rendered name (the picker paints it fully on the
    /// empty-picker -> hit transition; the echoed query does not contain it).
    pub switch_row: String,
    /// The @-completion target file name under the project dir.
    pub at_file: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct MarkerSession {
    pub id: String,
    pub file: PathBuf,
    pub needle: String,
}

/// One marker session captured during generation.
struct Marker {
    id: String,
    file: PathBuf,
}

impl Marker {
    fn session(&self, needle: String) -> MarkerSession {
        MarkerSession {
            id: self.id.clone(),
            file: self.file.clone(),
            needle,
        }
    }
}

/// Generate the corpus: the full agent-state tree under `options.out`,
/// then the manifest at `corpus.json`.
///
/// # Errors
///
/// Propagates filesystem, serialization, and ledger failures.
pub fn generate(options: &CorpusOptions) -> anyhow::Result<Manifest> {
    anyhow::ensure!(
        options.sessions >= 3,
        "the corpus needs at least 3 sessions (the huge, switch-a, and switch-b markers)"
    );
    let out = canonical_root(&options.out)?;
    anyhow::ensure!(
        std::fs::read_dir(&out)?.next().transpose()?.is_none(),
        "corpus output directory must be empty: {}",
        out.display()
    );
    let agent_dir = out.join("agent");
    let sessions_dir = agent_dir.join("sessions");
    let archive_dir = agent_dir.join("sessions-archive");
    let project_dir = out.join("project");
    for dir in [&agent_dir, &sessions_dir, &archive_dir, &project_dir] {
        std::fs::create_dir_all(dir).with_context(|| format!("create {}", dir.display()))?;
    }
    let cwd = project_dir.display().to_string();

    std::fs::write(
        agent_dir.join("settings.json"),
        serde_json::json!({
            "onboardingShown": true,
            "agentTraces": { "enabled": false },
        })
        .to_string(),
    )?;
    let at_file = write_project(&project_dir, options.cwd_files)?;

    let mut rng = Rng::new(options.seed);
    let mut total_rows = 0usize;
    let mut child_sessions = 0usize;
    let ledger = RlmSpawnLedger::new(&agent_dir, &sessions_dir, |_| {});

    let mut mtime = BASE_MS + MTIME_STEP_MS;
    let mut huge: Option<Marker> = None;
    let mut switch_a: Option<Marker> = None;
    let mut switch_b: Option<Marker> = None;
    for index in 0..options.sessions {
        let start = BASE_MS - index as u64 * MTIME_STEP_MS;
        let (rows, name, marker) = match index {
            0 => (
                options.huge_rows,
                Some("huge corpus session".to_string()),
                Some(format!("corpus huge marker {:x}", options.seed)),
            ),
            1 => (
                options.rows,
                Some("switch target a".to_string()),
                Some(format!("corpus switch marker a {:x}", options.seed)),
            ),
            // The `zq` token makes switch-b the agents-view search's ONLY
            // possible hit: no generated text (names or messages) contains
            // the letter z, so the query can never rank another row first.
            2 => (
                options.rows,
                Some("switch target zqmark".to_string()),
                Some(format!("corpus switch marker b {:x}", options.seed)),
            ),
            _ => (
                options.rows,
                rng.chance(70)
                    .then(|| format!("{} #{index}", TASKS[rng.below(TASKS.len() as u64) as usize])),
                None,
            ),
        };
        let id = rows::session_id(&mut rng, start);
        let file = sessions_dir.join(format!("{id}.jsonl"));
        let written = rows::write_session_file(
            &file,
            &SessionSpec {
                id: id.clone(),
                start_ms: start,
                cwd: cwd.clone(),
                rows,
                name,
                marker: marker.clone(),
                parent_session: None,
                rlm_depth: Some(0),
            },
            &mut rng,
        )?;
        total_rows += written.rows;
        if let Some(marker) = &marker {
            anyhow::ensure!(
                written.last_user_text == *marker,
                "the {} session's marker did not land on the final user row",
                file.display()
            );
            let captured = Marker {
                id: id.clone(),
                file: file.clone(),
            };
            match marker.as_str() {
                m if m.starts_with("corpus huge") => huge = Some(captured),
                m if m.starts_with("corpus switch marker a") => switch_a = Some(captured),
                m if m.starts_with("corpus switch marker b") => switch_b = Some(captured),
                _ => {}
            }
        }
        set_mtime(&file, mtime)?;
        mtime -= MTIME_STEP_MS;

        if options.artifacts {
            let artifacts_root = agent_dir.join("session-artifacts");
            artifacts::write_artifact_dir(&artifacts_root.join(&id), &id, &id, &mut rng)?;
        }

        // Subagent trees: the first `tree_parents` sessions grow one; the
        // first of those also grows the wide-children set.
        if index > 2 && index <= 2 + options.tree_parents {
            let tree = SubagentTree {
                fanout: options.fanout,
                max_depth: options.depth,
                child_rows: options.child_rows,
                artifacts: options.artifacts,
            };
            child_sessions += spawn_and_count(
                &ledger,
                &agent_dir.join("session-artifacts"),
                &id,
                &file,
                &tree,
                &cwd,
                &mut rng,
                &mut total_rows,
            )?;
            if index == 3 && options.wide_children > 0 {
                let wide_tree = SubagentTree {
                    fanout: options.wide_children,
                    max_depth: 1,
                    child_rows: options.child_rows,
                    artifacts: options.artifacts,
                };
                child_sessions += spawn_and_count(
                    &ledger,
                    &agent_dir.join("session-artifacts"),
                    &id,
                    &file,
                    &wide_tree,
                    &cwd,
                    &mut rng,
                    &mut total_rows,
                )?;
            }
        }
    }

    // Archived sessions: plain files in the archive dir (older mtimes).
    for index in 0..options.archive {
        let start = BASE_MS / 2 - index as u64 * HOUR_MS;
        let id = rows::session_id(&mut rng, start);
        let file = archive_dir.join(format!("{id}.jsonl"));
        let written = rows::write_session_file(
            &file,
            &SessionSpec {
                id: id.clone(),
                start_ms: start,
                cwd: cwd.clone(),
                rows: options.rows,
                name: None,
                marker: None,
                parent_session: None,
                rlm_depth: Some(0),
            },
            &mut rng,
        )?;
        total_rows += written.rows;
        set_mtime(&file, start + HOUR_MS)?;
    }

    // The warm-up pass: the product's own window-store open writes the
    // window-cache sidecars (the info-cache sidecar has no product writer
    // outside a worker lease release; the bench measures that warmth via
    // the daemon's own process cache — see README).
    if options.cache == CacheMode::Warm {
        warm_sidecars(&sessions_dir, &archive_dir)?;
    }

    let manifest = Manifest {
        schema: 1,
        profile: options.profile,
        seed: options.seed,
        paths: ManifestPaths {
            agent_dir,
            sessions_dir,
            archive_dir,
            project_dir,
            manifest_file: out.join("corpus.json"),
        },
        counts: ManifestCounts {
            sessions: options.sessions,
            archive: options.archive,
            child_sessions,
            total_rows,
            subagent_edges: child_sessions,
            cwd_files: options.cwd_files,
        },
        files: collect_files(&out)?,
        markers: ManifestMarkers {
            huge: marker_session(huge, &format!("corpus huge marker {:x}", options.seed))?,
            switch_a: marker_session(
                switch_a,
                &format!("corpus switch marker a {:x}", options.seed),
            )?,
            switch_b: marker_session(
                switch_b,
                &format!("corpus switch marker b {:x}", options.seed),
            )?,
            roster_inactive: options.sessions,
            switch_query: "target zqmark".to_string(),
            switch_row: "switch target zqmark".to_string(),
            at_file: at_file.clone(),
        },
    };
    std::fs::write(
        out.join("corpus.json"),
        serde_json::to_string_pretty(&manifest)?,
    )?;
    Ok(manifest)
}

/// Replace only a prior corpus owned by this suite; arbitrary populated output
/// remains an error. remove_dir_all does not follow nested directory symlinks.
#[cfg(any(unix, test))]
pub(crate) fn regenerate_for_suite(options: &CorpusOptions) -> anyhow::Result<Manifest> {
    anyhow::ensure!(
        options.sessions >= 3,
        "the corpus needs at least 3 sessions"
    );
    let root = &options.out;
    if let Ok(metadata) = std::fs::symlink_metadata(root) {
        anyhow::ensure!(
            !metadata.file_type().is_symlink(),
            "suite corpus root must not be a symlink: {}",
            root.display()
        );
    }
    if root.exists() && std::fs::read_dir(root)?.next().transpose()?.is_some() {
        let canonical = root.canonicalize()?;
        let manifest: Manifest =
            serde_json::from_slice(&std::fs::read(canonical.join("corpus.json"))?)
                .context("refuse to replace output without a corpus manifest")?;
        anyhow::ensure!(
            manifest.schema == 1
                && manifest.paths.manifest_file == canonical.join("corpus.json")
                && manifest.paths.agent_dir == canonical.join("agent")
                && manifest.paths.project_dir == canonical.join("project"),
            "refuse to replace a corpus whose manifest belongs to another root"
        );
        std::fs::remove_dir_all(root)?;
    }
    generate(options)
}

/// A one-child spawn through the product's ledger, then the recursion's row
/// accounting.
#[allow(clippy::too_many_arguments)] // the spawn inputs are the tree site's own facts
fn spawn_and_count(
    ledger: &RlmSpawnLedger,
    artifacts_root: &Path,
    id: &str,
    file: &Path,
    tree: &SubagentTree,
    cwd: &str,
    rng: &mut Rng,
    total_rows: &mut usize,
) -> anyhow::Result<usize> {
    let children = artifacts::spawn_child(ledger, artifacts_root, id, file, 1, tree, cwd, rng)?;
    for child in &children {
        *total_rows += count_rows(child);
    }
    Ok(children.len())
}

fn marker_session(marker: Option<Marker>, needle: &str) -> anyhow::Result<MarkerSession> {
    marker.map_or_else(
        || anyhow::bail!("the marker session was not generated"),
        |marker| Ok(marker.session(needle.to_string())),
    )
}

/// Deterministic project tree: five dirs, plain content files, plus the
/// @-completion marker file the bench needles on.
fn write_project(project: &Path, files: usize) -> anyhow::Result<String> {
    let dirs = ["src", "src/kernel", "tests", "docs", "scripts"];
    for dir in dirs {
        std::fs::create_dir_all(project.join(dir))?;
    }
    for index in 0..files {
        let dir = dirs[index % dirs.len()];
        let name = if index % 50 == 0 {
            format!("mod{index}.rs")
        } else {
            format!("file{index:05}.rs")
        };
        std::fs::write(
            project.join(dir).join(name),
            format!("// corpus file {index}\nfn stub{index}() {{}}\n"),
        )?;
    }
    let marker = "zzq-corpus-marker.md";
    std::fs::write(project.join(marker), "# corpus @ completion marker file\n")?;
    Ok(marker.to_string())
}

pub(crate) fn set_mtime(path: &Path, millis: u64) -> anyhow::Result<()> {
    let time = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_millis(millis);
    let file = std::fs::File::options().write(true).open(path)?;
    file.set_times(
        std::fs::FileTimes::new()
            .set_modified(time)
            .set_accessed(time),
    )?;
    Ok(())
}

fn count_rows(path: &Path) -> usize {
    std::fs::read_to_string(path)
        .map(|text| text.lines().filter(|line| !line.is_empty()).count())
        .unwrap_or(0)
}

fn warm_sidecars(sessions_dir: &Path, archive_dir: &Path) -> anyhow::Result<()> {
    for dir in [sessions_dir, archive_dir] {
        for entry in std::fs::read_dir(dir)? {
            let path = entry?.path();
            if path.extension().is_some_and(|ext| ext == "jsonl") {
                let _ = pa_core::session::window::WindowedSessionStore::open(&path)?;
            }
        }
    }
    Ok(())
}

fn collect_files(root: &Path) -> anyhow::Result<Vec<String>> {
    fn walk(dir: &Path, out: &mut Vec<String>) -> anyhow::Result<()> {
        let mut entries = std::fs::read_dir(dir)?.collect::<Result<Vec<_>, _>>()?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, out)?;
            } else {
                out.push(path.display().to_string());
            }
        }
        Ok(())
    }
    let mut files = Vec::new();
    walk(root, &mut files)?;
    files.sort();
    Ok(files)
}

fn canonical_root(out: &Path) -> anyhow::Result<PathBuf> {
    std::fs::create_dir_all(out).with_context(|| format!("create {}", out.display()))?;
    // macOS /tmp -> /private/tmp: the ledger hash, the header parentSession
    // paths, and every ledger record key on canonical paths.
    out.canonicalize()
        .with_context(|| format!("canonicalize {}", out.display()))
}

#[cfg(test)]
mod tests {
    fn tiny_options(out: &std::path::Path) -> super::CorpusOptions {
        let mut options = super::Profile::Small.defaults();
        options.out = out.to_path_buf();
        options.sessions = 4;
        options.rows = 8;
        options.huge_rows = 8;
        options.child_rows = 8;
        options.archive = 0;
        options.cwd_files = 0;
        options.tree_parents = 1;
        options.wide_children = 0;
        options.artifacts = false;
        options
    }

    #[test]
    fn generation_rejects_stale_output_without_changing_existing_files() {
        let directory = tempfile::tempdir().expect("output directory");
        let options = tiny_options(directory.path());
        super::generate(&options).expect("generate initial corpus");
        let sentinel = directory.path().join("unrelated.txt");
        std::fs::write(&sentinel, b"keep this file").expect("write unrelated file");
        let manifest = std::fs::read(directory.path().join("corpus.json")).expect("manifest");
        let error = super::generate(&options).expect_err("reject previously populated output");
        assert!(error.to_string().contains("must be empty"), "{error:#}");
        assert_eq!(
            std::fs::read(&sentinel).expect("sentinel retained"),
            b"keep this file"
        );
        assert_eq!(
            std::fs::read(directory.path().join("corpus.json")).expect("old manifest"),
            manifest
        );
    }

    #[test]
    fn depth_zero_generates_no_recursive_children_or_spawn_edges() {
        let directory = tempfile::tempdir().expect("output directory");
        let mut options = tiny_options(directory.path());
        options.depth = 0;
        options.fanout = 3;
        let manifest = super::generate(&options).expect("generate depth-zero corpus");
        assert_eq!(manifest.counts.child_sessions, 0);
        assert_eq!(manifest.counts.subagent_edges, 0);
        assert!(!manifest.files.iter().any(|file| file.contains("sub-")));
    }

    #[test]
    fn artifact_option_preserves_deep_and_wide_children_without_optional_payloads() {
        for artifacts in [false, true] {
            let directory = tempfile::tempdir().expect("output directory");
            let mut options = tiny_options(directory.path());
            options.artifacts = artifacts;
            options.fanout = 2;
            options.depth = 2;
            options.wide_children = 3;
            let manifest = super::generate(&options).expect("generate child trees");
            // Two direct children, four grandchildren, and three wide children.
            assert_eq!(manifest.counts.child_sessions, 9);
            let ledger = pa_daemon::rlm_ledger::RlmSpawnLedger::new(
                &manifest.paths.agent_dir,
                &manifest.paths.sessions_dir,
                |_| {},
            );
            let edges = ledger.live_edges().expect("replay actual spawn ledger");
            assert_eq!(edges.len(), 9);
            assert!(edges.iter().any(|edge| edge.depth == 2));
            for edge in edges {
                assert!(std::path::Path::new(&edge.child).is_file());
                assert!(manifest.files.contains(&edge.child));
            }
            let payloads = manifest
                .files
                .iter()
                .filter(|file| {
                    file.ends_with("kernel-state.json") || file.ends_with("kernel-state.dill")
                })
                .count();
            if artifacts {
                assert_eq!(payloads, 2 * (options.sessions + 9));
            } else {
                assert_eq!(payloads, 0);
                assert!(!manifest.files.iter().any(|file| {
                    file.contains("/harness/") || file.ends_with("scheduled-jobs.json")
                }));
            }
        }
    }

    #[test]
    fn suite_regeneration_replaces_owned_corpora_without_admitting_stale_files() {
        let directory = tempfile::tempdir().expect("suite output");
        let options = tiny_options(&directory.path().join("corpus-cold"));
        super::generate(&options).expect("initial corpus");
        let stale = options.out.join("agent/sessions/stale.jsonl");
        std::fs::write(&stale, "stale transcript").expect("stale file");
        let manifest = super::regenerate_for_suite(&options).expect("repeat suite generation");
        assert!(!stale.exists());
        assert!(!manifest
            .files
            .iter()
            .any(|file| file.ends_with("stale.jsonl")));
        assert_eq!(manifest.counts.sessions, options.sessions);
    }

    #[test]
    fn suite_regeneration_refuses_unowned_populated_output() {
        let directory = tempfile::tempdir().expect("suite output");
        let sentinel = directory.path().join("unrelated.txt");
        std::fs::write(&sentinel, "preserve me").expect("unrelated file");
        assert!(super::regenerate_for_suite(&tiny_options(directory.path())).is_err());
        assert_eq!(std::fs::read_to_string(sentinel).unwrap(), "preserve me");
    }

    #[cfg(unix)]
    #[test]
    fn suite_regeneration_does_not_follow_external_directory_symlinks() {
        let directory = tempfile::tempdir().expect("suite output");
        let outside = tempfile::tempdir().expect("outside tree");
        let sentinel = outside.path().join("sentinel");
        std::fs::write(&sentinel, "outside survives").expect("sentinel");
        let options = tiny_options(&directory.path().join("corpus-cold"));
        super::generate(&options).expect("initial corpus");
        std::os::unix::fs::symlink(outside.path(), options.out.join("external-link"))
            .expect("external symlink");
        super::regenerate_for_suite(&options).expect("replace owned corpus");
        assert_eq!(
            std::fs::read_to_string(sentinel).unwrap(),
            "outside survives"
        );
    }
    #[cfg(unix)]
    #[test]
    fn suite_regeneration_rejects_even_an_empty_external_root_symlink() {
        let directory = tempfile::tempdir().expect("suite output");
        let outside = tempfile::tempdir().expect("empty outside directory");
        let link = directory.path().join("corpus-cold");
        std::os::unix::fs::symlink(outside.path(), &link).expect("root symlink");
        assert!(super::regenerate_for_suite(&tiny_options(&link)).is_err());
        assert!(std::fs::read_dir(outside.path()).unwrap().next().is_none());
    }
}
