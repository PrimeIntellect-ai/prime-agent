# Known failures in the vendored runtime suite (Windows)

The kernel-side Python suite (`prime-agent-runtime/test`) is a **Linux CI gate**
(`.github/workflows/ci.yml`, job `runtime`: `cd prime-agent-runtime && uv run --python 3.11
python -m unittest discover -s test`). On Windows the same suite does not run clean, for
platform reasons unrelated to any one change. This file records what fails, why, and how to
tell a real regression from the known noise — so "the suite is red on my box" has an answer
that does not depend on asking whoever ran it last.

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

## Establishing "this failure is not from my change"

Two checks are enough for the runtime suite:

1. `git diff --name-only main..HEAD -- prime-agent-runtime/` lists the files the change
   touched. A failure in a module that is not in that list is not the change's (as of
   2026-11-16 that diff was `src/rlm/mcp.py`, `src/rlm/mcp_notify.py`,
   `test/test_mcp.py` — `test_repl.py` was untouched, while its failures reproduced).
2. `git show main:prime-agent-runtime/test/test_mcp.py | grep -n "os.kill"` shows the
   calls predate the change when a test uses a Unix-only API.

The Linux CI job is the authority: if a module in the list above passes there and fails
here, the difference is the platform, not the code.
