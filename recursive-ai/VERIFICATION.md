# Verification record

Local checks on 2026-09-08:

- `python3 -m unittest tests.test_lab tests.test_docker -v`: 16 controller tests passed; 3 Docker integration tests skipped because Docker is unavailable.
- `npm run check`: passed (Biome, TypeScript, installer rendering, browser smoke checks). Used npm 11.10.0 to support the repository minimum-release-age configuration; dependencies were installed from the existing lockfile without changing it.
- Static policy rejection, each gate failing closed, invalid protocol outputs, actual isolation-probe limits, Git checkpoint preservation, SQLite activation atomicity, and zero gain for repeated success are covered by controller tests.
- No generated candidate code was executed on the host. Controller tests use an explicitly fake runner; their synthetic promotion telemetry is not evidence of real candidate success.
- The optional model API adapter has not been exercised against a live model.

The branch includes `.github/workflows/recursive-ai.yml` to build the Docker image, run all integration tests, and verify an actual ten-gate promotion. Remote execution results must be checked separately; adding the workflow does not establish that it ran or passed.
