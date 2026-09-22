## Ownership compliance

<!-- Crate scope/non-goals/public API + dependency direction per AGENTS.md -->

## What changed

## Parity-diff evidence (merge gate for user-visible surfaces)

<!-- Per the AGENTS.md merge gates: features are not done until diffed against the TS binary. -->
- [ ] Rendered output: frame-diff vs the TS binary for every touched surface (visual_parity.py / the specific harness)
- [ ] Interactive behavior: same input, identical handling (keys/mouse/timing) vs TS
- [ ] Wire parity: byte-compare TS daemon traffic for protocol changes
- [ ] User-visible invariants: every user action produces the same visible reaction TS shows; nothing extra TS does not show

<!-- If a checked box does not apply (pure refactor, docs, internal crate), say why. -->

## Gates

- [ ] cargo fmt --all --check
- [ ] cargo clippy --workspace --all-targets -- -D warnings
- [ ] cargo test --workspace
<!-- Windows-touching PRs: make windows-cross (zero warnings) -->

## Test/e2e evidence
