//! Differential parity harness: prints `word_wrap_line` chunks for a JSON corpus of
//! [line, maxWidth] pairs, one output array per case, matching the TS wordWrapLine shape
//! (text + start/end indices) for byte-diffing.
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

use std::io::Read;

fn main() {
    let path = std::env::args().nth(1).expect("corpus path");
    let mut raw = String::new();
    std::fs::File::open(&path)
        .expect("open corpus")
        .read_to_string(&mut raw)
        .expect("read corpus");
    let cases: Vec<(String, usize)> = serde_json::from_str(&raw).expect("parse corpus");
    let mut out = String::from("[");
    for (i, (line, width)) in cases.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        let chunks = pa_tui::editor::word_wrap_line(line, *width, None);
        out.push('[');
        for (j, c) in chunks.iter().enumerate() {
            if j > 0 {
                out.push(',');
            }
            out.push_str(
                &serde_json::json!({
                    "text": c.text,
                    "startIndex": c.start_index,
                    "endIndex": c.end_index,
                })
                .to_string(),
            );
        }
        out.push(']');
    }
    out.push(']');
    println!("{out}");
}
