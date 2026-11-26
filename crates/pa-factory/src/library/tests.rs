use super::*;

fn write_dir_machine(root: &Path, folder: &str, name: &str) {
    let dir = root.join(folder);
    std::fs::create_dir_all(dir.join("prompts")).unwrap();
    std::fs::write(
        dir.join("machine.toml"),
        format!("format = 1\nname = \"{name}\"\nversion = 2\ndescription = \"Dir {name}.\"\n\n[states.go]\nentry = true\nagent = {{ prompt = \"prompts/go.md\" }}\n"),
    )
    .unwrap();
    std::fs::write(dir.join("prompts/go.md"), "Go.\n").unwrap();
}

fn machine_md(name: &str, spec: &str) -> String {
    format!("---\nname: {name}\ndescription: File {name}.\nversion: 1\nauthor: Tester\n---\n\n# {name}\n\n```json\n{{\"not\": \"the spec\"}}\n```\n\n```machine-spec\n{spec}\n```\n")
}

fn write_md_machine(root: &Path, folder: &str, name: &str, spec: &str) {
    std::fs::create_dir_all(root.join(folder)).unwrap();
    std::fs::write(
        root.join(folder).join(MACHINE_MD_FILE),
        machine_md(name, spec),
    )
    .unwrap();
}

const SPEC: &str =
    r#"{"states": [{"id": "a", "entry": true, "subagent": {"prompt": "Go."}}], "transitions": []}"#;

fn levels(repo: &Path, user: &Path) -> Vec<Level> {
    vec![
        Level {
            source: "repo".to_string(),
            dir: repo.to_path_buf(),
        },
        Level {
            source: "user".to_string(),
            dir: user.to_path_buf(),
        },
    ]
}

#[test]
fn a_machine_md_parses_its_frontmatter_and_its_one_spec_block() {
    let machine = parse_machine_md(&machine_md("sweep", SPEC), "m").unwrap();
    assert_eq!(
        (
            machine.name.as_str(),
            machine.description.as_str(),
            machine.version.as_str(),
            machine.author.as_str()
        ),
        ("sweep", "File sweep.", "1", "Tester")
    );
    assert_eq!(machine.spec["states"][0]["id"], "a");
    let quoted = "---\nname: q\ndescription: \"Says: hi\"\nauthor: 'O''Neil'\n---\n```machine-spec\n{}\n```\n";
    let machine = parse_machine_md(quoted, "m").unwrap();
    assert_eq!(
        (machine.description.as_str(), machine.author.as_str()),
        ("Says: hi", "O'Neil")
    );
}

#[test]
fn a_machine_md_reports_every_frontmatter_problem() {
    let text = "---\nname: x\ntitle: y\ndescription: a: b\n\n---\n```machine-spec\n{}\n```\n";
    assert_eq!(
        parse_machine_md(text, "m").unwrap_err(),
        [
            "m: unknown frontmatter key \"title\" (allowed: name, description, version, author)",
            "m: frontmatter description is not a plain scalar (quote the value to include ':' characters)",
            "m: frontmatter line 5 is empty (one `key: value` line per field)",
        ]
    );
    assert_eq!(
        parse_machine_md("---\nname: x\ndescription: d\n---\nno spec\n", "m").unwrap_err(),
        ["m: MACHINE.md requires exactly one fenced ```machine-spec block; found none"]
    );
    assert_eq!(
        parse_machine_md(
            "---\nname: X-\ndescription: d\n---\n```machine-spec\n{}\n```\n",
            "m"
        )
        .unwrap_err(),
        [
            "m: machine name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)",
            "m: machine name must not end with a hyphen",
        ]
    );
}

#[test]
fn every_bundled_seed_parses() {
    let seeds =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../prime-agent-runtime/src/rlm/machines");
    let library = scan_library(&[Level {
        source: "repo".to_string(),
        dir: seeds,
    }]);
    assert!(library.warnings.is_empty(), "{:?}", library.warnings);
    assert!(library.machines().count() >= 3);
}

#[test]
fn a_name_belongs_to_the_first_folder_that_claims_it() {
    let repo = tempfile::tempdir().unwrap();
    let user = tempfile::tempdir().unwrap();
    // Within a level the directory beats a MACHINE.md declaring its name.
    write_dir_machine(repo.path(), "sweep", "sweep");
    write_md_machine(repo.path(), "other", "sweep", SPEC);
    // An earlier level beats a later one.
    write_md_machine(user.path(), "sweep", "sweep", SPEC);
    // A MACHINE.md is listed under its declared name.
    write_md_machine(user.path(), "folder", "declared", SPEC);
    // A broken directory keeps its name: run reports its errors.
    std::fs::create_dir_all(repo.path().join("broken")).unwrap();
    std::fs::write(repo.path().join("broken/machine.toml"), "format = 1\n").unwrap();
    write_md_machine(user.path(), "broken", "broken", SPEC);
    // A MACHINE.md past a limit is broken, not listed.
    write_md_machine(
        user.path(),
        "wide",
        "wide",
        r#"{"run": {"max_parallel": 65}, "states": []}"#,
    );

    let library = scan_library(&levels(repo.path(), user.path()));
    let listed: Vec<(&str, &str, MachineKind)> = library
        .machines()
        .map(|machine| (machine.name.as_str(), machine.source.as_str(), machine.kind))
        .collect();
    assert_eq!(
        listed,
        [
            ("declared", "user", MachineKind::File),
            ("sweep", "repo", MachineKind::Directory)
        ]
    );
    assert_eq!(
        library.resolve("sweep").unwrap().path,
        repo.path().join("sweep")
    );
    assert!(library
        .resolve("broken")
        .unwrap_err()
        .starts_with("the library machine \"broken\" exists but is broken"));
    assert!(library
        .resolve("wide")
        .unwrap_err()
        .contains("run max_parallel must be an integer between 1 and 64"));
    assert_eq!(
        library.resolve("absent").unwrap_err(),
        "no library machine named \"absent\" (machines: declared, sweep)"
    );
    assert_eq!(library.warnings.len(), 2, "{:?}", library.warnings);
}

#[test]
fn a_structurally_invalid_machine_md_is_a_warning_not_a_machine() {
    let user = tempfile::tempdir().unwrap();
    write_md_machine(
        user.path(),
        "lost",
        "lost",
        r#"{"states": [{"id": "a", "entry": true}]}"#,
    );
    let library = scan_library(&[Level {
        source: "user".to_string(),
        dir: user.path().to_path_buf(),
    }]);
    assert_eq!(library.machines().count(), 0);
    assert_eq!(library.warnings.len(), 1);
    assert!(
        library.warnings[0].contains("state a requires a subagent"),
        "{:?}",
        library.warnings
    );
}
