//! Prompt guard tests (the prompt linters):
//!
//! 1. **Cache safety**: the static layer files never contain dynamic
//!    (session-specific) content, and the assembled prompt's cached prefix is
//!    byte-identical across sessions with different dynamic tails.
//! 2. **Tool surface**: the core layer's documented programmatic-tool
//!    surface matches the real registered surface — kernel-bound names from
//!    the bootstrap code, host-request handlers registered by the session
//!    engine, and the bundled Python skills' public functions. Adding or
//!    removing a tool without updating the prompt fails here.

use std::collections::BTreeSet;
use std::path::Path;

use pa_core::prompts::layers::{self, CORE_LAYER, OPINIONATED_LAYER, PER_MODEL_MAP, USAGE_LAYER};
use pa_core::prompts::system_prompt::{
    system_prompt_breakdown, BuildSystemPromptOptions, SegmentKind,
};
use pa_core::skills::load_skills_from_dir;

/// The workspace bundled skills directory (source-checkout layout):
/// pa-core lives at `<root>/crates/pa-core`.
fn bundled_skills_dir() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("workspace root")
        .join("skills")
}

fn sorted_bundled_skills() -> Vec<pa_core::skills::Skill> {
    let skills_dir = bundled_skills_dir();
    let mut loaded = load_skills_from_dir(&skills_dir, "package");
    loaded
        .skills
        .sort_by(|left, right| left.name.cmp(&right.name));
    loaded.skills
}

// ---------------------------------------------------------------------
// Cache safety
// ---------------------------------------------------------------------

/// Strings that only dynamic segments generate. If one of these ever
/// appears in a static layer file, the cached prefix has started leaking
/// per-session content.
const DYNAMIC_ONLY_MARKERS: &[&str] = &[
    "Working directory:",
    "Conversation log:",
    "Recursive agent depth:",
    "Current date:",
    "<available_skills>",
    "Enabled generic MCP servers:",
    "# Project Context",
    "# Additional Guidance",
    "Pre-installed Python packages:",
    "You are a child agent spawned by",
];

#[test]
fn static_layers_contain_no_dynamic_content() {
    for (name, text) in [
        ("core", CORE_LAYER),
        ("usage", USAGE_LAYER),
        ("opinionated", OPINIONATED_LAYER),
        ("per-model", PER_MODEL_MAP),
    ] {
        for marker in DYNAMIC_ONLY_MARKERS {
            assert!(
                !text.contains(marker),
                "static layer {name} contains dynamic-only marker {marker:?}: \
                 dynamic content must stay in the tail, not the cacheable prefix"
            );
        }
    }
}

#[test]
fn cached_prefix_is_stable_across_sessions() {
    let mut options = BuildSystemPromptOptions {
        cwd: "/first/cwd".to_string(),
        messages_path: Some("/first/session.jsonl".to_string()),
        model: Some("mock/mock-1"),
        skills: sorted_bundled_skills(),
        selected_tools: Some(vec!["ipython"]),
        ..Default::default()
    };
    let first = system_prompt_breakdown(&options);

    options.cwd = "/completely/different".into();
    options.messages_path = None;
    options.rlm_depth = Some(3);
    options.rlm_parent_agent = Some("orchestrator");
    options.generic_mcp_servers = vec!["slack".into(), "github".into()];
    options.context_files = vec![("AGENTS.md".into(), "Never commit main.".into())];
    options.prompt_guidelines = Some(vec!["prefer tabs".into()]);
    options.append_system_prompt = Some("And one more thing.".into());
    let second = system_prompt_breakdown(&options);

    // The cacheable prefix is byte-identical and exactly the layered static
    // content; every per-session value lives after it.
    assert_eq!(first.cached_prefix_len, second.cached_prefix_len);
    assert_eq!(
        &first.assembled[..first.cached_prefix_len],
        &second.assembled[..second.cached_prefix_len]
    );
    assert_eq!(
        &first.assembled[..first.cached_prefix_len],
        layers::static_prefix(Some("mock/mock-1"))
    );

    // The tails carry each session's own values.
    let first_tail = &first.assembled[first.cached_prefix_len..];
    assert!(first_tail.contains("Current date: "));
    assert!(first_tail.contains("Working directory: /first/cwd"));
    assert!(first_tail.contains("Recursive agent depth: 0 (root)"));
    assert!(first_tail.contains("<available_skills>"));
    assert!(first_tail.contains("Pre-installed Python packages:"));
    let second_tail = &second.assembled[second.cached_prefix_len..];
    assert!(second_tail.contains("/completely/different"));
    assert!(second_tail.contains("Enabled generic MCP servers: `github`, `slack`."));
    assert!(second_tail.contains("Recursive agent depth: 3 (not root)"));
    assert!(second_tail.contains("You are a child agent spawned by orchestrator."));
    assert!(second_tail.contains("# Project Context"));
    assert!(second_tail.contains("# Additional Guidance"));
    assert!(second_tail.ends_with("And one more thing."));

    // Static segments all sit inside the cached prefix, dynamic ones after.
    for segment in &first.segments {
        let inside = first
            .assembled
            .find(&segment.text)
            .is_some_and(|at| at < first.cached_prefix_len);
        assert_eq!(
            inside,
            segment.kind == SegmentKind::Static,
            "segment {} on the wrong side of the cache boundary",
            segment.name
        );
    }
}

// ---------------------------------------------------------------------
// Tool surface
// ---------------------------------------------------------------------

/// Host-request types that are host-internal plumbing, not model-facing
/// programmatic tools (the prompt must not document them).
const INTERNAL_HOST_REQUESTS: &[&str] =
    &["model.info", "mcp.config", "mcp.refresh", "mcp.begin_login"];

/// Map one registered host-request type to the prompt token that documents
/// it. `None` when the request is host-internal.
fn prompt_token_for_host_request(request: &str) -> Option<String> {
    if INTERNAL_HOST_REQUESTS.contains(&request) {
        return None;
    }
    Some(
        match request {
            "rlm.run" => "rlm.spawn",
            "rlm.progress.note" => "rlm.progress_note",
            "agent_observe.list" | "agent_message.list_agents" => "agent_observe.list_agents",
            "agent_observe.get" => "agent_observe.get_agent",
            "agent_observe.recent" => "agent_observe.recent_messages",
            other => other,
        }
        .to_string(),
    )
}

/// Kernel-side programmatic tools implemented by the vendored
/// `prime-agent-runtime` package (generic MCP calls). Update together with
/// the runtime sidecar.
const KERNEL_LOCAL_TOKENS: &[&str] = &["mcp.list_tools", "mcp.call_tool"];

/// The harness-state API of the vendored runtime (`rlm.harness` CRUD and
/// `rlm.get_harness_state`). Update together with the runtime sidecar.
const HARNESS_TOKENS: &[&str] = &[
    "rlm.harness.create_memory",
    "rlm.harness.update_memory",
    "rlm.harness.delete_memory",
    "rlm.harness.create_prompt_note",
    "rlm.harness.update_prompt_note",
    "rlm.harness.delete_prompt_note",
    "rlm.harness.create_skill",
    "rlm.harness.update_skill",
    "rlm.harness.delete_skill",
    "rlm.harness.create_subagent",
    "rlm.harness.update_subagent",
    "rlm.harness.delete_subagent",
    "rlm.harness.record_refinement",
    "rlm.harness.plan_refinement",
    "rlm.harness.overview",
    "rlm.harness.search",
    "rlm.get_harness_state",
];

/// A host-request type literal: lowercase dotted name (`rlm.collect`).
fn is_request_type_literal(literal: &str) -> bool {
    !literal.is_empty()
        && literal
            .chars()
            .next()
            .is_some_and(|ch| ch.is_ascii_lowercase())
        && literal
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_' || ch == '.')
        && literal.contains('.')
}

/// Scan the pa-core sources for every host-request type the session engine
/// registers: `handlers.register("<type>", ...)` literals plus
/// `for request_type in [ "<type>", ... ]` loop tables.
fn registered_host_requests() -> BTreeSet<String> {
    let src_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut found = BTreeSet::new();
    let mut stack = vec![src_root];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            if path.extension().and_then(|ext| ext.to_str()) != Some("rs") {
                continue;
            }
            let source = std::fs::read_to_string(&path).expect("read source");
            // Direct registrations: the first string literal after each
            // `.register(` (the request type comes first in the call).
            for remainder in source.split(".register(").skip(1) {
                if let Some(literal) = first_string_literal(remainder) {
                    if is_request_type_literal(&literal) {
                        found.insert(literal);
                    }
                }
            }
            // Loop tables: `for request_type in [ "a.b", ... ]`.
            for remainder in source.split("for request_type in").skip(1) {
                let Some(open) = remainder.find('[') else {
                    continue;
                };
                let Some(close) = remainder[open..].find(']') else {
                    continue;
                };
                for literal in all_string_literals(&remainder[open..open + close]) {
                    if is_request_type_literal(&literal) {
                        found.insert(literal);
                    }
                }
            }
        }
    }
    found
}

fn first_string_literal(text: &str) -> Option<String> {
    let open = text.find('"')?;
    let tail = &text[open + 1..];
    let close = tail.find('"')?;
    Some(tail[..close].to_string())
}

fn all_string_literals(text: &str) -> Vec<String> {
    let mut literals = Vec::new();
    let mut rest = text;
    while let Some(open) = rest.find('"') {
        let tail = &rest[open + 1..];
        match tail.find('"') {
            Some(close) => {
                literals.push(tail[..close].to_string());
                rest = &tail[close + 1..];
            }
            None => break,
        }
    }
    literals
}

/// Kernel-bound REPL names from the real bootstrap code (`rlm`, `bash`,
/// `mcp`), derived from `build_rlm_bootstrap_code`.
fn kernel_bound_names() -> BTreeSet<String> {
    let code = pa_core::kernel::bootstrap::build_rlm_bootstrap_code(&[]);
    let mut names = BTreeSet::new();
    for line in code.lines() {
        let line = line.trim_start();
        if line.starts_with("rlm = ") {
            names.insert("rlm".to_string());
        }
        if line.starts_with("bash = ") {
            names.insert("bash".to_string());
        }
        if let Some(rest) = line.strip_prefix("import rlm.mcp as ") {
            names.insert(rest.trim().to_string());
        }
    }
    names
}

/// One bundled Python skill's public module-level functions (column-zero
/// `def`/`async def` only, so nested helpers stay out).
fn python_skill_functions(package_path: &Path) -> Vec<String> {
    let mut functions = Vec::new();
    let mut stack = vec![package_path.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            if path.extension().and_then(|ext| ext.to_str()) != Some("py") {
                continue;
            }
            let Ok(source) = std::fs::read_to_string(&path) else {
                continue;
            };
            for line in source.lines() {
                let after = line
                    .strip_prefix("async def ")
                    .or_else(|| line.strip_prefix("def "));
                if let Some(signature) = after {
                    if let Some(name) = signature.split(['(', ':']).next() {
                        functions.push(name.trim().to_string());
                    }
                }
            }
        }
    }
    functions
}

/// Bundled skills that are auth-gated builtin MCP integrations: they are
/// disabled in sessions whose user is not logged into the integration, so
/// the prompt documents them only through the dynamic skills inventory (and
/// its generic "additional skills may exist" note), not as API surface.
fn auth_gated_bundled_skills() -> BTreeSet<String> {
    pa_core::mcp::BUILTIN_MCP_CATALOG
        .iter()
        .map(|(server, _, _)| server.to_string())
        .collect()
}

/// (import name, public functions) for every bundled Python skill that is
/// always available (auth-gated integrations excluded).
fn bundled_python_skills() -> Vec<(String, Vec<String>)> {
    let gated = auth_gated_bundled_skills();
    sorted_bundled_skills()
        .into_iter()
        .filter(|skill| {
            skill
                .python
                .as_ref()
                .is_none_or(|python| !gated.contains(&python.import_name))
        })
        .filter_map(|skill| {
            let python = skill.python?;
            let mut functions = python_skill_functions(&python.package_path)
                .into_iter()
                .filter(|name| !name.starts_with('_'))
                .collect::<Vec<_>>();
            functions.sort();
            Some((python.import_name, functions))
        })
        .collect()
}

/// The surface tokens the prompt is allowed to document: kernel-bound names,
/// registered host requests, bundled Python skills, and the runtime-package
/// (harness + generic MCP) API.
fn allowed_surface_tokens() -> BTreeSet<String> {
    let mut allowed = BTreeSet::new();
    allowed.extend(kernel_bound_names());
    for request in registered_host_requests() {
        if let Some(token) = prompt_token_for_host_request(&request) {
            allowed.insert(token);
        }
    }
    for (import, functions) in bundled_python_skills() {
        allowed.insert(import.clone());
        for function in functions {
            allowed.insert(format!("{import}.{function}"));
        }
    }
    for token in KERNEL_LOCAL_TOKENS.iter().chain(HARNESS_TOKENS) {
        allowed.insert(token.to_string());
    }
    allowed
}

/// The surface tokens the prompt MUST document. Stricter than the allowed
/// set: skill entry points (`run`/`status`) are callable through the module
/// itself, so the module bullet suffices for them.
fn required_surface_tokens() -> BTreeSet<String> {
    let mut required = BTreeSet::new();
    for request in registered_host_requests() {
        if let Some(token) = prompt_token_for_host_request(&request) {
            required.insert(token);
        }
    }
    for (import, functions) in bundled_python_skills() {
        required.insert(import.clone());
        for function in functions {
            if function == "run" || function == "status" {
                continue;
            }
            required.insert(format!("{import}.{function}"));
        }
    }
    for token in KERNEL_LOCAL_TOKENS.iter().chain(HARNESS_TOKENS) {
        required.insert(token.to_string());
    }
    required
}

/// Surface tokens documented in the core layer: bullet entries whose first
/// backtick token is a lowercase module path.
fn documented_surface_tokens() -> BTreeSet<String> {
    let mut documented = BTreeSet::new();
    for line in CORE_LAYER.lines() {
        let Some(rest) = line.trim_start().strip_prefix("- `") else {
            continue;
        };
        let Some(end) = rest.find('`') else {
            continue;
        };
        let token = rest[..end].split('(').next().unwrap_or_default().trim();
        let valid = token
            .chars()
            .next()
            .is_some_and(|ch| ch.is_ascii_lowercase())
            && token
                .chars()
                .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_' || ch == '.')
            && !token.is_empty();
        if valid {
            documented.insert(token.to_string());
        }
    }
    documented
}

#[test]
fn core_layer_documents_the_real_tool_surface() {
    let documented = documented_surface_tokens();
    let allowed = allowed_surface_tokens();
    let required = required_surface_tokens();

    assert!(
        !required.is_empty() && !documented.is_empty(),
        "surface extraction produced nothing; the guard would be vacuous"
    );

    // Nothing phantom: every documented token exists on the real surface
    // (as the exact token, or an entry point of an allowed module).
    for token in &documented {
        let root = token.split('.').next().expect("non-empty token");
        let known = allowed.contains(token)
            || allowed.contains(root)
            || allowed
                .iter()
                .any(|candidate| candidate.starts_with(&format!("{root}.")));
        assert!(
            known,
            "prompt documents unknown tool {token:?}: a tool-surface change must \
             update prompts/layers/core.md (and this test's token mapping)"
        );
    }

    // Nothing missing: every registered surface entry is documented, either
    // as its own bullet or through a documented member of its module.
    for token in &required {
        let documented_form = documented.contains(token)
            || documented
                .iter()
                .any(|entry| entry.starts_with(&format!("{token}.")))
            || documented
                .iter()
                .any(|entry| entry.starts_with(token.as_str()) && entry.contains('.'));
        assert!(
            documented_form,
            "tool {token:?} is on the registered surface but the prompt does not \
             document it: update prompts/layers/core.md"
        );
    }
}
