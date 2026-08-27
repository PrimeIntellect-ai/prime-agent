# Python-Backed Skills

A Python-backed skill is a regular markdown skill that also ships a Python package. Prime Agent installs the package editable into the kernel venv (`~/.prime/agent/kernel-venv` by default, `PRIME_AGENT_KERNEL_VENV` to override) and exposes it in the persistent Python kernel, so the agent can call it directly instead of shelling out.

## Detection Contract

All of these must hold or the skill silently degrades to a markdown-only skill (with a load warning):

- `SKILL.md` exists as usual.
- `pyproject.toml` exists at the skill root — its presence is what marks the skill as Python-backed.
- The import name is the skill name with hyphens converted to underscores, and it must be a valid Python identifier.
- `src/<import_name>/__init__.py` exists (src layout, exact directory name).

For a skill named `word-count`, the kernel exposes `word_count`.

## Minimal Template

```
word-count/
├── SKILL.md
├── pyproject.toml
└── src/
    └── word_count/
        └── __init__.py
```

**`SKILL.md`**

```markdown
---
name: word-count
description: Count word frequencies in text and return the most common words. Use when the user asks for word counts or frequency analysis of a text snippet.
---

# Word Count

Call directly from the kernel:

    await word_count("some text to analyze", top=3)

Or from a shell cell:

    !word_count "some text to analyze" --top 3
```

**`pyproject.toml`**

```toml
[project]
name = "word-count"
version = "0.1.0"
requires-python = ">=3.10"
dependencies = []

[project.scripts]
word_count = "rlm.skill:cli"

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["src/word_count"]
```

**`src/word_count/__init__.py`**

```python
from collections import Counter


async def run(text: str, top: int = 5) -> str:
    """Count words in text and return the most common ones."""
    counts = Counter(text.lower().split())
    return "\n".join(f"{word}: {count}" for word, count in counts.most_common(top))
```

The `[tool.hatch.build.targets.wheel]` section is required with hatchling whenever the project name differs from the package directory name (it always does for hyphenated skill names).

## The run() Convention

If `src/<import_name>/__init__.py` defines `run()`, the kernel wraps the module so the module itself is an async callable:

```python
await word_count("text")        # same as word_count.run("text")
await word_count.run("text")
help(word_count)                # shows run()'s docstring and signature
```

- `run()` may be sync or async; the wrapper awaits awaitable results.
- The signature and docstring of `run()` are copied onto the module, so write a real docstring and typed keyword arguments with defaults — they are the skill's API documentation *and* its CLI.
- Without `run()`, the module is still imported and exposed by name, just not callable.
- Import failures do not break the kernel: the name is bound to a placeholder that raises a `RuntimeError` containing the import error when called.

## Optional CLI Command

The `[project.scripts]` entry pointing at `rlm.skill:cli` gives the skill a shell command. Rules:

- The script name must **exactly** match the Python import name, underscores included (`word_count`, not `word-count`).
- `rlm.skill:cli` imports `<script_name>.run` and parses argv against its signature with `tyro`, awaits async results, and prints non-`None` return values.
- `rlm` and `tyro` are already present in the kernel venv. Do **not** declare `prime-agent-runtime` as a dependency: it is bundled with Prime Agent, not published on PyPI, so declaring it breaks installs outside the kernel venv. The CLI entry point only works where the runtime is installed, i.e. inside the kernel venv.

The agent can then use either form:

```python
await word_count("prime agent", top=3)
```

```bash
!word_count "prime agent" --top 3
```

Omit `[project.scripts]` when a CLI is not needed.

## Dependencies and the Kernel Venv

- Declare every third-party package `run()` imports in `dependencies` — `pyproject.toml` is the source of truth. The one exception is `prime-agent-runtime` (see above).
- These are already in the kernel venv, so depending on them is free: `requests`, `httpx`, `pyyaml`, `tomli`, `python-dotenv`, `pandas`, `numpy`, `scipy`, `beautifulsoup4`, `lxml`, `pydantic`, `tyro`.
- The install is editable and keyed on a hash of `pyproject.toml`: editing Python source takes effect on the next kernel start with no reinstall; editing `pyproject.toml` triggers a reinstall automatically.
- If the user sets `PRIME_AGENT_KERNEL_PYTHON`, Prime Agent installs nothing — skills whose imports are missing there are disabled with a warning.

A Python skill runs inside the agent's kernel, so it can itself spawn recursive sub-agents with `import rlm` and `await rlm.run("subtask")` — useful for skills that delegate open-ended work.

## Verifying a Python Skill

1. Check the contract: skill name maps to a valid identifier, `src/<import_name>/__init__.py` exists, hatchling wheel packages list matches.
2. Test `run()` standalone from the skill directory, without the kernel:

   ```bash
   cd <skill-dir> && uv run python -c "import asyncio, word_count; print(asyncio.run(word_count.run('a b a', top=1)))"
   ```

3. In a fresh agent session (the kernel installs skills at startup), confirm `help(<import_name>)` shows the docstring and `await <import_name>(...)` works. If it raises `RuntimeError`, the message contains the underlying import error.
