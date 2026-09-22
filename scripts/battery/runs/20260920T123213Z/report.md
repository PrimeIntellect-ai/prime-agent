# Parity battery run 20260920T123213Z

Note: 0 gaps below covers only these scripted flows; it is not a product-parity verdict (docs/completion-matrix.md).
- ts binary: prime-agent
- rust binary: /home/ubuntu/prime-agent-rs/target/release/prime-agent
- flows: f7_compaction, f14_compact

## Findings

2 gaps, 2 EXPECTED-FAIL (known gaps, owner lanes), 11 parity checks passed.

## Known gaps (EXPECTED-FAIL — evidence for the owning fix lanes)

- [f14_compact/behavior] EXPECTED-FAIL (lane: compact-fb-2): rust: threshold crossing produced no visible auto-compaction outcome — evidence: rust/f14_compact/05-auto-after.txt
- [f14_compact/visual] EXPECTED-FAIL (lane: compact-fb-2): auto-compact: frames differ TS vs Rust (see frame-diff-auto-compact.txt) — evidence: ts/f14_compact/frame-diff-auto-compact.txt

### f7_compaction

- [behavior] overflow compact-and-retry wire surface differs: ts=[{"type": "assistant_error", "overflow": true}, {"type": "assistant_error", "overflow": true}, {"type": "compaction_start", "reason": "overflow"}, {"type": "compaction_end", "reason": "overflow", "willRetry": true, "hasResult": true, "errorMessage": null, "errorSeverity": null}, {"type": "assistant_error", "overflow": true}, {"type": "assistant_error", "overflow": true}, {"type": "compaction_outco rust=[{"type": "assistant_error", "overflow": true}, {"type": "assistant_error", "overflow": true}] — evidence: [PosixPath('/home/ubuntu/prime-agent-rs/scripts/battery/runs/20260920T123213Z/ts/f7_compaction/overflow-wire-projection.json'), PosixPath('/home/ubuntu/prime-agent-rs/scripts/battery/runs/20260920T123213Z/rust/f7_compaction/overflow-wire-projection.json')]
- [behavior] durable compaction entries differ: ts=[{"summary": "pre-compaction reply 6", "tokensBefore": 110, "details": {"readFiles": [], "modifiedFiles": []}, "fromHook": false, "usage": {"input": 20, "output": 10, "cacheRead": 80, "cacheWrite": 0, "totalTokens": 110, "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0}}, "harnessDigest": "# Continual Harness State\n\nLocal continual harness entries belong to this Prim rust=[{"summary": "pre-compaction reply 6", "tokensBefore": 110, "details": {"modifiedFiles": [], "readFiles": []}, "fromHook": false, "usage": {"cacheRead": 80, "cacheWrite": 0, "cost": {"cacheRead": 0, "cacheWrite": 0, "input": 0, "output": 0, "total": 0}, "input": 20, "output": 10, "totalTokens": 110}, "harnessDigest": null}] — evidence: [PosixPath('/home/ubuntu/prime-agent-rs/scripts/battery/runs/20260920T123213Z/ts/f7_compaction/sessions'), PosixPath('/home/ubuntu/prime-agent-rs/scripts/battery/runs/20260920T123213Z/rust/f7_compaction/sessions')]

## Passed checks

- [f7_compaction/protocol] ts: daemon 'compact' succeeded: {"summary": "pre-compaction reply 6", "firstKeptEntryId": "de0aebea", "tokensBefore": 110, "details": {"readFiles": [], "modifiedFiles": []}}
- [f7_compaction/protocol] rust: daemon 'compact' succeeded: {"firstKeptEntryId": "a686ee6d", "summary": "pre-compaction reply 6", "tokensBefore": 110}
- [f14_compact/visual] ts: /compact shows the durable '◆ Context compacted' summary row
- [f14_compact/visual] ts: the Ctrl+O detail cycle expands the compaction summary block
- [f14_compact/visual] ts: the third Ctrl+O re-collapses the compaction summary block
- [f14_compact/behavior] ts: crossing the compaction threshold auto-compacts and shows the summary row
- [f14_compact/visual] rust: /compact shows the durable '◆ Context compacted' summary row
- [f14_compact/visual] rust: the Ctrl+O detail cycle expands the compaction summary block
- [f14_compact/visual] rust: the third Ctrl+O re-collapses the compaction summary block
- [f14_compact/visual] manual-compact: frames identical TS vs Rust (normalized)
- [f14_compact/visual] manual-expanded: frames identical TS vs Rust (normalized)
