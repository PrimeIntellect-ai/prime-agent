use super::*;

fn machine_dir() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("assets/rubrics")).unwrap();
    std::fs::write(dir.path().join("assets/rubrics/quality.md"), "Judge.").unwrap();
    dir
}

fn asset(reference: &str) -> AssetPath {
    AssetPath::parse(reference).unwrap()
}

#[test]
fn a_nested_asset_resolves_inside_the_dir() {
    let dir = machine_dir();
    assert_eq!(
        check(dir.path(), &asset("assets/rubrics/quality.md")).unwrap(),
        dir.path()
            .join("assets/rubrics/quality.md")
            .canonicalize()
            .unwrap()
    );
}

#[test]
fn a_dot_dot_escape_names_the_path_and_the_dir() {
    let dir = machine_dir();
    let error = check(dir.path(), &asset("assets/../../secret.md")).unwrap_err();
    assert_eq!(
        error.to_string(),
        format!(
            "\"assets/../../secret.md\" must be a relative path inside the machine directory {}",
            dir.path().display()
        )
    );
}

#[cfg(unix)]
#[test]
fn a_symlink_escape_names_the_path_and_its_target() {
    let dir = machine_dir();
    let outside = tempfile::tempdir().unwrap();
    let secret = outside.path().join("secret.md");
    std::fs::write(&secret, "secret").unwrap();
    std::os::unix::fs::symlink(&secret, dir.path().join("assets/link.md")).unwrap();
    let error = AssetCache::new(dir.path())
        .load(&asset("assets/link.md"))
        .unwrap_err();
    assert_eq!(
        error,
        AssetError::Escapes {
            path: "assets/link.md".to_string(),
            target: secret.canonicalize().unwrap(),
            dir: dir.path().to_path_buf(),
        }
    );
}
