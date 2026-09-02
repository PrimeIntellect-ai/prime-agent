# AVO Architectural Separation: Paper Core vs. Prime Extensions

This document establishes the formal architectural separation between the **Paper-Faithful AVO Core** ([arXiv:2603.24517](https://arxiv.org/abs/2603.24517)) and **Prime Host Governance Extensions**.

---

## 1. Feature Matrix

| Feature | Paper AVO Core (`arXiv:2603.24517`) | Prime Host Governance Extensions | Notes / Issue Reference |
|---|---|---|---|
| **System Role** | Variation operator $\text{Vary}(P_t) = \text{Agent}(P_t, K, f)$ | Universal operating architecture for every root task | [#48](https://github.com/lewbei/prime-agent/issues/48) |
| **Lineage ($P_t$)** | Committed solution-score pairs $P_t = \{(x_i, f(x_i))\}$ | Internal `AvoStore` candidates and SQLite ledger | [#48](https://github.com/lewbei/prime-agent/issues/48), [#50](https://github.com/lewbei/prime-agent/issues/50) |
| **Working Trajectory** | Internal conversational action history (edits, repairs, failed runs) | Persisted parent-child candidate chain in AVO store | [#50](https://github.com/lewbei/prime-agent/issues/50) |
| **Commit Rule** | Pass correctness gate AND match/improve baseline score | `complete_cycle` derived from host receipt outcome | [#50](https://github.com/lewbei/prime-agent/issues/50) |
| **Knowledge Base ($K$)** | Explicit, addressable catalog of guides, specs, and reference code | Optional reference files | [#51](https://github.com/lewbei/prime-agent/issues/51) |
| **Memory Subsystem** | Conversational history within the variation episode | NVIDIA NOOA 0.0.9 (episodic, reflection, semantic recall) | [#53](https://github.com/lewbei/prime-agent/issues/53) |
| **Scoring Utility ($f$)** | Fixed, immutable scoring handle returning vector + correctness | Shell commands passed to `run_evaluation` on each turn | [#52](https://github.com/lewbei/prime-agent/issues/52) |
| **Action Sequencing** | Open-ended agent trajectory (plan, inspect, edit, eval, repair) | Prescribed `candidate -> eval -> cycle -> stop_gate` pipeline | [#49](https://github.com/lewbei/prime-agent/issues/49) |
| **Supervisor Role** | Conditional intervention on detected stagnation | Mandatory on long horizon; post-acceptance adversarial audit | [#54](https://github.com/lewbei/prime-agent/issues/54) |
| **Host Watchdog** | Bounded budget enforcement (max evals / time) | Turn-by-turn API enforcement, probation, delivery watch | [#49](https://github.com/lewbei/prime-agent/issues/49), [#54](https://github.com/lewbei/prime-agent/issues/54) |
| **Obligation Ledgers** | Not part of paper core | Host-derived requirement decomposition & receipt binding | [#53](https://github.com/lewbei/prime-agent/issues/53) |
| **Canonical Delivery** | Outer caller responsibility (not part of variation) | `beginCanonicalDelivery` / `completeCanonicalDelivery` gate | [#48](https://github.com/lewbei/prime-agent/issues/48), [#53](https://github.com/lewbei/prime-agent/issues/53) |

---

## 2. Paper Core Boundary Specification

### Mathematical Interface
$$\text{Vary}(P_t) = \text{Agent}(P_t, K, f)$$

Outer Loop:
$$P_{t+1} = \text{Update}(P_t, (x_{t+1}, f(x_{t+1})))$$

### Inputs (`AvoVariationContract`)
* `lineage`: $P_t$, addressable catalog of committed solution-score pairs.
* `knowledge`: $K$, addressable catalog of domain documentation, specifications, and reference implementations.
* `scorer`: $f$, immutable evaluation handle providing correctness gates and named score dimensions.
* `taskContext`: Problem description and optimization objectives.
* `budget`: Bounded execution permissions (e.g. `maxEvaluations`, `maxWallClockSeconds`).

### Outputs (`AvoVariationResult`)
* `status`: `"committed" | "uncommitted_exhausted" | "budget_exceeded"`.
* `candidateSolution`: $x_{t+1}$ with verified score vector $f(x_{t+1})$ (only present if committed).
* `trajectory`: Audit trail of actions chosen by the agent (`inspect_lineage`, `inspect_knowledge`, `edit`, `evaluate`, `diagnose`, `repair`).
* `sampledLineageIds`: References to prior solutions deliberately consulted.
* `sampledKnowledgeIds`: References to domain knowledge items consulted.

---

## 3. Telemetry & Versioning

* **Paper Core Version:** `avo_paper_core_v1`
* **Extensions Identifier:** `enabledExtensions: string[]` (`"nooa_memory"`, `"obligations"`, `"canonical_delivery"`, `"adversarial_supervision"`)
