# Recursive AI laboratory

An executable, bounded program-search prototype for `binary_search`. This is not AGI or autonomous model training. The default demo searches supplied algorithms; the optional API mode requests new source from a local or remote chat-completions-compatible service.

## Run

Requires Linux, Python 3.12+, Git, and a Docker daemon with working cgroup v2 limits and its default seccomp profile. Docker Desktop's Linux VM is also suitable for evaluation, but the controller uses POSIX file locking. Colab without Docker cannot run candidates: there is deliberately no host-execution fallback.

From the repository root:

```sh
cd recursive-ai
docker build -t recursive-ai-runner:local sandbox/
python3 main.py run --iterations 8
python3 main.py status
python3 -m unittest tests.test_lab -v
```

Capture each run's JSON lines if you want a separate telemetry file. Persistent telemetry, exact-source Beta evidence, bandit statistics, and the atomic active checkpoint pointer are in `.lab-state/memory.sqlite3`. Git checkpoints are in `.lab-state/checkpoints.git`. `main.py status` reports the current SHA. To restore a previously promoted checkpoint, pass that SHA to `python3 main.py rollback --checkpoint`. Rollback changes only the active pointer and appends an event; it preserves all historical evidence and never resets the parent repository.

The first promotion gains the single benchmark capability. Later replacements require objective improvement greater than 0.001; merely passing again is not capability growth. Runtime measurements are noisy, so this threshold is a prototype heuristic, not statistical proof of optimization.

## Optional model synthesis

Set `LAB_MODEL_URL` to the full chat-completions endpoint, `LAB_MODEL_NAME` to an installed or available model, and optionally `LAB_MODEL_KEY` in the environment. Run `python3 main.py run --provider api --iterations 8`. HTTPS is required except for loopback HTTP. No credentials are written to memory. API mode can incur provider charges and is only used when explicitly selected. The client requests at most 2048 output tokens per direct/repair proposal and uses a 60-second request timeout. Actual billed token usage is not currently tracked. Mutation and crossover run locally on source ASTs; they never execute candidate code.

## Boundaries and gates

The host controller, evaluator, source-generation adapters, SQLite store, Git store, Docker daemon, and image are trusted. The generator receives only public specification/examples, active source, and aggregate failed gate names. Candidate containers receive source and the current inputs, but never expected answers, repository files, evaluator code, credentials, or the Docker socket. Fresh holdout samples are withheld from the generator, not secret from the function processing its own inputs. The sampling distribution is public. Repeated adaptive selection can still overfit that distribution.

Every promotion requires these gates, in order:

1. Syntax and source/AST size limits.
2. Conservative pure-function AST policy (no imports, attributes, reflection, private names, decorators, defaults, or arbitrary calls).
3. Container boot: verify non-root UID, read-only root, seccomp filter, no-new-privileges, zero effective capabilities, and actual cgroup CPU/memory/swap/PID limits.
4. Public tests with host-computed expected answers.
5. Current candidate regression tests plus rechecks of every active skill (currently one supported task).
6. 128 fresh holdout cases.
7. Translation, positive scaling, sign reversal with re-sorting, duplicates, empty inputs, and large integer cases.
8. CPU time and traced Python heap thresholds; broker wall timeout and container memory ceiling. These are not hardware CPU-cycle measurements or total RSS measurements.
9. 1000 new randomized comparisons with a linear reference.
10. Three fresh-container runs on identical inputs, requiring byte-identical serialized outputs and oracle correctness.

Candidate inputs must remain unchanged. All output validation occurs on the host. A failing or unavailable gate ends evaluation, and unavailable isolation stops the run. Exceptions from candidates and private values are not fed into synthesis. AST filtering is defense in depth, not a proof that arbitrary Python is safe. Docker shares a kernel: use a dedicated disposable VM for hostile source.

The image contains only the trusted harness. The runner sets a read-only root, non-root UID, no network, one CPU, 512 MiB memory with no additional swap, 64 PIDs, no capabilities, no new privileges, and a 16 MiB noexec tmpfs. It retains Docker's maintained default seccomp profile instead of shipping an unverified custom syscall list. Configuration reference: https://docs.docker.com/reference/cli/docker/container/run/

There is no autonomous agent process with host write access. The requested OS-enforced read-only generator workspace and full mutable synthesizer subsystem are not implemented; only candidate execution is isolated. Editing trusted controller files is an operator action. Do not give a model host tools or run this controller from a model-writable checkout.

## Metrics

For binary skill indicators `p_i`, normalized nonnegative weights `w_i`, and wall time `E_k`:

- `C_k = sum(w_i * p_i)`.
- `delta_k = C_k - C_(k-1)`.
- `R_k = delta_k / E_k`; the implementation reports `R_k - R_(k-1)` as rate change, not physical acceleration.
- `J = 1 - 0.001 * AST_depth - source_bytes / 1e6 - peak_heap_bytes / 1e9 - CPU_seconds / 10`, compared only after all gates pass.
- Each exact source hash has a Beta(1,1) prior: posterior mean `(1 + successes) / (2 + successes + failures)`. Repeated related test suites are correlated evidence, not calibrated correctness probabilities.
- UCB1 selects an untried strategy first, then maximizes `mean_gain + sqrt(2 * log(total_attempts) / strategy_attempts)`. Rewards are capability gains in [0,1]; objective-only changes are not rewarded as new capabilities.

Git snapshot objects are written before SQLite activation. A crash before activation can leave an inactive checkpoint object; it cannot partially replace active state. A process lock serializes controller mutations. SQLite transactions atomically record activation, evidence, strategy reward, and episode. Events are append-only by controller convention, not tamper-proof against the host owner.

## Scope and verification

Implemented search strategies: direct synthesis, integer AST mutation, scope-preserving whole-function crossover, and regeneration using failure-gate context. The demo is deliberately finite; it does not discover an unlimited curriculum. Semantic embeddings, trained model updates, multi-task registration, historical evaluation-suite versioning, measured API token accounting, and hardware cycle counters are not provided.

`tests.test_lab` verifies controller gates using a fake runner, static rejection, actual Git checkpoints, SQLite rollback, and fail-closed behavior. It does not execute untrusted Python on the host. `tests.test_docker` contains real Docker integration checks and must be run separately on a Docker host after building the image:

```sh
python3 -m unittest tests.test_docker -v
```

A green controller test suite is not evidence that the container image has run successfully. See `VERIFICATION.md` for the actual verification results for this change.
