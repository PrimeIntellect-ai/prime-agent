# checks/hidden_holdout

`test_public_transport_smoke.py` is intentionally a public transport smoke and non-scientific.
It proves only that a fresh install can transport the existing `holdout`
profile through pytest without exit code 5. It is **not private holdout
evidence**, must never be cited as such, and contains no secret challenge.

Human-curated private tests evaluate agent-produced changes and Continual
Harness refinements — the defense against reward hacking (an agent that
passes the visible gate while violating the intent).

**Honest limitation:** anything committed in the repository is readable by
the agent. This directory offers only soft separation and the public workflow
therefore runs only the transport smoke. Keep scientific holdouts outside the
agent workspace and inject them on protected infrastructure immediately
before running:

    python harness/doctor.py
    python harness/verify.py --profile holdout --json

Supported private-CI patterns (documentation only; none is configured here):

1. A private repository owns a reusable workflow, checks out the candidate at
   an immutable SHA, adds its private tests under `checks/hidden_holdout/`, and
   runs doctor plus the existing `holdout` profile.
2. A protected environment or self-hosted runner mounts an ephemeral holdout
   directory into `checks/hidden_holdout/` for the gate, then destroys it.
3. A trusted CI job checks out a separate private test repository with a
   short-lived read-only credential scoped to that job. The credential and
   repository coordinates belong in CI environment configuration, never this
   workflow, source tree, logs, artifacts, prompts, or pull-request context.

Pin every action and private-suite revision by full commit digest, disable
checkout credential persistence, restrict permissions to read-only, and do
not expose private jobs to untrusted fork pull requests. A protected private
job — not the public matrix result — is the scientific promotion signal.
Never disclose test names, inputs, expected values, or failure details to an
agent session; even structural leakage invites overfitting.
