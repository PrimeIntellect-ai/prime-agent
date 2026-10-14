#!/usr/bin/env bash
# Hosted-only: keep the new integration test while restoring the pre-fix census.
set -euo pipefail
if [[ "${CI:-}" != true ]]; then
  echo 'Run this regression check in hosted CI, not on the local Mac.' >&2
  exit 2
fi
baseline="${1:-5f8ad0c85}"
source_file=crates/pa-cli/src/daemon_discovery/mod.rs
test_name=a_pinned_root_with_an_overlapping_agent_dir_never_stops_foreign_workers
receipt_dir="${RUNNER_TEMP:-/tmp}/shutdown-scope-review-regression"
mkdir -p "$receipt_dir"
backup_dir="$(mktemp -d)"
cp "$source_file" "$backup_dir/mod.rs"
restore_source() {
  cp "$backup_dir/mod.rs" "$source_file"
}
trap 'restore_source; rm -rf "$backup_dir"' EXIT
# The baseline and fixed source differ only in worker-directory filtering and
# its comments. The new test file stays untouched throughout the mutation.
git show "$baseline:$source_file" > "$source_file"
if cargo test --locked -p pa-cli --test daemon_discovery_e2e "$test_name" -- --exact > "$receipt_dir/red.log" 2>&1; then
  echo "Regression did not fail before the fix: $test_name" >&2
  exit 1
fi
# Compilation failures or zero selected tests do not prove the defect.
if ! rg -F "test $test_name ... FAILED" "$receipt_dir/red.log"; then
  cat "$receipt_dir/red.log" >&2
  exit 1
fi
restore_source
cargo test --locked -p pa-cli --test daemon_discovery_e2e "$test_name" -- --exact > "$receipt_dir/green.log" 2>&1
rg -F "test $test_name ... ok" "$receipt_dir/green.log"
cat "$receipt_dir/green.log"
