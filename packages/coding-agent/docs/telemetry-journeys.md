# Installation, onboarding, feature outcomes, and startup timing

These events add detail without changing the existing `onboarding completed` or `agent command used` meanings. The older onboarding event still means that a model has configured credentials. It does not prove that an inference request will succeed.

## Installation and update observations

`agent installation stage` requires telemetry schema version 2, revision 3. A random `installation_attempt_id` links stages within an observed shell installer, CLI update, or interactive `/update` attempt. A child updater retains its parent's attempt/source context. `installation_action=install` identifies a shell-installer attempt, which can include reinstalling existing software; it is not proof of a first-ever installation. `installation_action=update` identifies built-in update activity. Direct package-manager installs/updates are not observed by these hooks.

| Stage | What was observed |
| --- | --- |
| `started` | A telemetry-enabled installation/update attempt began. |
| `requirements` | The installer checked required tools/platform support. |
| `release_lookup` | A release lookup ran, failed, or found the installed version already current. |
| `download` | An installer download completed or failed. |
| `verification` | The downloaded package passed or failed the installer's existing checks. |
| `package_install` | The package installation command completed or failed; this does not establish runtime readiness. |
| `completed` | The installer/updater command succeeded, failed, was canceled, was skipped, or was unavailable. Later restart/readiness observations remain separate. |
| `daemon_restart` | The post-update daemon restart completed, failed, or was skipped. |
| `session_restore` | Session restoration was observed, with bounded total and failed-session counts when available. Failed counts include sessions recreated with incomplete queued work. Older restart results that cannot establish complete restoration remain unavailable. |
| `relaunch` | The interactive process attempted to start the new program. |
| `ready` | A fresh runtime initialized after package installation; `ready_kind` distinguishes interactive and headless readiness. The agents view qualifies after daemon roster attachment and UI setup. Running `--version` alone does not count. A known requested/running-version mismatch is reported separately. |

Each measured stage duration starts at that stage's initiation. When a command attempt begins and completes in the same process, its `completed` duration covers that attempt; do not add it to stage durations. An interactive updater child inherits an attempt ID but cannot inherit the parent's monotonic clock, so its total duration remains null while locally measured stage durations are retained. Shell stages and later runtime-ready observations also omit precise timing with `duration_ms=null`. Missing stages can mean they were not applicable, not reached, or not reported. A successful package operation must not be interpreted as successful daemon restart, session restoration, launch, or model access.

Successful package installation can retain a private marker in `telemetry-installations/` for a later ready observation. It contains only sanitized attempt/version context plus the originating working directory used locally to re-check project consent; that directory never enters telemetry. At most 16 markers survive for seven days. A process that was already running when installation finished leaves the marker for a newer process. A ready observation consumes its marker and re-checks current and originating-project opt-outs, including saved settings again before delivery. Disabling telemetry clears this state; expired, invalid, opted-out, and unavailable observations are not replayed. This is bounded startup correlation, not a disk queue of error reports. Readiness delivery starts in the background, with controlled exit waiting only for its bounded flush; it does not delay UI or headless startup.

Only numeric release versions and approved prerelease forms are retained. Custom labels map to the existing unknown version and are excluded from mismatch calculations. Reasons, stages, sources, and outcomes are finite categories. No command arguments, package-manager output, download URLs, repository paths, credentials, or prompt content are included. The existing content-safe error reporter supplies an optional independent `error_id` for failures it observes; an installation stage itself does not create a native error exception.

Count distinct installation/attempt/stage combinations before aggregating attempts. Keep install/update and shell/CLI/interactive sources separate. Missing command completion or runtime readiness is pending or unknown, not an inferred failed installation. Download-request analytics remain aggregate script requests and do not join these client identities.

Installation/update observations use a separate delivery client that re-checks consent during capture and delivery. Their final flush is best effort and bounded; remaining in-memory reports are discarded afterward. Ready markers are consumed when readiness is observed even if delivery fails, so they do not create a durable retry queue. Missing delivery remains unknown coverage. The existing general telemetry retry policy is unchanged.

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

Prime login reports the duration and outcome of its existing identity/scope checks, including manual key entry. These checks do not establish access to the selected team, sufficient balance, or access to every model. Other API key saves and OAuth credential acquisition are reported as configured, with further validation explicitly unchecked. A later associated run with `successful_model_call_count > 0` demonstrates a completed model response, even if the run then fails in a tool or another step. That inference observation remains separate from setup readiness and successful whole work. No new provider requests or startup prerequisites are introduced.

`acquisition_method` records the route used to obtain credentials, such as existing configuration, browser sign-in, manual key entry, OAuth, or external credentials. `auth_category` reports the safe category of the effective credential source at the observation. A browser login can still be followed by a different effective credential source; acquisition must not be used as a substitute for source. Provider names are reduced to built-in categories or `custom`. Keys, team identifiers, scopes returned by providers, and custom provider names are excluded.

An earlier failed login remains visible when a retry succeeds. A later successful credential check can mark login/validation failures for the same UI and provider as recovered; saving an unvalidated key cannot. The exact provider identity is compared only in bounded local state, so providers sharing an analytics category cannot resolve each other's errors. Storage load/save, unrelated-provider and worker inference failures remain separate. A user who cancels a menu after a failure has a canceled exit. A failed login that ends the initial flow has a failed exit. Re-entry gets a new attempt ID. Skipped flows emit observations but do not replace the saved activation context.

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

System durations use a monotonic clock. `timing_scope` distinguishes system work from elapsed time that can include user wait. Worker run-to-first-text timing starts at `agent_start`; it must not be presented as time from user submission.

## Input, queue, and cancellation observations

`agent input stage` separates UI submission from receipt in the worker, queue selection, preparation, dispatch, and completion of the prompt call. A random `input_id` joins observations of the same input. The worker observes actual session-action state changes, including rollback to the queue and cancellation before execution. Finishing the prompt call is not proof that a run completed: queued prompts can return while their work is still waiting. A request rejected before dispatch is also distinct from a provider failure.

UI submission starts when a normal editor submission reaches the prompt path, before the startup-prompt admission barrier. For startup-supplied prompts it starts immediately before the connection call. UI admission ends when that call returns or rejects. A transport result that cannot confirm ownership has outcome `unavailable`; it does not claim cancellation or rejection. These UI durations include local preparation and any connection or admission wait after their start. Worker queue and preparation durations start and end within the worker. The UI and worker never subtract timestamps from different processes.

`agent timing` adds two observations from the interactive UI:

| Stage | Boundary and coverage |
| --- | --- |
| `first_status` | UI input start to the first successfully written terminal frame that rendered a nonempty working-status area, once admission of that input is confirmed. Coverage is limited to a single input submitted while idle, with no queued action or overlay. Overlapping inputs, observed queueing, a missing rendered frame, and view replacement produce `unavailable` with a null duration. This observes a terminal write, not a display-device acknowledgement. |
| `cancellation_to_idle` | Interrupt request to the first observed state with no running, compacting, retrying, shell, or active session action, provided the cancellation requests succeed. Preserved queued messages do not prevent idle. Failed cancellation or lost observation produces a null duration. A new input or view replacement closes an unfinished measurement as unavailable. |

The first-status observation has no per-input status identifier from the daemon. Its narrow idle-input coverage reduces ambiguity, but does not prove that another attached client could not have started work concurrently. Do not use it as complete prompt latency coverage. Cancellation is associated with the UI lifetime, rather than an invented input or worker run ID. Neither measurement adds a blocking wait or a new keybinding.

## Setup, UI, and executing-worker context

At the end of an actual onboarding attempt, local correlation state can retain a bounded setup snapshot: provider and model category, credential-source category, personal/team category, and default/custom endpoint category. Before submitting a prompt, the UI can include its current snapshot. The worker separately observes the context used when request authentication is actually resolved. Configuration at setup and configuration in the UI are not substitutes for the executing worker's request context.

Differences compare categories only. Two credentials, team identifiers, or endpoint URLs can differ while their categories are equal. Unknown values remain unknown. Keys, account or team identifiers, URLs, prompt text, and paths are never included in these snapshots. No provider request is made just to populate telemetry.

Successful login, provider changes, and model changes can mark the next input with a fixed recovery-action category. An input that fails admission restores that pending action for a later attempt. This records the action taken, not a claim that it solved the error. Worker recovery observations determine whether a later request actually succeeds.

The optional `telemetryInput` prompt metadata is capability-gated by `telemetry_input` and daemon schema revision 28. The protocol version is unchanged. It applies to `prompt` and `prompt_and_wait`; no command or event is required during startup. Clients strip the metadata when the connected server lacks the capability or schema, including reconnect replay and direct-worker fallback. Older clients continue to send their existing prompt shape. Worker-only observations still work when UI metadata is unavailable.

Non-HTTP failures in commands for an already resident session use that session's settings, runtime opt-out, and agent directory. Unbound catalog requests and cross-project session replacement do not acquire a global error-reporting context; caller-side reporting covers visible failures where consent is known.

## Activation pairing and opt-out

The most recent actual onboarding attempt stores random attempt/client IDs, its start time, and the bounded setup categories in private local state, retained for at most seven days. Worker run events can use this context to relate later successful runs to onboarding. When input metadata names an earlier attempt than the current stored context, elapsed time is omitted instead of borrowing the newer attempt's timestamp. A 24-hour activation metric requires an observed successful run with the same `onboarding_id` and `elapsed_since_onboarding_ms` between zero and 86,400,000. Missing pairs are unknown coverage, not demonstrated failure.

For first-session activation, select the first observed worker session associated with the attempt and inspect successful runs in that session. `run_index` counts runs inside a worker session; it does not identify the first session by itself. Input metadata can associate a submitting UI with a worker run. The fallback shared local onboarding context remains an installation association: concurrent UIs can update it. Keep missing metadata and ambiguous cases separate.

Telemetry remains enabled by default and follows the existing setting and environment precedence. Disabling effective telemetry immediately removes local onboarding correlation and clears in-memory journey state, pending UI observations, and recovery-action markers. Disabled operations allocate no analytics IDs and are not replayed after telemetry is re-enabled. Worker consent is checked independently before input observation. Fresh activity after re-enabling starts new correlation IDs.
