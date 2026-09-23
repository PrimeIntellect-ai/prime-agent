# R6 reliable force-shutdown continuation

Branch: `fix/reliable-force-shutdown`

## Done
- Traced `shutdown --force --json` through `run_shutdown_converging`, `force_kill_daemon`, residual termination, and JSON reporting.
- Identified that SIGKILL paths do not consistently wait for confirmed death before socket cleanup/reporting.

## Remains
- Add a bounded post-SIGKILL wait and return confirmed success/failure from force-kill helpers.
- Remove sockets only after confirmed process death; record survivors as failures.
- Verify every `--json` failure path prints valid JSON and add focused tests, then run full gates in the Prime VM.

## Acceptance criteria
Force shutdown escalates TERM→KILL with deadlines, cleans sockets safely, emits valid JSON on every failure, CI and Cursor Bugbot/Macroscope are clean, and PR is merged.
