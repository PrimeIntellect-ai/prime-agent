//! The `/scoped-models` inline selector (TS `ScopedModelsSelectorComponent`):
//! the checkbox list over the model catalog that picks the models Alt+M
//! cycles through. Session-only changes apply immediately; Ctrl+S persists
//! the selection to settings; Esc closes. The list owns toggle, bulk, and
//! reorder semantics exactly like the TS component.

use crate::keybindings::KeybindingsManager;
use crate::search_input::SearchInput;
use crate::theme::{Theme, ThemeColor};
use pa_types::ai::Model;

/// One key press while the selector is open.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScopedModelsAction {
    None,
    /// A change to apply session-only (TS `onChange`; `None` = all enabled).
    Change {
        enabled_ids: Option<Vec<String>>,
    },
    /// Ctrl+S: persist the selection (TS `onPersist`).
    Persist {
        enabled_ids: Option<Vec<String>>,
    },
    /// Esc, or Ctrl+C with an empty search: close.
    Cancel,
}

/// Whether `id` is enabled (`None` = every model).
fn is_enabled(enabled_ids: &Option<Vec<String>>, id: &str) -> bool {
    enabled_ids
        .as_ref()
        .is_none_or(|enabled| enabled.iter().any(|candidate| candidate == id))
}

/// Toggle one id (TS `toggle`: the first toggle starts from only it).
fn toggle(enabled_ids: &Option<Vec<String>>, id: &str) -> Option<Vec<String>> {
    match enabled_ids {
        None => Some(vec![id.to_string()]),
        Some(enabled) => {
            if enabled.iter().any(|candidate| candidate == id) {
                Some(
                    enabled
                        .iter()
                        .filter(|candidate| *candidate != id)
                        .cloned()
                        .collect(),
                )
            } else {
                Some(
                    enabled
                        .iter()
                        .cloned()
                        .chain(std::iter::once(id.to_string()))
                        .collect(),
                )
            }
        }
    }
}

/// Enable the targets (TS `enableAll`: enabling everything collapses to
/// `None`, the unfiltered state).
fn enable_all(
    enabled_ids: &Option<Vec<String>>,
    all_ids: &[String],
    target_ids: Option<&[String]>,
) -> Option<Vec<String>> {
    let mut result = enabled_ids.clone().unwrap_or_default();
    for id in target_ids.unwrap_or(all_ids) {
        if !result.iter().any(|candidate| candidate == id) {
            result.push(id.clone());
        }
    }
    if result.len() == all_ids.len() {
        None
    } else {
        Some(result)
    }
}

/// Disable the targets (TS `clearAll`).
fn clear_all(
    enabled_ids: &Option<Vec<String>>,
    all_ids: &[String],
    target_ids: Option<&[String]>,
) -> Option<Vec<String>> {
    let targets: Vec<String> = match target_ids {
        Some(targets) => targets.to_vec(),
        None => match enabled_ids {
            None => all_ids.to_vec(),
            Some(enabled) => enabled.clone(),
        },
    };
    match enabled_ids {
        None => Some(
            all_ids
                .iter()
                .filter(|id| !targets.contains(id))
                .cloned()
                .collect(),
        ),
        Some(enabled) => Some(
            enabled
                .iter()
                .filter(|id| !targets.contains(id))
                .cloned()
                .collect(),
        ),
    }
}

/// Move one id within the enabled order (TS `move`).
fn move_id(enabled_ids: &[String], id: &str, delta: isize) -> Vec<String> {
    let mut list = enabled_ids.to_vec();
    let Some(index) = list.iter().position(|candidate| candidate == id) else {
        return list;
    };
    let new_index = index as isize + delta;
    if new_index < 0 || new_index >= list.len() as isize {
        return list;
    }
    list.swap(index, new_index as usize);
    list
}

/// The enabled-first id order (TS `getSortedIds`).
fn sorted_ids(enabled_ids: &Option<Vec<String>>, all_ids: &[String]) -> Vec<String> {
    match enabled_ids {
        None => all_ids.to_vec(),
        Some(enabled) => enabled
            .iter()
            .cloned()
            .chain(
                all_ids
                    .iter()
                    .filter(|id| {
                        !enabled
                            .iter()
                            .any(|candidate| candidate.as_str() == id.as_str())
                    })
                    .cloned(),
            )
            .collect(),
    }
}

/// Whether a pattern contains glob metacharacters (TS
/// `resolveModelScopeFromModels` switches on `*`, `?`, `[`).
fn is_glob(pattern: &str) -> bool {
    pattern.contains('*') || pattern.contains('?') || pattern.contains('[')
}

/// One glob pattern against a candidate (minimatch's practical subset —
/// `*`, `?`, and bracket classes, case-insensitive; `.` is literal).
fn glob_matches(pattern: &str, candidate: &str) -> bool {
    fn inner(pattern: &[char], candidate: &[char]) -> bool {
        if pattern.is_empty() {
            return candidate.is_empty();
        }
        match pattern[0] {
            '*' => {
                // `*` spans separators too (minimatch without the
                // `nostar` option).
                for skip in 0..=candidate.len() {
                    if inner(&pattern[1..], &candidate[skip..]) {
                        return true;
                    }
                }
                false
            }
            '?' => !candidate.is_empty() && inner(&pattern[1..], &candidate[1..]),
            '[' => {
                let Some(close) = pattern.iter().position(|c| *c == ']') else {
                    return false;
                };
                let mut body = &pattern[1..close];
                let negated = body[0] == '^' || body[0] == '!';
                if negated {
                    body = &body[1..];
                }
                if candidate.is_empty() {
                    return false;
                }
                let character = candidate[0];
                let mut matched = false;
                let mut index = 0;
                while index < body.len() {
                    if index + 2 < body.len() && body[index + 1] == '-' {
                        if character >= body[index] && character <= body[index + 2] {
                            matched = true;
                        }
                        index += 3;
                    } else {
                        if character == body[index] {
                            matched = true;
                        }
                        index += 1;
                    }
                }
                if matched != negated {
                    inner(&pattern[close + 1..], &candidate[1..])
                } else {
                    false
                }
            }
            literal => {
                !candidate.is_empty()
                    && literal.eq_ignore_ascii_case(&candidate[0])
                    && inner(&pattern[1..], &candidate[1..])
            }
        }
    }
    let pattern: Vec<char> = pattern.chars().collect();
    let candidate: Vec<char> = candidate.chars().collect();
    inner(&pattern, &candidate)
}

/// The enabled-models patterns resolved over the catalog (TS
/// `resolveModelScopeFromModels`): glob patterns match `provider/id` and
/// the bare id; plain entries are exact `provider/id` keys (with an
/// optional `:thinking` suffix this surface keeps verbatim on the id
/// match). The result keeps the catalog order of the matched models.
pub fn resolve_pattern_scope(patterns: &[String], models: &[Model]) -> Vec<String> {
    let mut result: Vec<String> = Vec::new();
    for pattern in patterns {
        // An optional trailing `:thinking` suffix scopes the thinking
        // level; the picker resolves the model identity only.
        let mut scope_pattern = pattern.as_str();
        if let Some((rest, suffix)) = pattern.rsplit_once(':') {
            if !rest.is_empty() && suffix.chars().all(|c| c.is_ascii_lowercase()) {
                scope_pattern = rest;
            }
        }
        let matched = models.iter().filter(|model| {
            let full_id = format!("{}/{}", model.provider, model.id);
            if is_glob(scope_pattern) {
                glob_matches(scope_pattern, &full_id) || glob_matches(scope_pattern, &model.id)
            } else {
                full_id == scope_pattern
            }
        });
        for model in matched {
            let full_id = format!("{}/{}", model.provider, model.id);
            if !result.contains(&full_id) {
                result.push(full_id);
            }
        }
    }
    result
}

/// One catalog row keyed by the full id.
#[derive(Debug, Clone, PartialEq, Eq)]
struct CatalogRow {
    full_id: String,
    model_id: String,
    provider: String,
    name: String,
}

/// One filtered list row.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ScopedItem {
    full_id: String,
    model_id: String,
    provider: String,
    name: String,
    enabled: bool,
}

/// The selector state (TS `ScopedModelsSelectorComponent`).
#[derive(Debug)]
pub struct ScopedModelsSelector {
    rows: Vec<CatalogRow>,
    all_ids: Vec<String>,
    enabled_ids: Option<Vec<String>>,
    filtered: Vec<ScopedItem>,
    selected: usize,
    search: SearchInput,
    dirty: bool,
    /// TS `maxVisible` (the component is constructed with 8).
    max_visible: usize,
}

impl ScopedModelsSelector {
    /// Build over the catalog (TS `ModelsConfig`): `enabled_model_ids` is
    /// `None` when every model is enabled.
    pub fn new(models: &[Model], enabled_model_ids: Option<Vec<String>>) -> ScopedModelsSelector {
        let mut selector = ScopedModelsSelector {
            rows: models
                .iter()
                .map(|model| CatalogRow {
                    full_id: format!("{}/{}", model.provider, model.id),
                    model_id: model.id.clone(),
                    provider: model.provider.clone(),
                    name: model.name.clone(),
                })
                .collect(),
            all_ids: models
                .iter()
                .map(|model| format!("{}/{}", model.provider, model.id))
                .collect(),
            enabled_ids: enabled_model_ids,
            filtered: Vec::new(),
            selected: 0,
            search: SearchInput::new(),
            dirty: false,
            max_visible: 8,
        };
        selector.refresh();
        selector
    }

    /// Rebuild the filtered rows (TS `refresh`: the fuzzy filter matches
    /// `model.id model.provider`; the selection clamps or resets when the
    /// query changed).
    fn refresh(&mut self) {
        let query = self.search.value();
        let items: Vec<ScopedItem> = sorted_ids(&self.enabled_ids, &self.all_ids)
            .into_iter()
            .filter_map(|full_id| {
                // Filter out ids that no longer have a model (e.g. after
                // logout) — TS `buildItems`.
                let row = self.rows.iter().find(|row| row.full_id == full_id)?;
                Some(ScopedItem {
                    full_id: row.full_id.clone(),
                    model_id: row.model_id.clone(),
                    provider: row.provider.clone(),
                    name: row.name.clone(),
                    enabled: is_enabled(&self.enabled_ids, &row.full_id),
                })
            })
            .collect();
        self.filtered = if query.is_empty() {
            items
        } else {
            let text = format!("{query} ");
            let _ = text;
            crate::fuzzy::fuzzy_filter(&items, query, |item| {
                format!("{} {}", item.model_id, item.provider)
            })
        };
        self.selected = self.selected.min(self.filtered.len().saturating_sub(1));
    }

    /// Report the change to the caller (TS `notifyChange`).
    fn change(&self) -> ScopedModelsAction {
        ScopedModelsAction::Change {
            enabled_ids: self.enabled_ids.clone(),
        }
    }

    /// One key id (TS `handleInput`).
    pub fn handle_key(&mut self, key: &str, kb: &KeybindingsManager) -> ScopedModelsAction {
        if kb.matches(key, "tui.select.up") {
            if !self.filtered.is_empty() {
                self.selected = if self.selected == 0 {
                    self.filtered.len() - 1
                } else {
                    self.selected - 1
                };
            }
            return ScopedModelsAction::None;
        }
        if kb.matches(key, "tui.select.down") {
            if !self.filtered.is_empty() {
                self.selected = (self.selected + 1) % self.filtered.len();
            }
            return ScopedModelsAction::None;
        }
        let reorder_up = kb.matches(key, "app.models.reorderUp");
        let reorder_down = kb.matches(key, "app.models.reorderDown");
        if reorder_up || reorder_down {
            // TS reorders only enabled models and moves the selection with
            // the row.
            if self.enabled_ids.is_some() {
                if let Some(item) = self.filtered.get(self.selected) {
                    if is_enabled(&self.enabled_ids, &item.full_id) {
                        let delta = if reorder_up { -1 } else { 1 };
                        let index = self
                            .enabled_ids
                            .as_ref()
                            .and_then(|enabled| {
                                enabled
                                    .iter()
                                    .position(|candidate| candidate == &item.full_id)
                            })
                            .map(|index| index as isize + delta);
                        if let Some(new_index) = index {
                            if new_index >= 0
                                && (new_index as usize)
                                    < self.enabled_ids.as_ref().map_or(0, Vec::len)
                            {
                                self.enabled_ids = Some(move_id(
                                    self.enabled_ids.as_deref().unwrap_or(&[]),
                                    &item.full_id,
                                    delta,
                                ));
                                self.dirty = true;
                                self.selected = (self.selected as isize + delta).max(0) as usize;
                                self.refresh();
                                return self.change();
                            }
                        }
                    }
                }
            }
            return ScopedModelsAction::None;
        }
        if kb.matches(key, "tui.select.confirm") {
            if let Some(item) = self.filtered.get(self.selected).cloned() {
                self.enabled_ids = toggle(&self.enabled_ids, &item.full_id);
                self.dirty = true;
                self.refresh();
                return self.change();
            }
            return ScopedModelsAction::None;
        }
        if kb.matches(key, "app.models.enableAll") {
            let targets = (!self.search.value().is_empty()).then(|| {
                self.filtered
                    .iter()
                    .map(|item| item.full_id.clone())
                    .collect::<Vec<_>>()
            });
            self.enabled_ids = enable_all(&self.enabled_ids, &self.all_ids, targets.as_deref());
            self.dirty = true;
            self.refresh();
            return self.change();
        }
        if kb.matches(key, "app.models.clearAll") {
            let targets = (!self.search.value().is_empty()).then(|| {
                self.filtered
                    .iter()
                    .map(|item| item.full_id.clone())
                    .collect::<Vec<_>>()
            });
            self.enabled_ids = clear_all(&self.enabled_ids, &self.all_ids, targets.as_deref());
            self.dirty = true;
            self.refresh();
            return self.change();
        }
        if kb.matches(key, "app.models.toggleProvider") {
            if let Some(item) = self.filtered.get(self.selected).cloned() {
                let provider_ids: Vec<String> = self
                    .rows
                    .iter()
                    .filter(|row| row.provider == item.provider)
                    .map(|row| row.full_id.clone())
                    .collect();
                let all_enabled = provider_ids
                    .iter()
                    .all(|id| is_enabled(&self.enabled_ids, id));
                self.enabled_ids = if all_enabled {
                    clear_all(&self.enabled_ids, &self.all_ids, Some(&provider_ids))
                } else {
                    enable_all(&self.enabled_ids, &self.all_ids, Some(&provider_ids))
                };
                self.dirty = true;
                self.refresh();
                return self.change();
            }
            return ScopedModelsAction::None;
        }
        if kb.matches(key, "app.models.save") {
            self.dirty = false;
            return ScopedModelsAction::Persist {
                enabled_ids: self.enabled_ids.clone(),
            };
        }
        if key == "ctrl+c" {
            if !self.search.value().is_empty() {
                self.search.set_value("");
                self.refresh();
                return ScopedModelsAction::None;
            }
            return ScopedModelsAction::Cancel;
        }
        if kb.matches(key, "tui.select.cancel") {
            return ScopedModelsAction::Cancel;
        }
        // Everything else edits the search field.
        self.search.handle_key(key, kb);
        self.refresh();
        ScopedModelsAction::None
    }

    /// Render (TS `render`): border, title, the save hint, the search
    /// field, the windowed checkbox rows, the model-name line, the footer,
    /// border.
    pub fn render(&self, theme: &Theme, width: usize, kb: &KeybindingsManager) -> Vec<crate::Line> {
        let border = theme.fg_style(ThemeColor::Border);
        let accent = theme.fg_style(ThemeColor::Accent);
        let muted = theme.fg_style(ThemeColor::Muted);
        let dim = theme.fg_style(ThemeColor::Dim);
        let success = theme.fg_style(ThemeColor::Success);
        let key = |binding: &str| {
            kb.get_keys(binding)
                .iter()
                .map(|key| crate::keybindings::format_key_text(key))
                .collect::<Vec<_>>()
                .join("/")
        };
        let mut rows: Vec<crate::Line> = Vec::new();
        rows.push(vec![crate::Span::styled("─".repeat(width.max(1)), border)]);
        rows.push(Vec::new());
        rows.push(vec![
            theme.fg_span(ThemeColor::Accent, "Model Configuration".to_string())
        ]);
        rows.push(vec![
            crate::Span::raw("Session-only. ".to_string()),
            crate::Span::styled(
                format!("{} to save to settings.", key("app.models.save")),
                muted,
            ),
        ]);
        rows.push(Vec::new());
        rows.push(self.search_field(theme));
        rows.push(Vec::new());
        if self.filtered.is_empty() {
            rows.push(vec![theme.fg(ThemeColor::Muted, "  No matching models")]);
        } else {
            let start = self
                .selected
                .saturating_sub(self.max_visible / 2)
                .min(self.filtered.len().saturating_sub(self.max_visible));
            let end = (start + self.max_visible).min(self.filtered.len());
            let all_enabled = self.enabled_ids.is_none();
            for (position, item) in self.filtered[start..end].iter().enumerate() {
                let position = start + position;
                let selected = position == self.selected;
                let mut line: crate::Line = Vec::new();
                if selected {
                    line.push(crate::Span::styled("› ".to_string(), accent));
                    line.push(crate::Span::styled(item.model_id.clone(), accent));
                } else {
                    line.push(crate::Span::raw("  ".to_string()));
                    line.push(crate::Span::raw(item.model_id.clone()));
                }
                line.push(crate::Span::styled(format!(" [{}]", item.provider), muted));
                if !all_enabled {
                    line.push(if item.enabled {
                        crate::Span::styled(" ✓".to_string(), success)
                    } else {
                        crate::Span::styled(" ✗".to_string(), dim)
                    });
                }
                rows.push(line);
            }
            if start > 0 || end < self.filtered.len() {
                rows.push(vec![theme.fg(
                    ThemeColor::Muted,
                    format!("  ({}/{})", self.selected + 1, self.filtered.len()),
                )]);
            }
            if let Some(selected) = self.filtered.get(self.selected) {
                rows.push(Vec::new());
                rows.push(vec![theme.fg(
                    ThemeColor::Muted,
                    format!("  Model Name: {}", selected.name),
                )]);
            }
        }
        rows.push(Vec::new());
        // The footer (TS `getFooterText`).
        let enabled_count = self
            .enabled_ids
            .as_ref()
            .map_or(self.all_ids.len(), Vec::len);
        let count_text = if self.enabled_ids.is_none() {
            "all enabled".to_string()
        } else {
            format!("{enabled_count}/{} enabled", self.all_ids.len())
        };
        let parts = format!(
            "  {} toggle · {} all · {} clear · {} provider · {}/{} reorder · {} save · {} ",
            key("tui.select.confirm"),
            key("app.models.enableAll"),
            key("app.models.clearAll"),
            key("app.models.toggleProvider"),
            key("app.models.reorderUp"),
            key("app.models.reorderDown"),
            key("app.models.save"),
            count_text,
        );
        if self.dirty {
            rows.push(vec![
                crate::Span::styled(parts, dim),
                crate::Span::styled("(unsaved)".to_string(), theme.fg_style(ThemeColor::Warning)),
            ]);
        } else {
            rows.push(vec![crate::Span::styled(parts, dim)]);
        }
        rows.push(vec![crate::Span::styled("─".repeat(width.max(1)), border)]);
        rows
    }

    /// The search field row (the SearchInput's value with its cursor).
    fn search_field(&self, theme: &Theme) -> crate::Line {
        let value = self.search.value();
        let cursor = self.search.cursor();
        let chars: Vec<char> = value.chars().collect();
        let before: String = chars[..cursor.min(chars.len())].iter().collect();
        let at: String = chars.get(cursor).map(|c| c.to_string()).unwrap_or_default();
        let after: String = chars[(cursor + 1).min(chars.len())..].iter().collect();
        let cursor_style = theme
            .bg_style(crate::theme::ThemeBg::SelectedBg)
            .add_modifier(ratatui::style::Modifier::REVERSED);
        vec![
            crate::Span::raw(before),
            crate::Span::styled(at, cursor_style),
            crate::Span::raw(after),
        ]
    }
}

#[cfg(test)]
mod glob_tests {
    use super::*;

    #[test]
    fn glob_patterns_match_full_and_bare_ids() {
        assert!(glob_matches("anthropic/*", "anthropic/claude-5"));
        assert!(glob_matches("*sonnet*", "anthropic/claude-sonnet-5"));
        assert!(!glob_matches("openai/*", "anthropic/claude-5"));
        assert!(glob_matches("gpt-5.?*", "gpt-5.4"));
        assert!(glob_matches("[ab]*", "bclaude"));
        assert!(!glob_matches("[ab]*", "cclaude"));
    }

    #[test]
    fn pattern_scope_resolves_globs_and_exact_keys() {
        let models: Vec<Model> = serde_json::from_value(serde_json::json!([
            { "id": "claude-5", "name": "Claude 5", "api": "anthropic", "provider": "anthropic",
              "baseUrl": "", "reasoning": false, "input": ["text"],
              "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
              "contextWindow": 1000, "maxTokens": 10 },
            { "id": "gpt-5.4", "name": "GPT", "api": "openai-responses", "provider": "openai",
              "baseUrl": "", "reasoning": false, "input": ["text"],
              "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
              "contextWindow": 1000, "maxTokens": 10 }
        ]))
        .expect("models");
        let scope = resolve_pattern_scope(
            &["anthropic/*".to_string(), "openai/gpt-5.4:high".to_string()],
            &models,
        );
        assert_eq!(scope, vec!["anthropic/claude-5", "openai/gpt-5.4"]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kb() -> KeybindingsManager {
        KeybindingsManager::new()
    }

    fn model(provider: &str, id: &str) -> Model {
        serde_json::from_value(serde_json::json!({
            "id": id,
            "name": format!("{id} model"),
            "api": "anthropic",
            "provider": provider,
            "baseUrl": "",
            "reasoning": false,
            "input": ["text"],
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
            "contextWindow": 100000,
            "maxTokens": 1000
        }))
        .expect("model")
    }

    fn ids(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn toggle_starts_from_only_the_first_model() {
        assert_eq!(toggle(&None, "a/2"), Some(ids(&["a/2"])));
        let enabled = toggle(&None, "a/2");
        assert_eq!(toggle(&enabled, "a/1"), Some(ids(&["a/2", "a/1"])));
    }

    #[test]
    fn enable_all_collapses_to_none() {
        let all = ids(&["a/1", "a/2"]);
        let enabled = Some(ids(&["a/1"]));
        assert_eq!(enable_all(&enabled, &all, None), None);
        assert_eq!(
            clear_all(&None, &all, Some(&ids(&["a/1"]))),
            Some(ids(&["a/2"]))
        );
    }

    #[test]
    fn sorted_ids_enabled_first() {
        let all = ids(&["a/1", "a/2", "b/3"]);
        let enabled = Some(ids(&["b/3"]));
        assert_eq!(sorted_ids(&enabled, &all), ids(&["b/3", "a/1", "a/2"]));
    }

    #[test]
    fn confirm_toggles_and_persists_key_saves() {
        let models = vec![model("a", "one"), model("b", "two")];
        let mut selector = ScopedModelsSelector::new(&models, None);
        // Enter on the first row: only it enabled.
        assert_eq!(
            selector.handle_key("enter", &kb()),
            ScopedModelsAction::Change {
                enabled_ids: Some(vec!["a/one".to_string()])
            }
        );
        // The reorder keys move an enabled row.
        selector.handle_key("down", &kb());
        assert_eq!(
            selector.handle_key("ctrl+alt+up", &kb()),
            ScopedModelsAction::None
        );
        // Ctrl+S persists.
        assert_eq!(
            selector.handle_key("ctrl+s", &kb()),
            ScopedModelsAction::Persist {
                enabled_ids: Some(vec!["a/one".to_string()])
            }
        );
        // Esc closes.
        assert_eq!(
            selector.handle_key("esc", &kb()),
            ScopedModelsAction::Cancel
        );
    }
}
