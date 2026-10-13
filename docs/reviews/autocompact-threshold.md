# Configurable automatic compaction percentage

Baseline: main cf119a7a8 (2026-10-13).

The current threshold is the minimum of `floor(contextWindow * 0.95)` and
`contextWindow - requestedOutput - max(reserveTokens, 4096)` (saturating subtraction).
Automatic compaction fires strictly above a positive threshold. The default reserve is
16,384 tokens. A 131,072-token window with a requested output of 32,768 therefore triggers
above 81,920 tokens (62.5%), rather than 95%. A 1,048,576 window with 32,000 output triggers
above 996,147 tokens. The compiled Prime Inference GPT 5.4 fallback declares a 1,050,000
window and 128,000 maximum output; its default request uses 32,000 output, yielding a
997,500 threshold (95%). Live catalog entries and explicit model configurations can differ.
The request-output calculation also accounts for thinking-budget folding on Anthropic and
Bedrock models without adaptive thinking. All decisions use the current serving model's limits.

`compaction.thresholdPercent` accepts finite numbers from 1 through 100, including fractions.
The `/settings` General tab offers whole percentages and preserves a configured fractional
value in its choices. Unset, malformed or out-of-range loaded values use 95; invalid writes
fail without mutating settings. The nested global write preserves unknown sibling keys and
other writers' changes; project settings retain normal precedence. A saved percentage is read
at threshold decision boundaries so existing sessions observe it. These reads occur off the
paint path, using the same resolved settings directories as auxiliary summarizer routing.

The output/reserve ceiling always caps the requested percentage. This setting does not alter
manual `/compact`, kernel-requested compaction, overflow recovery, retention or summary output
budgets. The autonomous continuation mirror also resolves the live percentage rather than
keeping its build-time copy. A successful interactive save emits the primitive-only
`autocompact threshold changed` adoption event from a background worker.

## Background compaction overlap

Reviewed PR #3409 at a559057050b0b5f357f4fad9e3a655fefdf9d0a6.
It keeps `compaction_threshold` as the blocking threshold and subtracts two headroom reserves
for its background watermark. Its stale-summary admission check also uses that function.
On integration, retain this percentage calculation inside its refactored threshold function;
background watermarks and stale-result admission then move consistently. Resolve overlapping
compaction tests using the default percentage or `..Default::default()`. No background
compaction scheduler or concurrency changes belong to this PR.

## Ownership

Architectural classification: new public settings accessors and client trait methods, plus
one field on the existing public compaction policy. No new dependencies or re-exports.
pa-core owns settings, persistence and threshold policy; pa-daemon owns autonomous scheduling;
pa-tui owns rendering and the existing settings seam; pa-cli supplies the file-backed seam;
pa-telemetry owns the additive event schema. These fit the existing crate README scopes.
Dependency direction is unchanged; pa-tui does not depend on pa-core.

## Validation and parity-diff evidence

Local: formatting and whitespace checks only; no local compilation because of thermal limits.
Hosted CI executes Rust threshold/persistence tests and headless settings-menu tests, together
with the required fmt/check/clippy and sharded workspace suites.

`scripts/review_autocompact_settings_parity.py` runs real Rust and pinned TS 0.9.8 client
binaries with the same isolated daemon fixture and PTY inputs. It records full terminal
frames, a frame diff, commands and binary hashes in the lifecycle parity artifact. It checks
that the existing auto-compaction toggle renders the same row and sends the same canonical
payload. The percentage row is an explicit requested addition, absent in TS; Rust's previously
introduced tab layout is preserved in the full frame diff, rather than claimed identical.
It also changes the Rust percentage from 95 to 96 and verifies both visible feedback and the
actual saved settings document. This client comparison does not establish engine parity;
Rust tests cover the deliberate output-headroom difference and custom threshold policy.
CI results and receipts must be reviewed before merging; this PR remains a draft.
