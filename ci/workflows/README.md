# CI workflows (staged)

The GitHub Actions workflows for this repo live here, byte-identical to their
final form, because the dev box's GitHub token has no `workflow` scope and
cannot push anything under `.github/workflows/` (see
docs/installer-ci-design.md §3 and PR #76 for the same constraint). 

Local gates mirror every workflow step today:

    make check            # fmt + clippy + test + release build (ci.yml fmt/clippy-test jobs)
    make deny             # cargo-deny advisories + licenses (ci.yml deny job)
    make windows-cross    # cfg-hygiene: cross-target check + clippy -D warnings (ci.yml windows-cross job)
    make actionlint       # validates the staged workflow files
    make perf-wave        # the TS-vs-Rust perf wave + regression gate (benchmark.yml)
    make release-dry-run  # local mirror of the release build-job gates (release.yml)
    make continuous-dry-run  # continuous.yml build job: commit-stamped tarball + livecheck

The `windows` job runs on a real `windows-latest` runner (portable tests plus
the Windows-only platform tests); it has no local mirror - the sandbox is
Linux-only.

## Promotion (needs a machine whose push credential has `workflow` scope)

`continuous.yml` + `release.yml` in one operator step:

    make activate-workflows

which runs, on `main`:

    git mv ci/workflows/continuous.yml ci/workflows/release.yml .github/workflows/
    git commit -m "ci: activate the continuous + release workflows (.github/workflows/)"
    git push origin main

To promote the whole staged set at once instead (adds `benchmark.yml`, and
`ci.yml` — which turns on repo-wide PR CI, an operator decision), run the
classical sequence by hand on `main`:

    git mv ci/workflows/ci.yml ci/workflows/release.yml ci/workflows/benchmark.yml .github/workflows/
    git rm ci/workflows/README.md

Run either from a clone whose push credential has the `workflow` scope
(Kevin's Mac qualifies; the dev box does not — pushes under
`.github/workflows/` are remote-rejected). Alternative without any scoped
token: create each file via the GitHub web UI (web editor) pasting the staged
content — the web UI bypasses the scope check. Nothing changes content-wise;
the files are inert until Actions is enabled anyway.

## continuous.yml — rolling prebuilt binaries for coworkers

`continuous.yml` builds the 4-target release matrix on every push to `main`
and republishes it to the ROLLING GitHub release tagged `continuous`:
artifacts are overwritten per push, so the stable URLs always serve the
latest build (`releases/download/continuous/prime-agent-<version>-<target>.tar.gz`).
The publish job moves the `continuous` tag to the triggering commit, states
"Built from <sha> — <subject>" in the release body, and stamps the commit into
the binary: the tarball carries a `package.json` manifest and `prime-agent
--version` reports `<version>-continuous.<sha>`. It needs no secrets beyond
the job token (`contents: write` on the publish job only). Install steps for
coworkers are in the top-level README.md ("Continuous builds"). Verify after
promotion: `gh workflow list --repo PrimeIntellect-ai/prime-agent` shows
`continuous` and `release` active; the next push to `main` publishes the
first `continuous` release.
