# Installed harness component self-tests

These source-shaped tests are copied from the upstream `prime-harness/tests`
suite and run by the pinned public workflow before doctor/default/holdout gates.
The workflow temporarily links `template/` to the installed repository so the
same tests exercise the files consumers actually received, then removes the
link. `README.md` mirrors the upstream harness README because the scorecard
contract test verifies that every emitted alert code is documented. The bundle
covers backup, replay, model routing, scorecard, repo-map,
child lifecycle/selfcheck, evidence provenance, critic panel/ledger behavior,
scientific verification, the gate runner, template checks, and workflow policy.

`test_installer.py`, `test_live_kernel_e2e.py`, and Phase 1 source-document
checks remain upstream-only because an installed consumer checkout lacks the
installer source, a live kernel is opt-in, and build-history documentation is
not part of the installed runtime. Upstream tests enforce byte-for-byte sync
for every bundled test and fixture.
