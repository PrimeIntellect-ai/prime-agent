//! Python subprocess environment: inherited path overrides must not turn a
//! repository into interpreter startup code before the user has acted.

use std::collections::HashMap;
#[cfg(any(not(windows), test))]
use std::ffi::OsStr;
use std::ffi::OsString;
use std::path::Path;

/// Reject executable search paths inside the opened repository, even when the
/// session cwd is a subdirectory. An ancestor can also expose project files.
fn path_starts_with(path: &Path, project: &Path) -> bool {
    #[cfg(windows)]
    {
        // Windows paths are case-insensitive, including when the input uses
        // different casing from the spelling returned by canonicalize.
        let project = project.to_string_lossy().to_lowercase();
        let path = path.to_string_lossy().to_lowercase();
        let project = Path::new(&project);
        let path = Path::new(&path);
        path.starts_with(project)
    }
    #[cfg(not(windows))]
    {
        path.starts_with(project)
    }
}

fn paths_overlap(path: &Path, project: &Path) -> bool {
    path_starts_with(path, project) || path_starts_with(project, path)
}

pub(crate) fn safe_path(path: &Path, project: Option<&Path>) -> bool {
    safe_path_with_home(path, project, pa_types::platform::home_dir().as_deref())
}

/// An ancestor PATH entry is safe for direct executable lookup only when the
/// selected executable itself resolves outside the project.
pub(crate) fn safe_executable_path(path: &Path, project: Option<&Path>) -> bool {
    safe_path_with_home_mode(
        path,
        project,
        pa_types::platform::home_dir().as_deref(),
        true,
    )
}

fn safe_path_with_home(path: &Path, project: Option<&Path>, home: Option<&Path>) -> bool {
    safe_path_with_home_mode(path, project, home, false)
}

fn safe_path_with_home_mode(
    path: &Path,
    project: Option<&Path>,
    home: Option<&Path>,
    allow_ancestor: bool,
) -> bool {
    let Some(project) = project else {
        return false;
    };
    let Ok(project) = project.canonicalize() else {
        return false;
    };
    let repository_root = project
        .ancestors()
        .filter(|ancestor| ancestor.join(".git").exists())
        .last();
    // Opening the user's home itself does not make its normal tool installs
    // repository-controlled. A Git checkout at home still remains untrusted.
    let unmarked_home = repository_root.is_none()
        && home.and_then(|home| home.canonicalize().ok()).as_deref() == Some(project.as_path());
    let boundary = repository_root.unwrap_or(&project);
    if !path.is_absolute() {
        return false;
    }
    let Ok(canonical_path) = path.canonicalize() else {
        return false;
    };
    let trusted_home_tool = unmarked_home
        && home
            .and_then(|home| {
                let tools = home.join(".local/bin");
                tools
                    .canonicalize()
                    .ok()
                    .map(|canonical| (tools, canonical))
            })
            .is_some_and(|(tools, canonical)| {
                (path_starts_with(path, &tools) || path_starts_with(path, &canonical))
                    && canonical == project.join(".local/bin")
                    && path_starts_with(&canonical_path, &canonical)
            });
    let overlaps = if allow_ancestor {
        path_starts_with(path, boundary) || path_starts_with(&canonical_path, boundary)
    } else {
        paths_overlap(path, boundary) || paths_overlap(&canonical_path, boundary)
    };
    trusted_home_tool || !overlaps
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

    #[test]
    fn unmarked_home_keeps_user_tool_install_but_home_repo_blocks_it() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let tool_dir = home.join(".local/bin");
        let untrusted = home.join("untrusted-repo/tools");
        std::fs::create_dir_all(&tool_dir).unwrap();
        std::fs::create_dir_all(&untrusted).unwrap();
        assert!(safe_path_with_home(&tool_dir, Some(&home), Some(&home)));
        assert!(!safe_path_with_home(&untrusted, Some(&home), Some(&home)));
        #[cfg(unix)]
        {
            std::fs::remove_dir(&tool_dir).unwrap();
            std::os::unix::fs::symlink(&untrusted, &tool_dir).unwrap();
            assert!(!safe_path_with_home(&tool_dir, Some(&home), Some(&home)));
            std::fs::remove_file(&tool_dir).unwrap();
            std::fs::create_dir(&tool_dir).unwrap();
        }
        std::fs::create_dir(home.join(".git")).unwrap();
        assert!(!safe_path_with_home(&tool_dir, Some(&home), Some(&home)));
    }
}
