//! rlm bootstrap code injected into every kernel start (TS:
//! `buildRlmBootstrapCode` and its constants in
//! `packages/coding-agent/src/core/tools/ipython.ts`). Split from the
//! ipython tool module for module-size hygiene.

const RLM_BOOTSTRAP_HEADER_CODE: &str = r#"
import asyncio
import os as _prime_agent_os

_prime_agent_os.environ["NO_COLOR"] = "1"
"#;

const RLM_BOOTSTRAP_RUNTIME_CODE: &str = r#"
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
"#;

/// A Python skill installed into the kernel namespace.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PythonSkillRuntimeInfo {
    /// Module import name bound in the kernel namespace.
    pub import_name: String,
}

/// Bootstrap code that binds `rlm` and the Python skills into the kernel.
///
/// Port of `buildRlmBootstrapCode` from ipython.ts: imports the rlm runtime,
/// substitutes a raising stub when it is missing, and wraps each Python skill
/// module with a callable wrapper that forwards `__call__` to `run`.
pub fn build_rlm_bootstrap_code(python_skills: &[PythonSkillRuntimeInfo]) -> String {
    let base_code = format!("{RLM_BOOTSTRAP_HEADER_CODE}\n\n{RLM_BOOTSTRAP_RUNTIME_CODE}");

    // The Python source embeds the exact JS JSON.stringify of the import names.
    let import_names: Vec<&str> = {
        let mut names: Vec<&str> = python_skills
            .iter()
            .map(|skill| skill.import_name.as_str())
            .collect();
        names.sort_unstable();
        names.dedup();
        names
    };
    if import_names.is_empty() {
        return base_code;
    }

    let import_names_json = serde_json::to_string(&import_names).expect("names serialize");

    format!(
        r#"
{base_code}

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
        self.__doc__ = f"Python skill {{name}} is unavailable: {{error}}"

    async def run(self, *args, **kwargs):
        raise RuntimeError(
            f"Python skill {{self.__name__}} is unavailable in this kernel. "
            f"Import error: {{self._prime_agent_import_error}}"
        )

    async def __call__(self, *args, **kwargs):
        return await self.run(*args, **kwargs)

    def __repr__(self):
        return f"<unavailable Python skill {{self.__name__!r}}: {{self._prime_agent_import_error}}>"

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

_PRIME_AGENT_SKILL_IMPORT_ERRORS = {{}}

for _prime_agent_skill_name in {import_names_json}:
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
"#
    )
    .trim()
    .to_string()
}
