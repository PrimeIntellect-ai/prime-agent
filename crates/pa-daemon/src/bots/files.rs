//! `pull_bot_files`: copy one file or directory out of a bot. The bot has no
//! platform credential and no shared path, so the supervisor streams a tar
//! archive of the path over the exec stream and unpacks it on this machine.

use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use anyhow::{bail, Context, Result};
use pa_sandbox::CommandSpec;
use pa_types::daemon::DaemonCommand;
use serde_json::json;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use super::commands::BOT_DEADLINE;
use super::{BotManager, BotRecord};
use crate::protocol::{response_failure, response_success, DaemonResponse};
use crate::supervisor::Supervisor;

/// The largest archive one pull takes. A larger one fails; it is never cut.
pub const MAX_PULL_BYTES: u64 = 256 * 1024 * 1024;

/// The bot's working directory: relative bot paths start here.
const GUEST_HOME: &str = "/root";

/// The guest directory and the entry name to archive for `path`.
fn guest_target(path: &str) -> Result<(String, String)> {
    let path = path.trim();
    let full = if path.starts_with('/') {
        path.to_string()
    } else {
        format!("{GUEST_HOME}/{path}")
    };
    let full = full.trim_end_matches('/');
    let (dir, name) = full.rsplit_once('/').unwrap_or(("", full));
    if name.is_empty() || name == "." || name == ".." {
        bail!("name one file or directory in the bot, not {path:?}");
    }
    let dir = if dir.is_empty() { "/" } else { dir };
    Ok((dir.to_string(), name.to_string()))
}

/// Copy `reader` to `writer`, failing once more than `cap` bytes arrive.
async fn copy_capped<R, W>(reader: &mut R, writer: &mut W, cap: u64) -> Result<u64>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut buffer = vec![0u8; 64 * 1024];
    let mut total = 0u64;
    loop {
        let read = reader.read(&mut buffer).await?;
        if read == 0 {
            writer.flush().await?;
            return Ok(total);
        }
        total += u64::try_from(read)?;
        if total > cap {
            bail!("the bot path is larger than the pull limit of {cap} bytes");
        }
        writer.write_all(&buffer[..read]).await?;
    }
}

/// Unpack `archive` under `dest`. Only regular files and directories with
/// plain relative names are taken, and no existing file is replaced.
/// Returns the written files.
fn unpack(archive: &Path, dest: &Path) -> Result<Vec<PathBuf>> {
    let mut archive = tar::Archive::new(std::fs::File::open(archive)?);
    let mut written = Vec::new();
    for entry in archive.entries()? {
        let mut entry = entry?;
        let name = entry.path()?.into_owned();
        if name.as_os_str().is_empty()
            || !name
                .components()
                .all(|component| matches!(component, Component::Normal(_)))
        {
            bail!(
                "the bot archive has an unsafe member name: {}",
                name.display()
            );
        }
        let target = dest.join(&name);
        match entry.header().entry_type() {
            tar::EntryType::Directory => std::fs::create_dir_all(&target)?,
            tar::EntryType::Regular | tar::EntryType::Continuous => {
                if let Some(parent) = target.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                let mut file = std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&target)
                    .with_context(|| format!("cannot write {}", target.display()))?;
                std::io::copy(&mut entry, &mut file)?;
                written.push(target);
            }
            tar::EntryType::XGlobalHeader => {}
            other => bail!(
                "the bot archive member {} is a {other:?}; only files and directories are pulled",
                name.display()
            ),
        }
    }
    Ok(written)
}

impl BotManager {
    /// Archive `path` in the bot with `tar` and write the archive to
    /// `archive`, at most [`MAX_PULL_BYTES`]. Returns the archive size.
    ///
    /// # Errors
    ///
    /// Returns the error when the bot has no sandbox, the stream fails, the
    /// archive is over the limit, or `tar` fails in the bot.
    pub async fn archive_path(&self, bot: &BotRecord, path: &str, archive: &Path) -> Result<u64> {
        let sandbox_id = bot
            .sandbox_id
            .as_deref()
            .with_context(|| format!("the bot {} has no sandbox", bot.name))?;
        let (dir, name) = guest_target(path)?;
        let command = CommandSpec {
            cmd: "tar".into(),
            args: vec![
                "-C".into(),
                dir,
                "-cf".into(),
                "-".into(),
                "--".into(),
                name,
            ],
            envs: std::collections::BTreeMap::new(),
            cwd: None,
        };
        let mut halves = self.platform.open_stream(sandbox_id, &command).await?;
        let mut file = tokio::fs::File::create(archive).await?;
        // Dropping the halves on an error ends the guest process.
        let size = copy_capped(&mut halves.read, &mut file, MAX_PULL_BYTES).await?;
        let end = halves.ended.await.unwrap_or_default();
        if !end.starts_with("exit code 0,") {
            bail!("tar in the bot failed: {end}");
        }
        Ok(size)
    }
}

impl Supervisor {
    /// `pull_bot_files`: copy one path out of a bot its owner names into
    /// `dest`. A paused bot is resumed, and paused again after the grace.
    pub(crate) async fn handle_pull_bot_files(
        self: &Arc<Self>,
        command_id: &str,
        command: &DaemonCommand,
    ) -> DaemonResponse {
        let DaemonCommand::PullBotFiles {
            bot_id,
            owner_session_id,
            path,
            dest,
            ..
        } = command
        else {
            return response_failure(Some(command_id), "pull_bot_files", "invalid command", None);
        };
        let pulled = tokio::time::timeout(
            BOT_DEADLINE,
            self.pull_bot_files(bot_id, owner_session_id, path, Path::new(dest)),
        )
        .await
        .unwrap_or_else(|_| {
            Err(anyhow::anyhow!(
                "the pull did not finish within {BOT_DEADLINE:?}"
            ))
        });
        match pulled {
            Ok((files, bytes)) => response_success(
                Some(command_id),
                "pull_bot_files",
                Some(json!({ "files": files, "bytes": bytes })),
            ),
            Err(error) => response_failure(
                Some(command_id),
                "pull_bot_files",
                &format!("{error:#}"),
                None,
            ),
        }
    }

    async fn pull_bot_files(
        self: &Arc<Self>,
        bot_id: &str,
        owner_session_id: &str,
        path: &str,
        dest: &Path,
    ) -> Result<(Vec<PathBuf>, u64)> {
        if !dest.is_absolute() {
            bail!("the pull destination must be an absolute directory");
        }
        let manager = super::manager_for(&self.options.agent_dir)?;
        let record = manager
            .list()
            .into_iter()
            .find(|bot| bot.bot_id == bot_id && bot.owner_session_id == owner_session_id)
            .ok_or_else(|| anyhow::anyhow!("Unknown bot: {bot_id}"))?;
        // The idle pause skips an attached bot, so it cannot cut the stream.
        let guard = manager.attach_guard(bot_id);
        let pulled = async {
            let record = manager.ensure_running(&record.bot_id).await?;
            tokio::fs::create_dir_all(dest).await?;
            let archive = dest.join(format!(".bot-pull-{}.tar", uuid::Uuid::new_v4().simple()));
            let archived = manager.archive_path(&record, path, &archive).await;
            let unpacked = match archived {
                Ok(bytes) => {
                    let (archive, dest) = (archive.clone(), dest.to_path_buf());
                    tokio::task::spawn_blocking(move || unpack(&archive, &dest))
                        .await
                        .context("the unpack task failed")?
                        .map(|files| (files, bytes))
                }
                Err(error) => Err(error),
            };
            let _ = tokio::fs::remove_file(&archive).await;
            unpacked
        }
        .await;
        drop(guard);
        // Pause the bot again once it is idle.
        self.follow_bot(bot_id);
        pulled
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guest_targets_resolve_against_the_bot_home() {
        assert_eq!(
            guest_target("out/run/").unwrap(),
            ("/root/out".to_string(), "run".to_string())
        );
        assert_eq!(
            guest_target("/tmp/a.txt").unwrap(),
            ("/tmp".to_string(), "a.txt".to_string())
        );
        assert!(guest_target("..").is_err());
        assert!(guest_target("/").is_err());
    }

    #[tokio::test]
    async fn a_stream_over_the_cap_fails() {
        let mut sink = Vec::new();
        let mut data: &[u8] = &[7u8; 100];
        assert!(copy_capped(&mut data, &mut sink, 99).await.is_err());
        let mut data: &[u8] = &[7u8; 100];
        sink.clear();
        assert_eq!(copy_capped(&mut data, &mut sink, 100).await.unwrap(), 100);
        assert_eq!(sink.len(), 100);
    }

    fn archive_with(build: impl FnOnce(&mut tar::Builder<Vec<u8>>)) -> tempfile::NamedTempFile {
        let mut builder = tar::Builder::new(Vec::new());
        build(&mut builder);
        let bytes = builder.into_inner().unwrap();
        let file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(file.path(), bytes).unwrap();
        file
    }

    fn header(kind: tar::EntryType, size: u64) -> tar::Header {
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(kind);
        header.set_size(size);
        header.set_mode(0o644);
        header
    }

    #[test]
    fn unpack_takes_files_and_dirs_and_refuses_unsafe_members() {
        let dest = tempfile::tempdir().unwrap();
        let good = archive_with(|builder| {
            builder
                .append_data(&mut header(tar::EntryType::Directory, 0), "run", &[][..])
                .unwrap();
            builder
                .append_data(
                    &mut header(tar::EntryType::Regular, 2),
                    "run/a.txt",
                    &b"hi"[..],
                )
                .unwrap();
        });
        let files = unpack(good.path(), dest.path()).unwrap();
        assert_eq!(files, [dest.path().join("run/a.txt")]);
        assert_eq!(std::fs::read(&files[0]).unwrap(), b"hi");
        // An existing file is never replaced.
        assert!(unpack(good.path(), dest.path()).is_err());

        let link = archive_with(|builder| {
            let mut link = header(tar::EntryType::Symlink, 0);
            builder.append_link(&mut link, "evil", "/etc").unwrap();
        });
        assert!(unpack(link.path(), dest.path()).is_err());

        // `..` and absolute names, written raw: the builder refuses them.
        for name in ["../escape", "/abs"] {
            let mut header = header(tar::EntryType::Regular, 1);
            header.as_old_mut().name[..name.len()].copy_from_slice(name.as_bytes());
            header.set_cksum();
            let mut bytes = header.as_bytes().to_vec();
            bytes.extend_from_slice(&[b'x'; 512]);
            bytes.extend_from_slice(&[0u8; 1024]);
            let file = tempfile::NamedTempFile::new().unwrap();
            std::fs::write(file.path(), bytes).unwrap();
            assert!(unpack(file.path(), dest.path()).is_err(), "{name}");
        }
        assert!(!dest.path().parent().unwrap().join("escape").exists());
    }
}
