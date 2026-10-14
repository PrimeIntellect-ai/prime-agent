#!/usr/bin/env bash
# Hosted red/green proof: retain the production test and restore only edge_is_live.
set -euo pipefail
if [[ "${CI:-}" != true ]]; then
  echo 'Run this regression check in hosted CI, not on the local Mac.' >&2
  exit 2
fi
baseline="${1:-926ec7ef38924342737896069c795b3fe59edeb2}"
source_file='crates/pa-daemon/src/rlm_ledger.rs'
test_name='rlm_ledger::tests::edge_is_live_revalidates_paths_without_a_ledger_append'
receipt_dir="${RUNNER_TEMP:-/tmp}/ledger-review-regression"
mkdir -p "$receipt_dir"
backup_dir="$(mktemp -d)"
cp "$source_file" "$backup_dir/fixed.rs"
restore_source() {
  cp "$backup_dir/fixed.rs" "$source_file"
}
trap 'restore_source; rm -rf "$backup_dir"' EXIT
# Fetch the exact historical source for this PR-only hosted proof; checkout is shallow.
git fetch --no-tags --depth=1 origin "$baseline"
# Reject a missing baseline before touching production source.
git show "$baseline:$source_file" > "$backup_dir/baseline.rs"
python3 - "$source_file" "$backup_dir/baseline.rs" <<'PY'
from pathlib import Path
import sys
source, baseline = map(Path, sys.argv[1:])
start = '    pub fn edge_is_live('
end = '\n    fn seed_once('
current, original = source.read_text(), baseline.read_text()
assert current.count(start) == original.count(start) == 1
left, right = current.index(start), current.index(end, current.index(start))
old_left, old_right = original.index(start), original.index(end, original.index(start))
assert current[left:right] != original[old_left:old_right], 'baseline is already fixed'
source.write_text(current[:left] + original[old_left:old_right] + current[right:])
PY
if cargo test --locked -p pa-daemon --lib "$test_name" -- --exact > "$receipt_dir/red.log" 2>&1; then
  echo "Regression did not fail before the fix: $test_name" >&2
  exit 1
fi
# A compiler or infrastructure failure is not behavioral red-first evidence.
if ! rg -F "test $test_name ... FAILED" "$receipt_dir/red.log"; then
  cat "$receipt_dir/red.log" >&2
  exit 1
fi
restore_source
cargo test --locked -p pa-daemon --lib "$test_name" -- --exact > "$receipt_dir/green.log" 2>&1
if ! rg -F "test $test_name ... ok" "$receipt_dir/green.log"; then
  cat "$receipt_dir/green.log" >&2
  exit 1
fi
cmp "$backup_dir/fixed.rs" "$source_file"
cat "$receipt_dir/green.log"
