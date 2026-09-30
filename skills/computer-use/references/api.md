# Computer Use API Reference

Every call is async. Targets are `element_index` integers from the latest AX
snapshot, or `(x, y)` tuples in window-screenshot coordinates. This is the
complete module surface; [safety.md](safety.md) governs *when* to act.

## Module functions

| Signature | Returns | Notes |
|---|---|---|
| `await get_state(emit: bool = True)` | `dict` | Grants, app inventory, allowlist, platform. Prints fix-it guidance when a macOS grant is missing. The first call per process also emits the `computer_use_session_started` telemetry event; `emit=False` skips it. |
| `await list_apps()` | `list[dict]` | One `{"id": bundle_id, "name": display, "running": bool}` record per app. Use it to resolve names and check `running` before binding. |
| `await get_app(app: str \| dict)` | `App` | Binds by display name or bundle id; dicts: `{"bundle_id": ...}`, `{"path": ...}`, `{"name": ...}`. Returns the app with its first AX state already loaded (`app.state`). |
| `await permissions_status()` | `dict` | `{"accessibility": ..., "screen_recording": ..., "help": [lines]}`; each status is `ok`, `missing`, or `unknown`. |

`get_state()` returns `{"apps": [...], "permissions": {...}, "allowlist":
{...}, "platform": "mac" | "linux" | None}`. `apps` carries the `list_apps()`
records; `permissions` mirrors `permissions_status()`.

`get_app` raises `APP_NOT_ALLOWED` (allowlist gate), `PERMISSIONS_NOT_GRANTED`,
`APP_NOT_RUNNING`, `AMBIGUOUS_APP`, `APP_LAUNCH_FAILED`, and `SCREEN_LOCKED`.
Binding an installed app that is not running launches it in the background
(`open -g`): the app binds and observes without taking over the screen, and
only an explicit `App.activate()` brings it forward. A failed start raises
`APP_LAUNCH_FAILED`.

## App object

Properties: `bundle_id` (`str`), `name` (`str`), `state` (`str | None` — the
last observed AX text).

| Signature | Returns | Notes |
|---|---|---|
| `await get_ax_state(diff: bool = True)` | `str` | Element-indexed AX text. `diff=True` shows only what changed since the previous snapshot; `diff=False` returns the full tree. Indices always refer to the latest snapshot, whichever view you read. |
| `await get_screenshot(attach: bool = True)` | `dict` | `{"path", "width", "height"}` taken from the window bounds. `attach=True` loads the image into your context (attach failures are swallowed; the dict is still returned); `attach=False` skips attaching. |
| `await get_state_and_screenshot(diff: bool = True, attach: bool = True)` | `dict` | One snapshot combining the two calls above: `{"state": ..., "screenshot": ...}`. |
| `await get_text_regions()` | `list[dict]` | Window-scoped OCR over the focused window: a normalized list of text regions with window-relative pixel coordinates — the same space as screenshot `(x, y)` targets, so a region can be clicked directly. The screen-reading path for models that cannot see images (see Non-vision models in SKILL.md); also reads image and canvas text the AX tree cannot expose. |
| `await click(target, button: str = "left", count: int = 1)` | `None` | `target` is an `element_index` or an `(x, y)` screenshot-coordinate tuple. `button`: `"left"` (default), `"right"`, `"middle"`; `count=2` double-clicks. |
| `await drag(from_, to)` | `None` | Two `(x, y)` screenshot-coordinate points. |
| `await scroll(target, direction: str, pages: int = 1)` | `None` | `direction` is one of `up`, `down`, `left`, `right`; `target` is an index or `(x, y)`. |
| `await press_key(key: str)` | `None` | Chord names: `"cmd+shift+f"`, `"Return"`, `"super+c"`. |
| `await type_text(text: str)` | `None` | Literal keystrokes; every newline presses Return. See typing hazards in SKILL.md. |
| `await set_value(element_index: int, value: str)` | `None` | Sets an editable element's value in one call; multiline-safe. Non-editable or secure elements raise `ACTION_UNSUPPORTED`. |
| `await select_text(element_index: int, text: str, prefix: str \| None = None, suffix: str \| None = None)` | `None` | Selects an exact run of `text` inside the element. `prefix` and `suffix` disambiguate repeated occurrences. |
| `await perform_secondary_action(element_index: int, action: str)` | `None` | Runs an AX action the element exposes. The element's available `actions` appear in its AX text — never guess a name. |
| `await paste(text: str, format: str = "text")` | `None` | Writes through the clipboard in `text`, `md`, or `html` form; the previous clipboard content is restored. |
| `await activate()` | `None` | Brings the app's frontmost window to the foreground and makes the app key. Keystrokes always reach the bound app's process, but app-scoped shortcuts (menus, quick switchers, composer keys) only fire while the app is key — call this before any shortcut-driven flow. Never fake focus from bash with `open -a`, osascript, or `screencapture`. |
| `is_frontmost()` | `bool` | Whether the app is the frontmost (key) application. Synchronous, no `await`. The pre-flight check before a shortcut flow: when it returns `True`, app-scoped shortcuts fire without `activate()`. |

Every `App` action can raise `ELEMENT_STALE`, `ACTION_UNSUPPORTED`,
`INVALID_ARGUMENT`, `INJECTION_FAILED`, `TRANSPORT_ERROR`, `SCREEN_LOCKED`,
`APP_NOT_ALLOWED` (the gate is re-checked on every action), and
`PERMISSIONS_NOT_GRANTED`.

Web views (Electron apps) often omit per-element geometry; an element click
there raises `ACTION_UNSUPPORTED`. Switch to keyboard navigation or `(x, y)`
window-screenshot coordinates — `get_text_regions()` supplies those
coordinates for models that cannot see screenshots.

## AX text

`get_ax_state` walks the focused window's AX tree. Each element reports its
`element_index` plus `role`, `subrole`, `title`, `value`, `description`,
`placeholder`, `actions`, `position`, and `size`. Use the text fields to
identify the element and the `element_index` to target it. Secure fields
(`AXTextField` with subrole `AXSecureTextField`) refuse typing and
`set_value` with `ACTION_UNSUPPORTED` and a hand-off message; ask the user to
enter credentials themselves.

## Error codes

Every failure raises `computer_use.errors.ComputerUseError` with a `code`:

| Code | Meaning | Recovery |
|---|---|---|
| `APP_NOT_ALLOWED` | App blocked, system-denied, or absent from the allowlist. | Tell the user the error and the fix: add the bundle id to `apps.allowed` in `~/.prime/agent/settings/computer-use.toml`. Never edit that file yourself. |
| `PERMISSIONS_NOT_GRANTED` | A required macOS grant is missing. | Run `permissions_status()`, relay the `help` lines, wait for the user to grant (see [permissions.md](permissions.md)). |
| `PERMISSIONS_PENDING` | A grant is mid-flight. | Ask the user to finish granting, then re-check with `permissions_status()`. |
| `SCREEN_LOCKED` | The screen is locked. | Stop and ask the user to unlock — the skill never unlocks. After unlocking, re-observe; indices are stale. |
| `USER_STOPPED` | The user stopped or intervened. | Stop the task and ask how to proceed; do not immediately retry. |
| `ELEMENT_STALE` | The index belongs to an old snapshot. | Call `get_ax_state()` and act on fresh indices; never retry the same index. |
| `AMBIGUOUS_APP` | The name matches several apps. | Call `list_apps()` and bind by the exact bundle id. |
| `APP_NOT_RUNNING` | The target is not running and could not be attached. | Check the `running` flag via `list_apps()`; have the user start the app, or bind by bundle id or path. |
| `APP_LAUNCH_FAILED` | The start attempt failed. | Verify the app name or path with the user; start the app manually and bind again. |
| `ACTION_UNSUPPORTED` | The element or backend does not support the action (non-editable `set_value`, secure field, unlisted secondary action). | Read the element's `role` and `actions` in the AX text; use an alternative control path; secure fields: hand off to the user. |
| `INJECTION_FAILED` | Posting the input event failed. | Re-observe, then retry once with fresh targeting; if it repeats, report it. |
| `TRANSPORT_ERROR` | Backend or transport failure — including no backend on this platform. | Confirm the platform is supported; re-observe; report persistent failures to the user. |
| `INVALID_ARGUMENT` | Malformed argument: bad chord, unknown direction, bad coordinates, wrong index type. | Fix the call to match the signatures above. |

## Policy files

The skill's on-disk paths — settings, approvals, and screenshot tmp files —
all derive from the agent state dir: `~/.prime/agent` by default, or the dir
named by the `PRIME_AGENT_CODING_AGENT_DIR` environment variable when set.

- Settings: `~/.prime/agent/settings/computer-use.toml` — `apps = {allowed =
  [...], blocked = [...]}`, `system_deny = [bundle ids]`, and `risk =
  {"com.apple.Safari" = "low"}` — quote every dotted bundle-id key (unquoted,
  TOML nests them silently); values are `low`, `medium`, `high`. Blocked and
  system-denied apps are hard refusals; anything not in `allowed` raises
  `APP_NOT_ALLOWED` with instructions for the user. The file is user-edited
  only; the skill never writes settings.
- Approvals: `~/.prime/agent/state/computer-use/approvals.json` —
  `{"persistent": [...], "session": [...]}` recorded approvals.
- Lock check: actions consult the login-session state. A locked screen fails
  closed with `SCREEN_LOCKED`; an unknown state proceeds.

## Telemetry

Emission is best-effort and never raises; properties are primitives only.

- `computer_use_session_started` — `{platform}`, once per process on the
  first `get_state()` call (`emit=True`).
- `computer_use_action` — `{action, outcome, duration_ms}` per action.
  `action` is one of `click`, `drag`, `scroll`, `press_key`, `type_text`,
  `set_value`, `select_text`, `secondary`, `paste`, `activate`, `get_state`;
  `outcome` is `ok` or `error:<CODE>`.

## Platforms

`backend()` resolves `"mac"` on macOS, `"linux"` when X11 tooling is
present, and `None` otherwise — in which case API calls raise
`TRANSPORT_ERROR` ("computer use backend unavailable: \<reason\>"). macOS is
the v1 platform; the Linux backend ships in a follow-up release.
