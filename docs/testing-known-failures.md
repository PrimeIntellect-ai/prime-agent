# Known failures on Windows (outside CI)

The two suites below run green on the Linux CI gates but have long-standing red tests on
Windows, for platform reasons unrelated to any one change. This file records what fails,
why, and how to tell a real regression from the known noise — so "the suite is red on my
box" has an answer that does not depend on asking whoever ran it last.

## The kernel-side runtime suite (`prime-agent-runtime/test`)

The suite is a **Linux CI gate** (`.github/workflows/ci.yml`, job `runtime`:
`cd prime-agent-runtime && uv run --python 3.11 python -m unittest discover -s test`).

Run one module at a time to isolate (a hang in one module otherwise hides the rest):

```powershell
cd prime-agent-runtime
$env:PYTHONPATH = "src"
# or: uv run --python 3.11 python -m unittest test.<module>
python -m unittest test.test_mcp -v
```

| Module | Symptom on Windows | Cause | Reproducible |
| --- | --- | --- | --- |
| `test_repl` | **hangs** in `FinishRequestTest::test_owner_wait_polls_when_exit_registration_fails` (killed by a 90 s timeout); `FinishRequestTest::test_untargeted_interrupt_in_done_task_handoff_is_not_parked` and `OwnerExitWaitTest::test_owner_exit_wakes_the_wait_without_polling` fail first | POSIX process-exit/signal semantics; the Windows arms of these paths are not exercised on CI | yes (every run, observed 2026-11-16) |
| `test_bash` | module fails to import: `ModuleNotFoundError: No module named 'resource'` | `resource` is a Unix-only stdlib module | yes |
| `test_harness` | `HarnessStateTest::test_dead_lock_is_reclaimed_without_old_owner_cleanup` errors; `test_save_preserves_restrictive_file_mode` and `test_save_temp_file_is_never_looser_than_the_destination` fail | POSIX file modes (0700/0600) and lock-file semantics; Windows has neither | yes |
| `test_mcp` | `test_real_stdio_startup_diagnostic_is_safe_bounded_and_reaped` and `test_reload_reaps_real_acp_stdio_process` error with `OSError: [WinError 87]` / `SystemError: kill returned a result with an exception set` | the tests call `os.kill(pid, 0)`, which Windows does not support | yes |

## The Rust workspace: `cargo test -p pa-daemon --lib`

On this machine that command ends with **42 failed / N passed** (1066 passed at `main`
`ad1613303`; 1080 passed on `wip/block-images-strip` with the MCP phases, which add 14
passing tests). The 42 failures are the same tests on both, in the same order after
sorting — they are the environment's baseline, not any branch's work.

They cluster in four areas (the individual root causes were not diagnosed; only the
main-vs-branch equality was established):

- **Windowed session-store / compaction readback** — `session_store::*` (window, page
  walk, child usage, info), `session_stats::compaction_boundary_serves_the_windowed_reader`,
  `worker::tests::windowed_attach_tests`, `worker::worker_resume_settings_tests`,
  `worker::tests::summary_tests`, `rlm_children::usage_emit_tests`.
- **Compaction / goal / autonomous engine behaviour** —
  `agent_engine::tests::compaction::*`, `agent_engine::tests::goal::*`,
  `agent_engine::tests::autonomous::*`, `compact_autorefine::*`,
  `worker::tests::goal_tests::goal_turn_end_loop_runs_to_completion`.
- **Model catalog and resolution** — `agent_engine::tests::model_resolution::*`,
  `state_getters::state_getters_tests::model_catalog_and_available_models_match_the_ts_shapes`.
- **Lease / ledger file semantics, and one platform arm** — `lease::tests::*`,
  `registration::tests::*`, `rlm_ledger::tests::*`,
  `scheduled_jobs::tests::rlm_heartbeat_mutation_hook_fires_into_the_session_queue`
  (the `lease::process_start_id_reflects_the_platform_ladder` failure is a platform
  difference by construction).

The exact 42 test names observed on 2026-11-16, identical on `main` `ad1613303` and on
`wip/block-images-strip` `06151b152`:

```
agent_engine::tests::autonomous::autonomous_gate_pass_and_failure_drive_the_loop
agent_engine::tests::compaction::failed_mid_run_compaction_resumes_without_retrying_each_tool_round
agent_engine::tests::compaction::low_custom_percentage_compacts_real_history_once_and_then_makes_progress
agent_engine::tests::compaction::threshold_compaction_aborted_mid_run_records_the_cancelled_outcome
agent_engine::tests::compaction::threshold_compaction_counts_into_the_run_telemetry
agent_engine::tests::compaction::threshold_compaction_stays_on_the_session_provider_after_a_resolution_drift
agent_engine::tests::compaction::threshold_crossing_auto_compacts_with_the_event_pair
agent_engine::tests::compaction::threshold_crossing_inside_one_run_compacts_before_the_next_model_turn
agent_engine::tests::goal::shared_window_goal_seed_matches_persisted_goal_state
agent_engine::tests::model_resolution::an_explicit_scope_with_no_matches_does_not_warn_about_an_excluded_default
agent_engine::tests::model_resolution::switch_model_never_poisons_the_selection_with_a_refused_candidate
agent_engine::tests::model_resolution::the_startup_chain_refuses_models_outside_the_allowlist
compact_autorefine::tests::sessions_without_the_refine_surface_never_run_a_review
compact_autorefine::tests::threshold_compaction_arms_the_review_off_the_turn_path
lease::tests::process_start_id_reflects_the_platform_ladder
registration::tests::a_definitive_rejection_retires_and_a_transient_one_retries
rlm_children::usage_emit_tests::reseed_lists_live_ledger_children_settled_and_bills_only_after_a_delivery
rlm_ledger::tests::legacy_registry_probe_reads_the_header_line_bounded
rlm_ledger::tests::legacy_registry_probe_resolves_a_readable_header_over_a_corrupt_tail
rlm_ledger::tests::moved_edge_paths_resolve_through_the_session_id
rlm_ledger::tests::seeds_from_legacy_registries_once_and_atomically
rlm_ledger::tests::unknown_op_records_are_skipped_forward_compatible
scheduled_jobs::tests::rlm_heartbeat_mutation_hook_fires_into_the_session_queue
session_stats::tests::compaction_boundary_serves_the_windowed_reader
session_store::child_usage_tests::hydration_after_an_uncertain_append_does_not_lose_child_usage
session_store::child_usage_tests::hydration_before_confirmation_retains_pending_and_created_receipts
session_store::child_usage_tests::nonzero_cost_hydration_confirms_the_complete_wire_decoded_owned_row
session_store::info_tests::zero_usage_states_are_capped_by_count_not_only_the_usage_budget
session_store::view::page_walk_tests::a_windowed_store_counts_its_prefix_and_reads_its_window
session_store::view::page_walk_tests::pages_match_the_full_branch_reference
session_store::window_tests::full_history_hydration_keeps_the_billed_row_sink
session_store::window_tests::non_message_compaction_boundary_retains_the_persisted_timeline
session_store::window_tests::window_preserves_transcript_metadata_and_append_then_hydrate
session_store::window_tests::windowed_open_folds_attributions_on_both_sides_of_the_boundary
session_store::window_tests::windowed_restored_settings_match_the_full_open
session_store::window_tests::windowed_tool_call_count_matches_the_full_open_across_the_cut
state_getters::state_getters_tests::model_catalog_and_available_models_match_the_ts_shapes
worker::tests::goal_tests::goal_turn_end_loop_runs_to_completion
worker::tests::summary_tests::live_summary_usage_is_the_catalog_fold
worker::tests::windowed_attach_tests::session_messages_hydrate_only_for_the_unloaded_prefix
worker::worker_resume_settings_tests::resume_settings_tests::compacted_create_restores_settings_and_honors_explicit_overrides
worker::worker_resume_settings_tests::resume_settings_tests::create_backfills_the_default_tier_when_the_resumed_file_has_none
```

### How to re-run the baseline comparison

A passing count says nothing on its own; the *names* are the evidence. Compare against a
clean checkout of the base branch in a scratch worktree, run the same command, and diff
the sorted failure lists:

```powershell
git worktree add E:/UserTemp/pa-baseline-main main
$env:CARGO_TARGET_DIR = (Resolve-Path .).Path + "/target"   # reuse the dependency builds
cargo test -p pa-daemon --lib 2>&1 | Select-String '^    \w.*::' | % { $_.Line.Trim() } | Sort-Object > E:/UserTemp/main.txt
cd E:/UserTemp/pa-baseline-main
cargo test -p pa-daemon --lib 2>&1 | Select-String '^    \w.*::' | % { $_.Line.Trim() } | Sort-Object > E:/UserTemp/branch.txt
diff (Get-Content E:/UserTemp/main.txt) (Get-Content E:/UserTemp/branch.txt)
```

An empty diff means the branch added no failures; every line in the diff is a failure the
branch introduced and must be fixed or explained.

## Establishing "this failure is not from my change"

Two checks are enough for the runtime suite:

1. `git diff --name-only main..HEAD -- prime-agent-runtime/` lists the files the change
   touched. A failure in a module that is not in that list is not the change's (as of
   2026-11-16 that diff was `src/rlm/mcp.py`, `src/rlm/mcp_notify.py`,
   `test/test_mcp.py` — `test_repl.py` was untouched, while its failures reproduced).
2. `git show main:prime-agent-runtime/test/test_mcp.py | grep -n "os.kill"` shows the
   calls predate the change when a test uses a Unix-only API.

For the Rust suite, the sorted-diff comparison above is the equivalent check. The Linux CI
jobs are the authority: if a test in the lists here passes there and fails here, the
difference is the platform, not the code.
