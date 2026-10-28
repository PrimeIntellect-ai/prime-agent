// Pedantic-gate dispositions as src/lib.rs (large_futures/too_many_lines/casts).
#![allow(
    clippy::large_futures,
    clippy::too_many_lines,
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss
)]

//! Prompt guard tests: cache safety (static layers never contain dynamic content; the cached prefix
//! is byte-identical across sessions) and tool surface (the core layer's documented tools match the
//! real registered surface; a tool change without a prompt update fails here).

use std::collections::BTreeSet;
use std::path::Path;

use pa_core::prompts::layers::{CORE_LAYER, OPINIONATED_LAYER, USAGE_LAYER};
use pa_core::prompts::model_prompts::MODEL_PROMPTS_TOML;
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

// Cache safety

/// Strings that only dynamic segments generate. If one of these ever appears in a static layer
/// file, the cached prefix has started leaking per-session content.
const DYNAMIC_ONLY_MARKERS: &[&str] = &[
    "Working directory:",
    "Conversation log:",
    "Recursive agent depth:",
    "Current date:",
    "<available_skills>",
    "Enabled generic MCP servers:",
    "# Project Context",
    "Pre-installed Python packages:",
    "You are a child agent spawned by",
];

#[test]
fn static_layers_contain_no_dynamic_content() {
    for (name, text) in [
        ("core", CORE_LAYER),
        ("usage", USAGE_LAYER),
        ("opinionated", OPINIONATED_LAYER),
        ("model-prompts", MODEL_PROMPTS_TOML),
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
        model_prompt_extras: Some("model guidance."),
        skills: sorted_bundled_skills(),
        selected_tools: Some(vec!["python_repl"]),
        ..Default::default()
    };
    let first = system_prompt_breakdown(&options);

    options.cwd = "/completely/different".into();
    options.messages_path = None;
    options.rlm_depth = Some(3);
    options.rlm_parent_agent = Some("orchestrator");
    options.generic_mcp_servers = vec!["slack".into(), "github".into()];
    options.context_files = vec![("AGENTS.md".into(), "Never commit main.".into())];
    options.append_system_prompt = Some("And one more thing.".into());
    let second = system_prompt_breakdown(&options);

    assert_eq!(first.cached_prefix_len, second.cached_prefix_len);
    assert_eq!(
        &first.assembled[..first.cached_prefix_len],
        &second.assembled[..second.cached_prefix_len]
    );
    assert_eq!(
        &first.assembled[..first.cached_prefix_len],
        &format!(
            "{}\n\n{}\n\n{}\n\nmodel guidance.",
            CORE_LAYER.trim(),
            USAGE_LAYER.trim(),
            OPINIONATED_LAYER.trim()
        )
    );

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
    assert!(second_tail.ends_with("And one more thing."));

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

// Tool surface

/// Host-request types that are host-internal plumbing, not model-facing
/// programmatic tools (the prompt must not document them).
const INTERNAL_HOST_REQUESTS: &[&str] = &[
    "model.info",
    "mcp.config",
    "mcp.refresh",
    "mcp.begin_login",
    // The runtime's detached-bash notice pair (the kernel's bash module
    // fires them; the model never calls them).
    "bash.completed",
    "bash.consumed",
    // The factory module reports run milestones; the model never calls it.
    "factory.progress",
];

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

/// Kernel-side programmatic tools implemented by the vendored `prime-agent-runtime` package
/// (generic MCP calls). Update together with the runtime sidecar.
const KERNEL_LOCAL_TOKENS: &[&str] = &[
    "mcp.list_tools",
    "mcp.call_tool",
    "mcp.search_tools",
    "mcp.describe_tool",
];

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
            // Direct registrations: the request type is the FIRST
            // argument of each `.register(` — a literal right at the
            // call's head counts; anything after a non-literal first
            // argument is not the request type.
            for remainder in source.split(".register(").skip(1) {
                let rest = remainder.trim_start();
                if rest.starts_with('"') {
                    if let Some(literal) = first_string_literal(rest) {
                        if is_request_type_literal(&literal) {
                            found.insert(literal);
                        }
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
    let code = pa_core::kernel::bootstrap::build_rlm_bootstrap_code(&[], false);
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

/// Bundled skills that are auth-gated builtin MCP integrations: they are disabled in sessions whose
/// user is not logged into the integration, so the prompt documents them only through the dynamic
/// skills inventory (and its generic "additional skills may exist" note), not as API surface.
fn auth_gated_bundled_skills() -> BTreeSet<String> {
    pa_core::mcp::BUILTIN_MCP_CATALOG
        .iter()
        .map(|(server, _, _)| server.to_string())
        .collect()
}

/// Conditionally-available bundled skills: the websearch skill rides with its
/// credential (an unset `bundledSkills.websearch` resolves with the stored or
/// ambient Serper key), so keyless installs exclude it — it must never be
/// documented as static core-tool surface; the dynamic skills inventory
/// renders it only on installs where it resolves enabled.
fn settings_gated_bundled_skills() -> BTreeSet<String> {
    ["websearch".to_string()].into_iter().collect()
}

/// (import name, public functions) for every bundled Python skill that is
/// always available (auth-gated integrations and the conditionally-available
/// websearch skill excluded).
fn bundled_python_skills() -> Vec<(String, Vec<String>)> {
    let gated = auth_gated_bundled_skills();
    let settings_gated = settings_gated_bundled_skills();
    sorted_bundled_skills()
        .into_iter()
        .filter(|skill| {
            skill
                .python
                .as_ref()
                .is_none_or(|python| !gated.contains(&python.import_name))
        })
        .filter(|skill| !settings_gated.contains(&skill.name))
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

/// The surface tokens the prompt is allowed to document: kernel-bound names, registered host
/// requests, bundled Python skills, and the runtime-package (harness + generic MCP) API.
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

/// The surface tokens the prompt MUST document. Stricter than the allowed set: skill entry points
/// (`run`/`status`) are callable through the module itself, so the module bullet suffices for them.
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

/// The core layer's `rlm.spawn` line documents the decision child's JSON
/// contract: the request fields (`seq`, `state`, `questions`), the tagged
/// `decision_api.decision` follow-up reply carrying the request's `seq`, and
/// the ready-not-decision answer for any other message — a line that promises
/// a decision for every message fails here.
#[test]
fn core_layer_documents_the_decision_child_contract() {
    let spawn_line = CORE_LAYER
        .lines()
        .find(|line| line.contains("rlm.spawn("))
        .expect("the core layer documents rlm.spawn");
    for token in [
        r#""seq""#,
        r#""state""#,
        r#""questions""#,
        "decision_api.decision",
    ] {
        assert!(
            spawn_line.contains(token),
            "the rlm.spawn line must document the decision request/reply contract ({token})"
        );
    }
    assert!(
        spawn_line.contains("follow-up row"),
        "the rlm.spawn line must document the reply's follow-up delivery"
    );
    assert!(
        spawn_line.contains("Decision child ready."),
        "the rlm.spawn line must say a non-request message readies the child, not a decision"
    );
    assert!(
        !spawn_line.contains("answers every message"),
        "the decision child answers decision requests only, not every message"
    );
}

// Packaged-set parity (TS packages/coding-agent/skills)

/// The packaged skill set at TS tip `f62dae4d0` (`packages/coding-agent/skills/`): 12 skills — the
/// generic `mcp` doc skill in, the per-service linear/notion pair out (TS removed theirs when the
/// generic MCP surface landed).
const TS_PACKAGED_SKILL_SET: &[&str] = &[
    "agent-message",
    "agent-observe",
    "attach-image",
    "compact",
    "edit",
    "goal",
    "mcp",
    "prime-intellect",
    "refine",
    "rlm-heartbeat",
    "skill-creator",
    "websearch",
];

/// The bundled skills directory matches the TS packaged set name-for-name: the generic `mcp` skill
/// is present and markdown-only, and the retired per-service pair (linear/notion) is gone.
#[test]
fn bundled_skills_match_the_ts_packaged_set() {
    let skills = sorted_bundled_skills();
    let names: Vec<&str> = skills.iter().map(|skill| skill.name.as_str()).collect();
    let mut expected = TS_PACKAGED_SKILL_SET.to_vec();
    expected.sort_unstable();
    assert_eq!(
        names, expected,
        "the packaged skill set must match the TS packaged set"
    );
    assert!(
        !names.contains(&"linear") && !names.contains(&"notion"),
        "the per-service MCP skills retired with the generic mcp skill"
    );
    let mcp_skill = skills
        .iter()
        .find(|skill| skill.name == "mcp")
        .expect("the generic mcp skill is packaged");
    assert!(
        mcp_skill.python.is_none(),
        "the mcp skill is documentation for the pre-imported runtime module, not a Python package"
    );
    assert_eq!(
        mcp_skill.description,
        "Use external MCP services generically from Python - search the supported-service catalog, inspect the user's connections, discover live tool schemas, and call tools on any connection (Notion, Linear, Slack, and the rest of the catalog) without per-service packages."
    );
}

/// The bounded-await contract renders wherever the Python REPL does: every session kind, daemon
/// or daemonless, registers the bash completion notice the degrade relies on.
#[test]
fn bounded_await_contract_renders_in_daemon_and_daemonless_sessions() {
    let mut options = BuildSystemPromptOptions {
        cwd: "/w".to_string(),
        messages_path: Some("/log.jsonl".to_string()),
        skills: sorted_bundled_skills(),
        selected_tools: Some(vec!["python_repl"]),
        ..Default::default()
    };
    for daemonless in [false, true] {
        options.daemonless = daemonless;
        let prompt = system_prompt_breakdown(&options).assembled;
        assert!(
            prompt.contains("`r.running` is True")
                && prompt.contains("`r.exit_code` is None"),
            "daemonless={daemonless}: the prompt must carry the bounded-await result contract: {prompt}"
        );
    }
}

/// The generic mcp skill loads through the normal markdown discovery and renders in the
/// `<available_skills>` inventory exactly like any other markdown skill: the `[skill name
/// location]`-style XML the TS `formatSkillsForPrompt` emits, without a `python_import` line.
#[test]
fn generic_mcp_skill_renders_in_the_prompt_inventory() {
    let mut options = BuildSystemPromptOptions {
        cwd: "/w".to_string(),
        messages_path: Some("/log.jsonl".to_string()),
        skills: sorted_bundled_skills(),
        selected_tools: Some(vec!["python_repl"]),
        ..Default::default()
    };
    let breakdown = system_prompt_breakdown(&options);
    let inventory = breakdown
        .segments
        .iter()
        .find(|segment| {
            matches!(segment.kind, SegmentKind::Dynamic)
                && segment.text.contains("<available_skills>")
        })
        .map(|segment| segment.text.clone())
        .expect("the skills inventory segment renders");
    assert!(inventory.contains("<name>mcp</name>"));
    assert!(inventory.contains("<type>markdown</type>"));
    let mcp_block_start = inventory
        .find("<name>mcp</name>")
        .expect("the mcp skill block");
    let mcp_block_end = inventory[mcp_block_start..]
        .find("</skill>")
        .map_or(inventory.len(), |end| mcp_block_start + end);
    let mcp_block = &inventory[mcp_block_start..mcp_block_end];
    assert!(
        !mcp_block.contains("python_import"),
        "a markdown skill never carries a python_import line"
    );
    options.generic_mcp_servers = vec!["notion".into()];
    let second = system_prompt_breakdown(&options);
    assert!(second
        .assembled
        .contains("await mcp.list_tools(\"notion\")"));
}

// Async turn discipline

/// Since #3580 every session kind wakes on bash completion: daemonless runs
/// get a queued `[bash-done]` turn, so the static usage layer must not carry
/// the pre-#3580 rule to await commands before ending the turn — the
/// no-polling rule right below it already ends turns on the done
/// notification, and an unscoped await rule would contradict that wake.
#[test]
fn usage_layer_ends_turns_on_the_done_notification_not_an_await_rule() {
    assert!(
        !USAGE_LAYER.contains("await commands before ending the turn"),
        "every session kind has completion notifications: the await-before-turn-end rule is stale"
    );
    assert!(
        USAGE_LAYER.contains("end the turn and collect the result on the done notification"),
        "the no-polling rule keeps the collect-on-notice turn-end contract"
    );
}
