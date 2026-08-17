# Review rules

## No legacy or migration scaffolding

- When a migration or refactor completes within a PR, its staging scaffolding must be deleted, not kept: no type aliases where two names point at one type, no re-exports "for compatibility" without a live external consumer, no migration-era vocabulary ("staged", "legacy", "new-style") surviving in names, comments, or test titles.
- Flag any parameter, option type, or constant that has exactly one legal value at every call site. That is ceremony, not configuration.
- Flag exported symbols, fields, and methods with zero non-test consumers. Speculative surface is worse than dead code in security-relevant modules: it implies invariants that do not exist.
- Flag predicates that are provably equivalent to an existing check, and call sites that check the same condition twice under two spellings.

## Comments

- Comments must be short, human-readable, and only where the code cannot say it. Reject comments that restate code, narrate control flow, or describe deleted mechanisms or history.
- Doc comments must describe current behavior, not the history of how it got there.

## Tests

- Add a regression test only when it captures meaningful behavior that fails before the fix; do not require one for trivial or documentation-only changes.
- Reject incidental or duplicate coverage and copy/string snapshot assertions that merely restate labels or descriptions; assert text only when the text is the behavior.
