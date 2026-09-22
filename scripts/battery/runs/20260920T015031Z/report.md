# Parity battery run 20260920T015031Z

Note: 0 gaps below covers only these scripted flows; it is not a product-parity verdict (docs/completion-matrix.md).
- ts binary: prime-agent
- rust binary: /home/ubuntu/prime-agent-rs/target/release/prime-agent
- flows: f14_compact, f17_slash_model, f20_subagents, f23_keybindings, f9_agents_view, f11_provider_failure, f12_scroll

## Findings

4 gaps, 4 EXPECTED-FAIL (known gaps, owner lanes), 52 parity checks passed.

## Known gaps (EXPECTED-FAIL — evidence for the owning fix lanes)

- [f14_compact/behavior] EXPECTED-FAIL (lane: compact-fb-2): rust: threshold crossing produced no visible auto-compaction outcome — evidence: rust/f14_compact/05-auto-after.txt
- [f14_compact/visual] EXPECTED-FAIL (lane: compact-fb-2): auto-compact: frames differ TS vs Rust (see frame-diff-auto-compact.txt) — evidence: ts/f14_compact/frame-diff-auto-compact.txt
- [f20_subagents/visual] EXPECTED-FAIL (lane: subagents-tui): spawn: frames differ TS vs Rust (see frame-diff-spawn.txt) — evidence: ts/f20_subagents/frame-diff-spawn.txt
- [f20_subagents/visual] EXPECTED-FAIL (lane: subagents-tui): child-status: frames differ TS vs Rust (see frame-diff-child-status.txt) — evidence: ts/f20_subagents/frame-diff-child-status.txt

### f9_agents_view

- [visual] agents view frames differ at 120x36 (see frame-diff-120x36.txt) — evidence: ts/f9_agents_view/frame-diff-120x36.txt
- [visual] agents view frames differ at 220x50 (see frame-diff-220x50.txt) — evidence: ts/f9_agents_view/frame-diff-220x50.txt
### f12_scroll

- [behavior] ts: scrollback checks failed: paged shows early prompt — evidence: ts/f12_scroll
- [behavior] rust: scrollback checks failed: paged shows early prompt — evidence: rust/f12_scroll

## Passed checks

- [f14_compact/visual] ts: /compact shows the durable '◆ Context compacted' summary row
- [f14_compact/visual] ts: the Ctrl+O detail cycle expands the compaction summary block
- [f14_compact/visual] ts: the third Ctrl+O re-collapses the compaction summary block
- [f14_compact/behavior] ts: crossing the compaction threshold auto-compacts and shows the summary row
- [f14_compact/visual] rust: /compact shows the durable '◆ Context compacted' summary row
- [f14_compact/visual] rust: the Ctrl+O detail cycle expands the compaction summary block
- [f14_compact/visual] rust: the third Ctrl+O re-collapses the compaction summary block
- [f14_compact/visual] manual-compact: frames identical TS vs Rust (normalized)
- [f14_compact/visual] manual-expanded: frames identical TS vs Rust (normalized)
- [f17_slash_model/visual] ts: /model opens the selector with the configured model listed
- [f17_slash_model/visual] ts: picking a model in the selector shows the 'Model: <id>' confirm row
- [f17_slash_model/visual] ts: /effort shows the thinking-level picker or its unsupported-model row
- [f17_slash_model/visual] rust: /model opens the selector with the configured model listed
- [f17_slash_model/visual] rust: picking a model in the selector shows the 'Model: <id>' confirm row
- [f17_slash_model/visual] rust: /effort shows the thinking-level picker or its unsupported-model row
- [f17_slash_model/visual] model-selector: frames identical TS vs Rust (normalized)
- [f17_slash_model/visual] model-selected: frames identical TS vs Rust (normalized)
- [f17_slash_model/visual] effort-picker: frames identical TS vs Rust (normalized)
- [f20_subagents/visual] ts: a kernel rlm.spawn renders the subagent summary line above the editor with the running/idle/inactive counts
- [f20_subagents/visual] ts: a child finishing without a reply renders the 'RLM child status' terminal-notice row in the parent transcript
- [f20_subagents/visual] ts: the scoped agents view lists the spawned child by name
- [f20_subagents/visual] rust: a kernel rlm.spawn renders the subagent summary line above the editor with the running/idle/inactive counts
- [f20_subagents/visual] rust: a child finishing without a reply renders the 'RLM child status' terminal-notice row in the parent transcript
- [f20_subagents/visual] rust: the scoped agents view lists the spawned child by name
- [f20_subagents/visual] scoped-agents: frames identical TS vs Rust (normalized)
- [f23_keybindings/visual] ts: the prompt-context hint renders the user override (X), not the default
- [f23_keybindings/visual] ts: the override key cycled the conversation detail
- [f23_keybindings/visual] ts: the removed default key no longer cycles the detail
- [f23_keybindings/visual] ts: /hotkeys documents the effective override (X row)
- [f23_keybindings/visual] ts: the ? quick-shortcut guide mounted with the effective bindings
- [f23_keybindings/visual] ts: the submission cleared the quick-shortcut guide
- [f23_keybindings/visual] rust: the prompt-context hint renders the user override (X), not the default
- [f23_keybindings/visual] rust: the override key cycled the conversation detail
- [f23_keybindings/visual] rust: the removed default key no longer cycles the detail
- [f23_keybindings/visual] rust: /hotkeys documents the effective override (X row)
- [f23_keybindings/visual] rust: the ? quick-shortcut guide mounted with the effective bindings
- [f23_keybindings/visual] rust: the submission cleared the quick-shortcut guide
- [f23_keybindings/visual] detail-hint: frames identical TS vs Rust (normalized)
- [f23_keybindings/visual] override-fired: frames identical TS vs Rust (normalized)
- [f23_keybindings/visual] default-key: frames identical TS vs Rust (normalized)
- [f23_keybindings/visual] hotkeys-guide: frames identical TS vs Rust (normalized)
- [f23_keybindings/visual] shortcut-guide: frames identical TS vs Rust (normalized)
- [f23_keybindings/visual] guide-cleared: frames identical TS vs Rust (normalized)
- [f9_agents_view/behavior] ts: agents view groups the roster into Running/Idle/Inactive sections with the scripted sessions in place
- [f9_agents_view/behavior] ts: opening the Running row attached to the live session and its in-flight reply rendered
- [f9_agents_view/behavior] rust: agents view groups the roster into Running/Idle/Inactive sections with the scripted sessions in place
- [f9_agents_view/behavior] rust: opening the Running row attached to the live session and its in-flight reply rendered
- [f9_agents_view/visual] agents view frames identical at filtered-120x36 (normalized: paths, ids, ages)
- [f9_agents_view/visual] agents view frames identical at transcript-120x36 (normalized: paths, ids, ages)
- [f11_provider_failure/behavior] ts: provider failure surfaces (retry banner + 4 error row(s))
- [f11_provider_failure/behavior] rust: provider failure surfaces (retry banner + 4 error row(s))
- [f11_provider_failure/visual] provider-failure rendering parity: 4 error row(s) on both sides
