//! The corpus verification battery: every generated file loads through the
//! PRODUCT's own readers (pa-daemon SessionFile, pa-core parse, the RLM
//! ledger replay), the tree is seed-deterministic, and the marker discipline
//! holds. Kept small and fast: tiny corpora in temp dirs only.

use std::collections::HashSet;
use std::path::Path;

use pa_core::session::parse_session_entries;
use pa_daemon::rlm_ledger::RlmSpawnLedger;
use pa_daemon::session_store::SessionFile;
use pa_perf::corpus::{generate, CacheMode, CorpusOptions, Profile};

fn tiny(profile: Profile, out: &Path) -> CorpusOptions {
    CorpusOptions {
        out: out.to_path_buf(),
        ..profile.defaults()
    }
}

/// Every generated session file must parse through the daemon's own store.
#[test]
fn sessions_load_through_the_product_store() {
    let dir = tempfile::tempdir().expect("temp dir");
    let options = tiny(Profile::Small, dir.path());
    let manifest = generate(&options).expect("generate");
    let mut checked = 0;
    for file in &manifest.files {
        let path = std::path::PathBuf::from(file);
        if path.parent() != Some(&manifest.paths.sessions_dir) {
            continue;
        }
        let store = SessionFile::open(&path).expect("the product store opens the file");
        assert_eq!(store.header.id, path.file_stem().unwrap().to_string_lossy());
        assert!(!store.entries().is_empty(), "the session carried its rows");
        checked += 1;
    }
    assert_eq!(checked, options.sessions, "every sessions-dir file checked");
}

/// No row may degrade to an Unknown entry: the corpus speaks the wire format.
#[test]
fn rows_never_degrade_to_unknown_entries() {
    let dir = tempfile::tempdir().expect("temp dir");
    let options = tiny(Profile::Small, dir.path());
    let manifest = generate(&options).expect("generate");
    let huge = &manifest.markers.huge;
    let text = std::fs::read_to_string(&huge.file).expect("read the huge session");
    let entries = parse_session_entries(&text);
    assert!(
        entries
            .iter()
            .all(|entry| !matches!(entry, pa_types::session::FileEntry::Unknown { .. })),
        "no unknown rows in the generated huge session"
    );
}

/// The marker lands on the final user row of each marker session.
#[test]
fn markers_land_on_the_final_user_message() {
    let dir = tempfile::tempdir().expect("temp dir");
    let options = tiny(Profile::Small, dir.path());
    let manifest = generate(&options).expect("generate");
    for marker in [
        &manifest.markers.huge,
        &manifest.markers.switch_a,
        &manifest.markers.switch_b,
    ] {
        let text = std::fs::read_to_string(&marker.file).expect("read session");
        // The reply under the marker is one short text line, so rows the
        // product appends at attach cannot push the marker off screen.
        let last: serde_json::Value =
            serde_json::from_str(text.lines().last().expect("a last row")).expect("valid row");
        let blocks = last["message"]["content"].as_array();
        assert!(
            last["message"]["role"] == "assistant"
                && last["message"]["stopReason"] == "stop"
                && blocks.is_some_and(|blocks| blocks.len() == 1 && blocks[0]["type"] == "text"),
            "the marker reply is one text block: {last}"
        );
        let last_user = text
            .lines()
            .rev()
            .find_map(|line| {
                let value: serde_json::Value = serde_json::from_str(line).ok()?;
                (value.get("type") == Some(&serde_json::json!("message"))
                    && value["message"]["role"] == serde_json::json!("user"))
                .then(|| value["message"]["content"].to_string())
            })
            .expect("a final user message");
        assert!(
            last_user.contains(&marker.needle),
            "the needle is the final user message: {last_user}"
        );
    }
}

/// The ledger the corpus writes replays through the product's own reader.
#[test]
fn the_ledger_replays_through_the_product_reader() {
    let dir = tempfile::tempdir().expect("temp dir");
    let options = tiny(Profile::Small, dir.path());
    let manifest = generate(&options).expect("generate");
    let ledger = RlmSpawnLedger::new(
        &manifest.paths.agent_dir,
        &manifest.paths.sessions_dir,
        |_| {},
    );
    let edges = ledger.live_edges().expect("the ledger replays");
    assert_eq!(
        edges.len(),
        manifest.counts.subagent_edges,
        "every spawn edge replays as live"
    );
    assert!(
        edges
            .iter()
            .all(|edge| edge.depth >= 1 && edge.child.contains("session-artifacts")),
        "edges carry the artifact-tree child files"
    );
}

/// Same seed, same tree: every file the generator owns is byte-identical
/// (the ledger's `at` stamps come from the product writer's wall clock; the
/// edge content is compared field-by-field instead).
#[test]
fn the_same_seed_rebuilds_the_identical_tree() {
    let first = tempfile::tempdir().expect("temp dir");
    let second = tempfile::tempdir().expect("temp dir");
    let first_root = first.path().canonicalize().expect("canonical first");
    let second_root = second.path().canonicalize().expect("canonical second");
    generate(&tiny(Profile::Small, &first_root)).expect("first generate");
    generate(&tiny(Profile::Small, &second_root)).expect("second generate");
    // The ledger file NAME is the hash of the canonical sessions dir, so
    // two corpus roots name it differently; normalize it for comparison.
    fn normalized(mut files: Vec<String>) -> Vec<String> {
        for file in &mut files {
            if let Some(hash) = file
                .strip_prefix("agent/rlm-ledger/")
                .and_then(|rest| rest.strip_suffix(".jsonl"))
            {
                if !hash.contains('/') {
                    *file = "agent/rlm-ledger/<hash>.jsonl".to_string();
                }
            }
        }
        files
    }
    let first_files = normalized(relative_files(&first_root));
    let second_files = normalized(relative_files(&second_root));
    let mut first_sorted = first_files.clone();
    first_sorted.sort();
    let mut second_sorted = second_files.clone();
    second_sorted.sort();
    assert_eq!(first_sorted, second_sorted, "the file sets match");

    for relative in &first_sorted {
        let a = first_root.join(relative);
        let b = second_root.join(relative);
        if relative.starts_with("agent/rlm-ledger/") {
            let a = ledger_of(&first_root);
            let b = ledger_of(&second_root);
            let edges = |path: &Path, root: &Path| -> Vec<(String, String, u32)> {
                std::fs::read_to_string(path)
                    .expect("read ledger")
                    .lines()
                    .filter_map(|line| {
                        let value: serde_json::Value = serde_json::from_str(line).ok()?;
                        (value["op"] == serde_json::json!("spawn")).then(|| {
                            let child = Path::new(value["child"].as_str().unwrap_or_default());
                            let child = child
                                .strip_prefix(root)
                                .map_or_else(|_| child.to_path_buf(), Path::to_path_buf);
                            (
                                value["childId"].as_str().unwrap_or_default().to_string(),
                                child.to_string_lossy().to_string(),
                                value["depth"].as_u64().unwrap_or_default() as u32,
                            )
                        })
                    })
                    .collect()
            };
            assert_eq!(
                edges(&a, &first_root),
                edges(&b, &second_root),
                "the ledger edges match"
            );
            continue;
        }
        // corpus.json embeds absolute paths and the ledger's hash name; the
        // ledger itself and child headers embed the corpus root in
        // parentSession/child paths. Normalize the root, skip the manifest.
        if relative == "corpus.json" {
            continue;
        }
        let read = |path: &Path, root: &Path| -> Vec<u8> {
            let bytes = std::fs::read(path).expect("read");
            let root = root.to_string_lossy().into_owned().into_bytes();
            let mut normalized = Vec::with_capacity(bytes.len());
            let mut index = 0;
            while index < bytes.len() {
                if bytes[index..].starts_with(&root) {
                    normalized.extend_from_slice(b"<root>");
                    index += root.len();
                } else {
                    normalized.push(bytes[index]);
                    index += 1;
                }
            }
            normalized
        };
        assert_eq!(
            read(&a, &first_root),
            read(&b, &second_root),
            "{relative} differs between seeds-equal runs"
        );
    }
}

/// Entry ids are unique 8-hex counters even past the ~22k-row collision
/// cliff the product's uuid-prefix ids hit.
#[test]
fn entry_ids_stay_unique_past_the_uuid_prefix_collision_cliff() {
    let dir = tempfile::tempdir().expect("temp dir");
    let options = CorpusOptions {
        sessions: 3,
        rows: 25_000,
        child_rows: 0,
        fanout: 0,
        depth: 0,
        tree_parents: 0,
        wide_children: 0,
        cwd_files: 5,
        ..tiny(Profile::Small, dir.path())
    };
    let manifest = generate(&options).expect("generate");
    let file = manifest
        .paths
        .sessions_dir
        .join(format!("{}.jsonl", manifest.markers.huge.id));
    let text = std::fs::read_to_string(&file).expect("read session");
    let mut ids = HashSet::new();
    let mut rows = 0;
    for line in text.lines() {
        let value: serde_json::Value = serde_json::from_str(line).expect("a parseable row");
        if value["type"] == serde_json::json!("session") {
            continue;
        }
        let id = value["id"].as_str().expect("an id").to_string();
        assert_eq!(id.len(), 8, "the id is 8-hex");
        assert!(id.chars().all(|c| c.is_ascii_hexdigit()), "hex id: {id}");
        ids.insert(id);
        rows += 1;
    }
    assert_eq!(ids.len(), rows, "no id collides across {rows} rows");
}

/// The warm pass writes the product's own window-cache sidecars.
#[test]
fn the_warm_pass_writes_product_sidecars() {
    let dir = tempfile::tempdir().expect("temp dir");
    let mut options = tiny(Profile::Small, dir.path());
    options.cache = CacheMode::Warm;
    let manifest = generate(&options).expect("generate");
    let sidecars = manifest
        .files
        .iter()
        .filter(|file| file.ends_with("window-cache.json"))
        .count();
    assert_eq!(
        sidecars, options.sessions,
        "every openable session gained a window-cache sidecar"
    );
}

/// The switch-b row is the ONLY session the switch query can match. The
/// agents-view search is a fuzzy subsequence match over each row's name
/// AND message text, so a common token could rank another row first; the
/// guarantee needs the `zq` token to be literally impossible elsewhere —
/// no generated corpus text (names or message bodies) contains the letter
/// z at all (the ISO `Z` header suffix is the one allowed z).
#[test]
fn the_switch_query_can_only_match_switch_b() {
    let dir = tempfile::tempdir().expect("temp dir");
    let options = tiny(Profile::Small, dir.path());
    let manifest = generate(&options).expect("generate");
    assert_eq!(manifest.markers.switch_row, "switch target zqmark");
    assert!(manifest.markers.switch_query.contains("zqmark"));
    assert!(manifest.markers.switch_query != manifest.markers.switch_row);
    let mut scanned = 0;
    for file in &manifest.files {
        let path = std::path::PathBuf::from(file);
        if path.parent() == Some(&manifest.paths.sessions_dir) {
            // The search corpus folds MESSAGE text and names (not header
            // timestamps, whose ISO `Z` suffix is the one allowed z).
            for line in std::fs::read_to_string(&path)
                .expect("read session")
                .lines()
            {
                if line.contains('z')
                    && !line.contains(r#""type":"session""#)
                    && !line.contains(&manifest.markers.switch_row)
                {
                    panic!("a non-header row carries z: {line}");
                }
            }
            scanned += 1;
        }
    }
    assert_eq!(scanned, options.sessions, "every session checked");
}

/// The corpus manifest records the generated file set (the bench's
/// per-run restore baseline).
#[test]
fn the_manifest_is_the_file_set_baseline() {
    let dir = tempfile::tempdir().expect("temp dir");
    let options = tiny(Profile::Small, dir.path());
    let manifest = generate(&options).expect("generate");
    let on_disk = relative_files(dir.path());
    assert_eq!(
        manifest.files.len() + 1, // corpus.json is written after the walk
        on_disk.len(),
        "the manifest lists every generated file"
    );
}

/// The one ledger file under a corpus root (its name is the sessions-dir
/// hash, which differs per root).
fn ledger_of(root: &Path) -> std::path::PathBuf {
    let dir = root.join("agent/rlm-ledger");
    std::fs::read_dir(dir)
        .expect("read the ledger dir")
        .map(|entry| entry.expect("entry").path())
        .find(|path| path.extension().is_some_and(|ext| ext == "jsonl"))
        .expect("the ledger file")
}

fn relative_files(root: &Path) -> Vec<String> {
    fn walk(dir: &Path, root: &Path, out: &mut Vec<String>) {
        let entries = std::fs::read_dir(dir).expect("read dir");
        for entry in entries {
            let entry = entry.expect("entry");
            let path = entry.path();
            if path.is_dir() {
                walk(&path, root, out);
            } else {
                out.push(
                    path.strip_prefix(root)
                        .expect("inside root")
                        .to_string_lossy()
                        .to_string(),
                );
            }
        }
    }
    let mut files = Vec::new();
    walk(root, root, &mut files);
    files.sort();
    files
}
