//! `factory validate` and `factory compile` on the bundled example machine,
//! and on a copy whose asset is missing.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

fn example_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../examples/machines/outline-draft")
}

fn factory(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_prime-agent"))
        .arg("factory")
        .args(args)
        .output()
        .unwrap()
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_dir(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), target).unwrap();
        }
    }
}

#[test]
fn validate_and_compile_accept_the_example_machine() {
    let dir = example_dir();
    let dir = dir.to_str().unwrap();
    let validate = factory(&["validate", dir]);
    assert_eq!(
        String::from_utf8_lossy(&validate.stdout),
        "outline-draft v1 is valid: 2 states.\n"
    );
    let compile = factory(&["compile", dir, "--param", "topic=tide pools"]);
    assert!(compile.status.success(), "{compile:?}");
    let spec: serde_json::Value = serde_json::from_slice(&compile.stdout).unwrap();
    assert_eq!(spec["states"][1]["inputs"][1]["from"], "assets/style.md");
}

#[test]
fn validate_and_compile_report_an_unresolvable_asset() {
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join("outline-draft");
    copy_dir(&example_dir(), &dir);
    std::fs::remove_file(dir.join("assets/style.md")).unwrap();
    let shown = dir.display();
    let expected = format!(
        "Error: {shown}: machine.toml: states.draft.inputs.style: \"assets/style.md\" does not exist in the machine directory {shown}\n"
    );
    let dir = dir.to_str().unwrap();
    for args in [
        vec!["validate", dir],
        vec!["compile", dir, "--param", "topic=t"],
    ] {
        let output = factory(&args);
        assert_eq!(output.status.code(), Some(1), "{args:?}");
        assert_eq!(
            String::from_utf8_lossy(&output.stderr),
            expected,
            "{args:?}"
        );
    }
}
