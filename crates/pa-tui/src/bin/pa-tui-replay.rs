//! `pa-tui-replay`: render a captured agent session in the pa-tui agent view.
//!
//! Modes:
//! - live (default): full-screen TUI in a real terminal; typing, editing keys,
//!   and history navigation behave like the interactive product.
//! - `--frame WxH`: render one 80x24-style frame as plain text to stdout
//!   (headless structural dump for the tmux verifier).
//! - `--panic-exit`: panic mid-loop after the first paint (the exit-restore
//!   verifier's driver: a real unwind on a live surface must still leave
//!   the terminal whole — alt screen left, cooked tty, no mode leaks).

use anyhow::{Context, Result};
use clap::Parser;
use pa_tui::app::{render_frame_text, run_app, AppOptions};
use pa_tui::session::{JsonlSessionStream, SessionStream, TranscriptItem};
use pa_tui::theme::{ColorMode, Theme};
use pa_tui::view::AgentView;

#[derive(Parser, Debug)]
#[command(
    name = "pa-tui-replay",
    about = "Replay a prime-agent session in the TUI"
)]
struct Args {
    /// Path to the session JSONL file (defaults to the newest session).
    session: Option<String>,
    /// Theme: prime | dark | light.
    #[arg(long, default_value = "prime")]
    theme: String,
    /// Headless single-frame dump at this size, e.g. 80x24.
    #[arg(long)]
    frame: Option<String>,
    /// Print the frame with ANSI colors (only with --frame).
    #[arg(long, default_value_t = false)]
    color: bool,
    /// Show thinking blocks in the transcript dump.
    #[arg(long, default_value_t = false)]
    show_thinking: bool,
    /// Panic mid-loop after the first paint (the exit-restore verifier's
    /// panic-path driver: a real unwind on the live surface).
    #[arg(long, default_value_t = false)]
    panic_exit: bool,
}

fn newest_session() -> Result<std::path::PathBuf> {
    let dir = pa_types::platform::home_dir()
        .context("home directory not found (HOME, or USERPROFILE on Windows)")?
        .join(".prime/agent/sessions");
    let mut best: Option<(std::time::SystemTime, std::path::PathBuf)> = None;
    for entry in std::fs::read_dir(&dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let mtime = entry.metadata()?.modified()?;
        if best.as_ref().is_none_or(|(t, _)| mtime > *t) {
            best = Some((mtime, path));
        }
    }
    best.map(|(_, p)| p)
        .context("no session files found in ~/.prime/agent/sessions")
}

fn main() -> Result<()> {
    let args = Args::parse();
    let path = match &args.session {
        Some(p) => std::path::PathBuf::from(p),
        None => newest_session()?,
    };
    let stream = JsonlSessionStream::from_path(&path)?;
    let _ = args.show_thinking;

    if let Some(size) = &args.frame {
        let (w, h) = size
            .split_once('x')
            .and_then(|(w, h)| Some((w.parse::<u16>().ok()?, h.parse::<u16>().ok()?)))
            .context("--frame expects WxH, e.g. 80x24")?;
        let theme = Theme::builtin(&args.theme, ColorMode::TrueColor);
        let mut view = AgentView::new(theme);
        let mut stream: Box<dyn SessionStream> = Box::new(stream);
        while let pa_tui::session::SessionEvent::Item(item) = stream.poll()? {
            if let TranscriptItem::ModelChange { model_id, .. } = &item {
                view.chrome.model_id = Some(model_id.clone());
            }
            view.push(item);
        }
        for line in render_frame_text(&mut view, w, h) {
            println!("{line}");
        }
        let _ = &args.color;
        return Ok(());
    }

    let options = AppOptions {
        theme: args.theme.clone(),
        panic_after_frame: args.panic_exit,
        ..Default::default()
    };
    run_app(
        Box::new(stream),
        options,
        Box::new(|text| {
            // In replay mode submissions print to the transcript as new user
            // turns would be queued; nothing is sent to a model.
            let _ = text;
        }),
    )
}
