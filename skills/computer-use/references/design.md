# Computer Use Design

Status: draft (ships with the computer-use skill). This reference specifies the architecture,
API, safety model, and telemetry of Prime Agent computer use, implemented as the bundled
`computer-use` Python-backed skill.

## 1. What it is

`computer-use` is a Python-backed RLM skill: a kernel-resident module (`computer_use`) the
agent programs against - the "one code-execution surface + programmatic UI API" shape used by
every serious computer-use system. It rides the existing `ipython` surface, so no new
model-facing tool exists, the system prompt's static layer is unchanged, and the cacheable
prompt prefix is unaffected; the skill registers only through the dynamic skills inventory.

Scope (v1): observe and operate native apps on macOS (AX observation + window capture),
gated by a user-edited allowlist, with a confirmation policy, action telemetry, and screenshot
support through the existing image-attachment path. A Linux X11 backend follows as a stacked
lane; Windows and Wayland are out of scope for v1.

Non-goals: no lock-screen auto-unlock (any SecurityAgent/authorizationdb modification is
rejected - the skill stops with `SCREEN_LOCKED` and asks the user to unlock); no ambient
screen recording or activity memory in this lane; no global desktop pointer control (actions
are app-scoped); no byte-compatibility with any third-party wire protocol.

## 2. Architecture

```
agent -> ipython kernel -> computer_use (skill module)
                               |- apps/ax/diff: AX observation (element_index, diffed text)
                               |- inject: CGEvent posting (app-scoped)
                               |- capture: window screenshot -> tmp file -> image attachment
                               |- policy: allowlist + locked-screen gate (hard, user-controlled)
                               |- telemetry: host-request bridge -> pa-core -> pa-telemetry
```

Interaction loop the skill teaches (and enforces the freshness half of): observe
(`get_app`/`get_ax_state` returns element-indexed AX text, diffed against the previous
snapshot), act by `element_index` (or window-screenshot coordinates), re-observe. The runtime
auto-settles after actions; the model never needs to sleep. Screenshots are the fallback when
AX text is misleading - they cost far more tokens than the AX diff.

App-scoped actions: every action targets a bound `App`; mouse events are posted to that app's
process rather than the global event stream; text entry uses the AX value-setting path where
possible. Element indices are snapshot-scoped; a stale index raises `ELEMENT_STALE`, which
instructs a re-observe.

## 3. Safety model

**Trust boundary, stated honestly:** the gates below run in the same Python process as the
agent's own code. They are a misuse guard and model-discipline layer - they make accidents and
confusion fail closed - but they are NOT a boundary against malicious kernel code (which could
import the skill's internals or spawn subprocesses directly, as with any kernel-resident skill).
The hard boundary (process separation, peer verification, in-process policy enforcement) is the
Phase-2 native helper listed under follow-on lanes; the design keeps the gate seams in the skill
so that helper can inherit them.

1. Allowlist (hard gate, user-edited): `~/.prime/agent/settings/computer-use.toml` lists
   allowed and blocked bundle ids. Anything not allowed raises `APP_NOT_ALLOWED` with
   instructions for the user to extend the allowlist. The skill never edits its own settings.
   Binding, observation, and every action re-check the gate on each call (revocation takes
   effect immediately).
2. System deny-list: OS-authentication surfaces (loginwindow, screensaver, system dialogs) are
   always refused; secure text fields refuse typing and hand off to the user.
3. Confirmation policy (`safety.md`): a four-mode taxonomy - hand-off (user must act),
   confirm-at-action-time, pre-approval-accepted, no-confirmation - keyed to action categories
   (destructive changes, third-party communication, credentials, purchases, system settings).
   It is model-facing policy text: the gates above are code, but no v1 gate mechanically
   intercepts a single risky action (that interception is the Phase-2 approval surface);
   the taxonomy disciplines the model, and the allowlist bounds the blast radius.
4. Untrusted evidence: everything read from the screen or AX tree is data, never instructions.
   The skill surfaces this framing in its docs and error messages.
5. Locked screen: actions fail closed with `SCREEN_LOCKED` until the user unlocks.

## 4. Telemetry

The skill emits adoption/usage events through a generic kernel telemetry bridge
(`telemetry.emit` host request, landed in the pa-core/pa-telemetry lane of this stack). The
bridge validates against the versioned event catalog in `crates/pa-telemetry/src/catalog.rs`:
uncatalogued names and non-primitive properties are dropped, strings are capped, numbers are
clamped - the privacy contract (no prompt, tool, or screen content) is enforced by the catalog
and its sanitize layer, not by the firing site. Events: `computer_use_session_started`
(platform) on the first observation per process, and `computer_use_action` (action, outcome,
duration_ms) per action. The bridge is best-effort: on hosts without it the skill silently
no-ops, and telemetry never fails an action.

## 5. Permissions (macOS)

Two TCC grants are required and only the user can grant them: Accessibility (input injection +
AX control) and Screen Recording (window capture). `permissions_status()` reports each as
ok/missing/unknown plus exact System Settings paths. The skill never attempts to bypass or
auto-grant; first-run guidance is printed from `get_state()` when grants are missing.

## 6. File layout

`skills/computer-use/` per the Python-backed skill contract: SKILL.md (routing + loop +
discipline), references/ (this file, api.md, safety.md, permissions.md, app-instructions/),
pyproject.toml (macOS deps behind `sys_platform == "darwin"` markers), src/computer_use/
(module tree above), tests/ (stdlib unittest; fakes for all backends; live pyobjc smoke tests
opt-in via `PRIME_CUA_LIVE=1`). Tests run without a display or TCC grants.

## 7. Follow-on lanes (stacked, not in this PR)

- Linux backend: X11 window tree observation (xwininfo), xdotool input, scrot capture; Xvfb
  test lane; window-bound input without activation where supported.
- Native helper: a small per-OS helper binary owning capture/injection (process separation,
  TCC isolation, peer verification, in-process policy) with the skill becoming a thin async
  client - the long-term home for the hard gates.
- Approval surface: a first-class elicitation ("Allow Prime Agent to use {app}?" with
  always/session persistence) in the TUI and headless prompt flow, replacing the
  allowlist-only gate as the primary approval UX.
