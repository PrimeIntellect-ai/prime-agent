# Universal AVO

AVO is Prime Agent's default execution architecture. You do not enable a mode:
every root task is routed automatically to a general, coding, or research
evaluation adapter and a direct, iterative, or long horizon.

The host requires a candidate, an evaluation appropriate to the task, an
accepted cycle, and an exact canonical final delivery. Coding work also binds
the candidate to the observed workspace and an unchanged pre-task test
baseline. Factual work binds verbatim claims to host-observed external sources.
Artifact and deterministic tasks use their own host checks.

## Live phase graph

Run this in another terminal while Prime Agent is working:

```bash
prime-agent-avo avo dashboard
```

The upstream command name works as well:

```bash
prime-agent avo dashboard --no-open
```

The dashboard listens only on `127.0.0.1` and defaults to
<http://127.0.0.1:4317/>. It shows the active phase graph, verification contract,
candidate/evaluation progress, authoritative stop gate, supervisor state, and
NOOA memory metrics. Use `--session <id>` for a specific durable session or
`--port <number>` to select another local port.

## NOOA memory

Prime pins NVIDIA NOOA memory 0.0.9 in an isolated Python 3.13 worker. The host
is the canonical truth ledger; NOOA supplies hybrid retrieval, ACT-R scoring,
associative spread, reflection/consolidation, and forgetting.

Every memory independently records:

- cognitive type: `info`, `skill`, `episode`, `intent`, `todo`, `reflection`,
  or `scratch`;
- AVO namespace: `general`, `coding`, `research`, or `shared`;
- scope: `task`, `project`, or `global`;
- verification: `proposed`, `verified`, `contested`, or `invalidated`.

Before every root turn, Prime automatically derives a cue from the prompt,
objective, environment, latest candidate, and latest failure. It injects a
bounded NOOA recall block before the model starts reasoning. This spontaneous
recall is non-reinforcing, so injection cannot create a self-amplifying recall
loop.

Completed cycles, research experiments, supervisor interventions, and tasks
produce host-verified project episodes. On long runs, the current Prime model
may distill multiple verified episodes into an owner-isolated proposed
reflection. A separate isolated verifier must support the proposal against at
least two verified episodes before it becomes canonical shared memory.
NOOA also supplies semantic candidate clusters for reconsolidation. The current
Prime model may propose that a newer verified record supersedes an older version
of the same fact, but a second isolated verifier and the host's provenance,
scope, type, and timestamp checks must all agree before the old record is
invalidated. Related facts, exceptions, and counterexamples remain separate.

Task memory lives with the session artifacts. Project and global memory live
under Prime's agent data directory:

```text
memory/projects/<repository-sha256>/canonical.json
memory/projects/<repository-sha256>/nooa-memory.sqlite
memory/global/canonical.json
memory/global/nooa-memory.sqlite
```

Canonical JSON writes are atomic and locked, so concurrent Prime sessions merge
distinct records instead of silently replacing one another. The SQLite files
are derived NOOA indexes; deleting an index does not delete the canonical JSON
ledger.

Hashing embeddings are the offline default. Semantic embeddings are opt-in:

```bash
export PRIME_AGENT_AVO_MEMORY_EMBEDDING=litellm
export PRIME_AGENT_AVO_MEMORY_EMBEDDING_MODEL='openai/text-embedding-3-large'
export PRIME_AGENT_AVO_MEMORY_EMBEDDING_ENDPOINT='https://example.test/v1'
export PRIME_AGENT_AVO_MEMORY_EMBEDDING_API_KEY='...'
export PRIME_AGENT_AVO_MEMORY_EMBEDDING_DIMENSIONS='1024'
```

Prime does not create a paid embedding request unless this is configured.
When the NOOA worker is unavailable, automatic recall falls back to the
host-owned lexical index without losing canonical memory.
