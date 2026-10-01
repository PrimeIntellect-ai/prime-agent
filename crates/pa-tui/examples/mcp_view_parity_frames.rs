//! The `/mcp` view's parity harness (TS `ServiceCatalogPickerComponent`):
//! renders the fixture frames the TS side (the read-only checkout's own
//! component, driven through tsx) produces for the same input, so the
//! two can be diffed line-for-line. Takes the fixture JSON path, the
//! viewport rows, the render width, and a key sequence (space-separated
//! key ids, "-" for none); prints one trimmed frame line per stdout
//! line. Test/evidence tooling — never linked into the product.
// Pedantic-gate exceptions (every other pedantic warning in this crate is
// fixed in place; each exception carries its one-line justification):
// - the casts: terminal-layout arithmetic narrows structurally bounded
//   values (screen coordinates, byte counts, timestamps); guarded
//   conversions would add panic paths the bounds guarantee away.
#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss
)]
// - the render routes are flat tables (one arm per route); splitting them
//   would add indirection without changing the flow.
#![allow(clippy::too_many_lines)]
// - widget state structs carry independent flag bits; a nested struct
//   would add indirection without changing the shape.
#![allow(clippy::struct_excessive_bools, clippy::fn_params_excessive_bools)]
// - the futures are bounded by the surface's lifetime; boxing them would
//   add an allocation to the steady-state loop.
#![allow(clippy::large_futures)]
// - the wrappers preserve a uniform Result-returning API surface; unwrap
//   removals would ripple through the callers without changing behavior.
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
