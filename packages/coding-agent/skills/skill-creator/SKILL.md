---
name: skill-creator
description: Create, validate, and install Prime Agent Agent Skills, including Markdown instruction skills and Python-backed skills callable from the persistent IPython kernel. Use when the user asks to create a skill, package a reusable workflow or capability, add a Python skill, or explain SKILL.md structure and skill locations.
---

# Skill Creator

An Agent Skill is a directory whose `SKILL.md` file contains YAML frontmatter
and Markdown instructions. Prime Agent reads each visible skill's name and
description at startup, then loads the full file when the task matches. Prime
Agent implements the [Agent Skills specification](https://agentskills.io/specification)
and adds Python-backed skills that install a package into the persistent
IPython kernel.

| Kind | What it contains | Use it when |
|---|---|---|
| Markdown | `SKILL.md` plus optional scripts, references, and assets | The reusable capability is chiefly instructions, a decision flow, a CLI recipe, or domain reference material. |
| Python-backed | A Markdown skill plus `pyproject.toml` and an importable Python package | The agent should invoke reusable executable functionality from IPython through a documented call. |

A Continual Harness `skill` entry stores metadata for a Python call that an
installed package already provides. Use this skill creator for new executable
functionality or a new on-disk Agent Skill. Use refinement to save the call
contract for an existing capability.

Before creating a Python-backed skill, read
[references/python-skills.md](references/python-skills.md) for the package,
callable, optional CLI, dependency, and verification contract.

## Creation Threshold

Create a skill when the user explicitly requests one or when at least two
concrete uses reveal the same missing reusable capability. Identify the behavior
that must remain consistent, the existing command, library, prompt, or skill
that does not provide it, and the boundary that requires reuse across tasks. If
an existing mechanism satisfies the need, use it instead.

Choose the smallest complete shape. Add a script, reference, asset,
configuration file, schema, dependency, or Python package only when the skill's
actual interface needs it. Remove unused scaffold before delivery.

## Create the Skill

1. Choose Markdown or Python-backed form from the intended interface. A
   Python-backed skill must expose the documented Python call the agent needs;
   a shell command is optional and exists only when the package declares one.
2. Choose the location from task scope and repository policy:
   - Prime Agent project skill: `.prime/agent/skills/<name>/`
   - Cross-agent project skill: `.agents/skills/<name>/`
   - Prime Agent personal skill: `~/.prime/agent/skills/<name>/`
   - Cross-agent personal skill: `~/.agents/skills/<name>/`
   - Package-provided skill: a `skills/` directory in the package, or a path in
     the package's `pi.skills` setting
3. Write `SKILL.md` and only the supporting files its interface requires.
4. Validate the metadata, discovery, and actual invocation described below.

When several skills share a name, the first discovered skill wins. Prime Agent
applies explicit `--skill` paths first. Configured project paths precede
auto-discovered project skills, followed by configured user paths,
auto-discovered user skills, package skills, and built-in skills.

## Layout

```text
my-skill/
├── SKILL.md
├── scripts/
├── references/
└── assets/
```

Only `SKILL.md` is required. Supporting directories are optional. Refer to
supporting files with paths relative to the directory that contains
`SKILL.md`.

A Python-backed skill also follows the package layout in
[references/python-skills.md](references/python-skills.md), including
`pyproject.toml` and `src/<import_name>/__init__.py`.

## Frontmatter

```markdown
---
name: my-skill
description: What this skill does and when to use it. Be specific.
---
```

| Field | Required | Rules |
|---|---|---|
| `name` | Yes | 1 through 64 characters. Lowercase `a-z`, digits, and hyphens only. No leading, trailing, or consecutive hyphens. Must match the parent directory name. |
| `description` | Yes | At most 1024 characters. State both the capability and the task conditions that should load it. A missing or empty description prevents model routing. |
| `disable-model-invocation` | No | `true` hides the skill from the startup skill list. The user can still invoke it with `/skill:<name>`. |
| `license` | No | License name or a reference to a bundled license file. |
| `compatibility` | No | At most 500 characters describing environment requirements. |
| `metadata` | No | Arbitrary key-value mapping. |
| `allowed-tools` | No | Space-delimited tool list from the Agent Skills specification. Prime Agent currently retains this experimental field as metadata. |

Prime Agent ignores unknown fields. Name and length violations produce warnings;
the runtime remains intentionally lenient where the Agent Skills integration
permits it.

### Description for routing

The description is the only prose the model sees before deciding whether to
load the complete skill. Name what the skill does and the concrete requests,
formats, services, or tools that should trigger it.

Good:

```yaml
description: Extracts text and tables from PDF files, fills PDF forms, and merges PDFs. Use when working with PDF documents.
```

Too vague:

```yaml
description: Helps with PDFs.
```

### Body for progressive disclosure

Keep `SKILL.md` focused on the decision path, common commands, setup, interface,
and limits needed for normal use. Put long API schemas, exhaustive option lists,
and uncommon examples in `references/*.md` and link them at the point of use.
State required credentials, installation, or environment setup before the first
operation that needs them.

## Verification

After writing the skill:

1. Check the frontmatter against every rule above. Confirm that `name` matches
   the directory and that `description` is non-empty and specific enough for
   routing.
2. Run `/reload` in an interactive session to rediscover new or edited skill
   metadata. Check runtime warnings for invalid names, missing descriptions, or
   collisions.
3. Load the skill through a matching task or `/skill:<name>` and verify that its
   common path follows the documented instructions.
4. For a Python-backed skill, run the checks in
   [references/python-skills.md](references/python-skills.md), start a fresh
   Prime Agent session so kernel setup can install and import the package, and
   execute the documented Python call with a small real input. Verify its result
   and failure behavior. Verify a shell command only when `pyproject.toml`
   declares that console script.
