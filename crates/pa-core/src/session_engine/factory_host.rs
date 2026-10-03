//! The factory host bridge: the session seam that exposes the kernel's
//! factory surface (`factory.graph/status/watch/run/stop/resume`) to the
//! daemon and TUI, the `/factory` view's lane.
//!
//! The factory itself lives in the kernel (`rlm/factory.py`, the Rust port's
//! Python kernel architecture — the executor owns the run registry in kernel
//! memory), so this bridge is host->kernel: the session engine validates the
//! request, prefights a `run` before any child spawns, and rides the
//! out-of-band `factory_activity` kernel frame (the `bash_activity`
//! precedent — a running cell never delays the live view).
//!
//! The module follows the `system_router_host` pattern from #3184: a config
//! struct of session facts captured in `create_session` (the daemon model
//! allowlist pin, the session model), a registry-backed model preflight
//! (exact catalog match, TS short form, the stale-provider gate) that fails
//! loudly before a run starts, and a unit battery in the child module. The
//! direction differs by design: #3184 registers a kernel->host handler, while
//! the factory bridge serves daemon/TUI->kernel requests through
//! [`SessionEngine::factory_activity`]; the executor's own children ride the
//! existing `rlm.spawn` host path, where the daemon allowlist pin is
//! enforced per spawn.

use std::path::PathBuf;

use anyhow::anyhow;
use serde_json::Value;

use crate::kernel::shared::{FACTIVITY_WATCH_TIMEOUT_MS_CAP, FACTORY_ACTIVITY_ACTIONS};
use crate::models::registry::ModelRegistry;
use crate::models::resolver::find_exact_model_reference_match;
use pa_types::ai::Model as AiModel;

/// The session facts the factory bridge resolves against, captured in
/// `create_session` (the #3184 `SystemRouterHostConfig` capture shape).
#[derive(Clone)]
pub struct FactoryHostConfig {
    /// The agent directory: the model registry and auth cache resolve
    /// against it (the `run` preflight's model resolution).
    pub agent_dir: PathBuf,
    /// The global harness state directory (factory spec lookup).
    pub global_harness_dir: PathBuf,
    /// The session's local harness state directory, when it has one
    /// (depth-0 daemon sessions; `None` for engines without artifacts).
    pub local_harness_dir: Option<PathBuf>,
    /// The session model (the agent-side descriptor `create_session`
    /// requires): the declared-selector preflight's stale-provider gate and
    /// the equality fallback for a selector the catalog does not carry (the
    /// spawn path owns the full resolution). The descriptor is lossy by
    /// design, so the preflight crosses it back to the ai side field by
    /// field for the auth check (the #3184 field mapping).
    pub session_model: Option<pa_agent::types::Model>,
    /// The daemon `allowedModels` pin, enforced on every resolved model the
    /// preflight accepts (the per-spawn enforcement stays on the
    /// `rlm.spawn` host path).
    pub allowed_models: Option<Vec<String>>,
}

/// The factory host bridge built from [`FactoryHostConfig`]; held by the
/// session engine, reached through [`SessionEngine::factory_activity`].
#[derive(Clone)]
pub struct FactoryHost {
    config: FactoryHostConfig,
}

impl FactoryHost {
    #[must_use]
    pub fn new(config: FactoryHostConfig) -> Self {
        Self { config }
    }

    /// The global harness state (factory spec lookup's fallback tier).
    fn global_harness_state(&self) -> crate::refinement::HarnessState {
        crate::refinement::load_harness_state(
            &self.config.global_harness_dir,
            crate::refinement::HarnessScope::Global,
        )
    }

    /// The local harness state, when the session has one (the lookup's
    /// first tier, exactly like the kernel harness's unprefixed `get`).
    fn local_harness_state(&self) -> Option<crate::refinement::HarnessState> {
        self.config.local_harness_dir.as_ref().map(|dir| {
            crate::refinement::load_harness_state(dir, crate::refinement::HarnessScope::Local)
        })
    }

    /// Every model selector a stored factory spec declares: an inline
    /// subagent object's `model`, or a referenced harness subagent entry's
    /// `metadata.model`. `None` when the spec is not readable here (the
    /// kernel's `run()` remains the authority and reports unknown specs).
    /// Ids carry the harness's scope prefixes (`local:`/`global:`) verbatim
    /// — the kernel's harness `get` routes them to one store, so the
    /// preflight resolves the exact entry the run will execute. An
    /// unprefixed id resolves local state first, then global — broader
    /// than the kernel's own unprefixed lookup, which reads one store
    /// (a spec stored only globally is an unknown spec to the kernel),
    /// so a global fall-through judges a run the kernel would refuse;
    /// harmless, and the kernel's `run()` remains the authority.
    fn spec_model_selectors(&self, spec_id: &str) -> Option<Vec<String>> {
        let (spec_scope, spec_id) = split_harness_scope(spec_id);
        let global = self.global_harness_state();
        let local = self.local_harness_state();
        let entry = match spec_scope {
            Scope::Local => local
                .as_ref()?
                .entries
                .get(&crate::refinement::RefinementKind::Factory)
                .and_then(|entries| entries.get(spec_id)),
            Scope::Global => global
                .entries
                .get(&crate::refinement::RefinementKind::Factory)
                .and_then(|entries| entries.get(spec_id)),
            Scope::Any => local
                .as_ref()
                .and_then(|state| {
                    state
                        .entries
                        .get(&crate::refinement::RefinementKind::Factory)
                        .and_then(|entries| entries.get(spec_id))
                })
                .or_else(|| {
                    global
                        .entries
                        .get(&crate::refinement::RefinementKind::Factory)
                        .and_then(|entries| entries.get(spec_id))
                }),
        }?;
        // JSON null is absent, the read every settled seam makes
        // (`refinement::planner`'s dag/machine reads, the kernel's Python
        // writers): a stored `"machine": null` beside a `dag` is the dag
        // form. `Value::Null` is `Some` here without the filter, so the
        // fall-through never reached the `dag` and the preflight read "no
        // declared models" — exempting the dag's selectors from the
        // allowlist and auth checks.
        let arguments = entry
            .arguments
            .get("machine")
            .filter(|value| !value.is_null())
            .or_else(|| entry.arguments.get("dag").filter(|value| !value.is_null()))?;
        let Some(argument_object) = arguments.as_object() else {
            return Some(Vec::new());
        };
        let states = argument_object
            .get("states")
            .or_else(|| argument_object.get("nodes"))?
            .as_array()?;
        let mut subagents: Vec<(Scope, crate::refinement::HarnessEntry)> = Vec::new();
        if let Some(local) = &local {
            if let Some(entries) = local
                .entries
                .get(&crate::refinement::RefinementKind::Subagent)
            {
                for entry in entries.values() {
                    subagents.push((Scope::Local, entry.clone()));
                }
            }
        }
        if let Some(entries) = global
            .entries
            .get(&crate::refinement::RefinementKind::Subagent)
        {
            for entry in entries.values() {
                subagents.push((Scope::Global, entry.clone()));
            }
        }
        let mut selectors: Vec<String> = Vec::new();
        for state in states {
            let Some(subagent) = state.get("subagent") else {
                continue;
            };
            let model = if let Some(inline) = subagent.as_object() {
                inline.get("model").and_then(Value::as_str)
            } else {
                // A harness subagent reference: the metadata carries the
                // spawn settings (the kernel resolves the same way). An
                // unreadable reference (a non-string value, or a name no
                // harness entry carries) is the kernel's own `run()`
                // error, not the preflight's (this read stays
                // best-effort): skip the state, never the whole spec —
                // one unresolved reference must not exempt the other
                // states' declared models from the preflight. A scoped
                // reference (`local:`/`global:`) resolves its own
                // store's entry, exactly like the kernel's harness get.
                //
                // The match order is the kernel's own resolution, tier
                // by tier: the id, then the title, within a tier before
                // the next tier (its harness `get` answers the id before
                // the title scan, and the local store is the
                // unprefixed tier). A global id must not shadow a local
                // title — the old id-first sweep matched the global id
                // while the kernel spawned the local titled subagent,
                // validating (and allowlisting) the wrong model. Among
                // duplicate titles within a tier, the kernel's title
                // scan reads `harness.list`, sorted by (kind, path,
                // title, id), so it picks the (path, id)-least entry —
                // the preflight must pick the same one, not whichever
                // entry the store's map iteration happens to offer.
                let Some(reference) = subagent.as_str() else {
                    continue;
                };
                let (reference_scope, reference) = split_harness_scope(reference);
                let allows = |scope: Scope| match reference_scope {
                    Scope::Any => true,
                    other => other == scope,
                };
                let id_in_tier = |tier: Scope| {
                    subagents.iter().find(|(scope, candidate)| {
                        *scope == tier && allows(*scope) && candidate.id == reference
                    })
                };
                let title_in_tier = |tier: Scope| {
                    subagents
                        .iter()
                        .filter(|(scope, candidate)| {
                            *scope == tier && allows(*scope) && candidate.title == reference
                        })
                        .min_by(|a, b| (&a.1.path, &a.1.id).cmp(&(&b.1.path, &b.1.id)))
                };
                [Scope::Local, Scope::Global]
                    .into_iter()
                    .filter(|tier| allows(*tier))
                    .find_map(|tier| id_in_tier(tier).or_else(|| title_in_tier(tier)))
                    .and_then(|(_, entry)| entry.metadata.get("model"))
                    .and_then(Value::as_str)
            };
            if let Some(model) = model.filter(|model| !model.trim().is_empty()) {
                let model = model.trim().to_string();
                if !selectors.contains(&model) {
                    selectors.push(model);
                }
            }
        }
        Some(selectors)
    }

    /// Preflight one `factory run` from the daemon/TUI lane: every model
    /// selector the spec declares must resolve through the credential-backed
    /// catalog, sit inside the daemon allowlist pin, and carry request auth
    /// — a doomed run fails before any child spawns (the #3184 auth
    /// preflight's factory analogue). States without a declared model ride
    /// the existing spawn-path default chain (resolved per spawn); a spec
    /// this host cannot read passes through to the kernel's own `run()`
    /// validation.
    ///
    /// # Errors
    ///
    /// Returns an error when a declared selector is unavailable,
    /// unauthenticated, or expired, sits outside the allowlist pin, or its
    /// provider credentials are stale.
    pub fn preflight_run(&self, spec_id: &str) -> anyhow::Result<()> {
        let Some(selectors) = self.spec_model_selectors(spec_id) else {
            return Ok(());
        };
        let mut registry = ModelRegistry::create(
            crate::auth::AuthStorage::create(&self.config.agent_dir),
            self.config.agent_dir.join("models.json"),
        );
        registry.load_private_authorization_from_cache();
        let searchable: Vec<AiModel> = registry
            .get_rlm_searchable_models()
            .into_iter()
            .cloned()
            .collect();
        for selector in selectors {
            let model = resolve_declared_model(&searchable, &selector)
                .or_else(|| self.session_model_fallback(&registry, &selector))
                .ok_or_else(|| unavailable_error(&selector))?;
            if let Some(allowlist) = &self.config.allowed_models {
                let pinned = format!("{}/{}", model.provider, model.id).to_lowercase();
                if !crate::models::model_allowed(&pinned, allowlist) {
                    anyhow::bail!(
                        "Requested factory model \"{pinned}\" is blocked by the model allowlist"
                    );
                }
            }
            let resolved = registry.get_api_key_and_headers(&model, model.headers.as_ref());
            if !resolved.ok {
                anyhow::bail!(
                    "Model \"{}/{}\" is not authenticated: {}",
                    model.provider,
                    model.id,
                    resolved.error.as_deref().unwrap_or("no credential found")
                );
            }
        }
        Ok(())
    }

    /// A declared selector naming the session's own model the catalog does
    /// not carry (a scripted or in-memory model): the spawn path resolves
    /// it, so the preflight gates only the stale/expired provider — the
    /// #3184 session-model fallback gate.
    fn session_model_fallback(&self, registry: &ModelRegistry, selector: &str) -> Option<AiModel> {
        let session_model = self.config.session_model.as_ref()?;
        let session_selector = format!("{}/{}", session_model.provider, session_model.id);
        let matches = selector.trim().eq_ignore_ascii_case(&session_selector)
            || is_short_form_selector(selector, &session_selector);
        if !matches {
            return None;
        }
        let status = registry.get_provider_auth_status(&session_model.provider);
        if status.source != Some(crate::auth::types::AuthSource::Stale)
            && status.label.as_deref() != Some("expired")
        {
            return Some(agent_model_to_ai_model(session_model));
        }
        None
    }
}

/// The ai-side view of the session's agent-side model descriptor, for the
/// preflight's allowlist and auth checks only. The two `Model`s do not
/// share a wire shape (the agent side serializes `base_url`, never carries
/// `input`), and the descriptor is lossy by design (no input modalities,
/// thinking-level map, featured flag, request headers, or compat
/// overrides), so full resolution stays with the catalog and the spawn
/// path (the #3184 `provider_adapter::agent_model_to_ai_model` field
/// mapping).
fn agent_model_to_ai_model(model: &pa_agent::types::Model) -> AiModel {
    AiModel {
        id: model.id.clone(),
        name: model.name.clone(),
        api: model.api.clone(),
        provider: model.provider.clone(),
        base_url: model.base_url.clone(),
        reasoning: model.reasoning,
        thinking_level_map: None,
        input: Vec::new(),
        cost: pa_types::ai::ModelCost {
            input: model.cost.input.into(),
            output: model.cost.output.into(),
            cache_read: model.cost.cache_read.into(),
            cache_write: model.cost.cache_write.into(),
        },
        context_window: model.context_window,
        max_tokens: model.max_tokens,
        featured: None,
        headers: None,
        compat: None,
    }
}

/// The exact catalog match over the searchable set, then the TS short form
/// (`_resolveRlmSubagentModel`'s unique-suffix rule): a bare id resolves
/// only while it names exactly one model.
fn resolve_declared_model(searchable: &[AiModel], selector: &str) -> Option<AiModel> {
    if let Some(model) = find_exact_model_reference_match(selector, searchable) {
        return Some(model.clone());
    }
    let short_form: Vec<&AiModel> = searchable
        .iter()
        .filter(|model| {
            is_short_form_selector(selector, &format!("{}/{}", model.provider, model.id))
        })
        .collect();
    match short_form.len() {
        1 => Some(short_form[0].clone()),
        _ => None,
    }
}

/// The TS short form: a reference names a model when the full selector ends
/// with `"/<reference>"`, so a bare id like "glm-5.3" also matches
/// "prime-inference/z-ai/glm-5.3".
fn is_short_form_selector(reference: &str, selector: &str) -> bool {
    let normalized = reference.trim().to_lowercase();
    !normalized.is_empty() && selector.to_lowercase().ends_with(&format!("/{normalized}"))
}

/// The unavailable-model refusal (the TS `formatRlmModelUnavailableError`
/// base wording).
fn unavailable_error(reference: &str) -> anyhow::Error {
    anyhow!(
        "Requested factory model \"{reference}\" is unavailable, unauthenticated, or expired; selectors use the form \"provider/model-id\" (e.g. \"prime-inference/internal/glm-5.3-fast\")"
    )
}

/// One harness store a scoped id routes to (`local:`/`global:` prefixes;
/// unprefixed ids resolve either, local first).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Scope {
    Any,
    Local,
    Global,
}

/// Split the harness's scope prefix off an id, mirroring the kernel
/// harness's `_strip_scope_prefix`: `local:x`/`global:x` route to one
/// store (`x` must be non-empty, or the prefix stays part of the id),
/// anything else is unprefixed.
fn split_harness_scope(id: &str) -> (Scope, &str) {
    if let Some(rest) = id.strip_prefix("local:") {
        if !rest.is_empty() {
            return (Scope::Local, rest);
        }
    }
    if let Some(rest) = id.strip_prefix("global:") {
        if !rest.is_empty() {
            return (Scope::Global, rest);
        }
    }
    (Scope::Any, id)
}

/// The out-of-band request the bridge sends into the kernel, validated
/// host-side before the frame: one action with its target and the watch
/// bound.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FactoryActivityRequest {
    pub action: &'static str,
    pub run_id: Option<String>,
    pub spec_id: Option<String>,
    pub timeout_ms: Option<u64>,
}

impl FactoryActivityRequest {
    /// Parse and validate one daemon command payload. Mirrors the kernel
    /// frame's own validation (the kernel re-validates): a known action,
    /// string targets when present, and a bounded watch timeout.
    ///
    /// # Errors
    ///
    /// Returns an error when the action is unknown, a required target is
    /// missing, or the timeout is outside its bounds.
    pub fn parse(
        action: &str,
        run_id: Option<&str>,
        spec_id: Option<&str>,
        timeout_ms: Option<u64>,
    ) -> anyhow::Result<Self> {
        let Some(action) = FACTORY_ACTIVITY_ACTIONS
            .iter()
            .find(|known| **known == action)
            .copied()
        else {
            return Err(anyhow!("unknown factory activity action"));
        };
        if action == "run" && spec_id.is_none_or(|id| id.trim().is_empty()) {
            return Err(anyhow!("factory activity run requires specId"));
        }
        if action != "graph" && action != "run" && run_id.is_none_or(|id| id.trim().is_empty()) {
            return Err(anyhow!("factory activity {action} requires runId"));
        }
        if let Some(timeout_ms) = timeout_ms {
            if timeout_ms > FACTIVITY_WATCH_TIMEOUT_MS_CAP {
                return Err(anyhow!(
                    "factory activity timeoutMs must be at most {FACTIVITY_WATCH_TIMEOUT_MS_CAP}"
                ));
            }
        }
        Ok(Self {
            action,
            run_id: run_id
                .filter(|id| !id.trim().is_empty())
                .map(str::to_string),
            spec_id: spec_id
                .filter(|id| !id.trim().is_empty())
                .map(str::to_string),
            timeout_ms,
        })
    }
}

// The unit battery lives in the child module (factory_host::tests).
#[cfg(test)]
mod tests;
