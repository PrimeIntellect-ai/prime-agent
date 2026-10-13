//! The external-editor handoff (TS `openExternalEditor`):
//! `app.editor.external` (default ctrl+g) hands the terminal to the
//! `$VISUAL`/`$EDITOR` child on a temp file and takes the saved text back
//! into the editor.

use anyhow::{Context, Result};

/// The editor command (TS `process.env.VISUAL || process.env.EDITOR`):
/// `$VISUAL` falls through to `$EDITOR` when unset or empty; `None` when
/// no non-empty command is configured at all.
pub(crate) fn editor_command() -> Option<String> {
    let configured = |name: &str| {
        std::env::var(name)
            .ok()
            .filter(|command| !command.is_empty())
    };
    configured("VISUAL").or_else(|| configured("EDITOR"))
}

/// Run `command` on a temp file seeded with `text` and return the saved
/// text (TS: the editor writes the file, the parent re-reads it).
/// `Ok(None)` is a non-zero editor exit — TS keeps the editor text and
/// stays silent; the IO/spawn failure TS swallows is surfaced instead.
/// The temp file is removed on every path past a successful create: we
/// created it, we remove it.
pub(crate) async fn edit(command: &str, text: &str) -> Result<Option<String>> {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_millis())
        .unwrap_or_default();
    // The name shows in the user's editor buffer; the TS `pi-editor-*`
    // form is scrubbed per the branding rule (a deliberate deviation).
    let path = std::env::temp_dir().join(format!("prime-agent-editor-{millis}.md"));
    // O_EXCL (`create_new`): the draft never follows or truncates a
    // pre-planted path or symlink, and 0600 keeps the prompt draft
    // owner-only in the shared temp dir. A pre-existing path fails the create
    // and this ctrl+g surfaces the error row — the path is not ours to
    // overwrite or remove.
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    // A path we did not create is not ours to delete: the cleanup runs on
    // every path past a successful create. The write handle is scoped to the
    // write: it drops before the editor child runs (a held-open handle is a
    // Windows sharing violation — the child could not rewrite the path).
    let written = (|| -> std::io::Result<()> {
        let mut file = options.open(&path)?;
        std::io::Write::write_all(&mut file, text.as_bytes())
    })();
    let outcome = if let Err(error) = written {
        Err(error).with_context(|| format!("write the editor draft to {}", path.display()))
    } else {
        // TS splits the command on spaces (`editorCmd.split(" ")`): the
        // first token is the program, the rest its arguments, and the
        // temp path rides last; win32 shells out instead (`shell:
        // process.platform === "win32"`).
        #[cfg(not(windows))]
        let mut editor = {
            let mut tokens = command.split(' ');
            let mut editor = tokio::process::Command::new(tokens.next().unwrap_or_default());
            editor.args(tokens);
            editor
        };
        #[cfg(windows)]
        let mut editor = {
            let mut editor = tokio::process::Command::new("cmd");
            editor.arg("/C").arg(command);
            editor
        };
        editor.arg(&path);
        match editor.status().await {
            Err(error) => {
                Err(error).with_context(|| format!("run the external editor `{command}`"))
            }
            Ok(status) if !status.success() => Ok(None),
            Ok(_) => match std::fs::read_to_string(&path) {
                Err(error) => Err(error)
                    .with_context(|| format!("read the edited draft back from {}", path.display())),
                // TS strips exactly one trailing newline
                // (`readFileSync(tmp).replace(/\n$/, "")`).
                Ok(saved) => Ok(Some(saved.strip_suffix('\n').unwrap_or(&saved).to_string())),
            },
        }
    };
    let _ = std::fs::remove_file(&path);
    outcome
}
