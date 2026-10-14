#!/usr/bin/env bash
# Hosted-only red/green check: retain the new tests while restoring pre-fix production files.
set -euo pipefail
if [[ "${CI:-}" != true ]]; then
  echo 'Run this regression check in hosted CI, not on the local Mac.' >&2
  exit 2
fi
baseline="${1:-3bad9c537ad0fd6466a47d6bf8aef64b71ba7bc3}"
if ! git cat-file -e "$baseline^{commit}"; then
  git fetch --no-tags --depth=1 origin "$baseline"
fi
receipt_dir="${RUNNER_TEMP:-/tmp}/markdown-review-regressions"
mkdir -p "$receipt_dir"
backup_dir="$(mktemp -d)"
source_files=(crates/pa-tui/src/markdown.rs crates/pa-tui/src/markdown/inline.rs)
for index in "${!source_files[@]}"; do
  cp "${source_files[index]}" "$backup_dir/$index"
done
restore_sources() {
  for index in "${!source_files[@]}"; do
    cp "$backup_dir/$index" "${source_files[index]}"
  done
}
trap 'restore_sources; rm -rf "$backup_dir"' EXIT
for source_file in "${source_files[@]}"; do
  git show "$baseline:$source_file" > "$source_file"
done
cases=(review_markdown_adjacent_emphasis_keeps_the_next_opener review_markdown_link_titles_skip_escaped_quotes review_markdown_deep_lists_keep_text_with_a_bounded_tree)
for case_name in "${cases[@]}"; do
  test_name="markdown::tests::$case_name"
  if cargo test -p pa-tui --lib "$test_name" -- --exact > "$receipt_dir/$case_name-red.log" 2>&1; then
    echo "Regression did not fail before the fix: $test_name" >&2
    exit 1
  fi
  # Compilation/infrastructure errors are not a red-first behavioral proof.
  if ! rg -F "test $test_name ... FAILED" "$receipt_dir/$case_name-red.log"; then
    cat "$receipt_dir/$case_name-red.log" >&2
    exit 1
  fi
done
restore_sources
cargo test -p pa-tui --lib review_markdown_ > "$receipt_dir/green.log" 2>&1
cat "$receipt_dir/green.log"
