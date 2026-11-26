//! `pa-tui-replay`: render a captured agent session in the pa-tui agent view. Modes: live
//! (default) — full-screen TUI in a real terminal; `--frame WxH` — one frame as plain
//! text to stdout (the tmux verifier), ANSI-styled with `--color`, with the step flags driving
//! the view's own expansion state; `--panic-exit` — panic mid-loop after the first
//! paint (the exit-restore verifier: a real unwind must leave the terminal whole).
// Casts: terminal-layout arithmetic narrows structurally bounded values.
#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss
)]
// Flat route tables: splitting the arms would add indirection.
#![allow(clippy::too_many_lines)]
// Independent flag bits: a nested struct would add indirection.
#![allow(clippy::struct_excessive_bools, clippy::fn_params_excessive_bools)]
// Futures are bounded by the surface's lifetime; boxing would add a per-loop allocation.
#![allow(clippy::large_futures)]
// Wrappers keep a uniform Result-returning API; removals would ripple through callers.
#![allow(clippy::unnecessary_wraps)]

use anyhow::{Context, Result};
use clap::Parser;
use pa_tui::app::{render_frame_styled, render_frame_text, run_app, AppOptions};
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
    /// Show thinking blocks in the transcript dump (the `details` level; only with --frame).
    #[arg(long, default_value_t = false)]
    show_thinking: bool,
    /// Render each thought and tool call as one summary line (the `compactSteps` setting; only
    /// with --frame).
    #[arg(long, default_value_t = false)]
    compact_steps: bool,
    /// Expand every step, as the expand/collapse-all shortcut does (only with --frame).
    #[arg(long, default_value_t = false)]
    expand_all: bool,
    /// Toggle transcript entry N (0-based) as a click on it does; repeatable, applied after
    /// --expand-all (only with --frame).
    #[arg(long, value_name = "N")]
    expand_entry: Vec<usize>,
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
    // Restore Windows VT on success and early error returns.
    if let Err(error) = replay() {
        pa_types::platform::console_restore();
        return Err(error);
    }
    pa_types::platform::console_restore();
    Ok(())
}

fn replay() -> Result<()> {
    let args = Args::parse();
    let path = match &args.session {
        Some(p) => std::path::PathBuf::from(p),
        None => newest_session()?,
    };
    let stream = JsonlSessionStream::from_path(&path)?;

    if let Some(size) = &args.frame {
        let (w, h) = size
            .split_once('x')
            .and_then(|(w, h)| Some((w.parse::<u16>().ok()?, h.parse::<u16>().ok()?)))
            .context("--frame expects WxH, e.g. 80x24")?;
        let theme = Theme::builtin(&args.theme, ColorMode::TrueColor);
        let mut view = AgentView::new(theme);
        view.compact_steps = args.compact_steps;
        if args.show_thinking {
            view.detail = pa_tui::chat::Detail::Details;
        }
        let mut stream: Box<dyn SessionStream> = Box::new(stream);
        while let pa_tui::session::SessionEvent::Item(item) = stream.poll()? {
            if let TranscriptItem::ModelChange { provider, model_id } = &item {
                view.chrome.model_id = Some(model_id.clone());
                view.chrome.model_provider = Some(provider.clone());
            }
            view.push(item);
        }
        // The same view state the shortcut and a click flip.
        if args.expand_all {
            view.toggle_all_steps();
        }
        for &entry in &args.expand_entry {
            anyhow::ensure!(
                entry < view.chat_len(),
                "--expand-entry {entry}: the transcript has {} entries",
                view.chat_len()
            );
            view.toggle_card_expansion(entry);
        }
        if args.color {
            let frame = render_frame_styled(&mut view, w, h);
            print!("{}", pa_tui::ansi::lines_to_ansi_block(&frame, w.into()));
        } else {
            for line in render_frame_text(&mut view, w, h) {
                println!("{line}");
            }
        }
        return Ok(());
    }

    let options = AppOptions {
        theme: args.theme.clone(),
        panic_after_frame: args.panic_exit,
        ..Default::default()
    };
    run_app(
        Box::new(stream),
        &options,
        Box::new(|text| {
            // Submissions print to the transcript; nothing is sent to a
            // model.
            let _ = text;
        }),
    )
}
