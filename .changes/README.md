# Changelog fragments

A PR that changes what the release ships adds a fragment here or carries the `no-changelog` label
(enforced by `.github/workflows/changelog-fragment.yml`, which lists the shipped paths).

- One file per PR, directly in this directory: `.changes/<branch-slug>.md`.
- Content: one user-facing bullet, e.g. `- Fixed the frobnicator dropping input on resize.`
- `release-prepare` folds the fragments into `CHANGELOG.md` and deletes them
  (`scripts/release/fold_changelog.py`). This README is never folded.
