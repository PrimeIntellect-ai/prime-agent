//! Saved-session catalog resolve (TS catalog `resolve`): the selector-to-session-file
//! lookup the supervisor uses when a client command addresses a session that is not
//! resident. Local (cwd-scoped) matches win over global ones; an ambiguous selector fails
//! with the TS error so callers can tell it apart from an unknown-target miss.

use std::path::Path;

use anyhow::{anyhow, Context, Result};

use crate::session_store::{list_sessions, session_file_name, SessionInfo};

/// One selector match against saved sessions: the session id is addressable
/// by prefix, the name only exactly; more than one match is ambiguous.
fn catalog_session_match<'a>(
    sessions: impl IntoIterator<Item = &'a SessionInfo>,
    selector: &str,
) -> Result<Option<&'a SessionInfo>> {
    let matches: Vec<&SessionInfo> = sessions
        .into_iter()
        .filter(|info| info.id.starts_with(selector) || info.name.as_deref() == Some(selector))
        .collect();
    match matches.len() {
        0 => Ok(None),
        1 => Ok(Some(matches[0])),
        _ => Err(anyhow!("Ambiguous session selector \"{selector}\"")),
    }
}

/// Resolve one selector to a saved session: cwd-scoped sessions first, the
/// whole live catalog second. A live miss lazily restores a match from
/// `sessions-archive/` (written by older Rust releases) before waking its worker. Misses are `None` (the caller
/// answers its unknown-target error, not a catalog one).
pub(crate) fn resolve_saved_session(
    sessions_dir: &Path,
    archive_dir: &Path,
    selector: &str,
    cwd: &str,
) -> Result<Option<SessionInfo>> {
    let all = list_sessions(sessions_dir);
    let local = catalog_session_match(all.iter().filter(|info| info.cwd == cwd), selector)?;
    if let Some(info) = local {
        return Ok(Some(info.clone()));
    }
    if let Some(info) = catalog_session_match(all.iter(), selector)? {
        return Ok(Some(info.clone()));
    }
    let archived = list_sessions(archive_dir);
    let local = catalog_session_match(archived.iter().filter(|info| info.cwd == cwd), selector)?;
    let matched = match local {
        Some(info) => Some(info),
        None => catalog_session_match(archived.iter(), selector)?,
    };
    let Some(info) = matched else {
        return Ok(None);
    };
    let destination = sessions_dir.join(session_file_name(&info.id));
    std::fs::create_dir_all(sessions_dir)?;
    // Stage in the live directory so custom sessions dirs on another
    // filesystem work too. Publish a complete file without replacing any
    // live path, even one the catalog could not parse.
    let temp = sessions_dir.join(format!(".restore-{}.tmp", uuid::Uuid::new_v4()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    pa_core::platform::perms::set_private_mode(&mut options);
    let mut target = options.open(&temp)?;
    let result = (|| -> Result<()> {
        let mut source = std::fs::File::open(&info.path)?;
        std::io::copy(&mut source, &mut target)?;
        target.set_times(std::fs::FileTimes::new().set_modified(source.metadata()?.modified()?))?;
        target.sync_all()?;
        Ok(())
    })();
    drop(target);
    let result = result
        .and_then(|()| std::fs::hard_link(&temp, &destination).context("publish restored session"));
    let cleanup = std::fs::remove_file(&temp);
    result.with_context(|| format!("restore archived session {}", info.id))?;
    cleanup.with_context(|| format!("remove restore staging file {}", temp.display()))?;
    std::fs::remove_file(&info.path)
        .with_context(|| format!("unlink restored archive {}", info.path.display()))?;
    let mut restored = info.clone();
    restored.path = destination;
    Ok(Some(restored))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_store::{session_file_name, SessionFile};
    use std::path::PathBuf;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pa-catalog-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_session(dir: &Path, cwd: &str, name: Option<&str>) -> (String, PathBuf) {
        let mut session = SessionFile::create(cwd, None, 0);
        if let Some(name) = name {
            session.append_session_info(name);
        }
        session.append_message(&serde_json::json!({
            "role": "user", "content": "hi", "timestamp": 1u64
        }));
        let path = dir.join(session_file_name(session.session_id()));
        session.set_path(path.clone());
        session.rewrite().unwrap();
        (session.session_id().to_string(), path)
    }

    #[test]
    fn resolves_by_id_prefix_and_exact_name() {
        let dir = temp_dir();
        let (id, _path) = write_session(&dir, "/work/a", Some("alpha"));
        let found = resolve_saved_session(&dir, &dir.join("archive"), &id[..8], "/work/a")
            .unwrap()
            .expect("id prefix resolves");
        assert_eq!(found.id, id);
        let found = resolve_saved_session(&dir, &dir.join("archive"), "alpha", "/work/a")
            .unwrap()
            .expect("name resolves");
        assert_eq!(found.id, id);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn local_scope_wins_and_global_is_the_fallback() {
        let dir = temp_dir();
        let (id, _path) = write_session(&dir, "/work/a", Some("alpha"));
        // A different cwd still resolves through the global pass.
        let found = resolve_saved_session(&dir, &dir.join("archive"), "alpha", "/work/other")
            .unwrap()
            .expect("global fallback");
        assert_eq!(found.id, id);
        // The local pass serves the session's own cwd.
        let found = resolve_saved_session(&dir, &dir.join("archive"), &id[..8], "/work/a")
            .unwrap()
            .expect("local pass");
        assert_eq!(found.cwd, "/work/a");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ambiguous_selectors_carry_the_ts_error() {
        let dir = temp_dir();
        write_session(&dir, "/work/a", Some("alpha"));
        write_session(&dir, "/work/a", Some("alpha"));
        let error =
            resolve_saved_session(&dir, &dir.join("archive"), "alpha", "/work/a").unwrap_err();
        assert_eq!(error.to_string(), "Ambiguous session selector \"alpha\"");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn archived_roots_restore_by_id_prefix_or_name_and_resolve_again() {
        for selector_index in 0..3 {
            let root = tempfile::TempDir::new().unwrap();
            let sessions = root.path().join("sessions");
            let archive = root.path().join("sessions-archive");
            std::fs::create_dir_all(&archive).unwrap();
            let (id, path) = write_session(&archive, "/work/a", Some("alpha"));
            let bytes = std::fs::read(&path).unwrap();
            let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
            let mut expected = crate::session_store::read_session_info(&path).unwrap();
            expected.path = sessions.join(session_file_name(&id));
            let selector = [id.as_str(), &id[..8], "alpha"][selector_index];
            // A global lookup must still recover a root created before upgrade.
            let restored = resolve_saved_session(&sessions, &archive, selector, "/other")
                .unwrap()
                .expect("archived selector resolves");
            assert_eq!(restored, expected);
            assert_eq!(std::fs::read(&restored.path).unwrap(), bytes);
            assert_eq!(
                std::fs::metadata(&restored.path)
                    .unwrap()
                    .modified()
                    .unwrap(),
                modified
            );
            assert!(!path.exists(), "restored file leaves the archive");
            let again = resolve_saved_session(&sessions, &archive, selector, "/other")
                .unwrap()
                .expect("restored session resolves again");
            assert_eq!(again.id, id);
            assert_eq!(again.path, restored.path);
            assert_eq!(std::fs::read(&again.path).unwrap(), bytes);
        }
    }

    #[test]
    fn a_restore_never_clobbers_an_unreadable_live_session() {
        let root = tempfile::TempDir::new().unwrap();
        let sessions = root.path().join("sessions");
        let archive = root.path().join("sessions-archive");
        std::fs::create_dir_all(&sessions).unwrap();
        std::fs::create_dir_all(&archive).unwrap();
        let (id, path) = write_session(&archive, "/work/a", Some("alpha"));
        let bytes = std::fs::read(&path).unwrap();
        let live_path = sessions.join(session_file_name(&id));
        let live_bytes = b"unparseable live session bytes\n";
        std::fs::write(&live_path, live_bytes).unwrap();
        for _ in 0..2 {
            assert!(resolve_saved_session(&sessions, &archive, "alpha", "/work/a").is_err());
            assert_eq!(std::fs::read(&live_path).unwrap(), live_bytes);
            assert_eq!(std::fs::read(&path).unwrap(), bytes);
            let remaining: Vec<_> = std::fs::read_dir(&sessions)
                .unwrap()
                .map(|entry| entry.unwrap().path())
                .collect();
            assert_eq!(remaining, vec![live_path.clone()]);
        }
    }

    #[test]
    fn live_matches_win_over_archived_ones() {
        let root = tempfile::TempDir::new().unwrap();
        let sessions = root.path().join("sessions");
        let archive = root.path().join("sessions-archive");
        std::fs::create_dir_all(&sessions).unwrap();
        std::fs::create_dir_all(&archive).unwrap();
        let (live_id, _) = write_session(&sessions, "/other", Some("alpha"));
        let (_, archived_path) = write_session(&archive, "/work/a", Some("alpha"));
        let bytes = std::fs::read(&archived_path).unwrap();
        let found = resolve_saved_session(&sessions, &archive, "alpha", "/work/a")
            .unwrap()
            .expect("live global match wins over archived local match");
        assert_eq!(found.id, live_id);
        assert_eq!(std::fs::read(&archived_path).unwrap(), bytes);
    }

    #[test]
    fn archived_matches_keep_local_scope_and_ambiguity_rules() {
        let root = tempfile::TempDir::new().unwrap();
        let sessions = root.path().join("sessions");
        let archive = root.path().join("sessions-archive");
        std::fs::create_dir_all(&archive).unwrap();
        let (local_id, _) = write_session(&archive, "/work/a", Some("alpha"));
        let (_, other_path) = write_session(&archive, "/other", Some("alpha"));
        let error = resolve_saved_session(&sessions, &archive, "alpha", "/third").unwrap_err();
        assert_eq!(error.to_string(), "Ambiguous session selector \"alpha\"");
        let found = resolve_saved_session(&sessions, &archive, "alpha", "/work/a")
            .unwrap()
            .expect("local archived match wins");
        assert_eq!(found.id, local_id);
        assert!(other_path.is_file(), "unselected archives stay in place");
    }

    #[test]
    fn a_miss_is_none_not_an_error() {
        let dir = temp_dir();
        write_session(&dir, "/work/a", Some("alpha"));
        let found = resolve_saved_session(&dir, &dir.join("archive"), "ghost", "/work/a").unwrap();
        assert!(found.is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
