# Computer Use API Reference

Every call is async. Targets are `element_index` integers from the latest AX
snapshot, or `(x, y)` tuples in window-screenshot coordinates. This is the
complete module surface; [safety.md](safety.md) governs *when* to act.

## Module functions

| Signature | Returns | Notes |
|---|---|---|
| `await get_state(emit: bool = True)` | `dict` | Grants, app inventory, allowlist, platform. Prints fix-it guidance when a macOS grant is missing. The first call per process also emits the `computer_use_session_started` telemetry event; `emit=False` skips it. Discovery calls do not raise `TRANSPORT_ERROR` off darwin: `get_state` reports `"platform": None` and `permissions_status` reports `unknown` grants — read those fields to detect a missing backend; the *action* calls are the ones that raise. |
| `await list_apps()` | `list[dict]` | One `{"id": bundle_id, "name": display, "running": bool}` record per app. Use it to resolve names and check `running` before binding. Unlike `get_state`/`permissions_status`, it *does* raise `TRANSPORT_ERROR` off darwin (reading the workspace needs the backend). |
| `await get_app(app: str \| dict)` | `App` | Binds by display name or bundle id; dicts: `{"bundle_id": ...}`, `{"path": ...}`, `{"name": ...}`. Returns the app with its first AX state already loaded (`app.state`). |
| `await permissions_status()` | `dict` | `{"accessibility": ..., "screen_recording": ..., "help": [lines]}`; each status is `ok`, `missing`, or `unknown`. |

`get_state()` returns `{"apps": [...], "permissions": {...}, "allowlist":
{...}, "platform": "mac" | None}`. `apps` carries the `list_apps()`
records; `permissions` mirrors `permissions_status()`.

`get_app` raises `APP_NOT_ALLOWED` (allowlist gate), `PERMISSIONS_NOT_GRANTED`,
`APP_NOT_RUNNING`, `AMBIGUOUS_APP`, `APP_LAUNCH_FAILED`, and `SCREEN_LOCKED`.
Binding an installed app that is not running attempts to start it; a failed
start raises `APP_LAUNCH_FAILED`.

## App object

Properties: `bundle_id` (`str`), `name` (`str`), `state` (`str | None` — the
last observed AX text).

| Signature | Returns | Notes |
|---|---|---|
| `await get_ax_state(diff: bool = True)` | `str` | Element-indexed AX text. `diff=True` shows only what changed since the previous snapshot; `diff=False` returns the full tree. Indices on current entries refer to the latest snapshot; indices shown on removed (`-`) entries are from the previous snapshot and are informational only, not valid action targets. |
| `await get_screenshot(attach: bool = True)` | `dict` | `{"path", "width", "height"}` — the PNG's own pixel dimensions, which on a Retina capture are 2x the window's logical bounds; `click`/`drag`/`scroll` scale the screenshot's pixels back to the window automatically. `attach=True` loads the image into your context (attach failures are swallowed; the dict is still returned); `attach=False` skips attaching. |
| `await get_state_and_screenshot(diff: bool = True, attach: bool = True)` | `dict` | One snapshot combining the two calls above: `{"state": ..., "screenshot": ...}`. If the screenshot capture fails, the error is swallowed and `screenshot` is `None`. |
| `await click(target, button: str = "left", count: int = 1)` | `None` | `target` is an `element_index` or an `(x, y)` screenshot-coordinate tuple. `button`: `"left"` (default), `"right"`, `"middle"`; `count=2` double-clicks. |
| `await drag(from_, to)` | `None` | Two `(x, y)` screenshot-coordinate points. |
| `await scroll(target, direction: str, pages: int = 1)` | `None` | `direction` is one of `up`, `down`, `left`, `right`; `target` is an index or `(x, y)`. |
| `await press_key(key: str)` | `None` | Chord names: `"cmd+shift+f"`, `"Return"`, `"super+c"`. |
| `await type_text(text: str)` | `None` | Literal keystrokes; every newline presses Return. See typing hazards in SKILL.md. |
| `await set_value(element_index: int, value: str)` | `None` | Sets an editable element's value in one call; multiline-safe. Non-editable or secure elements raise `ACTION_UNSUPPORTED`. |
| `await select_text(element_index: int, text: str, prefix: str \| None = None, suffix: str \| None = None)` | `None` | Selects an exact run of `text` inside the element. `prefix` and `suffix` disambiguate repeated occurrences. |
| `await perform_secondary_action(element_index: int, action: str)` | `None` | Runs an AX action the element exposes. The element's available `actions` appear in its AX text — never guess a name. |
| `await paste(text: str, format: str = "text")` | a status line | Writes through the clipboard in `text`, `md`, or `html` form — only `html` writes rich data, the others paste plain text. The previous clipboard content is restored after a verified paste (the payload visible in the focused element) and after any failure that never posted `cmd+v`; a copy made during the paste window is kept. When the app's consumption cannot be verified, the payload stays on the clipboard and the status line says so. |

Every `App` action can raise `ELEMENT_STALE`, `ACTION_UNSUPPORTED`,
`INVALID_ARGUMENT`, `INJECTION_FAILED`, `TRANSPORT_ERROR`, `SCREEN_LOCKED`,
`APP_NOT_ALLOWED` (the gate is re-checked on every action), and
`PERMISSIONS_NOT_GRANTED` (the Accessibility grant is re-checked on every
action, so a grant revoked mid-session reports itself instead of surfacing
as an injection failure).

Actions that inject input or perform an AX action (`click`, `drag`,
`scroll`, `press_key`, `type_text`, `paste`, `perform_secondary_action`)
wait for the app to settle before returning — a bounded poll of the focused
window's live fingerprint — so the next `get_ax_state()` shows the settled
UI. `set_value` and `select_text` are synchronous AX attribute writes and
return once the write has completed.

## AX text

`get_ax_state` walks the focused window's AX tree. Each element reports its
`element_index` plus `role`, `subrole`, `title`, `value`, `description`,
`placeholder`, `actions`, `position`, and `size`. The walk is bounded
(1500 elements, depth 12, 3 seconds); a bounded-away walk is reported in the
text as `— TRUNCATED: the observation stopped at its element/depth/time
bounds, some controls are hidden`, so a missing control is never confused
with one the bounds cut off — re-observe after narrowing the app's view (a
dialog, a sidebar collapse) when a target is not shown. Use the text fields to
identify the element and the `element_index` to target it. Secure fields
(`AXTextField` with subrole `AXSecureTextField`) refuse typing and
`set_value` with `ACTION_UNSUPPORTED` and a hand-off message; ask the user to
enter credentials themselves.

## Error codes

Every failure raises `computer_use.errors.ComputerUseError` with a `code`:

| Code | Meaning | Recovery |
|---|---|---|
| `APP_NOT_ALLOWED` | App absent from the allowlist, blocked, or system-denied — the reason text says which. | Absent: tell the user to add the bundle id to `apps.allowed` in `~/.prime/agent/settings/computer-use.toml` (never edit it yourself). Blocked: adding it to `apps.allowed` does NOT help — the user must remove it from `apps.blocked` first. System-denied (loginwindow, screensaver, OS-auth dialogs): always refused, there is no user override. |
| `PERMISSIONS_NOT_GRANTED` | A required macOS grant is missing, or the Accessibility grant was revoked mid-session. | Run `permissions_status()`, relay the `help` lines, wait for the user to grant (see [permissions.md](permissions.md)); a mid-session revoke needs the user to re-grant and Prime Agent restarted, then re-bind with `get_app`. |
| `SCREEN_LOCKED` | The screen is locked. | Stop and ask the user to unlock — the skill never unlocks. After unlocking, re-observe; indices are stale. |
| `ELEMENT_STALE` | The index belongs to an old snapshot. | Call `get_ax_state()` and act on fresh indices; never retry the same index. |
| `AMBIGUOUS_APP` | The name matches several apps. | Call `list_apps()` and bind by the exact bundle id. |
| `APP_NOT_RUNNING` | The target is not running and could not be attached. | Check the `running` flag via `list_apps()`; have the user start the app, or bind by bundle id or path. |
| `APP_LAUNCH_FAILED` | The start attempt failed. | Verify the app name or path with the user; start the app manually and bind again. |
| `ACTION_UNSUPPORTED` | The element or backend does not support the action (non-editable `set_value`, secure field, unlisted secondary action). | Read the element's `role` and `actions` in the AX text; use an alternative control path; secure fields: hand off to the user. |
| `INJECTION_FAILED` | Posting the input event failed. | Re-observe, then retry once with fresh targeting; if it repeats, report it. |
| `TRANSPORT_ERROR` | Backend or transport failure — including no backend on this platform. | Confirm the platform is supported; re-observe; report persistent failures to the user. |
| `INVALID_ARGUMENT` | Malformed argument: bad chord, unknown direction, bad coordinates, wrong index type. | Fix the call to match the signatures above. |

`PERMISSIONS_PENDING` and `USER_STOPPED` stay frozen in the code table for
contract stability, but this version never raises them: the grant probes
never prompt (so no grant is observed mid-flight) and there is no
user-stop detection to report. Do not wait on either.

## Policy files

- Settings: `~/.prime/agent/settings/computer-use.toml` — `apps = {allowed =
  [...], blocked = [...]}`, `system_deny = [bundle ids]`, and `risk =
  {"com.apple.Safari" = "low"}` — quote every dotted bundle-id key (unquoted,
  TOML nests them silently); values are `low`, `medium`, `high`. Blocked and
  system-denied apps are hard refusals; anything not in `allowed` raises
  `APP_NOT_ALLOWED` with instructions for the user. The file is user-edited
  only; the skill never writes settings.
- Approvals: `~/.prime/agent/state/computer-use/approvals.json` — reserved
  for the follow-on approval surface (the elicitation lane); v1 neither
  reads nor writes it, so the allowlist file is the only active policy
  surface today.
- Lock check: actions consult the login-session state. A locked screen fails
  closed with `SCREEN_LOCKED`; a session state that cannot be read is
  treated as locked, so binding and input injection never proceed on an
  unverifiable desktop.

## Telemetry

Emission is best-effort and never raises; properties are primitives only.

- `computer_use_session_started` — `{platform}`, once per process on the
  first `get_state()` call (`emit=True`).
- `computer_use_action` — `{action, outcome, duration_ms}` per action.
  `action` is one of `click`, `drag`, `scroll`, `press_key`, `type_text`,
  `set_value`, `select_text`, `secondary`, `paste`, `get_state`; `outcome`
  is `ok` or `error`, and failures carry their frozen code in the separate
  `error_code` property (for example `error_code: "INJECTION_FAILED"`).

## Platforms

`backend()` resolves `"mac"` on macOS and `None` otherwise — in which case
API calls raise `TRANSPORT_ERROR` ("computer use backend unavailable:
\<reason\>"). macOS is the v1 platform; the Linux backend ships in a
follow-up release and is not advertised until its module lands, so
`get_state()` never reports a platform this skill cannot drive.
