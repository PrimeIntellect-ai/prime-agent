# Review rules

## No legacy or migration scaffolding

- When a migration or refactor completes within a PR, its staging scaffolding must be deleted, not kept: no type aliases where two names point at one type, no re-exports "for compatibility" without a live external consumer, no migration-era vocabulary ("staged", "legacy", "new-style") surviving in names, comments, or test titles.
- Flag any parameter, option type, or constant that has exactly one legal value at every call site. That is ceremony, not configuration.
- Flag exported symbols, fields, and methods with zero non-test consumers. Speculative surface is worse than dead code in security-relevant modules: it implies invariants that do not exist.
- Flag predicates that are provably equivalent to an existing check, and call sites that check the same condition twice under two spellings.

## Comments

- Comments must be short, human-readable, and only where the code cannot say it. Flag comments that restate the code, narrate control flow, or describe deleted mechanisms.
- Doc comments must describe current behavior, not the history of how it got there.

## Compatibility and hot paths

- Validation over persisted user data must accept everything older versions of this product wrote. Check historical on-disk shapes (absent optional fields, old headers) before rejecting; a validator that throws on data our own older releases produced is a bug, and fail-closed handling multiplies the blast radius.
- If a function that previously swallowed errors starts throwing (or vice versa), every call site must be audited in the same PR.
- Flag loops that spawn a subprocess per item, and reads of full file contents where only a prefix or header is consumed. Watch for costs that scale with accumulated user state (session history, logs) on per-message or per-request paths.
- Side effects guarded by abort signals or revocation must check authority immediately before the effect, not only before the reply; attaching an abort listener after an event that can trigger the abort is an ordering bug.

## Tests

- Each bug fix carries a regression test that fails on the pre-fix code.
- Reject tests that assert incidental details or duplicate existing coverage.
