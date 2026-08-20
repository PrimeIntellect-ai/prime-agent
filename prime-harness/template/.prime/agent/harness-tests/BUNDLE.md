# Installed harness component self-tests

These source-shaped tests are copied from the upstream `prime-harness/tests`
suite and run by the pinned public workflow before doctor/default/holdout gates.
The shared `tests/conftest.py` creates `template/` as a directory symlink or,
on Windows without symlink rights, a junction to the installed repository root;
pytest removes only that link during unconfigure. In installed layouts it
refuses any pre-existing `template/` path that does not resolve to the consumer
root, preventing shadow-tree test redirection. No shell `ln` or elevated Windows
privilege is required. `docs/alert-codes.md` mirrors the small upstream runtime-contract doc so
alert and panel-verdict assertions stay valid without shipping environment-
specific upstream installation and routing content. The bundle covers backup,
replay, model routing, scorecard, repo-map,
child lifecycle/selfcheck, evidence provenance, critic panel/ledger behavior,
scientific verification, and the gate runner.

`test_installer.py`, `tests/test_live_kernel_e2e.py`,
`test_source_reviewability.py`, `test_standalone.py`, `test_template_checks.py`, `test_workflow.py`,
and Phase 1 source-document checks remain upstream-only.
The exact template-check and workflow tests intentionally are not installed
because those files are consumer customization contracts; freezing upstream
defaults would make legitimate customization fail the mandatory self-test step.
`test_workflow_policy.py` remains installed and enforces immutable security
properties (read-only permissions, full-SHA action pins, no secrets, full
history, and selftests-before-doctor-before-gate ordering) without freezing
custom gate commands. The
other exclusions need installer/standalone source, a live kernel, or upstream build-history
documentation. Upstream tests enforce byte-for-byte sync for every bundled test
and fixture that remains consumer-safe.
