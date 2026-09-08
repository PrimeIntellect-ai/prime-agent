"""Versioned public specification: return FIRST matching index, else -1."""
TASK_ID = "binary_search"
ENTRYPOINT = "binary_search"
SPEC = "Implement binary_search(values, target) for sorted integer lists. Return the FIRST matching index or -1. Do not mutate inputs. Use O(log n) time and O(1) auxiliary space. Only pure functions; no imports, attributes, annotations or default arguments."
PUBLIC = [([], 1), ([1], 1), ([1], 2), ([1, 2, 2, 3], 2), ([-5, -1, 0], -1)]
WEIGHTS = {TASK_ID: 1.0}
