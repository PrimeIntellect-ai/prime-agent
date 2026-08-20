---
name: repo-map
description: Read-only Git-indexed repository reconnaissance. It parses Python AST and TypeScript/JavaScript lexical declarations, builds scope/import-aware reference and containment edges, ranks symbols with deterministic personalized PageRank, and returns declaration-only text under a conservative UTF-8-byte token upper bound. It never emits source snippets, literals, comments, raw queries, absolute paths, ignored files, symlinks, or reparse targets. Use `await repo_map(query="...", root="...", token_budget=4096)` before broad codebase reads.
---

# repo-map

Use the default callable for a hard-bounded navigation map:

```python
text = await repo_map(
    query="agent session retry lifecycle",
    root="C:/path/to/repository",
    token_budget=4096,
)
print(text)
```

The default `run(..., format="text")` returns only the canonical map, and its
complete UTF-8 byte length is no greater than `token_budget`. One byte is
charged as one provider-independent upper-bound unit; this intentionally
overestimates typical model tokenizers. Structured metadata is available only
with `format="json"`; its `budget.map_budget_only=true` field makes clear that
the JSON envelope is outside the map budget.

## Boundaries and trust

- The root must be a real, non-link Git top level. Inventory comes from
  `git ls-files --stage` plus non-ignored untracked files (or tracked-only
  scope), never recursive filesystem guessing. Git symlinks/gitlinks,
  filesystem links/reparse points, ignored/vendor/build/artifact paths,
  common credential filenames, generated/minified files, binaries, and
  oversized files are not opened.
- Files are opened read-only with final-link denial where supported and
  lstat/fstat identity checks. Target modules are never imported or executed;
  no target cache, artifact, or output file is written.
- Output contains only escaped relative path, declaration identifier/location,
  parser/confidence, deterministic score, graph distance, and ranking reason.
  Source snippets, comments, docstrings, literals/defaults, raw query text,
  and absolute checkout paths are never rendered.
- Python uses AST lexical bindings and explicit imports. TypeScript/JavaScript
  uses a deterministic lexer that skips comments, strings, templates, and
  regular-expression bodies; its declarations are marked conservative.
  Other languages are not claimed as symbol-parsed in v1.
- Case-sensitive identifiers, lexical shadows, explicit relative imports, and
  unambiguous same-file definitions drive edges. Ambiguity creates no edge;
  there is no repo-wide first-name fallback.
- Parse/identity/query misses return `status="partial"` with stable warning
  codes. Hard file/byte/node/edge limits raise rather than silently selecting
  an arbitrary prefix. Rankings are navigation hints, never correctness or
  scientific evidence; inspect selected source directly.

CLI (use `-B` to suppress import-time bytecode beside the installed skill):

```bash
python -B -m repo_map C:/path/to/repo   --query "session retry" --token-budget 4096 --tracked-only
python -B -m repo_map C:/path/to/repo   --query "session retry" --token-budget 4096 --json
```
