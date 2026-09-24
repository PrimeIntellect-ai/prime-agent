# CI workflows (staged)

The GitHub Actions workflows for this repo live here, byte-identical to their
final form, because the dev box's GitHub token has no `workflow` scope and
cannot push anything under `.github/workflows/` (see
docs/installer-ci-design.md §3 and PR #76 for the same constraint).

Promotion state (2026-09-23):

- LIVE under `.github/workflows/`: `continuous.yml` + `release.yml` (the
  `make activate-workflows` step below), and `ci.yml` — the fmt +
  clippy-test gate set, PR gating on every pull_request against main/rust
  plus the tip gates: the same checks run on every push to main/rust, so
  the tip always compiles its test targets and passes the test suites.
- STAGED here, waiting for readiness: this `ci.yml` holds the
  windows-cross / windows / deny jobs (promote the windows gates when
  windows-readiness lands and windows-cross is validated green at the tip;
  deny needs an owner policy decision — the advisory DB drifts daily);
  `benchmark.yml` needs the self-hosted `prime-sandbox` runner labels.

Local gates mirror every workflow step today:

    make check            # fmt + clippy + test + release build (live ci.yml fmt/clippy-test jobs + the continuous build)
    make deny             # cargo-deny advisories + licenses (staged ci.yml deny job)
    make windows-cross    # cfg-hygiene: cross-target check + clippy -D warnings (staged ci.yml windows-cross job)
    make actionlint       # validates the live + staged workflow files
    make perf-wave        # the TS-vs-Rust perf wave + regression gate (benchmark.yml)
    make release-dry-run  # local mirror of the release build-job gates (release.yml)
    make continuous-dry-run  # continuous.yml build job: commit-stamped tarball + livecheck

The `windows` job runs on a real `windows-latest` runner (portable tests plus
the Windows-only platform tests); it has no local mirror - the sandbox is
Linux-only.

## Promotion (needs a machine whose push credential has `workflow` scope)

`continuous.yml` + `release.yml` went live through the operator step:

    make activate-workflows

which ran, on `main`:

    git mv ci/workflows/continuous.yml ci/workflows/release.yml .github/workflows/
    git commit -m "ci: activate the continuous + release workflows (.github/workflows/)"
    git push origin main

`ci.yml`'s fmt + clippy-test jobs were promoted the same way (they now live
at `.github/workflows/ci.yml`; what remains staged here is the windows/deny
remainder). To promote the remaining staged set later, run by hand on a
workflow-scoped clone: merge the windows-cross/windows/deny jobs of
`ci/workflows/ci.yml` into `.github/workflows/ci.yml`, and move
`benchmark.yml` whole:

    git mv ci/workflows/benchmark.yml .github/workflows/

Run either from a clone whose push credential has the `workflow` scope
(Kevin's Mac qualifies; the dev box does not — pushes under
`.github/workflows/` are remote-rejected). Alternative without any scoped
token: create each file via the GitHub web UI (web editor) pasting the staged
content — the web UI bypasses the scope check. Nothing changes content-wise;
the files are inert until Actions is enabled anyway.

## continuous.yml — prebuilt binaries as workflow artifacts

`continuous.yml` (live) builds the 4-target release matrix on every push to
`main` and `rust` and uploads the tarballs as workflow artifacts, downloadable
from the run page. It deliberately does NOT create tags or releases — the org
repo's release history stays owned by `release.yml`. The live `ci.yml` runs
alongside it on the same pushes: continuous.yml proves the release binaries
link, ci.yml proves the tip's test targets compile and its tests pass.
