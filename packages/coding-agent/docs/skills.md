> Prime Agent can create skills. Ask it to build one for your use case.

# Skills

Skills are self-contained capability packages that Prime Agent loads on demand. A skill provides specialized workflows, setup instructions, helper scripts, and reference documentation for specific tasks.

Prime Agent implements the [Agent Skills standard](https://agentskills.io/specification), warning about violations but remaining lenient. It also supports Python-backed skills: a superset of markdown skills that install Python packages into the persistent Python kernel.

## Table of Contents

- [Locations](#locations)
- [Built-in Skills](#built-in-skills)
- [How Skills Work](#how-skills-work)
- [Python-Backed Skills](#python-backed-skills)
- [Creating Skills with Prime Agent](#creating-skills-with-prime-agent)
- [Skill Commands](#skill-commands)
- [Skill Structure](#skill-structure)
- [Frontmatter](#frontmatter)
- [Validation](#validation)
- [Example](#example)
- [Skill Repositories](#skill-repositories)

## Locations

> **Security:** Skills can instruct the model to perform any action and may include executable code the model invokes. Review skill content before use.

Prime Agent loads skills from:

- Global:
  - `~/.prime/agent/skills/`
  - `~/.agents/skills/`
- Project:
  - `.prime/agent/skills/`
  - `.agents/skills/` in `cwd` and ancestor directories (up to git repo root, or filesystem root when not in a repo)
- Packages: `skills/` directories or `pi.skills` entries in `package.json`
- Settings: `skills` array with files or directories
- CLI: `--skill <path>` (repeatable, additive even with `--no-skills`)
- Built-in: `skills/` shipped with the prime-agent package (lowest precedence)

Discovery rules:
- In `~/.prime/agent/skills/` and `.prime/agent/skills/`, direct root `.md` files are discovered as individual skills
- In all skill locations, directories containing `SKILL.md` are discovered recursively
- In `~/.agents/skills/` and project `.agents/skills/`, root `.md` files are ignored

Disable discovery with `--no-skills` (explicit `--skill` paths still load).

## Built-in Skills

Prime Agent ships with built-in skills that load by default:

- `prime-intellect` - Prime Intellect products and workflows via the prime CLI: verifiers environments and the Environments Hub, evaluations (local and hosted), Hosted Training and prime-rl, sandboxes, tunnels, Prime Inference, GPU compute, and storage. Reference docs for each area load on demand from the skill's `references/` directory.
- `skill-creator` - teaches the agent to create new skills: markdown skill layout, frontmatter rules, placement and precedence, and the full Python-backed skill contract (package layout, `run()` convention, optional CLI, kernel venv behavior) with a working template in `references/python-skills.md`.
- `websearch` - a Python-backed Google search skill using the [Serper](https://serper.dev) API.

Built-in skills behave like any other skill but have the lowest precedence: a user, project, package, or `--skill` skill with the same name overrides the built-in one.

### websearch

Setup: get a free API key at [serper.dev](https://serper.dev), then run `/login`,
switch to **MCP Connections** using the displayed tab shortcuts, and choose
**Serper (web search)** to paste it. The key is stored alongside your other
credentials (in `auth.json`) and read by the skill on each call — no environment
variables required, and it works even if you add the key mid-session.

Optional overrides (environment variables):

```bash
export PRIME_AGENT_WEBSEARCH_TIMEOUT=45
export PRIME_AGENT_WEBSEARCH_NUM_RESULTS=5
```

A `SERPER_API_KEY` in the environment, if set, takes precedence over the stored key.

Once loaded, the model can call it directly in the Python kernel by import name:

```python
print(await websearch("latest Prime Agent release"))
```

Until a key is configured, web search returns a clear message telling the agent
to walk you through `/login`.

Disable only the built-in `websearch` skill in settings:

```json
{
  "bundledSkills": {
    "websearch": false
  }
}
```

To disable all built-in skills, set `enableBuiltinSkills` to `false` in `settings.json` (or toggle "Built-in skills" in `/settings`):

```json
{
  "enableBuiltinSkills": false
}
```

`--no-skills` also excludes built-in skills. To disable a single built-in skill without a dedicated setting, force-exclude it in the global `skills` array (patterns resolve against the built-in skills directory):

```json
{
  "skills": ["-prime-intellect/SKILL.md"]
}
```

### Using Skills from Other Harnesses

To use skills from Claude Code or OpenAI Codex, add their directories to settings:

```json
{
  "skills": [
    "~/.claude/skills",
    "~/.codex/skills"
  ]
}
```

For project-level Claude Code skills, add to `.prime/agent/settings.json`:

```json
{
  "skills": ["../.claude/skills"]
}
```

## How Skills Work

1. At startup, Prime Agent scans skill locations and extracts names, descriptions, type, and file locations
2. The system prompt includes visible skills in XML format per the [specification](https://agentskills.io/integrate-skills)
3. When a task matches, the agent uses `ipython` to load the full `SKILL.md` (models don't always do this; use prompting or `/skill:name` to force it)
4. The agent follows the instructions, using relative paths to reference scripts and assets

This is progressive disclosure: only descriptions are always in context, full instructions load on-demand.

Skills with `disable-model-invocation: true` are hidden from the startup skill list. They can still be invoked explicitly with `/skill:name`.

## Python-Backed Skills

A Python-backed skill uses the same `SKILL.md` metadata and invocation behavior as a markdown skill, but also provides a Python package for the Python kernel.

```
web-search/
├── SKILL.md
├── pyproject.toml
└── src/
    └── web_search/
        └── __init__.py
```

Detection rules:
- `SKILL.md` is still required
- `pyproject.toml` marks the skill as Python-backed
- the import name is the skill name with hyphens converted to underscores
- `src/<import_name>/__init__.py` must exist

For `web-search`, Prime Agent exposes `web_search` in the Python REPL. If the module defines `run()`, the module is wrapped as an async callable:

```python
await web_search("prime agent skills")
await web_search.run("prime agent skills")
help(web_search)
```

Python skills are installed editable into the kernel venv during kernel setup. By default this is `~/.prime/agent/kernel-venv`; set `PRIME_AGENT_KERNEL_VENV` to override it. If `pyproject.toml` changes, Prime Agent rebuilds the kernel venv so dependency changes are picked up.

If you set `PRIME_AGENT_KERNEL_PYTHON`, Prime Agent does not install packages into that environment. The Python must already have a current `prime-agent-runtime` and the default runtime packages installed. Missing Python skill imports are disabled with a warning and calling the skill raises a `RuntimeError`.

### Optional CLI Command

A Python skill can expose a shell command by declaring a console script in `pyproject.toml`. The script name must exactly match the Python import name, including underscores:

```toml
[project]
name = "web-search"
version = "0.1.0"
dependencies = ["requests"]

[project.scripts]
web_search = "rlm.skill:cli"
```

The `rlm.skill:cli` helper imports `web_search.run`, parses CLI arguments with `tyro`, awaits async results, and prints non-`None` return values.

```python
async def run(query: str, limit: int = 5) -> str:
    """Search the web and return a concise summary."""
    ...
```

The model can then call the skill from normal Python or from shell mode:

```python
await web_search("prime agent")
!web_search "prime agent" --limit 3
```

## Creating Skills with Prime Agent

Prime Agent ships with a built-in `skill-creator` skill that teaches the agent both the Agent Skills format and the Python-backed package contract. You can ask for a skill in normal language:

```text
Create a project Python-backed skill named release-audit in
.prime/agent/skills/release-audit. It should expose
await release_audit(repository, target_version), include concise SKILL.md
instructions, declare its dependencies, and verify the callable in a fresh
Prime Agent session.
```

To force the creation workflow explicitly, invoke the built-in skill command:

```text
/skill:skill-creator Create a personal markdown skill for reviewing database migrations.
```

Tell the agent three things:

1. **Scope:** use `.prime/agent/skills/<name>/` for a project skill committed with the repository, or `~/.prime/agent/skills/<name>/` for a personal skill.
2. **Kind:** ask for a markdown skill when the capability is primarily instructions; ask for a Python-backed skill when the agent should call reusable functionality from the Python REPL.
3. **Contract:** describe the intended Python call, inputs, output, dependencies, credentials, and verification behavior.

The agent should create `SKILL.md` in both cases. For a Python-backed skill it should also create `pyproject.toml` and `src/<import_name>/__init__.py`, expose a documented callable, and verify that the package imports in the kernel.

Use `/reload` to rediscover new or edited skill metadata. Start a fresh Prime Agent session after adding a Python-backed skill so kernel setup can install and import the package.

### Installed Skills and Continual Harness Skills

An installed Python-backed skill is a real package on disk that adds executable functionality to the kernel. A continual harness skill entry is a persisted description of a reusable Python call, including its reference and argument contract. `/refine` can create or update the latter after a repeated procedure emerges, but it does not replace packaging new functionality with `skill-creator`.

## Skill Commands

Skills register as `/skill:name` commands:

```bash
/skill:brave-search           # Load and execute the skill
/skill:pdf-tools extract      # Load skill with arguments
```

Arguments after the command are appended to the skill content as `User: <args>`.

Toggle skill commands via `/settings` in interactive mode or in `settings.json`:

```json
{
  "enableSkillCommands": true
}
```

## Skill Structure

A skill is a directory with a `SKILL.md` file. Everything else is freeform.

```
my-skill/
├── SKILL.md              # Required: frontmatter + instructions
├── scripts/              # Helper scripts
│   └── process.sh
├── references/           # Detailed docs loaded on-demand
│   └── api-reference.md
└── assets/
    └── template.json
```

### SKILL.md Format

````markdown
---
name: my-skill
description: What this skill does and when to use it. Be specific.
---

# My Skill

## Setup

Run once before first use:
```bash
cd /path/to/skill && npm install
```

## Usage

```bash
./scripts/process.sh <input>
```
````

Use relative paths from the skill directory:

```markdown
See [the reference guide](references/REFERENCE.md) for details.
```

## Frontmatter

Per the [Agent Skills specification](https://agentskills.io/specification#frontmatter-required):

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Max 64 chars. Lowercase a-z, 0-9, hyphens. Must match parent directory. |
| `description` | Yes | Max 1024 chars. What the skill does and when to use it. |
| `license` | No | License name or reference to bundled file. |
| `compatibility` | No | Max 500 chars. Environment requirements. |
| `metadata` | No | Arbitrary key-value mapping. |
| `allowed-tools` | No | Space-delimited list of pre-approved tools (experimental). |
| `disable-model-invocation` | No | When `true`, skill is hidden from system prompt. Users must use `/skill:name`. |

### Name Rules

- 1-64 characters
- Lowercase letters, numbers, hyphens only
- No leading/trailing hyphens
- No consecutive hyphens
- Must match parent directory name

Valid: `pdf-processing`, `data-analysis`, `code-review`
Invalid: `PDF-Processing`, `-pdf`, `pdf--processing`

### Description Best Practices

The description determines when the agent loads the skill. Be specific.

Good:
```yaml
description: Extracts text and tables from PDF files, fills PDF forms, and merges multiple PDFs. Use when working with PDF documents.
```

Poor:
```yaml
description: Helps with PDFs.
```

## Validation

Prime Agent validates skills against the Agent Skills standard. Most issues produce warnings but still load the skill:

- Name doesn't match parent directory
- Name exceeds 64 characters or contains invalid characters
- Name starts/ends with hyphen or has consecutive hyphens
- Description exceeds 1024 characters

Unknown frontmatter fields are ignored.

**Exception:** Skills with missing description are not loaded.

Name collisions (same name from different locations) warn and keep the first skill found.

## Example

```
brave-search/
├── SKILL.md
├── search.js
└── content.js
```

**SKILL.md:**
````markdown
---
name: brave-search
description: Web search and content extraction via Brave Search API. Use for searching documentation, facts, or any web content.
---

# Brave Search

## Setup

```bash
cd /path/to/brave-search && npm install
```

## Search

```bash
./search.js "query"              # Basic search
./search.js "query" --content    # Include page content
```

## Extract Page Content

```bash
./content.js https://example.com
```
````

## Skill Repositories

- [Anthropic Skills](https://github.com/anthropics/skills) - Document processing (docx, pdf, pptx, xlsx), web development
- [Pi Skills](https://github.com/badlogic/pi-skills) - Web search, browser automation, Google APIs, transcription
