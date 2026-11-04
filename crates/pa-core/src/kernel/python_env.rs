//! Python subprocess environment: inherited path overrides must not turn a
//! repository into interpreter startup code before the user has acted.

use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::path::Path;

/// Reject executable search paths inside the opened repository, even when the
/// session cwd is a subdirectory. An ancestor can also expose project files.
fn paths_overlap(path: &Path, project: &Path) -> bool {
    #[cfg(windows)]
    {
        // Windows paths are case-insensitive, including when the input uses
        // different casing from the spelling returned by canonicalize.
        let project = project.to_string_lossy().to_lowercase();
        let path = path.to_string_lossy().to_lowercase();
        let project = Path::new(&project);
        let path = Path::new(&path);
        path.starts_with(project) || project.starts_with(path)
    }
    #[cfg(not(windows))]
    {
        path.starts_with(project) || project.starts_with(path)
    }
}

pub(crate) fn safe_path(path: &Path, project: Option<&Path>) -> bool {
    let Some(project) = project else {
        return false;
    };
    let Ok(project) = project.canonicalize() else {
        return false;
    };
    let project_root = project
        .ancestors()
        .filter(|ancestor| ancestor.join(".git").exists())
        .last()
        .unwrap_or(&project);
    if !path.is_absolute() || paths_overlap(path, project_root) {
        return false;
    }
    let Ok(path) = path.canonicalize() else {
        return false;
    };
    !paths_overlap(&path, project_root)
}

/// Drop ambient Python import roots after caller overrides are applied. A path
/// outside the cwd can still be inside the opened repository, and interpreter
/// startup imports sitecustomize before the kernel can check it.
pub(crate) fn sanitize_python_env(env: &mut HashMap<OsString, OsString>) {
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
        for key in keys {
            env.remove(&key);
        }
    }
}

pub(crate) fn inherited_python_env(_project: Option<&Path>) -> HashMap<OsString, OsString> {
    let mut env = std::env::vars_os().collect();
    sanitize_python_env(&mut env);
    env
}

/// `uv` probes Python executables on PATH while creating a venv. Exclude
/// relative and repository entries before it can execute a checked-in binary.
pub(crate) fn sanitize_uv_path(env: &mut HashMap<OsString, OsString>, project: Option<&Path>) {
    let Some(project) = project else { return };
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
        .filter(|path| safe_path(path, Some(project)))
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

    #[test]
    fn python_import_roots_are_removed_after_options_overlay() {
        let mut env = HashMap::from([
            (OsString::from("PYTHONPATH"), OsString::from("/trusted")),
            (OsString::from("PYTHONHOME"), OsString::from("/trusted")),
            (OsString::from("PYTHONUSERBASE"), OsString::from("/trusted")),
            (OsString::from("PYTHONUTF8"), OsString::from("1")),
        ]);
        #[cfg(not(windows))]
        env.insert(OsString::from("pythonpath"), OsString::from("untouched"));
        #[cfg(windows)]
        env.insert(OsString::from("pythonpath"), OsString::from("/other"));

        sanitize_python_env(&mut env);
        for name in ["PYTHONPATH", "PYTHONHOME", "PYTHONUSERBASE"] {
            assert!(!env
                .keys()
                .any(|key| key.to_string_lossy().eq_ignore_ascii_case(name)
                    && (cfg!(windows) || key.as_os_str() == OsStr::new(name))));
        }
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

    #[cfg(unix)]
    #[test]
    fn sibling_python_path_cannot_run_sitecustomize_before_prompt() {
        let python = ["python3.11", "python3"].into_iter().find(|python| {
            std::process::Command::new(python)
                .args(["-P", "-c", "pass"])
                .status()
                .is_ok_and(|status| status.success())
        });
        let Some(python) = python else { return };
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("repo");
        let project = repo.join("app");
        let sibling = repo.join("skills");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&sibling).unwrap();
        let marker = root.path().join("project-code-ran");
        std::fs::write(
            sibling.join("sitecustomize.py"),
            format!("from pathlib import Path\nPath({marker:?}).touch()\n"),
        )
        .unwrap();
        let mut env = HashMap::from([(OsString::from("PYTHONPATH"), sibling.into_os_string())]);
        let run = |env: &HashMap<OsString, OsString>| {
            std::process::Command::new(python)
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
            "unsanitized sibling path must reproduce the bug"
        );
        std::fs::remove_file(&marker).unwrap();
        sanitize_python_env(&mut env);
        assert!(run(&env).success());
        assert!(
            !marker.exists(),
            "sibling sitecustomize ran after filtering"
        );
    }

    #[test]
    fn executable_search_rejects_repository_sibling_paths() {
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("repo");
        let project = repo.join("app");
        let sibling = repo.join("tools");
        let trusted = root.path().join("trusted");
        for dir in [&project, &sibling, &trusted] {
            std::fs::create_dir_all(dir).unwrap();
        }
        std::fs::create_dir(repo.join(".git")).unwrap();
        assert!(!safe_path(&sibling, Some(&project)));
        assert!(safe_path(&trusted, Some(&project)));
        #[cfg(unix)]
        {
            let alias = root.path().join("alias");
            std::os::unix::fs::symlink(&project, &alias).unwrap();
            assert!(!safe_path(&sibling, Some(&alias)));
        }

        let mut env = HashMap::from([(
            OsString::from("PATH"),
            std::env::join_paths([Path::new("."), &sibling, &trusted]).unwrap(),
        )]);
        sanitize_uv_path(&mut env, Some(&project));
        assert_eq!(env.get(OsStr::new("PATH")), Some(&trusted.into_os_string()));
    }
}
