import type { PythonSkillRuntimeInfo } from "../core/skills.js";

const RLM_BOOTSTRAP_HEADER_CODE = `
import asyncio
import os as _prime_agent_os

_prime_agent_os.environ["NO_COLOR"] = "1"
`.trim();

const RLM_BOOTSTRAP_RUNTIME_CODE = `
try:
    import rlm as _prime_agent_rlm_module
    rlm = _prime_agent_rlm_module.rlm
    bash = _prime_agent_rlm_module.bash
    import rlm.mcp as mcp
except Exception as _prime_agent_rlm_error:
    _PRIME_AGENT_RLM_IMPORT_ERROR = str(_prime_agent_rlm_error)

    class _PrimeAgentMissingRlm:
        def _raise_missing(self):
            raise RuntimeError(
                "prime-agent-runtime is not installed in this kernel. "
                "Remove ~/.prime/agent/kernel-venv so prime-agent can rebuild it, or set "
                "PRIME_AGENT_KERNEL_PYTHON to a kernel environment with prime-agent-runtime installed. "
                f"Import error: {_PRIME_AGENT_RLM_IMPORT_ERROR}"
            )

        async def spawn(self, prompt, **kwargs):
            self._raise_missing()

        async def find_models(self, query="", limit=8):
            self._raise_missing()

        async def create_session(self, prompt, **kwargs):
            self._raise_missing()

        async def list_subagents(self):
            self._raise_missing()

        async def delete_subagent(self, target):
            self._raise_missing()

    rlm = _PrimeAgentMissingRlm()

    def bash(command):
        rlm._raise_missing()
`.trim();

export function buildRlmBootstrapCode(pythonSkills: readonly PythonSkillRuntimeInfo[] = []): string {
	const baseCode = [RLM_BOOTSTRAP_HEADER_CODE, RLM_BOOTSTRAP_RUNTIME_CODE].join("\n\n");
	const importNames = [...new Set(pythonSkills.map((skill) => skill.importName))];
	if (importNames.length === 0) {
		return baseCode;
	}

	return `
${baseCode}

import importlib as _prime_agent_importlib
import inspect as _prime_agent_inspect
import sys as _prime_agent_sys
import types as _prime_agent_types

class _PrimeAgentCallableSkillModule(_prime_agent_types.ModuleType):
    async def __call__(self, *args, **kwargs):
        result = self.run(*args, **kwargs)
        if _prime_agent_inspect.isawaitable(result):
            return await result
        return result

class _PrimeAgentUnavailableSkill:
    def __init__(self, name, error):
        self.__name__ = name
        self._prime_agent_import_error = error
        self.__doc__ = f"Python skill {name} is unavailable: {error}"

    async def run(self, *args, **kwargs):
        raise RuntimeError(
            f"Python skill {self.__name__} is unavailable in this kernel. "
            f"Import error: {self._prime_agent_import_error}"
        )

    async def __call__(self, *args, **kwargs):
        return await self.run(*args, **kwargs)

    def __repr__(self):
        return f"<unavailable Python skill {self.__name__!r}: {self._prime_agent_import_error}>"

def _prime_agent_wrap_skill_module(module):
    run = getattr(module, "run", None)
    if not callable(run):
        return module
    if isinstance(module, _PrimeAgentCallableSkillModule):
        return module
    wrapped = _PrimeAgentCallableSkillModule(module.__name__)
    wrapped.__dict__.update(module.__dict__)
    try:
        wrapped.__signature__ = _prime_agent_inspect.signature(run)
    except Exception:
        pass
    doc = getattr(run, "__doc__", None)
    if doc:
        wrapped.__doc__ = doc
    _prime_agent_sys.modules[module.__name__] = wrapped
    return wrapped

_PRIME_AGENT_SKILL_IMPORT_ERRORS = {}

for _prime_agent_skill_name in ${JSON.stringify(importNames)}:
    try:
        globals()[_prime_agent_skill_name] = _prime_agent_wrap_skill_module(
            _prime_agent_importlib.import_module(_prime_agent_skill_name)
        )
    except Exception as _prime_agent_skill_error:
        _PRIME_AGENT_SKILL_IMPORT_ERRORS[_prime_agent_skill_name] = str(_prime_agent_skill_error)
        globals()[_prime_agent_skill_name] = _PrimeAgentUnavailableSkill(
            _prime_agent_skill_name,
            str(_prime_agent_skill_error),
        )
`.trim();
}
