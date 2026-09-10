# Trace sharing

Automatic trace sharing defaults to off. `/traces on` enables the global `agentTraces.enabled` setting and queues the current persisted session when its project permits sharing. `/traces off` disables automatic sharing globally. A project's `.prime/agent/settings.json` can further disable sharing with `{"agentTraces":{"enabled":false}}`; a project cannot override a global opt-out. Each queued session uses the project recorded in its own header.

| Command | Behavior |
| --- | --- |
| `/traces status` | Read effective consent, configuration, queue counts, current-session delivery state, recent outcomes, and retry/pause information. |
| `/traces preview` | Preview the current raw JSONL without uploading. |
| `/traces upload-current` (or `/traces upload`) | Queue a one-shot upload of the current file version, even when automatic sharing is off. |
| `/traces upload-all` | Queue discovery and one-shot uploads of existing sessions and child-session artifacts. |
| `/traces cancel` | Cancel the bulk request started in this interactive task. |
| `/traces cancel-all` | Cancel all pending one-shot requests in the shared agent directory, including requests from another task or a previous process. |
| `/traces login` | Configure a Prime credential with trace write permission. |

Upload commands acknowledge queueing, not successful delivery. Discovery, payload preparation, credential commands, and requests run in the background. Task startup, ongoing work, deletion, and shutdown do not drain the delivery queue. Status reads do not contact the trace server, run credential commands, or start uploads.

One-shot permission applies only to the requested file version. If the file is appended to or replaced before a snapshot can be captured, that request fails with guidance to authorize the current content again. Bulk discovery excludes files created or changed after the request. Once captured, retries reuse the snapshot even if the source changes. An older snapshot is superseded when a newer version has already been delivered. A one-shot request never enables automatic sharing or authorizes later appended content.

Automatic consent is checked before preparation and dispatch and during active requests. Disabling sharing pauses automatic work and attempts to abort active requests. One-shot requests remain independently authorized until cancelled. Cancellation is durable across worker changes; bytes already sent cannot be recalled. Snapshot copies are removed after delivery, cancellation, supersession, or permanent failure.

The existing local outbox stores delivery state and retry deadlines. Workers sharing an agent directory use one delivery lease and a shared request interval of at least 12.1 seconds, with at least 60 seconds between automatic attempts for a session. Network errors, timeouts, rate limits, and transient server failures retry with exponential jitter capped at five minutes; a longer `Retry-After` is respected. A crashed worker's lease can be reclaimed after 30 seconds. Pending work resumes while a worker is running or when one next starts.

Missing or rejected credentials pause delivery; setting a usable credential resumes it. Permanent request/file failures remain visible in status. Automatic file failures can resume after the file changes, and automatic endpoint failures after the endpoint changes. For a failed one-shot request, correct the problem and issue a new upload command. Repeated identical failures do not flood logs, and arbitrary server error bodies and credential values are excluded from status and logs.

The upload remains the existing raw JSONL `PUT` to `/api/v1/agent-traces/sessions/:sessionId`, with the existing parent/root and active-branch git headers and 20 MiB limit. Semantic-edge ledger entries remain separate, retain their cursors, and are excluded from JSONL delivery counts.
