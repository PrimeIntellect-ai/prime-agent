# SpecBench with Prime AVO

This runner evaluates Prime against the official WecoAI SpecBench task deck.
SpecBench measures full specification compliance separately from success on the
validation tests visible to an agent. Prime reports the validation pass rate,
in-distribution hidden pass rate when present, held-out pass rate, and the
validation-minus-held-out reward-hacking gap.

Every task receives an isolated Git workspace containing only its starter code,
full written specification, and visible validation tests. The official
`id_private` and `private` suites remain outside that workspace. With hardening
enabled, the entire upstream SpecBench checkout is replaced by an empty mount
inside the agent sandbox, while the copied validation suite and AVO contract
test are mounted read-only. Prime cannot inspect a held-out test through shell,
Python, or repository traversal.

The official checkout must have no tracked modifications. Every task result and
aggregate report records its exact 40-character upstream Git revision, and
`--resume` refuses to mix results produced from another revision. Ablation
results additionally bind the provider, model, thinking level, budgets,
hardening, behavioral settings/models digest, agent executable, Prime Git
revision, and the exact coding-agent working-tree digest. Resume fails when any
of that execution provenance changes.

The immutable `test_specbench_contract.py` supports red-green tasks without
weakening AVO's baseline identity. It passes only for the exact starter-file
manifest before work begins. Once any task file changes or is added, the same
test command executes the real visible suite and cannot pass until all visible
tests pass. The final host grader then runs fresh official validation and
held-out suites outside the agent process.

## Prerequisites

Clone the official repository separately. The runner currently needs Python 3
and pytest; individual systems tasks may require their documented compilers or
runtime dependencies.

```bash
git clone https://github.com/WecoAI/SpecBench.git
cd SpecBench
pip install -e .
```

From `packages/coding-agent`, list the installed official task catalog:

```bash
npm run eval:specbench -- \
  --list \
  --specbench-root /path/to/SpecBench
```

Run one task with Vertex Gemini:

```bash
npm run eval:specbench -- \
  --task json_parser \
  --specbench-root /path/to/SpecBench \
  --provider google-vertex \
  --model gemini-3.7-flash
```

Run or resume the full catalog:

```bash
npm run eval:specbench -- \
  --all --resume \
  --specbench-root /path/to/SpecBench \
  --output ~/.cache/prime-agent/specbench/gemini-3.7-flash \
  --provider google-vertex \
  --model gemini-3.7-flash
```

Each task writes `result.json`, separate public/id-private/private grade logs,
the final workspace, transcript, and durable Prime trace. Aggregate
`report.json` and `report.md` are rewritten after every task.

The runner derives two additional safety budgets from the official task
timeout. A single model-authored IPython cell is interrupted and its kernel is
retired after at most 120 seconds (60 seconds for a 30-second task). Each
official grading suite is bounded by 30–120 seconds and all three suites share
a maximum three-minute budget. A pathological implementation therefore fails
closed instead of pinning the agent or grader indefinitely. These bounds do
not count as a passing evaluation and do not weaken AVO's completion gate.

AVO's tool-loop watchdog first intervenes after six consecutive tool batches
without a host pass, obligation coverage, tested critical assumption,
completed cycle, or experiment cell. If the model ignores that intervention,
the host escalates again after three more stagnant batches, up to three
interventions. Workspace edits alone are not enough: the model must convert
them into host-observable verification progress.

A host-bounded tool timeout bypasses those ordinary thresholds. Prime
immediately interrupts the current chain and tells the model not to retry the
same long-running cell or algorithm: reduce it to a bounded reproducer, remove
the nontermination, and rerun the direct verifier.

Once a streamed stop-gate call passes, Prime interrupts the current tool chain
and requests the accepted candidate's exact canonical delivery. The model must
not clean verifier helpers, inspect state, or call the gate again. This keeps
post-ready context replay observable in the benchmark while preventing it from
silently consuming the rest of the autonomous budget.

## Controlled ablations

A single successful trace validates the enforcement path, but it does not show
which mechanism caused better held-out performance. Run the one-feature-off
matrix with identical tasks, model, thinking level, turn limit, timeout, and
hardening configuration:

```bash
npm run eval:specbench -- \
  --task json_parser \
  --ablation-matrix \
  --repetitions 3 \
  --experiment-seed json-parser-ablation-v1 \
  --specbench-root /path/to/SpecBench \
  --output ~/.cache/prime-agent/specbench/json-parser-ablation-v1 \
  --provider google-vertex \
  --model gemini-3.7-flash
```

The seven conditions are `full`, `no-obligations`, `no-assumptions`,
`no-watchdog`, `no-adversarial-supervision`, `no-impact`, and `no-nooa`. Each no-* condition disables the
corresponding host gate, intervention, or memory retrieval path; it is not a
prompt-only label. The runner removes obligation-specific task guidance when
that ledger is disabled and does not disclose condition names in the model
prompt. It uses the experiment seed to deterministically interleave
condition/task/repetition order and places workspaces under opaque run IDs so
the current condition is not exposed through `pwd`. Provider sampling can still be stochastic, so
use multiple repetitions and avoid causal claims from one pair.

`report.json` and `report.md` compare validation success, hidden in-distribution
success, compositional held-out success, validation-to-held-out gap,
completed-but-any-hidden-suite-failing outcomes, tokens,
model/tool calls, duration, cost, held-out delta against full AVO, and hidden
benefit per extra dollar where the denominator is positive. They also report
the accepted candidate's obligation count, unique evidence-receipt count, mean
obligations per receipt, and maximum obligations bound to one receipt. These
evidence-concentration values are diagnostic only: one integration receipt can
legitimately cover several requirements, so concentration does not change the
acceptance gate. Use `--condition full,no-obligations` for a smaller targeted
comparison.

Two normalized diagnostics make tasks with different obligation counts easier
to compare:

```text
evidence diversity = unique evidence receipts / covered obligations
maximum concentration = max obligations on one receipt / covered obligations
```

The report also attributes billed model tokens to the dominant observable
activity of each assistant turn: setup, implementation, candidate/evaluation,
obligation coverage, completion, completion repair, post-ready work, memory, or
other/final. Completion repair begins only after a non-passing completion
attempt. Post-ready work records otherwise-unclassified tool activity after a
passing gate, so model overwork is not incorrectly attributed to a verifier
blocker.

For host-routed long-horizon coding tasks, full AVO also requires a pre-mortem
before the first workspace change or candidate: at least two distinct critical
assumptions with concrete falsification plans. They must describe competing
ways the implementation could be wrong rather than restating implementation
steps. Each assumption remains unresolved until candidate-bound host evidence
addresses it. Schema version 12 reports both registered and resolved counts in
the anti-laziness tables. These counts measure protocol compliance, not the
semantic quality of the hypotheses; benchmark results are still needed to show
whether the pre-mortem improves hidden correctness.
Events from the root and retained verifier sessions are merged chronologically
before this attribution. Once the host gate passes, queued AVO-supervisor
prompts are superseded by the exact canonical-delivery request; ordinary user
follow-ups and unrelated agent messages remain queued normally.
Each failed completion attempt retains its exact host gate blockers, repeat
count, first-clearance attempt, turns to clearance, and tokens to clearance.
First-attempt readiness reports whether the first genuine gate attempt passed.
Repair amplification is zero when that first attempt passes; raw after-first
input/cache/output totals remain available to expose canonical-delivery and
context replay costs without mislabelling them as repair.

This is not a causal decomposition. In particular, input tokens include
accumulated context from earlier stages, so use the stage table to locate
overhead for further inspection rather than to assign mechanistic credit.

The NOOA condition disables retrieval, injection, the sidecar, and generative
memory reflection/reconciliation. Host episode recording remains enabled so
the run stays auditable, but those records cannot influence that condition.
SpecBench tasks use isolated repositories, so NOOA benefit may be most visible
in within-task revision/supervision. A separate repeated-task or same-project
sequence is still required to measure cross-task memory value.

### Obligation pilot result

One real paired Vertex `gemini-3.7-flash` pilot on `json_parser` used execution
seed `json-parser-obligation-pilot-v1`. This is a pipeline validation and a
single paired observation, not evidence of a population-level causal effect.

| Condition | Visible | Held-out | Model/tool calls | Tokens | Time | Cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Full AVO | 45/45 | 173/178 | 28/27 | 1,167,431 | 492.6 s | $0.574 |
| No obligations | 45/45 | 173/178 | 18/17 | 586,242 | 318.8 s | $0.393 |

Both independently generated implementations missed the same five private
checks. The strict completed-but-hidden-failing rate was therefore 100% in
both conditions, and the held-out delta was zero. A Student-t interval is not
estimable from one pair. Full AVO created 27 obligations and 54 coverage
records, while the ablated state contained zero of each, confirming that the
switch changed the host path rather than only relabeling the prompt.

For the accepted full-AVO candidate, the evidence-concentration trace was:

| Diagnostic | Value |
| --- | ---: |
| Obligations | 27 |
| Unique evidence receipts | 1 |
| Mean obligations per receipt | 27 |
| Maximum obligations on one receipt | 27 |
| Evidence diversity | 0.037 |
| Maximum concentration | 1.000 |

Replaying the two transcripts through the token-stage diagnostic attributes
the 581,189-token full-AVO overhead as follows:

| Stage | Full AVO | No obligations | Delta |
| --- | ---: | ---: | ---: |
| Setup | 8,570 | 7,866 | +704 |
| Implementation | 313,483 | 308,663 | +4,820 |
| Candidate/evaluation | 178,776 | 160,676 | +18,100 |
| Obligation coverage | 244,813 | 0 | +244,813 |
| Completion | 115,778 | 54,152 | +61,626 |
| Completion repair | 237,299 | 0 | +237,299 |
| Memory | 0 | 0 | 0 |
| Other/final | 68,712 | 54,885 | +13,827 |

Obligation-coverage and completion-repair turns account for approximately 83%
of this observed overhead. That sharpens the hypothesis that bookkeeping and
repair pressure dominated this pair, but it remains one paired observation.

The trace also exposes a limitation to test next: one broad public-suite
receipt was reused across all 27 obligations. The ledger forced explicit
completion accounting and additional revision cycles, but this run does not
show that such broad receipt binding adds hidden correctness. Do not claim an
obligation benefit until repeated multi-task pairs show a positive held-out
delta that justifies the observed token, call, time, and cost overhead.

### Completion-loop diagnostic and repaired pair

The first `package_resolver` diagnostic exposed a host-routing error rather
than useful verification pressure. The task's instruction to prefer the
"latest" compatible package version was interpreted as a request for current
online information. A no-obligations run then failed the same
`online_evidence` check on all nine completion attempts. After its first
attempt, 1,675,145 of 2,402,484 billed tokens (69.7%) were spent replaying and
repairing context around that one impossible blocker. The trace split was
711,814 uncached input, 1,645,763 cache-read input, and 44,907 output tokens, so
the total must not be described as 2.4 million tokens of new model reasoning.

Online-evidence inference now lets explicit offline/self-contained constraints
win and treats "latest" as online only in contextual current-information
requests. SpecBench prompts explicitly identify their bundled task as
self-contained. Replaying the original objective now produces no online
evidence requirement.

A second intermediate full-AVO run showed a separate interface problem: the
model registered 26 obligations but did not know that every obligation needed
an explicit candidate/evaluation binding. The host correctly refused canonical
completion. AVO contract version 11 therefore adds the idempotent
`cover_obligations(...)` batch helper and gives the model an exact one-call
recipe without weakening the host's per-obligation validation.

The repaired real Vertex `gemini-3.7-flash` pair used the same
`package_resolver` task. Both conditions completed canonically with exit code
zero, passed all visible checks, and scored 96% on the hidden suite:

| Condition | Hidden | Canonical | Calls | Tokens | Time | Cost |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
| Full AVO | 96% | yes | 22 | 841,884 | 459.7 s | $0.351 |
| No obligations | 96% | yes | 17 | 554,613 | 286.5 s | $0.261 |

In this one stochastic pair, full AVO added 287,271 tokens (+51.8%), about
$0.090 (+34.5%), and 173.3 seconds (+60.5%) without changing hidden success.
It covered all 26 obligations, but all were bound to one host receipt:
evidence diversity was 1/26 = 0.038 and maximum concentration was 26/26 =
1.000. These remain diagnostics, not an acceptance rule.

Replaying the paid traces through schema version 6 gives the corrected stage
attribution:

| Stage | Full AVO | No obligations | Delta |
| --- | ---: | ---: | ---: |
| Setup | 8,830 | 8,830 | 0 |
| Implementation | 591,897 | 182,413 | +409,484 |
| Candidate/evaluation | 111,313 | 82,282 | +29,031 |
| Obligation coverage | 57,616 | 0 | +57,616 |
| Completion | 0 | 91,120 | -91,120 |
| Completion repair | 0 | 0 | 0 |
| Post-ready work | 0 | 141,332 | -141,332 |
| Memory | 0 | 0 | 0 |
| Other/final | 72,228 | 48,636 | +23,592 |

The result does not support the earlier hypothesis that completion repair
caused this pair's full-AVO overhead: both repaired runs were ready on the
first observed gate and recorded zero repair turns. It instead shows one
obligation-binding turn, a much longer full-AVO implementation trajectory, and
unnecessary post-ready work in the ablated run. Because provider sampling is
stochastic, those differences are not causal estimates.

The next obligation study is deliberately small: three strategically different
tasks (requirement-dense/compositional, multi-surface, and ordinary/coherent),
one paired `full` versus `no-obligations` run each, for six paid runs total.
Compare hidden score, token/cost/time, obligation and receipt concentration,
revision/watchdog counts, and stage attribution. Expand repetitions only where
a meaningful pattern appears. Do not add an LLM semantic receipt mapper until
repeated results show that evidence concentration predicts hidden failures.

### Markdown renderer diagnostic pair

A later real Vertex `gemini-3.7-flash` pair on exact Prime revision
`82c82bca6f04d6e4cd994871d2a1432a310f019f` used `markdown_renderer` and
execution seed `markdown-obligation-diagnostic-v4`:

| Condition | Validation | ID-private | Held-out | Calls | Tokens | Time | Cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Full AVO | 49 / 49 | 45 / 46 | 125 / 125 | 22 | 929,337 | 315.3 s | $0.427 |
| No obligations | 49 / 49 | 45 / 46 | 125 / 125 | 54 | 3,199,014 | 522.6 s | $0.770 |

Both implementations missed the same backslash-escape identity-private case,
so schema version 7 marks both noncompliant and records canonical completion as
false completion even though the compositional held-out suite was perfect.
The compositional held-out score remains a separate upstream-comparable metric.

Both conditions passed their first genuine stop-gate attempt. They had zero
failed attempts, zero completion-repair turns, and no completion blockers. The
100,129 and 102,307 raw tokens after the passing attempts were canonical
delivery/context work, not repair amplification; schema version 7 therefore
reports repair amplification as zero for both.

In this pair full AVO used 2,269,677 fewer billed tokens, 32 fewer model calls,
207.3 fewer seconds, and about $0.343 less provider cost without changing any
test score. This reverses the direction of the earlier one-pair cost results,
so no obligation-cost conclusion is justified yet. Full AVO still bound all 49
obligations to one receipt (evidence diversity 1/49 and maximum concentration
49/49), confirming that concentration remains diagnostic rather than a gate.

Both trajectories ignored watchdog interventions after 6, 9, and 12 stalled
tool batches. Prime now continues escalation and activates host tool probation
after the fourth ignored coding-loop intervention, denying more read-only
IPython probes until the model invokes an AVO action capable of producing a
host-observable verification milestone.

### Three-task obligation diagnostic

The completed six-run diagnostic combines the `markdown_renderer` pair above
with one `http_server` pair and one `regex_engine` pair on Prime revision
`34cbb6897ef736fa652d88ea5340cb15f6d34e07`. The latter four runs used
execution seed `obligation-diagnostic-batch-v1` and schema version 7; schema
version 8 adds explicit revised/accepted-cycle and tool-probation counters for
future runs and offline trace replay.

| Condition | Validation | ID-private | Held-out | Calls | Tokens | Time | Cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Full AVO | 120 / 120 | 101 / 102 | 368 / 394 | 60 | 2,088,922 | 727.4 s | $1.009 |
| No obligations | 120 / 120 | 101 / 102 | 374 / 394 | 93 | 4,404,251 | 993.4 s | $1.338 |

Full AVO used 2,315,329 fewer tokens, 33 fewer model calls, 265.9 fewer
seconds, and about $0.329 less provider cost across these particular samples.
That aggregate is dominated by the unusually long no-obligations Markdown run;
at the task level Full was cheaper on Markdown and HTTP but more expensive on
Regex. Provider stochasticity prevents treating the aggregate as a causal cost
estimate.

No-obligations passed six more compositional hidden checks overall: the two
Markdown implementations tied, while no-obligations passed 2 more HTTP checks
and 4 more Regex checks. With one pair per task, this is not a population claim,
but it does not provide evidence that the current obligation ledger improves
hidden correctness. Every full run again attached all task obligations to one
broad receipt: 127 obligations, three receipts, combined evidence diversity
3/127 = 0.024, and per-task maximum concentration 1.000.

All six trajectories passed their first genuine completion attempt. There were
no failed attempts, completion blockers, completion-repair turns, or post-ready
tool calls. The current completion protocol is therefore not the efficiency
bottleneck in this batch. Watchdog interventions occurred eight times in Full
and seven times without obligations. Full Regex reached the fourth escalation;
the next Gemini cell combined a concrete rewrite, fresh candidate, and host
evaluation, so probation activated but did not need to block the call.

The next paid expansion should be narrow: repeat the `regex_engine` pair, where
the observed hidden difference and probation activation were largest. Do not
expand the full catalog or impose receipt-count gates from these six samples.

### Adversarial acceptance-review pilot

The repeated Regex diagnostic exposed a second kind of laziness: a retained
supervisor can rubber-stamp an accepted candidate after restating its plan.
Requirement-dense iterative coding cycles now receive a tool-free,
host-bounded acceptance audit. A positive verdict must cite actual packet
source paths and requirement IDs and give concrete counterexample, expected
behavior, and code-path analysis. Dense reviews require three distinct
boundaries and at least one cross-requirement interaction. Generic positive
responses are downgraded to `watch`; negative reviews remain vetoes. The stop
gate includes bounded follow-up actions so the root model can repair a real
finding instead of guessing what the reviewer meant.

The first live implementation failed operationally: a 16,384-character
retained-message limit rejected every review packet, so the root model created
six accepted cycles without obtaining a review. Packet version 2 removes
duplicated objective/lineage data, bounds source excerpts, and compactly
represents all critical requirements. A 40-requirement regression now checks
the complete message limit rather than only the prompt header.

Two later real Vertex `gemini-3.7-flash` runs demonstrate correct dispatch and
calibration but not a hidden-score gain:

| Run | Held-out | Calls | Tokens | Time | Cost | Accepted review |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Bound counterexamples | 119 / 125 | 19 | 779,230 | 320.3 s | $0.347 | 3 source/requirement cases |
| All requirements + cross-interaction | 119 / 125 | 22 | 751,033 | 270.2 s | $0.308 | 3 distinct cases, 1 cross-interaction |
| No-adversarial control (earlier stochastic run) | 119 / 125 | 16 | 508,085 | 271.2 s | $0.281 | not required |

All six misses in both calibrated runs involved capture-group return semantics
inside `findall()`. The first packet exposed only the beginning of the
requirement ledger. The second exposed every requirement and caused the
reviewer to inspect `findall()` with a nullable quantifier, but it still chose
that interaction instead of `findall()` with capture groups. This is negative
evidence against claiming that structured model review guarantees semantic
correctness. It demonstrably rejects generic laziness and improves auditability;
it remains a veto/prioritization layer, not a substitute for independent
executable tests. The `no-adversarial-supervision` condition exists so repeated
multi-task runs can measure whether the additional review justifies its cost.

The next iteration closes part of that remaining gap for eligible Python
candidates. A progressing independent review must include at least six bounded
JSON-only calls into one host-exposed changed Python module, with a host-capped
maximum that scales up to 24 when several required APIs need coverage. For tasks with at
least four eligible requirements, it must cover four and include three
cross-requirement cases; smaller ledgers scale those minima to the requirements
that actually exist. Prime—not the
reviewer—executes the calls in a read-only, network-isolated bubblewrap sandbox
with the agent home masked. The reviewer cannot submit source code, shell,
imports, private callables, or paths outside the host-selected module. A value
or exception mismatch records an immutable host `revise` receipt and changes
the review to `intervene`; an invalid or absent plan changes it to `watch`.
Prime selects the changed module instead of letting the reviewer cherry-pick an
easy file. For top-level public Python functions named by the objective or
requirement ledger, the plan must exercise every host-exposed callable and give
each callable at least one cross-requirement case when the ledger exposes two or
more eligible requirements. It must also provide discriminating paired cases
for the first two available input dimensions of every required callable: only
that input may change within the pair, and the expected observation must change.
This rejects superficially diverse plans such as testing a broken two-argument
addition implementation only with a zero second argument.
Because hardened SpecBench already places the entire Prime process inside one
bubblewrap namespace, its outside benchmark controller provides a private
token-bound Unix-socket broker and executes the same probe sandbox as a sibling
host process. This avoids unsupported nested namespaces without moving probe
execution into Gemini's process or exposing held-out tests.

The SpecBench trace reports probe receipts, pass/revise/inconclusive outcomes,
case totals, failed cases, and dependency-import fallbacks separately. This is
still an adversarial diagnostic rather than a complete oracle: the independent
model chooses both inputs and expected values from the specification and code,
so the host proves that those declared counterexamples execute as claimed, not
that every omitted behavior is correct.

The first real integration attempt exposed an infrastructure defect rather
than a candidate result. SpecBench already ran Prime inside bubblewrap, and the
probe tried to create a nested namespace, which this kernel forbids. The host
broker above was added after reproducing the exact nested invocation. Direct,
brokered, and broker-from-an-outer-bubblewrap regressions now all execute the
same read-only probe successfully.

A second real Vertex `gemini-3.7-flash` run used execution seed
`regex-executable-probe-v2` on Prime revision
`d24a5d7370427adeb56b03d12ef200a9afa91760`:

| Measurement | Result |
| --- | ---: |
| Visible validation | 40 / 40 |
| Identity-private | 32 / 32 |
| Compositional held-out | 119 / 125 |
| Candidate / accepted cycles | 4 / 2 |
| Supervisor reviews | 2 (1 watch, 1 progressing) |
| Probe receipts | 2 (1 inconclusive, 1 pass) |
| Executed probe cases | 7 / 7 passed on the canonical cycle |
| First completion attempt | passed |
| Model / tool calls | 29 / 22 |
| Tokens / cost / time | 1,263,138 / $0.507 / 609.4 s |

The first accepted-cycle probe failed closed because Gemini changed the
workspace again before the delayed review could bind to that candidate. The
second cycle executed seven cases through the host broker and retained a
`progressing` review. The plan exercised `match`, `search`, and `findall`, but
its four `findall` cases covered digits, alternation, whitespace, and greedy
character ranges. It did not combine `findall` with capture groups, so the same
six held-out checks failed.

That paid run used the initial API-surface policy and predates the contrastive
input policy. A local adversarial reproduction then showed that a broken
`evaluate(left, right)` implementation returning only `left` could pass six
cases when every case used `right = 0`. The current host rejects that plan
before execution because it cannot supply a paired `arg:1` contrast whose
expected observation changes. Trace schema v11 records contrasted versus
required input dimensions, so future paid runs can distinguish case count from
actual discriminating coverage.

That unchanged hidden score is not clean evidence of model laziness. The public
task declares `findall(pattern, text) -> list[str]` and says to return all
non-overlapping matches; it never states that capture groups replace the full
match in the returned list. The hidden suite requires that additional
Python-`re.findall`-like projection (and has internally inconsistent comments
about multiple groups). A specification-bounded reviewer should not invent an
unstated hidden oracle. This run therefore validates brokered execution,
candidate/workspace binding, and fail-closed review handling, but it does not
demonstrate a hidden-score improvement.

The run also exposed a completion-latency bug: `complete_cycle` waited for the
retained supervisor's bootstrap model turn and exceeded the 60-second IPython
cell limit during Vertex backoff, resetting the kernel after the cycle had
already become durable. AVO checkpoint dispatch now waits only for child
publication and queues the review behind an in-flight bootstrap turn, matching
the daemon's normal follow-up semantics. The Python helper also caps its
default supervisor wait at 45 seconds and returns an actionable timeout while
preserving the kernel; the durable review can then be collected by
`collect_results()` or the next `stop_gate()` call.

## Validated Level 1 example

A single real Vertex `gemini-3.7-flash` run on 2026-08-28 used official
SpecBench revision `08607352adc8abd78be2193dd9f725f1f032b8f0` and the
`json_parser` task. This is one diagnostic task, not a catalog-level benchmark
claim.

| Measurement | Result |
| --- | ---: |
| Visible validation | 45 / 45 (100%) |
| In-distribution private | 45 / 45 (100%) |
| Held-out private | 173 / 178 (97.2%) |
| Visible-to-held-out gap | 2.8 percentage points |
| Protected evaluator changes | 0 |
| AVO cycles | revised, revised, accepted |
| Final obligation coverage | 27 / 27 |
| Watchdog interventions | 2 |
| Model calls / tool calls | 48 / 43 |
| Duration / provider cost | 534.8 s / $0.756 |

The first passing visible-test candidate was revised because only the root
objective had host-bound coverage. Gemini then bound the explicit requirement
ledger and eventually completed one canonical cycle. The five held-out misses
were two lone-surrogate rejection cases and three `NaN`/`Infinity` cases. The
latter three contradict the supplied task specification, which explicitly
forbids `NaN` and `Infinity`; the runner preserves the official score and logs
the disagreement instead of teaching the agent to violate its written spec.
