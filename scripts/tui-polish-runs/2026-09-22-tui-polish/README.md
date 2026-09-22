# tui-polish parity evidence (2026-09-22)

Verifier: `scripts/tui_polish_parity.py` (lane tui-polish). Both sides run on
this box under tmux (120x90); the ts side is the deployed TS release
`0.9.5-linux-x64-bc4b0ed791d1e8b3b5d6a95249a60306d9579fc0d6038e5d7d82f068d81f008d/prime-agent`
(the box PATH `prime-agent` is currently a Rust dogfood install of this repo,
so the harness takes TS_BIN explicitly; `ts_identity.assert_ts_side_is_the_ts_product`
guards the binary used). The rust side is the worktree's
`target/debug/{prime-agent,pa-tui-replay}` at this branch's HEAD.

Result (both PASS; captures regenerated from the final tree at HEAD):

    PASS replay-a_collapsed-120x90 (byte-identical)
    PASS replay-b_details-120x90 (byte-identical)
    PASS replay-c_all-120x90 (byte-identical)
    PASS loader-row (byte-identical rows, ESC[39m gap reset)

A second fix landed before the final rerun: the markdown block-cache key now
carries the fence lang (TS keys on `token.raw`, which includes the info
string) - without it a cached ```python final block could serve its token
colors to a same-content ```json block during streaming (adopted from
tui-polish-v2's review; regression test
`block_cache_does_not_carry_token_colors_across_langs`).

Files:

- `ts-*-120x90.txt` / `rust-*-120x90.txt`: the three detail states per side,
  captured with `tmux capture-pane -e` (ANSI retained).
- `loader-probe-frames.txt`: dense mid-stream captures while the working
  loader was up on both sides (slow reasoning mock).
- `loader-rows.txt`: the normalized loader rows (spinner/elapsed/token
  count normalized; SGR placement retained) — byte-identical sets.

The replay fixture's assistant text carries a ```python fence (keywords,
built-ins, numbers, f-strings, def header, comment, literal), a bare fence
(uniform fallback), and a ```python title=x fence (marked passes the whole
info string as the lang, hljs has no such language -> uniform).

Found by the frame-diff on the first post-fix run: `header_mode` consumed the
`(` of a def/class params group without emitting it (text loss on the
expanded-ipynb surface too) - fixed together with the token-color wiring;
see the `def_header_line_text_is_lossless` test in `tool_card/highlight.rs`.
