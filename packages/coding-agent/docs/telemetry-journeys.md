# Onboarding, feature outcomes, and startup timing

These events add detail without changing the existing `onboarding completed` or `agent command used` meanings. The older onboarding event still means that a model has configured credentials. It does not prove that an inference request will succeed.

## Onboarding observations

`onboarding stage` groups observations with a random `onboarding_id` and the originating UI's random `client_session_id`.

| Stage | What was observed |
| --- | --- |
| `entry` | An onboarding attempt started. `entry_reason` distinguishes first setup, re-entry, an existing configuration, and a previously shown flow. |
| `provider_selection` | A provider or model was selected. `provider_switched` means the selection changed provider, before any claim about authentication. |
| `credential_discovery` | Credentials were found or saved. `configured` means configuration exists. |
| `credential_validation` | A check actually ran, or `unavailable` with `validation_scope=unchecked` when it did not. |
| `model_access` | Currently reported as unchecked during setup. Selecting a model does not perform an inference request. |
| `ready` | The current model has configured credentials and the existing UI readiness condition is satisfied. |
| `exit` | The flow completed, failed, was canceled, or was skipped. |

Prime login reports the duration and outcome of its existing identity/scope checks, including manual key entry. These checks do not establish access to the selected team, sufficient balance, or access to every model. Other API key saves and OAuth credential acquisition are reported as configured, with further validation explicitly unchecked. No new provider requests or startup prerequisites are introduced.

`acquisition_method` records the route used to obtain credentials, such as existing configuration, browser sign-in, manual key entry, OAuth, or external credentials. `auth_category` reports the safe category of the effective credential source at the observation. A browser login can still be followed by a different effective credential source; acquisition must not be used as a substitute for source. Provider names are reduced to built-in categories or `custom`. Keys, team identifiers, scopes returned by providers, and custom provider names are excluded.

An earlier failed login remains visible when a retry succeeds. A user who cancels a menu after a failure has a canceled exit. A failed login that ends the initial flow has a failed exit. Re-entry gets a new attempt ID. Skipped flows emit observations but do not replace the saved activation context.

## Feature outcomes and feedback

`agent feature outcome` pairs `initiated` with one terminal outcome using a random `feature_id`. Terminal outcomes are `completed`, `failed`, `canceled`, or `unavailable`. Normal UI teardown cancels pending attempts; a killed process may leave initiation unmatched. Treat unmatched attempts as unknown, rather than successful or failed.

The UI measures model and authentication changes, effort changes, new sessions, resume, fork, clone, and tree navigation. A completed change follows the actual operation's result. Worker goal command outcomes use their worker session/run context. UI feature events use `client_session_id` and do not manufacture worker IDs.

`/resume` without a selector opens the separate agents view. Opening that view is not recorded as a successful resume; this UI cannot observe the later choice or cancellation there.

`previous_success` only means the feature completed earlier in the same UI lifetime with telemetry enabled. It does not establish lifetime adoption or repeat use on another launch. Arguments, prompts, session paths, session names, and custom command names are excluded. `configuration_choice` is limited to fixed choices, such as effort levels.

`/feedback` optionally accepts `helpful`, `partly-helpful`, or `not-helpful`, or opens the existing configurable selector. Canceling sends nothing. This records the user's assessment; it does not turn a successful API request into a claim that the task was solved. Freeform text is rejected. Feedback is omitted when telemetry is disabled, including if it is disabled while the selector is open.

## Timing boundaries

| Observation | Boundary |
| --- | --- |
| Onboarding elapsed time | Since this attempt's entry, including user input and browser wait. Do not sum cumulative stage durations. |
| Credential validation | Only the existing identity/scope check; measured as system work. |
| Feature duration | From menu/action initiation to the observed outcome, including user wait. |
| `configuration_load` startup stage | Settings, credentials, and runtime resource/service preparation in the creating process. |
| `session_attach` startup stage | CLI socket connection through session create/attach completion or failure. Earlier daemon startup/readiness is excluded. |
| `session_ui_rebind` startup stage | UI subscription and state rebinding after selecting a connection. |
| `ui_ready` startup stage | CLI process start to completion of UI initialization, including any earlier user wait; before onboarding. An embedded UI measures from its initialization call unless an origin is supplied. |

System durations use a monotonic clock. `timing_scope` distinguishes system work from elapsed time that can include user wait. Worker run-to-first-text timing starts at `agent_start`; it must not be presented as time from user submission. UI submission-to-dispatch, queue wait, and first-visible-status timing are not inferred from these events.

## Activation pairing and opt-out

The most recent actual onboarding attempt stores only random attempt/client IDs and its start time in private local state, retained for at most seven days. Worker run events can use this context to relate later successful runs to onboarding. A 24-hour activation metric requires an observed successful run with the same `onboarding_id` and `elapsed_since_onboarding_ms` between zero and 86,400,000. Missing pairs are unknown coverage, not demonstrated failure.

For first-session activation, select the first observed worker session associated with the attempt and inspect successful runs in that session. `run_index` counts runs inside a worker session; it does not identify the first session by itself. This is a recent local-installation association, not proof that a particular UI submitted the run: concurrent UIs can update the shared context. Keep unmatched or ambiguous cases separate. No daemon commands, capabilities, or wire fields are added for this correlation.

Telemetry remains enabled by default and follows the existing setting and environment precedence. Disabling effective telemetry immediately removes local onboarding correlation and clears in-memory journey state. Disabled operations allocate no analytics IDs and are not replayed after telemetry is re-enabled. Fresh activity after re-enabling starts new correlation IDs.
