# Stop-lifecycle parity run (2026-09-23, lane deletion-lifecycle)

Both sides driven by `scripts/session_stop_lifecycle_parity.py` (the same
wire steps on each product): create a persisted session, start a goal,
set an `every 10s` heartbeat, wire-`kill` it, then restart the daemon and
watch for revival.

| step | rust | ts |
|---|---|---|
| daemon created the session | PASS | PASS |
| the goal start turn ran | PASS | PASS |
| heartbeat_set registered the heartbeat | PASS | PASS |
| the heartbeat job is active in the durable store | PASS | PASS |
| the wire kill succeeded | PASS | PASS |
| the killed session's heartbeat cancelled in the durable store (`status: cancelled`, `nextRunAt` cleared) | PASS | PASS |
| the killed session's file archived (`session_state: archived`) | PASS | PASS |
| the killed session never revived after the restart | PASS | PASS |
| the stopped session's goal record froze | PASS | PASS |
| the stopped session's file froze | PASS | PASS |
| the durable cancel held across the restart | PASS | PASS |
| the archived state held across the restart | PASS | PASS |

The durable-store evidence (`02-post-kill-jobs.json` per side) is
shape-identical across the products (ids/timestamps excepted): the killed
session's job flips to `cancelled` with `nextRunAt` cleared on both.
