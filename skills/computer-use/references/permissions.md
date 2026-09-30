# Permissions (macOS)

The skill needs two macOS privacy grants. Only the user can grant them: the
skill never grants, bypasses, or modifies privacy settings, and a missing
grant is a hard stop, not a problem to work around.

## The two grants

| Grant | What it enables | Without it |
|---|---|---|
| Accessibility | Observation and control: reading the AX tree, acting on elements, and posting keystrokes and clicks to the app. | Nothing works — every action raises `PERMISSIONS_NOT_GRANTED`. |
| Screen Recording | Window capture for screenshots. | `get_screenshot` cannot capture windows; the AX text still works. |

Grant both in System Settings, to the application hosting the Prime Agent
kernel (the terminal, IDE, or daemon you run Prime Agent from):

- System Settings > Privacy & Security > Accessibility
- System Settings > Privacy & Security > Screen Recording

Add the host application with the + button (or enable its toggle if it is
already listed). If `permissions_status()` still reports `missing` right
after granting, restart the host application — macOS reads some grants at
launch.

## First run

The first `await computer_use.get_state()` checks both grants and prints
the exact guidance above when one is missing. Relay the guidance to the user
and wait; do not continue into app binding before the grant is in place.

## Checking status

```python
status = await computer_use.permissions_status()
# {"accessibility": "ok" | "missing" | "unknown",
#  "screen_recording": "ok" | "missing" | "unknown",
#  "help": [lines]}
```

`unknown` means the probe could not determine the state, for example in a
non-standard host environment. Treat it as not granted and let the user
decide.

## Re-checks

- `permissions_status()` and `get_state()` probe the grants on every call;
  nothing is cached across sessions.
- Every action re-checks before acting. A grant revoked mid-session fails
  the next action with `PERMISSIONS_NOT_GRANTED`.
- `SCREEN_LOCKED` is a separate condition — the login screen is up, the
  grants are fine. Unlocking is always the user's move.

## What the skill never does

- Never edits TCC or privacy settings, never runs privileged tools, never
  clicks a grant dialog on the user's behalf.
- Never works around a missing grant through alternative input paths.
- Surfacing the two Settings paths and waiting is the entire remediation.
