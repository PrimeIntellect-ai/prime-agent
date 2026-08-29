---
"@earendil-works/pi-coding-agent": minor
---

Bound model-authored IPython cells and SpecBench grading, retire timed-out
kernels, and repeatedly escalate AVO tool-loop stagnation when a model ignores
the first anti-laziness intervention. A host-bounded tool timeout now interrupts
the chain immediately with a targeted nontermination-repair instruction instead
of waiting for the next ordinary stagnation threshold. Once a streamed stop
gate passes, Prime also interrupts post-ready tool use and requests the exact
canonical delivery immediately.
