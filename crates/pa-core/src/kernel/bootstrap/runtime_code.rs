//! The runtime bootstrap code injected into each kernel right after start or
//! restore: binds the `rlm`, `bash`, and MCP surfaces and pre-imports every
//! Python skill (from `core/tools/ipython.ts`'s `buildRlmBootstrapCode`).

use super::KernelPythonSkill;

/// The line the runtime bootstrap prints (once, after the skill import
/// loop) when one or more pre-imported Python skills failed to import
/// (TS `PYTHON_SKILL_IMPORT_ERROR_REPORT_MARKER`): the marker, then one
/// JSON object of `{importName: error}`. The host scans the bootstrap
/// cell's stdout for this line so unavailable skills reach the model
/// instead of failing only on first call.
pub const PYTHON_SKILL_IMPORT_ERROR_REPORT_MARKER: &str =
    "__PRIME_AGENT_PYTHON_SKILL_IMPORT_ERRORS__";

const RLM_BOOTSTRAP_HEADER_CODE: &str =
    "import asyncio\nimport os as _prime_agent_os\n\n_prime_agent_os.environ[\"NO_COLOR\"] = \"1\"";

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

/// The code the session injects right after kernel start/restore: binds the
/// `rlm`, `bash`, and MCP surfaces, imports every Python skill (wrapping
/// callable ones, replacing broken imports with a stub that raises), matching
/// the TS `buildRlmBootstrapCode`.
pub fn build_rlm_bootstrap_code(python_skills: &[KernelPythonSkill]) -> String {
    let base_code = format!("{RLM_BOOTSTRAP_HEADER_CODE}\n\n{RLM_BOOTSTRAP_RUNTIME_CODE}");
    let mut import_names: Vec<&str> = python_skills
        .iter()
        .map(|s| s.import_name.as_str())
        .collect();
    import_names.sort_unstable();
    import_names.dedup();
    if import_names.is_empty() {
        return base_code;
    }
    let imports_json = serde_json::to_string(&import_names).unwrap_or_else(|_| "[]".to_string());
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
        return await self.run()

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

for _prime_agent_skill_name in {imports_json}:
    try:
        globals()[_prime_agent_skill_name] = _prime_agent_wrap_skill_module(
            _prime_agent_importlib.import_module(_prime_agent_skill_name)
        )
    except Exception as _prime_agent_skill_error:
        # An exception with an empty message would otherwise be dropped by
        # the host-side parser; fall back to the exception type name.
        _prime_agent_skill_error_text = (
            str(_prime_agent_skill_error) or type(_prime_agent_skill_error).__name__
        )
        _PRIME_AGENT_SKILL_IMPORT_ERRORS[_prime_agent_skill_name] = _prime_agent_skill_error_text
        globals()[_prime_agent_skill_name] = _PrimeAgentUnavailableSkill(
            _prime_agent_skill_name,
            _prime_agent_skill_error_text,
        )

if _PRIME_AGENT_SKILL_IMPORT_ERRORS:
    import json as _prime_agent_json
    print(
        "{PYTHON_SKILL_IMPORT_ERROR_REPORT_MARKER}"
        + _prime_agent_json.dumps(_PRIME_AGENT_SKILL_IMPORT_ERRORS)
    )
"#
    )
    .trim()
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn bootstrap_code_without_skills_binds_rlm() {
        let code = build_rlm_bootstrap_code(&[]);
        assert!(code.contains("import rlm as _prime_agent_rlm_module"));
        assert!(!code.contains("_PrimeAgentUnavailableSkill"));
    }

    #[test]
    fn bootstrap_code_imports_skills() {
        let skills = vec![KernelPythonSkill {
            name: "edit".into(),
            import_name: "edit".into(),
            package_path: PathBuf::from("/pkg/edit"),
            pyproject_path: PathBuf::from("/pkg/edit/pyproject.toml"),
        }];
        let code = build_rlm_bootstrap_code(&skills);
        assert!(code.contains(r#"for _prime_agent_skill_name in ["edit"]"#));
        assert!(code.contains("_PrimeAgentUnavailableSkill"));
        // Failed imports report through the marker line (TS #2381): the
        // host scans the bootstrap cell's stdout for the marker + JSON of
        // the import errors, and an empty exception message falls back to
        // the exception type name (the parser drops empty errors).
        assert!(code.contains(PYTHON_SKILL_IMPORT_ERROR_REPORT_MARKER));
        assert!(
            code.contains("print("),
            "the marker report prints after the import loop"
        );
        assert!(
            code.contains("_prime_agent_skill_error_text = ("),
            "empty exception messages fall back to the type name"
        );
        assert!(
            code.contains("if _PRIME_AGENT_SKILL_IMPORT_ERRORS:"),
            "the report prints only when something failed"
        );
        // No skills: no marker machinery at all.
        let bare = build_rlm_bootstrap_code(&[]);
        assert!(!bare.contains(PYTHON_SKILL_IMPORT_ERROR_REPORT_MARKER));
    }
}
