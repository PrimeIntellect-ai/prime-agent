---
description: Run the independent cross-harness audit on the current branch and triage findings
argument-hint: [focus area...]
---

Run the external critic over the current branch and triage rigorously.

1. Run `r = external_critic.review()` — or, if a focus was given above, pass
   it: `external_critic.review("Focus on: $ARGUMENTS")`. If it returns
   `status="error"`, fix the cause (missing CLI, unparseable output) rather
   than skipping the audit; the raw output path is in the result.
2. `evidence_ledger.ingest(r["findings_path"])` to record the audit (guard
   with `r.get("findings_path")` — error results carry no findings file).
3. For EVERY finding of severity critical or major:
   - write the proposed falsification test (or an equivalent `sci_verify`
     check) and run it;
   - if it exposes a real defect: fix it, re-run the gate, and record the fix;
   - if it does not: record a rebuttal in the ledger
     (`record(claim, status="refuted", verifier="<the test>", ...)`).
4. Minor/info findings: fix cheaply or add to `task_state.next_actions`.
5. Report a summary table: finding → verdict (fixed / rebutted / deferred) →
   evidence id. An audit with unresolved criticals blocks goal completion.
