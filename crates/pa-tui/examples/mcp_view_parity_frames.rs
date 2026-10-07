//! The `/mcp` view's parity harness: renders the fixture frames the TS side produces
//! for the same input, so the two can be diffed line-for-line. Test/evidence tooling —
//! never linked into the product.
// Casts: terminal-layout arithmetic narrows structurally bounded values (screen
// coordinates, byte counts, timestamps); guarded conversions would add panic paths the
// bounds guarantee away.
#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss
)]
// Style gate only: flat render tables split cleanly per route.
#![allow(clippy::too_many_lines)]
// Style gate only: independent flag bits; a nested struct adds indirection without changing
// the shape.
#![allow(clippy::struct_excessive_bools, clippy::fn_params_excessive_bools)]
// The futures are bounded by the surface's lifetime; boxing them would add an allocation to
// the steady-state loop.
#![allow(clippy::large_futures)]
// The wrappers preserve a uniform Result-returning API surface; unwrap removals would ripple
// through the callers without changing behavior.
#![allow(clippy::unnecessary_wraps)]

use std::io::Read as _;

use pa_tui::keybindings::KeybindingsManager;
use pa_tui::mcp_view::McpView;
use pa_tui::theme::{ColorMode, Theme};

fn main() {
    let mut args = std::env::args().skip(1);
    let fixture_path = args.next().expect("fixture path");
    let viewport_rows: usize = args.next().expect("viewport rows").parse().expect("rows");
    let width: usize = args.next().expect("width").parse().expect("width");
    let keys: Vec<String> = args
        .next()
        .map(|sequence| {
            sequence
                .split(' ')
                .filter(|key| !key.is_empty() && *key != "-")
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let mut fixture = String::new();
    std::fs::File::open(&fixture_path)
        .expect("fixture file")
        .read_to_string(&mut fixture)
        .expect("read fixture");
    let data: serde_json::Value = serde_json::from_str(&fixture).expect("fixture json");
    let theme = Theme::builtin("prime", ColorMode::TrueColor);
    let kb = KeybindingsManager::new();
    let mut view = McpView::from_response(&data, viewport_rows);
    for key in keys {
        view.handle_key(&key, &kb);
    }
    for line in view.render(&theme, width, &kb) {
        let text: String = line
            .iter()
            .map(|span| span.content.as_str())
            .collect::<String>();
        println!("{}", text.trim_end());
    }
}
