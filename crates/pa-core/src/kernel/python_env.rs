//! Python subprocess environment: inherited path overrides must not turn a
//! repository into interpreter startup code before the user has acted.

use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

/// Keep caller-owned Python paths when they are existing absolute locations
/// disjoint from the project. An ancestor can also import a repository whose
/// directory name matches a module, so both directions are excluded.
fn path_starts_with(path: &Path, prefix: &Path) -> bool {
    #[cfg(windows)]
    {
        // Windows paths are case-insensitive, including when the input uses
        // different casing from the spelling returned by canonicalize.
        let prefix = prefix.to_string_lossy().to_lowercase();
        let path = path.to_string_lossy().to_lowercase();
        let prefix = Path::new(&prefix);
        let path = Path::new(&path);
        path.starts_with(prefix)
    }
    #[cfg(not(windows))]
    {
        path.starts_with(prefix)
    }
}

fn paths_overlap(path: &Path, project: &Path) -> bool {
    path_starts_with(path, project) || path_starts_with(project, path)
}

/// A session can start in a repository subdirectory. Treat every directory
/// under the outermost checkout root as project controlled.
fn project_root(project: Option<&Path>) -> Option<PathBuf> {
    let project = project?.canonicalize().ok()?;
    Some(
        project
            .ancestors()
            .filter(|ancestor| {
                let marker = ancestor.join(".git");
                marker.is_file() || marker.join("HEAD").is_file()
            })
            .last()
            .unwrap_or(&project)
            .to_path_buf(),
    )
}

/// Executable search can use an ancestor directory if the selected binary
/// itself stays outside the project. Python import paths cannot do that.
pub(crate) fn safe_executable_path(path: &Path, project: Option<&Path>) -> bool {
    let Some(project) = project_root(project) else {
        return false;
    };
    if !path.is_absolute() || path_starts_with(path, &project) {
        return false;
    }
    let Ok(path) = path.canonicalize() else {
        return false;
    };
    !path_starts_with(&path, &project)
}

pub(crate) fn safe_path(path: &Path, project: Option<&Path>) -> bool {
    let Some(project) = project_root(project) else {
        return false;
    };
    if !path.is_absolute() || paths_overlap(path, &project) {
        return false;
    }
    let Ok(path) = path.canonicalize() else {
        return false;
    };
    !paths_overlap(&path, &project)
}

fn safe_value(name: &str, value: &OsStr, project: Option<&Path>) -> Option<OsString> {
    match name {
        "PYTHONPATH" => {
            let entries: Vec<_> = std::env::split_paths(value)
                .filter(|path| safe_path(path, project))
                .collect();
            if entries.is_empty() {
                None
            } else {
                std::env::join_paths(entries).ok()
            }
        }
        "PYTHONHOME" => {
            let paths: Vec<_> = std::env::split_paths(value).collect();
            if (1..=2).contains(&paths.len()) && paths.iter().all(|path| safe_path(path, project)) {
                Some(value.to_os_string())
            } else {
                None
            }
        }
        "PYTHONUSERBASE" => safe_path(Path::new(value), project).then(|| value.to_os_string()),
        _ => unreachable!("only Python path variables are filtered"),
    }
}

/// Filter environment values after all caller overrides have been applied.
/// `None` means the project directory cannot be verified, so every path
/// override is dropped. This leaves unrelated environment settings intact.
pub(crate) fn sanitize_python_env(env: &mut HashMap<OsString, OsString>, project: Option<&Path>) {
    for name in ["PYTHONPATH", "PYTHONHOME", "PYTHONUSERBASE"] {
        // Windows environment names are case-insensitive. On Unix, a
        // lowercase name is a separate variable that Python ignores.
        let keys: Vec<_> = env
            .keys()
            .filter(|key| {
                #[cfg(windows)]
                {
                    key.to_string_lossy().eq_ignore_ascii_case(name)
                }
                #[cfg(not(windows))]
                {
                    key.as_os_str() == OsStr::new(name)
                }
            })
            .cloned()
            .collect();
        let value = keys
            .iter()
            .find(|key| key.as_os_str() == OsStr::new(name))
            .or_else(|| keys.first())
            .and_then(|key| env.get(key))
            .and_then(|value| safe_value(name, value, project));
        for key in keys {
            env.remove(&key);
        }
        if let Some(value) = value {
            env.insert(OsString::from(name), value);
        }
    }
}

pub(crate) fn inherited_python_env(project: Option<&Path>) -> HashMap<OsString, OsString> {
    let mut env = std::env::vars_os().collect();
    sanitize_python_env(&mut env, project);
    env
}

/// uv can search PATH for Python under several names. Remove relative,
/// repository, and ancestor entries before bootstrap; an ancestor could hold
/// a symlink to a repository-controlled interpreter.
pub(crate) fn sanitize_uv_path(env: &mut HashMap<OsString, OsString>, project: Option<&Path>) {
    let keys: Vec<_> = env
        .keys()
        .filter(|key| {
            #[cfg(windows)]
            {
                key.to_string_lossy().eq_ignore_ascii_case("PATH")
            }
            #[cfg(not(windows))]
            {
                key.as_os_str() == OsStr::new("PATH")
            }
        })
        .cloned()
        .collect();
    let entries: Vec<_> = keys
        .iter()
        .filter_map(|key| env.get(key))
        .flat_map(|value| std::env::split_paths(value))
        .filter(|path| safe_path(path, project))
        .collect();
    for key in keys {
        env.remove(&key);
    }
    if !entries.is_empty() {
        if let Ok(value) = std::env::join_paths(entries) {
            env.insert(OsString::from("PATH"), value);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    fn python_with_safe_path() -> Option<std::path::PathBuf> {
        let path = std::env::var_os("PATH")?;
        std::env::split_paths(&path)
            .flat_map(|dir| ["python3.11", "python3"].map(|name| dir.join(name)))
            .find(|python| {
                std::process::Command::new(python)
                    .args(["-P", "-c", "pass"])
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .status()
                    .is_ok_and(|status| status.success())
            })
    }

    #[test]
    fn python_path_variables_keep_only_disjoint_absolute_locations() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project");
        let trusted = root.path().join("trusted");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&trusted).unwrap();
        let mut env = HashMap::from([
            (
                OsString::from("PYTHONPATH"),
                std::env::join_paths([
                    Path::new(""),
                    Path::new("."),
                    &project,
                    root.path(),
                    &trusted,
                ])
                .unwrap(),
            ),
            (OsString::from("PYTHONHOME"), OsString::from(".")),
            (
                OsString::from("PYTHONUSERBASE"),
                project.as_os_str().to_os_string(),
            ),
            (OsString::from("PYTHONUTF8"), OsString::from("1")),
        ]);
        #[cfg(not(windows))]
        env.insert(OsString::from("pythonpath"), OsString::from("untouched"));

        sanitize_python_env(&mut env, Some(&project));
        assert_eq!(
            env.get(OsStr::new("PYTHONPATH")),
            Some(&trusted.into_os_string())
        );
        assert!(!env.contains_key(OsStr::new("PYTHONHOME")));
        assert!(!env.contains_key(OsStr::new("PYTHONUSERBASE")));
        assert_eq!(
            env.get(OsStr::new("PYTHONUTF8")),
            Some(&OsString::from("1"))
        );
        #[cfg(not(windows))]
        assert_eq!(
            env.get(OsStr::new("pythonpath")),
            Some(&OsString::from("untouched"))
        );
    }

    #[test]
    fn home_and_userbase_keep_trusted_absolute_paths_and_drop_project_aliases() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project");
        let trusted = root.path().join("trusted");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&trusted).unwrap();
        let mut env = HashMap::from([
            (
                OsString::from("PYTHONHOME"),
                std::env::join_paths([&trusted, &project]).unwrap(),
            ),
            (
                OsString::from("PYTHONUSERBASE"),
                trusted.as_os_str().to_os_string(),
            ),
        ]);
        sanitize_python_env(&mut env, Some(&project));
        assert!(!env.contains_key(OsStr::new("PYTHONHOME")));
        assert_eq!(
            env.get(OsStr::new("PYTHONUSERBASE")),
            Some(&trusted.as_os_str().to_os_string())
        );

        env.insert(
            OsString::from("PYTHONHOME"),
            trusted.as_os_str().to_os_string(),
        );
        sanitize_python_env(&mut env, Some(&project));
        assert_eq!(
            env.get(OsStr::new("PYTHONHOME")),
            Some(&trusted.as_os_str().to_os_string())
        );

        env.insert(OsString::from("PYTHONUSERBASE"), OsString::from("."));
        sanitize_python_env(&mut env, Some(&project));
        assert!(!env.contains_key(OsStr::new("PYTHONUSERBASE")));

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let alias = root.path().join("alias");
            symlink(&project, &alias).unwrap();
            env.insert(OsString::from("PYTHONUSERBASE"), alias.into_os_string());
            sanitize_python_env(&mut env, Some(&project));
            assert!(!env.contains_key(OsStr::new("PYTHONUSERBASE")));

            let alias = project.join("trusted-alias");
            symlink(&trusted, &alias).unwrap();
            env.insert(OsString::from("PYTHONPATH"), alias.into_os_string());
            sanitize_python_env(&mut env, Some(&project));
            assert!(!env.contains_key(OsStr::new("PYTHONPATH")));
        }
    }

    #[cfg(unix)]
    #[test]
    fn python_safe_path_cannot_import_project_sitecustomize_from_inherited_paths() {
        let Some(python) = python_with_safe_path() else {
            return;
        };
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project");
        let trusted = root.path().join("trusted");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&trusted).unwrap();
        let marker = root.path().join("project-code-ran");
        std::fs::write(
            project.join("sitecustomize.py"),
            format!("from pathlib import Path\nPath({marker:?}).touch()\n"),
        )
        .unwrap();
        std::fs::write(trusted.join("trusted_module.py"), "value = 42\n").unwrap();
        let path = std::env::join_paths([Path::new("."), &project, &trusted]).unwrap();
        let mut env = HashMap::from([(OsString::from("PYTHONPATH"), path)]);

        let run = |env: &HashMap<OsString, OsString>| {
            std::process::Command::new(&python)
                .args([
                    "-P",
                    "-c",
                    "import trusted_module; assert trusted_module.value == 42",
                ])
                .current_dir(&project)
                .env_clear()
                .envs(env)
                .status()
                .unwrap()
        };
        assert!(run(&env).success());
        assert!(
            marker.exists(),
            "the unsanitized environment must reproduce the bug"
        );
        std::fs::remove_file(&marker).unwrap();
        sanitize_python_env(&mut env, Some(&project));
        assert!(
            run(&env).success(),
            "a trusted absolute path remains importable"
        );
        assert!(!marker.exists(), "project startup code ran after filtering");
    }

    #[cfg(unix)]
    #[test]
    fn user_site_in_project_cannot_run_sitecustomize() {
        let Some(python) = python_with_safe_path() else {
            return;
        };
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project");
        std::fs::create_dir_all(&project).unwrap();
        let user_site = std::process::Command::new(&python)
            .args(["-P", "-c", "import site; print(site.getusersitepackages())"])
            .env_clear()
            .env("PYTHONUSERBASE", &project)
            .output()
            .unwrap();
        assert!(user_site.status.success());
        let user_site_path =
            std::path::PathBuf::from(std::str::from_utf8(&user_site.stdout).unwrap().trim());
        std::fs::create_dir_all(&user_site_path).unwrap();
        let marker = root.path().join("user-site-ran");
        std::fs::write(
            user_site_path.join("sitecustomize.py"),
            format!("from pathlib import Path\nPath({marker:?}).touch()\n"),
        )
        .unwrap();
        let mut env = HashMap::from([(
            OsString::from("PYTHONUSERBASE"),
            project.as_os_str().to_os_string(),
        )]);
        let run = |env: &HashMap<OsString, OsString>| {
            std::process::Command::new(&python)
                .args(["-P", "-c", "pass"])
                .current_dir(&project)
                .env_clear()
                .envs(env)
                .status()
                .unwrap()
        };
        assert!(run(&env).success());
        assert!(
            marker.exists(),
            "the unsanitized user base must reproduce the bug"
        );
        std::fs::remove_file(&marker).unwrap();
        sanitize_python_env(&mut env, Some(&project));
        assert!(run(&env).success());
        assert!(!marker.exists(), "project user site ran after filtering");
    }

    #[cfg(unix)]
    #[test]
    fn sibling_python_path_cannot_run_sitecustomize_before_prompt() {
        let Some(python) = python_with_safe_path() else {
            return;
        };
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("repo");
        let project = repo.join("app");
        let sibling = repo.join("skills");
        let trusted = root.path().join("trusted");
        for dir in [&project, &sibling, &trusted] {
            std::fs::create_dir_all(dir).unwrap();
        }
        std::fs::create_dir(repo.join(".git")).unwrap();
        std::fs::write(repo.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
        let marker = root.path().join("sibling-code-ran");
        std::fs::write(
            sibling.join("sitecustomize.py"),
            format!("from pathlib import Path\nPath({marker:?}).touch()\n"),
        )
        .unwrap();
        std::fs::write(trusted.join("trusted_module.py"), "value = 42\n").unwrap();
        let mut env = HashMap::from([(
            OsString::from("PYTHONPATH"),
            std::env::join_paths([&sibling, &trusted]).unwrap(),
        )]);
        let run = |env: &HashMap<OsString, OsString>| {
            std::process::Command::new(&python)
                .args([
                    "-P",
                    "-c",
                    "import trusted_module; assert trusted_module.value == 42",
                ])
                .current_dir(&project)
                .env_clear()
                .envs(env)
                .status()
                .unwrap()
        };
        assert!(run(&env).success());
        assert!(
            marker.exists(),
            "unsanitized sibling path did not reproduce the bug"
        );
        std::fs::remove_file(&marker).unwrap();
        sanitize_python_env(&mut env, Some(&project));
        assert!(run(&env).success(), "trusted path stopped working");
        assert!(!marker.exists(), "sibling startup code ran after filtering");
    }

    #[test]
    fn uv_subprocess_path_rejects_repository_sibling_and_ancestor() {
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("repo");
        let project = repo.join("app");
        let sibling = repo.join("tools");
        let trusted = root.path().join("trusted");
        for dir in [&project, &sibling, &trusted] {
            std::fs::create_dir_all(dir).unwrap();
        }
        std::fs::create_dir(repo.join(".git")).unwrap();
        std::fs::write(repo.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
        let mut env = HashMap::from([(
            OsString::from("PATH"),
            std::env::join_paths([Path::new("."), &sibling, &repo, &trusted]).unwrap(),
        )]);
        sanitize_uv_path(&mut env, Some(&project));
        assert_eq!(env.get(OsStr::new("PATH")), Some(&trusted.into_os_string()));
    }
}
