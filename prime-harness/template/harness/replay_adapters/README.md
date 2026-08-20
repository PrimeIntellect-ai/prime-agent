# Trusted replay adapters

A production adapter is the trust boundary between `replay.py` and the agent
whose frozen Continual Harness state is being evaluated. Replay pins the
adapter entry file by SHA-256 and launches it with `python -I -S` once per task
and repetition. The adapter must:

1. parse the protocol-v1 JSON object from stdin;
2. create an isolated agent/runtime using the supplied complete `local` and
   `global` harness state (not the current ambient state);
3. apply deterministic seed/model settings and present only `challenge`;
4. emit exactly one response-contract JSON object on stdout; and
5. fail nonzero if the state cannot be applied exactly.

Do not embed corpus answers, read `checks/evalset` or a prior response bundle,
or silently fall back to ambient/default harness state. Adapter dependencies
must themselves be pinned by the project environment; changing the entry file
changes the digest and invalidates existing snapshots. Credentials stay in the
operator environment and must never be written to replay reports.

The checked-in reference adapter under `checks/evalset/executors/` is only a
corpus/verifier self-test. `replay.py` rejects its path and exact digest in
comparison mode. A semantics-preserving edited copy cannot be identified
mechanically on a public corpus; code review and private holdouts must reject
that policy violation.
