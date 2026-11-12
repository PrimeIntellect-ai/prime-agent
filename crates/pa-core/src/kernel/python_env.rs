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
    safe_path_with_mode(path, project, false)
}

/// An ancestor PATH entry is safe for direct executable lookup only when the
/// selected executable itself resolves outside the project.
pub(crate) fn safe_executable_path(path: &Path, project: Option<&Path>) -> bool {
    safe_path_with_mode(path, project, true)
}

fn paths_equal(left: &Path, right: &Path) -> bool {
    path_starts_with(left, right) && path_starts_with(right, left)
}

fn safe_path_with_mode(path: &Path, project: Option<&Path>, allow_ancestor: bool) -> bool {
    let Some(project) = project else {
        return false;
    };
    let Ok(project) = project.canonicalize() else {
        return false;
    };
    let repository_roots: Vec<_> = project
        .ancestors()
        .filter(|ancestor| ancestor.join(".git").exists())
        .collect();
    if !path.is_absolute() {
        return false;
    }
    let Ok(canonical_path) = path.canonicalize() else {
        return false;
    };
    // An unmarked filesystem root is not a repository. Requiring a candidate
    // outside it would reject every installed executable on that volume.
    if repository_roots.is_empty() && project.parent().is_none() {
        return true;
    }
    let boundaries = if repository_roots.is_empty() {
        vec![project.as_path()]
    } else {
        repository_roots
    };
    !boundaries.into_iter().any(|boundary| {
        if allow_ancestor {
            path_starts_with(path, boundary) || path_starts_with(&canonical_path, boundary)
        } else {
            paths_overlap(path, boundary) || paths_overlap(&canonical_path, boundary)
        }
    })
}

/// The single global uv install is a trusted executable even when HOME is an
/// enclosing Git checkout. No other HOME path receives this exception.
pub(crate) fn safe_home_uv(path: &Path, project: Option<&Path>) -> bool {
    safe_home_uv_with_home(path, project, pa_types::platform::home_dir().as_deref())
}

fn safe_home_uv_with_home(path: &Path, project: Option<&Path>, home: Option<&Path>) -> bool {
    let (Some(project), Some(home)) = (project, home) else {
        return false;
    };
    let (Ok(project), Ok(canonical_home)) = (project.canonicalize(), home.canonicalize()) else {
        return false;
    };
    let tools = home.join(".local/bin");
    let Ok(canonical_tools) = tools.canonicalize() else {
        return false;
    };
    let uv_name = if cfg!(windows) { "uv.exe" } else { "uv" };
    let Ok(canonical_uv) = path.canonicalize() else {
        return false;
    };
    if !path.is_absolute()
        || !paths_equal(path, &tools.join(uv_name))
        || !paths_equal(&canonical_tools, &canonical_home.join(".local/bin"))
        || !paths_equal(&canonical_uv, &canonical_tools.join(uv_name))
    {
        return false;
    }
    let nearest_checkout = project
        .ancestors()
        .find(|ancestor| ancestor.join(".git").exists());
    // An unmarked filesystem root is not a repository boundary. Mirrors
    // safe_path_with_mode: a first-time setup launched from `/` must still
    // find the home uv.
    if nearest_checkout.is_none() && project.parent().is_none() {
        return true;
    }
    let active_boundary = nearest_checkout.unwrap_or(&project);
    !path_starts_with(&canonical_uv, active_boundary)
}

/// Drop ambient Python import roots after caller overrides are applied.
/// Python imports sitecustomize before the kernel can check it.
pub(crate) fn sanitize_python_env(env: &mut HashMap<OsString, OsString>) {
    for name in [
        "PYTHONPATH",
        "PYTHONHOME",
        "PYTHONUSERBASE",
        "PYTHONNOUSERSITE",
    ] {
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
    env.insert(OsString::from("PYTHONNOUSERSITE"), OsString::from("1"));
}

pub(crate) fn inherited_python_env() -> HashMap<OsString, OsString> {
    let mut env = std::env::vars_os().collect();
    sanitize_python_env(&mut env);
    env
}

/// `uv` probes Python executables on PATH while creating a venv. Exclude
/// relative and repository entries before it can execute a checked-in binary.
pub(crate) fn sanitize_uv_path(env: &mut HashMap<OsString, OsString>, project: Option<&Path>) {
    // These overrides can redirect managed-Python discovery into a checkout
    // even after PATH has been filtered.
    for name in [
        "UV_PYTHON_SEARCH_PATH",
        "UV_PYTHON_INSTALL_DIR",
        "UV_PYTHON",
        "UV_PYTHON_PREFERENCE",
        "UV_MANAGED_PYTHON",
        "UV_NO_MANAGED_PYTHON",
        "UV_SYSTEM_PYTHON",
        "VIRTUAL_ENV",
        "CONDA_PREFIX",
    ] {
        env.retain(|key, _| {
            #[cfg(windows)]
            {
                !key.to_string_lossy().eq_ignore_ascii_case(name)
            }
            #[cfg(not(windows))]
            {
                key.as_os_str() != OsStr::new(name)
            }
        });
    }
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
    fn python_for_test() -> Option<std::path::PathBuf> {
        let path = std::env::var_os("PATH")?;
        for dir in std::env::split_paths(&path) {
            for name in ["python3.11", "python3"] {
                let Ok(python) = dir.join(name).canonicalize() else {
                    continue;
                };
                if python.is_file()
                    && std::process::Command::new(&python)
                        .args(["-P", "-c", "pass"])
                        .status()
                        .is_ok_and(|status| status.success())
                {
                    return Some(python);
                }
            }
        }
        None
    }

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
        #[cfg(windows)]
        env.insert(OsString::from("pythonnousersite"), OsString::from("0"));

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
        assert_eq!(
            env.get(OsStr::new("PYTHONNOUSERSITE")),
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
        let python = python_for_test();
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

    #[cfg(unix)]
    #[test]
    fn default_user_site_cannot_run_usercustomize_before_prompt() {
        let Some(python) = python_for_test() else {
            return;
        };
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project");
        std::fs::create_dir(&project).unwrap();
        let site = std::process::Command::new(&python)
            .args(["-P", "-c", "import site; print(site.getusersitepackages())"])
            .env_clear()
            .env("HOME", &project)
            .output()
            .unwrap();
        assert!(site.status.success());
        let user_site = String::from_utf8(site.stdout).unwrap();
        let user_site = Path::new(user_site.trim());
        std::fs::create_dir_all(user_site).unwrap();
        let marker = root.path().join("user-site-ran");
        std::fs::write(
            user_site.join("usercustomize.py"),
            format!("from pathlib import Path\nPath({marker:?}).touch()\n"),
        )
        .unwrap();
        let mut env = HashMap::from([(OsString::from("HOME"), project.into_os_string())]);
        let run = |env: &HashMap<OsString, OsString>| {
            std::process::Command::new(&python)
                .args(["-P", "-c", "pass"])
                .env_clear()
                .envs(env)
                .status()
                .unwrap()
        };
        assert!(run(&env).success());
        assert!(
            marker.exists(),
            "default user site did not reproduce the bug"
        );
        std::fs::remove_file(&marker).unwrap();
        sanitize_python_env(&mut env);
        assert!(run(&env).success());
        assert!(
            !marker.exists(),
            "user site ran after sanitizing Python env"
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
        for name in [
            "UV_PYTHON_SEARCH_PATH",
            "UV_PYTHON_INSTALL_DIR",
            "UV_PYTHON",
            "UV_PYTHON_PREFERENCE",
            "UV_MANAGED_PYTHON",
            "UV_NO_MANAGED_PYTHON",
            "UV_SYSTEM_PYTHON",
            "VIRTUAL_ENV",
            "CONDA_PREFIX",
        ] {
            env.insert(OsString::from(name), sibling.clone().into_os_string());
        }
        #[cfg(windows)]
        env.insert(
            OsString::from("Uv_Python_Search_Path"),
            sibling.into_os_string(),
        );
        sanitize_uv_path(&mut env, Some(&project));
        assert_eq!(
            env.get(OsStr::new("PATH")),
            Some(&trusted.as_os_str().to_os_string())
        );
        for name in [
            "UV_PYTHON_SEARCH_PATH",
            "UV_PYTHON_INSTALL_DIR",
            "UV_PYTHON",
            "UV_PYTHON_PREFERENCE",
            "UV_MANAGED_PYTHON",
            "UV_NO_MANAGED_PYTHON",
            "UV_SYSTEM_PYTHON",
            "VIRTUAL_ENV",
            "CONDA_PREFIX",
        ] {
            assert!(!env.contains_key(OsStr::new(name)), "{name} survived");
        }
        #[cfg(windows)]
        assert!(!env.contains_key(OsStr::new("Uv_Python_Search_Path")));

        let mut unresolved = HashMap::from([(
            OsString::from("PATH"),
            std::env::join_paths([&trusted]).unwrap(),
        )]);
        sanitize_uv_path(&mut unresolved, None);
        assert!(!unresolved.contains_key(OsStr::new("PATH")));
    }

    #[test]
    fn filesystem_root_without_git_allows_the_home_uv() {
        // A first-time setup launched from `/` (no Git marker anywhere) must
        // still find the home uv: the unmarked root is not a boundary.
        let root = tempfile::tempdir().unwrap();
        let filesystem_root = root.path().ancestors().last().unwrap();
        if filesystem_root.join(".git").exists() {
            return;
        }
        let home = root.path().join("home");
        let tool_dir = home.join(".local/bin");
        let uv_name = if cfg!(windows) { "uv.exe" } else { "uv" };
        let uv = tool_dir.join(uv_name);
        std::fs::create_dir_all(&tool_dir).unwrap();
        std::fs::write(&uv, "uv").unwrap();
        assert!(safe_home_uv_with_home(
            &uv,
            Some(filesystem_root),
            Some(&home)
        ));
    }

    #[test]
    fn only_the_direct_home_uv_is_trusted_outside_the_active_checkout() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let tool_dir = home.join(".local/bin");
        let uv_name = if cfg!(windows) { "uv.exe" } else { "uv" };
        let uv = tool_dir.join(uv_name);
        let untrusted = home.join("tools");
        let untrusted_uv = untrusted.join(uv_name);
        std::fs::create_dir_all(&tool_dir).unwrap();
        std::fs::create_dir_all(&untrusted).unwrap();
        std::fs::write(&uv, "uv").unwrap();
        std::fs::write(&untrusted_uv, "uv").unwrap();
        // A no-Git archive opened at HOME can supply this exact path.
        assert!(!safe_home_uv_with_home(&uv, Some(&home), Some(&home)));
        assert!(!safe_home_uv_with_home(
            &untrusted_uv,
            Some(&home),
            Some(&home)
        ));
        #[cfg(unix)]
        {
            std::fs::remove_file(&uv).unwrap();
            std::fs::remove_dir(&tool_dir).unwrap();
            std::os::unix::fs::symlink(&untrusted, &tool_dir).unwrap();
            assert!(!safe_home_uv_with_home(&uv, Some(&home), Some(&home)));
            std::fs::remove_file(&tool_dir).unwrap();
            std::fs::create_dir(&tool_dir).unwrap();
            std::fs::write(&uv, "uv").unwrap();
        }
        std::fs::create_dir(home.join(".git")).unwrap();
        assert!(!safe_home_uv_with_home(&uv, Some(&home), Some(&home)));
        let nested = home.join("project");
        let nested_tools = nested.join("tools");
        std::fs::create_dir_all(&nested_tools).unwrap();
        std::fs::create_dir(nested.join(".git")).unwrap();
        assert!(safe_home_uv_with_home(&uv, Some(&nested), Some(&home)));
        assert!(!safe_executable_path(&untrusted_uv, Some(&nested)));
        assert!(!safe_home_uv_with_home(
            &untrusted_uv,
            Some(&nested),
            Some(&home)
        ));
        assert!(!safe_home_uv_with_home(
            &nested_tools.join(uv_name),
            Some(&nested),
            Some(&home)
        ));
    }

    #[test]
    fn filesystem_root_without_git_allows_absolute_uv_paths() {
        let root = tempfile::tempdir().unwrap();
        let filesystem_root = root.path().ancestors().last().unwrap();
        if filesystem_root.join(".git").exists() {
            return;
        }
        let tool = root.path().join("uv");
        std::fs::write(&tool, "uv").unwrap();
        assert!(safe_executable_path(&tool, Some(filesystem_root)));
        assert!(safe_path(root.path(), Some(filesystem_root)));
        assert!(!safe_executable_path(
            Path::new("uv"),
            Some(filesystem_root)
        ));
    }
}
