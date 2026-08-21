# Security and Sandboxing

Prime Agent does not provide a full security sandbox. The IPython kernel and commands it starts run with the operating-system permissions of the Prime Agent worker. Treat model-generated commands as commands run by your own user account.

This matters most for unattended and autonomous runs. Repository files, issue text, web content, skills, extensions, and tool output can all influence the model. A process boundary, working directory, scratch branch, autonomous budget, or passing quality gate is not a security boundary.

## Controls Prime Agent Enforces

Prime Agent provides controls that reduce exposure, but none confines IPython to the working directory:

- `--no-tools` disables model tools by default; an explicit `--tools <list>` allowlist overrides it and enables only the listed tools. `--no-builtin-tools` disables built-in tools by default, and `--tools <list>` likewise overrides it.
- `--no-extensions`, `--no-skills`, `--no-prompt-templates`, and `--no-context-files` disable resource discovery. Use them when the repository or installed resources are not trusted.
- Autonomous continuation, turn, token, and elapsed-time budgets bound host-managed continuations. The elapsed-time limit is checked between operations; it is not a hard kill deadline for arbitrary code already running.
- `--autonomous-gate-timeout-ms` bounds each quality-gate process and Prime Agent stops its process tree on timeout. Gates decide whether work satisfies a check; they do not isolate the agent.
- `--no-session` prevents normal session transcript and artifact persistence for the root run and its RLM descendants. It is not a stateless or sandbox mode.

The built-in `ipython` tool can execute Python, shell commands, and subprocesses and can access absolute paths, inherited environment variables, and the network. Allowlisting only `ipython` therefore does not create a command or filesystem allowlist. Prime Agent currently has no built-in per-command approval policy or complete filesystem/network sandbox.

`--offline` disables Prime Agent startup network operations such as update checks. It does not block provider inference, Python, extensions, skills, or executed commands from using the network.

## Recommended Isolation

For untrusted repositories or unattended runs, enforce the boundary outside Prime Agent:

1. Use a disposable container, virtual machine, or dedicated unprivileged operating-system account.
2. Mount only a scratch clone of the target repository. Do not mount your normal home directory, SSH or GPG directories, cloud configuration, browser profiles, password stores, or the Docker socket.
3. Do not forward an SSH agent. Remove push credentials and use a remote or token that cannot write unless the task requires it.
4. Pass only the credentials required for model inference. Assume environment credentials are readable by code running in IPython.
5. Deny network access when possible. Otherwise enforce an external egress allowlist for the model provider and explicitly required package or source hosts.
6. Run as non-root with dropped capabilities, `no-new-privileges`, a read-only container root, and CPU, memory, and process limits.
7. Review generated diffs and commands before merging or pushing from a trusted environment.

### Container baseline

The exact image and inference setup are deployment-specific. This baseline assumes `<prime-agent-image>` already contains Prime Agent and any required local model configuration:

```bash
docker run --rm -it \
  --user "$(id -u):$(id -g)" \
  --cap-drop=ALL \
  --security-opt no-new-privileges \
  --read-only \
  --pids-limit 256 \
  --memory 4g \
  --cpus 2 \
  --network none \
  --tmpfs /tmp:rw,nosuid,nodev,noexec,size=1g \
  --tmpfs /home/agent:rw,nosuid,nodev,size=1g \
  --env HOME=/home/agent \
  --volume "$PWD/scratch-repo:/workspace:rw" \
  --workdir /workspace \
  <prime-agent-image> \
  prime-agent --no-session --no-extensions --no-skills --no-prompt-templates --no-context-files
```

`--network none` also blocks cloud model providers and package installation. Keep it only for a local or otherwise reachable inference arrangement. For cloud inference, replace it with an externally enforced egress policy; Docker's default network does not provide a domain allowlist. Relax `noexec` on `/tmp` only if a required tool needs to execute files there.

## Persisted State

By default, Prime Agent uses `~/.prime/agent` for configuration and runtime state:

- `sessions/` contains session transcripts;
- `session-artifacts/` contains per-session kernel snapshots, harness state, and recursive-agent state;
- `logs/` and debug logs contain diagnostics;
- `auth.json`, settings, models, tools, extensions, skills, and other installed resources remain available across runs; and
- the IPython environment and package-manager/download caches may be stored elsewhere under the user's home or XDG directories.

Commands and third-party resources can write anywhere permitted by the operating system, including locations not listed above.

### What `--no-session` does

`--no-session` uses in-memory session managers for the root run and every RLM descendant, so none of them creates a normal persisted session JSONL or per-session artifact tree. RLM execution can still create private temporary working directories for local harness state; Prime Agent does not currently remove them, so they can remain until OS temporary-file cleanup or manual removal. The process still reads global/project configuration and resources. Logs, authentication state, the kernel environment, package caches, other temporary files, telemetry state, and files created by commands may still be read or written.

For disposable behavior, use a fresh container or VM with an ephemeral `HOME` and XDG config/cache/state directories. Redirecting `PRIME_AGENT_CODING_AGENT_DIR` can isolate the Prime Agent config directory, but it does not redirect every third-party cache or command output.

## Unattended-Run Checklist

- [ ] The clone, branch, container, or VM is disposable and has no valuable uncommitted work.
- [ ] Only the target workspace is writable.
- [ ] Home directories, SSH/GPG agents, cloud configs, browser data, and the Docker socket are unavailable.
- [ ] No push credential or repository write token is present unless explicitly required.
- [ ] Extensions, skills, packages, prompts, and context files are trusted or disabled.
- [ ] Network egress and inherited environment credentials are minimized.
- [ ] External CPU, memory, process, and hard wall-clock limits are set.
- [ ] Autonomous budgets and gate timeouts are explicit and appropriate.
- [ ] A human will review the resulting diff before merge or push.
