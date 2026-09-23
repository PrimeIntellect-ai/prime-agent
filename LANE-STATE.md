# LANE-STATE: mouse-sgr-leak (PR #2561)

Goal: PR #2561 MERGED, all comments resolved, gates green (sandbox), non-benchmark checks green.

## Current state (2026-09-23, updated as work proceeds)
- Worktree: ~/lane-worktrees/mouse-sgr-leak, branch lane/mouse-sgr-leak, based on org/rust tip e16196434 (already rebased by predecessor; transport.rs restore dropped - #2557 fixed it centrally).
- Local commits: 3e63096a3 (the guard fix) + df0c3ace2 (process.rs match_result_ok one-liner; DROP once base-heal PR #2565 lands - heartbeat-pr-threads lane drives it; was still OPEN at 01:5x UTC).
- UNCOMMITTED (in progress): all 8 Macroscope review-comment fixes in pa-tui + script.

## The 8 Macroscope comments and resolution state
1. mouse_sgr_parity.py:195 write_split no reader-sync -> TODO: fix script (gap 1.2->4ms, --defect-control gating: control build MUST leak else run fails, gap assertions).
2. sequence_guard.rs:99 expired-hold treats next key as continuation -> FIXED: deadline check in feed(), flush + reprocess. Tests: an_expired_hold_flushes_the_esc_before_the_next_key, an_expired_half_assembled_sequence_drops_and_the_key_types.
3. sequence_guard.rs:264 rxvt reports dropped -> FIXED: decode_rxvt_report (crossterm parse_csi_rxvt_mouse: cb field-32, coords-1, no release form) + report_modifiers shared helper. Test: every_split_of_an_rxvt_report_decodes (32=press, 64=drag; NOTE rxvt cb field is X10-byte+32).
4. sequence_guard.rs:581 CSI 57399u keypad dropped -> FIXED: csi_u_key keypad block 57399..=57426 mapped like crossterm translate_functional_key_code, KeyEventState::KEYPAD; rest of 57344..=63743 still consumed (TS drops too - keys.ts maps the same block). lock_state() = caps/num bits. Test: a_split_keypad_csi_u_arrives_as_the_key.
5. sequence_guard.rs:407 ESC[[A -> REJECTED with justification (do NOT implement): assembled 4-byte form is UNREACHABLE - guard+TS both complete the 3-byte prefix \x1b[[ at their own isCompleteSequence boundary (TS stdin-buffer.ts: lastChar '[' 0x5b in 0x40..0x7e => complete); TS then drops the prefix via parseKey and the trailing byte TYPES AS TEXT. Verified by source trace; pinning test a_split_legacy_function_key_form_stays_ts_exact added. csi_key [[ arm REMOVED (was dead code). Reviewer's fix would diverge from TS product (deliver F1 where TS types 'A').
6. input.rs:154 Alt+non-ASCII dropped -> FIXED in classify_key: [0x1b, byte, ..] arm (non-opener) uses first event + ALT for 1-byte and multi-byte UTF-8 alike. Test: a_split_alt_modified_character_keeps_the_alt (e-acute + E-acute SHIFT).
7. input.rs:151 HIGH drain loop never checks thread_stop -> FIXED: break on thread_stop at each drain iteration (join would hang forever on continuous input). No unit test possible (needs real tty); verified by inspection.
8. sequence_guard.rs:179 control_byte missing 4-7 -> FIXED: exact crossterm inverse (' '=>0, a-z=>1-26, '4'..'7'=>0x1c-0x1f; dropped dead caret-notation rows [ ] \ ] ^ _ @). Test: a_split_alt_ctrl_digit_reconstructs_the_combo.
- Test model (read_projection/model_parse) extended to crossterm-exact: control rows, UTF-8 chars (incomplete=More), ESC+byte+ALT forms, legacy [[ prefix (More at len3, F1-F5 at len4), rxvt arm, keypad CSI-u arm.
- cargo test -p pa-tui --lib: ALL GREEN (27 sequence_guard + full crate).

## Next steps (in order)
1. scripts/mouse_sgr_parity.py: implement comment-1 fix (see above).
2. cargo fmt + clippy -p pa-tui + test -p pa-tui on box (quick sanity only).
3. Commit. Then check gh pr view 2565 state; if MERGED: fetch org rust, drop df0c3ace2, rebase onto healed tip; else keep df0c3ace2.
4. VM sandbox gates (prime sandbox --plain create --vm -y --name build-mouse-sgr-leak --cpu-cores 4 --memory-gb 16 --disk-size-gb 40): fmt --all --check, clippy --workspace --all-targets -D warnings, test --workspace -j4 --no-fail-fast; toolchain: rustup component add rustfmt clippy; apt iproute2 lsof nodejs npm; PATH /usr/local/cargo/bin; uv + PI_PACKAGE_DIR for kernel tests; detached setsid nohup + DONE-marker polling; destroy sandbox after.
5. Build base-commit control binary (e16196434) for --defect-demo/--defect-control evidence; run scripts/mouse_sgr_parity.py on the box (ts release binary 0.9.5 + worktree debug build) => frame/behavior evidence.
6. Push lane/mouse-sgr-leak (existing remote branch - normal push OK), reply to all 8 threads + update PR body (new evidence, drop carried one-liner note, merge bar), gh pr checks.
7. When non-benchmark green + threads resolved: gh pr merge 2561 --squash --admin; verify state == MERGED; goal.complete().

## Gotchas learned this lane
- rxvt cb field = X10 byte + 32 (field 32 = left press, 64 = left drag) - crossterm checked_sub(32).
- crossterm maps 0x1c-0x1f to Char('4'..'7') CONTROL (not caret notation).
- Bash pipes mask cargo exit codes; use PIPESTATUS or no pipe.
- Benchmark check on every rust PR fails (tolerated, never chase).
- agent_observe before push: check for same-lane sibling (none as of 01:50 UTC).
