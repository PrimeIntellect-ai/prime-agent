# Parity battery run 20260920T032554Z

Note: 0 gaps below covers only these scripted flows; it is not a product-parity verdict (docs/completion-matrix.md).
- ts binary: prime-agent
- rust binary: /home/ubuntu/lane-worktrees/auto-compact/target/release/prime-agent
- flows: f14_compact

## Findings

0 gaps, 0 EXPECTED-FAIL (known gaps, owner lanes), 11 parity checks passed.


## Passed checks

- [f14_compact/visual] ts: /compact shows the durable '◆ Context compacted' summary row
- [f14_compact/visual] ts: the Ctrl+O detail cycle expands the compaction summary block
- [f14_compact/visual] ts: the third Ctrl+O re-collapses the compaction summary block
- [f14_compact/behavior] ts: crossing the compaction threshold auto-compacts and shows the summary row
- [f14_compact/visual] rust: /compact shows the durable '◆ Context compacted' summary row
- [f14_compact/visual] rust: the Ctrl+O detail cycle expands the compaction summary block
- [f14_compact/visual] rust: the third Ctrl+O re-collapses the compaction summary block
- [f14_compact/behavior] rust: crossing the compaction threshold auto-compacts and shows the summary row
- [f14_compact/visual] manual-compact: frames identical TS vs Rust (normalized)
- [f14_compact/visual] manual-expanded: frames identical TS vs Rust (normalized)
- [f14_compact/visual] auto-compact: frames identical TS vs Rust (normalized)
