# Harness refinements

In `/settings`, open **Agents** and toggle **Harness refinements**. The setting is
`harnessRefinements` in the existing settings document, defaults to `true`, and
uses the usual global/project precedence. The menu saves the global value; a
project override continues to win. `autoRefine` still controls the automatic
review cadence while this master switch is enabled.

When disabled, automatic reviews stop, `/refine` and model-requested refinements
refuse to run, and Python harness reads and writes refuse. A planning request
already running is allowed to finish, but its result is discarded if the switch
is disabled when the apply worker rechecks it. No harness state or refinement
history is deleted. Enabling the switch restores access to existing state.

Every provider request checks the current setting before converting typed
context. Saved digest rows and refinement notices are omitted, including on
resume, tool continuations and retries; dedicated digest fields in compaction
summaries are removed. Compaction and branch summarizers omit those typed rows
while disabled. A compaction that finishes after disabling drops its captured
digest before committing. The menu also reloads the session inputs so enabling
can refresh the digest through the normal cold-boundary path.

This does not erase history. A provider request already sent cannot be recalled.
Earlier assistant replies, tool outputs and summary prose may already reflect a
refinement. Those rows stay intact, as does user-authored text that quotes a
refinement. Start a new session with the switch disabled for a clean conversation
that has never used saved refinements. Re-enabling during an outstanding request
uses the value at the next check; the switch is not a cancellation-generation
counter.

The adoption event `harness refinements changed` records only the selected
boolean value through the existing fire-and-forget telemetry client.

Validation: focused regressions cover persistence/precedence, live request
filtering, quoted user text, compaction digest removal, planner refusal, in-flight
apply rejection, and cached Python harness access. Full Rust checks run on hosted
CI because local heavy builds are prohibited. TS v0.9.8 has no master toggle;
this is an intentional new setting requested by Kevin. Default-enabled rendered
and interactive parity evidence is still required before merging.
