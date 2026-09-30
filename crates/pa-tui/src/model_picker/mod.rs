//! The `/model` inline selector: the TS `ModelSelectorComponent` inline
//! panel — a bordered "Search models" field over `›`-marker rows that carry
//! effort squares and a right-aligned `current · provider` trailing, a
//! price-detail block for the selection, and the model/effort key hint.
//! The daemon supplies the catalog (bundled fallback); this module owns
//! ordering, filtering, effort state, and the inline geometry.

mod render;

use std::collections::{HashMap, HashSet};

use pa_types::ai::{
    clamp_thinking_level, get_supported_thinking_levels, Model, ModelThinkingLevel,
    PRIME_INFERENCE_PROVIDER_ID,
};

use crate::keybindings::KeybindingsManager;
use crate::search_input::SearchInput;
use crate::theme::Theme;

/// The session's current model, matched against the catalog (the TS
/// `modelsAreEqual` key: provider plus id).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CurrentModel {
    pub provider: String,
    pub model_id: String,
}

/// The model Enter applies, plus the effort the user edited (if any).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelSelectionApplied {
    pub provider: String,
    pub model_id: String,
    pub effort: Option<String>,
}

/// One key press while the picker is open.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ModelPickerAction {
    /// Enter on a model: the caller applies it.
    Apply(Box<ModelSelectionApplied>),
    /// Esc, Ctrl+C, or back: close without applying.
    Cancel,
    /// Navigation, filtering, or effort editing only.
    None,
    /// The scope key toggled the picker's list (the caller reports the
    /// adoption event; the picker stays mounted).
    ScopeToggled { scoped: bool },
}

/// The outcome of dispatching `/model [search]`.
#[derive(Debug)]
pub(crate) enum ModelCommandOutcome {
    /// Open the picker over the catalog.
    Open(Box<ModelPicker>),
}

/// The catalog snapshot plus the client state the picker needs (TS
/// `ModelSelectorOptions` inline subset).
#[derive(Debug, Default)]
pub struct ModelPickerOptions {
    /// The full catalog (bundled or daemon-refreshed); the picker owns its
    /// order.
    pub models: Vec<Model>,
    /// The session's model, checked `current` and leading the list.
    pub current: Option<CurrentModel>,
    /// Providers with configured auth (the daemon catalog's
    /// `configuredProviders`).
    pub configured_providers: HashSet<String>,
    /// The settings recent-model list (`provider/id` keys, newest first).
    pub recent_models: Vec<String>,
    /// The session's scoped models as `provider/id` keys (TS the
    /// selector's `scopedModels` option): the picker opens on them when
    /// non-empty; empty keeps the full catalog. The keys resolve against
    /// the loaded catalog at open and on every refresh — an entry missing
    /// from the loaded catalog is not listed.
    pub scoped_models: Vec<String>,
    /// The effort a fresh selection starts from (TS `thinkingLevel`).
    pub thinking_level: Option<ModelThinkingLevel>,
    /// The viewport height the list sizes itself against (already the TS
    /// `getRows` value: one row less than the dock's row budget).
    pub viewport_rows: usize,
}

mod scope;
mod search;
mod sort;

use scope::ModelScope;
use search::{score_model_search, SearchMatch};
use sort::{natural_cmp, version_desc, version_key};

#[cfg(test)]
mod tests;

/// Effort-column layout for the visible window (TS `EffortLayout`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct EffortLayout {
    name_column: usize,
    square_slots: usize,
    gap: usize,
    label_width: usize,
    show_label: bool,
    show_cluster: bool,
}

/// One picker over the model catalog.
#[derive(Debug)]
pub struct ModelPicker {
    /// The sorted catalog (`sortModels` order).
    all_models: Vec<Model>,
    current: Option<CurrentModel>,
    configured_providers: HashSet<String>,
    recent_rank: HashMap<String, usize>,
    /// The effort a fresh selection starts from; `None` mirrors TS
    /// `undefined` (resolved to "off" per model).
    initial_thinking_level: Option<ModelThinkingLevel>,
    /// The viewport row budget (TS `getRows`).
    viewport_rows: usize,
    search: SearchInput,
    filtered: Vec<usize>,
    selected: usize,
    /// True once the user moves into the list; left/right then adjust the
    /// highlighted model's effort instead of the search cursor.
    navigated_into_list: bool,
    /// Resolved effort per model key, seeded for every catalog entry with a
    /// thinking surface (TS `effortLevels`).
    effort_levels: HashMap<String, ModelThinkingLevel>,
    /// Models whose effort the user edited (Enter passes the effort only
    /// for these; TS `editedEffortModels`).
    edited_effort: HashSet<String>,
    render_width: usize,
    /// Cached inline list layout (recomputed on render).
    visible_items: usize,
    /// The query the filtered view was built for (TS `searchQuery`).
    last_query: String,
    /// The session's scoped list as `provider/id` keys (TS
    /// `scopedModelItems`); empty is the unscoped picker.
    scoped_models: Vec<String>,
    /// The scoped entries' positions in `all_models`, in the scoped
    /// list's own order (the scoped view keeps the session's scope
    /// order, not the catalog's sorted one).
    scoped_positions: Vec<usize>,
    /// The active list (TS `scope`): `Scoped` while the session holds
    /// scoped models, else the full catalog.
    scope: ModelScope,
    /// The version runs parsed from each `all_models` entry's id, indexed
    /// alike (the search sort's recency tier: the catalog carries no
    /// release-date metadata, so the id's version stands in for release
    /// recency).
    version_keys: Vec<Vec<String>>,
}

impl ModelPicker {
    /// Build the picker: sort the catalog, resolve the per-model effort
    /// defaults, then show everything unfiltered.
    #[must_use]
    pub fn new(options: ModelPickerOptions) -> Self {
        let mut picker = ModelPicker {
            all_models: Vec::new(),
            current: options.current,
            configured_providers: options.configured_providers,
            recent_rank: options
                .recent_models
                .iter()
                .enumerate()
                .map(|(index, key)| (key.clone(), index))
                .collect(),
            initial_thinking_level: options.thinking_level,
            viewport_rows: options.viewport_rows,
            search: SearchInput::new(),
            filtered: Vec::new(),
            selected: 0,
            navigated_into_list: false,
            effort_levels: HashMap::new(),
            edited_effort: HashSet::new(),
            render_width: 80,
            visible_items: 8,
            last_query: String::new(),
            scoped_models: options.scoped_models,
            scoped_positions: Vec::new(),
            scope: ModelScope::All,
            version_keys: Vec::new(),
        };
        picker.load_models(options.models);
        picker.resolve_scope_positions();
        // TS the selector constructor (:231): the picker opens scoped
        // while the session holds scoped models.
        if picker.has_scoped_models() {
            picker.scope = ModelScope::Scoped;
        }
        let query = picker.search.value().to_string();
        picker.filter_models(&query);
        // TS `loadModels` (:373-375): the current model re-selects inside
        // the active list (the scoped view orders by the session's
        // scope, not the catalog's sort).
        if matches!(picker.scope, ModelScope::Scoped) {
            picker.select_current_or_top();
        }
        picker
    }

    /// The active filter query.
    #[must_use]
    pub fn query(&self) -> &str {
        self.search.value()
    }

    /// Replace the catalog snapshot (the daemon refresh landing; TS
    /// `updateState`): re-sort, re-filter with the live query, and keep the
    /// selection on the same model when it survived the refresh.
    pub fn update_state(
        &mut self,
        current: Option<CurrentModel>,
        models: Vec<Model>,
        configured_providers: HashSet<String>,
    ) {
        self.current = current;
        self.configured_providers = configured_providers;
        let selected_key = self
            .selected_model()
            .map(|model| Self::model_key_provider(&model.provider, &model.id));
        self.load_models(models);
        // The catalog refresh re-resolves the scoped keys against it: an
        // entry missing from the loaded catalog is not listed, and one
        // the refresh brings appears (the earlier map could only run
        // against what had loaded).
        self.resolve_scope_positions();
        let query = self.search.value().to_string();
        self.filter_models(&query);
        if let Some(key) = selected_key {
            if let Some(index) = self
                .filtered
                .iter()
                .position(|&index| self.key_at(index) == key)
            {
                self.selected = index;
            }
        }
    }

    /// One key id. Cancel keys close without applying; Enter applies the
    /// selection (plus the user-edited effort); everything else navigates,
    /// edits the filter, or adjusts effort.
    pub fn handle_key(&mut self, key: &str, kb: &KeybindingsManager) -> ModelPickerAction {
        // The full-screen selector loop treats Ctrl+C as process exit; the
        // in-chat overlay only cancels, like the TS model selector.
        if key == "ctrl+c" {
            return ModelPickerAction::Cancel;
        }
        // TS model-selector `handleInput` checks the scope toggle first (:704). It
        // toggles only with scoped entries (else the key is a no-op), re-filters,
        // and re-selects the current model, else the top (TS `setScope`).
        if kb.matches(key, "app.model.toggleScope")
            || kb.matches_option_composed(key, "app.model.toggleScope")
        {
            if self.has_scoped_models() {
                self.scope = match self.scope {
                    ModelScope::All => ModelScope::Scoped,
                    ModelScope::Scoped => ModelScope::All,
                };
                let query = self.search.value().to_string();
                self.filter_models(&query);
                self.select_current_or_top();
                return ModelPickerAction::ScopeToggled {
                    scoped: self.scoped_side(),
                };
            }
            return ModelPickerAction::None;
        }
        // Keep arrows available for editing a filter; an empty filter or an
        // explicit move into the list controls effort.
        if self.search.value().is_empty() || self.navigated_into_list {
            for (binding, direction) in
                [("tui.editor.cursorLeft", -1), ("tui.editor.cursorRight", 1)]
            {
                if kb.matches(key, binding) {
                    if let Some(model) = self.selected_model().cloned() {
                        if self.adjust_effort(&model, direction) {
                            return ModelPickerAction::None;
                        }
                    }
                }
            }
        }
        if kb.matches(key, "tui.select.up") {
            let count = self.filtered.len();
            if count > 0 {
                self.navigated_into_list = true;
                self.selected = if self.selected == 0 {
                    count - 1
                } else {
                    self.selected - 1
                };
            }
            return ModelPickerAction::None;
        }
        if kb.matches(key, "tui.select.down") {
            let count = self.filtered.len();
            if count > 0 {
                self.navigated_into_list = true;
                self.selected = if self.selected == count - 1 {
                    0
                } else {
                    self.selected + 1
                };
            }
            return ModelPickerAction::None;
        }
        if kb.matches(key, "tui.select.pageUp") || kb.matches(key, "tui.select.pageDown") {
            let direction = if kb.matches(key, "tui.select.pageUp") {
                -(self.visible_items as isize)
            } else {
                self.visible_items as isize
            };
            self.navigated_into_list = true;
            let count = self.filtered.len();
            if count > 0 {
                let target = self.selected as isize + direction;
                self.selected = target.clamp(0, count as isize - 1) as usize;
            }
            return ModelPickerAction::None;
        }
        if kb.matches(key, "tui.select.confirm") {
            return self.confirm();
        }
        if kb.matches(key, "tui.select.cancel") || self.should_treat_as_back(kb, key) {
            return ModelPickerAction::Cancel;
        }
        // Everything else edits the search field.
        let previous = self.search.value().to_string();
        self.search.handle_key(key, kb);
        if self.search.value() != previous {
            self.navigated_into_list = false;
            let query = self.search.value().to_string();
            self.filter_models(&query);
        }
        ModelPickerAction::None
    }

    /// The picked frame (the inline panel: bordered search field, rows,
    /// scroll indicator, selection detail, hint).
    pub fn render(
        &mut self,
        theme: &Theme,
        width: usize,
        kb: &KeybindingsManager,
    ) -> Vec<crate::Line> {
        render::render(self, theme, width, kb)
    }

    /// The inline list layout for the current width (TS
    /// `updateResponsiveLayout`, inline shape). The frame's trailing
    /// blank row (the operator's 2026-09-24 spacing directive) rides the
    /// reserved rows: the list shrinks first on a height-limited
    /// terminal, never the frame's own head (a front-crop would hide the
    /// bordered search field).
    pub(crate) fn list_layout(&self) -> usize {
        let detail_rows = self.detail_rows();
        crate::menu_panel::menu_list_layout(
            Some(self.viewport_rows),
            8,
            self.filtered.len(),
            // The frame's fixed rows plus the scope row when the session
            // has scoped models (TS `reservedRows` counts `scopeRows`,
            // model-selector.ts:807).
            4 + usize::from(self.has_scoped_models()) + detail_rows,
            1,
        )
    }

    pub(crate) fn detail_rows(&self) -> usize {
        let detail_rows = if self.render_width >= 58 { 4 } else { 5 };
        // The fixed floor is the search field (3), the scroll row (1),
        // the hint (1), and the trailing blank (1): the detail block
        // needs that plus its own rows to render at all.
        if self.viewport_rows >= 6 + detail_rows {
            detail_rows
        } else {
            0
        }
    }

    pub(crate) fn set_render_width(&mut self, width: usize) {
        self.render_width = width;
    }

    pub(crate) fn set_visible_items(&mut self, visible: usize) {
        self.visible_items = visible;
    }

    /// The list's visible-row budget at the current width.
    #[must_use]
    pub fn visible_items(&self) -> usize {
        self.visible_items
    }

    pub(crate) fn selected_model(&self) -> Option<&Model> {
        self.all_models.get(*self.filtered.get(self.selected)?)
    }

    /// The catalog index behind one filtered position.
    pub(crate) fn filtered_index(&self, position: usize) -> Option<usize> {
        self.filtered.get(position).copied()
    }

    pub(crate) fn filtered_len(&self) -> usize {
        self.filtered.len()
    }

    pub(crate) fn filtered_window(&self) -> (usize, usize) {
        let max_visible = self.visible_items.max(1);
        let selected_index = self.selected.min(self.filtered.len().saturating_sub(1));
        let start = selected_index
            .saturating_sub(max_visible / 2)
            .min(self.filtered.len().saturating_sub(max_visible));
        let end = (start + max_visible).min(self.filtered.len());
        (start, end)
    }

    pub(crate) fn selected_index(&self) -> usize {
        self.selected.min(self.filtered.len().saturating_sub(1))
    }

    /// Move the selection to one filtered position (the click grammar's
    /// row select — the arrow keys' exact movement, no apply): a
    /// position past the filtered list keeps the selection where it
    /// was. A click lands the user in the list, so the arrow keys
    /// adjust the clicked row's effort instead of editing the search
    /// (the same flag the arrow paths set).
    pub(crate) fn select_filtered(&mut self, position: usize) {
        if position < self.filtered.len() {
            self.selected = position;
            self.navigated_into_list = true;
        }
    }

    /// The provider-sorted catalog (TS `sortModels`): configured providers
    /// first, signed-in Prime Inference pinned, the current model leading,
    /// then the recent-use rank, the provider name, `featured`, and the
    /// numeric id compare.
    fn load_models(&mut self, models: Vec<Model>) {
        let mut models = models;
        models.sort_by(|a, b| self.compare(a, b));
        self.all_models = models;
        self.version_keys = self
            .all_models
            .iter()
            .map(|model| version_key(&model.id))
            .collect();
        self.resolve_effort_defaults();
        let current_index = self
            .all_models
            .iter()
            .position(|model| self.is_current(model));
        match current_index {
            Some(index) => self.selected = index,
            None => {
                self.selected = self.selected.min(self.filtered.len().saturating_sub(1));
            }
        }
    }

    fn compare(&self, a: &Model, b: &Model) -> std::cmp::Ordering {
        use std::cmp::Ordering;
        // Configured providers first.
        let configured = |model: &Model| self.configured_providers.contains(&model.provider);
        match (configured(b), configured(a)) {
            (true, false) => return Ordering::Greater,
            (false, true) => return Ordering::Less,
            _ => {}
        }
        // Signed-in Prime Inference pinned above the rest.
        let pinned =
            |model: &Model| model.provider == PRIME_INFERENCE_PROVIDER_ID && configured(model);
        match (pinned(b), pinned(a)) {
            (true, false) => return Ordering::Greater,
            (false, true) => return Ordering::Less,
            _ => {}
        }
        // The current model leads.
        let is_current = |model: &Model| self.is_current(model);
        match (is_current(a), is_current(b)) {
            (true, false) => return Ordering::Less,
            (false, true) => return Ordering::Greater,
            _ => {}
        }
        // Then the recent-use rank.
        let rank = |model: &Model| {
            self.recent_rank
                .get(&Self::model_key_provider(&model.provider, &model.id))
                .copied()
                .unwrap_or(usize::MAX)
        };
        let (a_rank, b_rank) = (rank(a), rank(b));
        if a_rank != b_rank {
            return a_rank.cmp(&b_rank);
        }
        // Then the provider name.
        if a.provider != b.provider {
            return a.provider.cmp(&b.provider);
        }
        // Featured models of the same provider lead.
        let featured = |model: &Model| model.featured == Some(true);
        match (featured(a), featured(b)) {
            (true, false) => return Ordering::Less,
            (false, true) => return Ordering::Greater,
            _ => {}
        }
        // Finally the model id, numeric-aware.
        natural_cmp(&a.id, &b.id)
    }

    /// Rebuild the filtered view (TS `filterModels`): a non-empty query
    /// scores every model and orders the matches by configured provider,
    /// pin, match quality, score, version descending, currency, recent
    /// rank, and key. The selection resets to the top only when the query
    /// changed.
    fn filter_models(&mut self, query: &str) {
        let query_changed = query != self.last_query;
        self.last_query = query.to_string();
        if query.trim().is_empty() {
            self.filtered = self.active_indices();
        } else {
            let mut matches: Vec<(usize, SearchMatch)> = self
                .active_indices()
                .into_iter()
                .filter_map(|index| {
                    score_model_search(&self.all_models[index], query).map(|match_| (index, match_))
                })
                .collect();
            let configured = |model: &Model| self.configured_providers.contains(&model.provider);
            let pinned =
                |model: &Model| model.provider == PRIME_INFERENCE_PROVIDER_ID && configured(model);
            matches.sort_by(|(a_index, a_match), (b_index, b_match)| {
                use std::cmp::Ordering;
                let a = &self.all_models[*a_index];
                let b = &self.all_models[*b_index];
                match (configured(b), configured(a)) {
                    (true, false) => return Ordering::Greater,
                    (false, true) => return Ordering::Less,
                    _ => {}
                }
                match (pinned(b), pinned(a)) {
                    (true, false) => return Ordering::Greater,
                    (false, true) => return Ordering::Less,
                    _ => {}
                }
                if a_match.quality != b_match.quality {
                    return a_match.quality.cmp(&b_match.quality);
                }
                if a_match.score.partial_cmp(&b_match.score) != Some(Ordering::Equal) {
                    return a_match
                        .score
                        .partial_cmp(&b_match.score)
                        .unwrap_or(Ordering::Equal);
                }
                // The version tier: newer releases first. The catalog
                // carries no release-date metadata, so the version runs
                // parsed from the ids stand in for release recency.
                let order =
                    version_desc(&self.version_keys[*a_index], &self.version_keys[*b_index]);
                if order != Ordering::Equal {
                    return order;
                }
                match (self.is_current(b), self.is_current(a)) {
                    (true, false) => return Ordering::Greater,
                    (false, true) => return Ordering::Less,
                    _ => {}
                }
                let (a_rank, b_rank) = (
                    self.recent_rank
                        .get(&Self::model_key_provider(&a.provider, &a.id))
                        .copied()
                        .unwrap_or(usize::MAX),
                    self.recent_rank
                        .get(&Self::model_key_provider(&b.provider, &b.id))
                        .copied()
                        .unwrap_or(usize::MAX),
                );
                if a_rank != b_rank {
                    return a_rank.cmp(&b_rank);
                }
                natural_cmp(
                    &Self::model_key_provider(&a.provider, &a.id),
                    &Self::model_key_provider(&b.provider, &b.id),
                )
            });
            self.filtered = matches.into_iter().map(|(index, _)| index).collect();
        }
        self.selected = if query_changed {
            0
        } else {
            self.selected.min(self.filtered.len().saturating_sub(1))
        };
        self.visible_items = self.list_layout();
    }

    fn should_treat_as_back(&self, kb: &KeybindingsManager, key: &str) -> bool {
        // Left arrow acts like Esc only when the search cursor sits at the
        // start of the field (TS `shouldTreatAsBack`).
        kb.matches(key, "app.modal.back") && self.search.cursor() == 0
    }

    fn confirm(&self) -> ModelPickerAction {
        let Some(model) = self.selected_model() else {
            return ModelPickerAction::None;
        };
        let key = Self::model_key_provider(&model.provider, &model.id);
        let effort = if self.edited_effort.contains(&key) {
            self.effort_levels
                .get(&key)
                .map(|level| level.wire_name().to_string())
        } else {
            None
        };
        ModelPickerAction::Apply(Box::new(ModelSelectionApplied {
            provider: model.provider.clone(),
            model_id: model.id.clone(),
            effort,
        }))
    }

    /// The selectable effort levels of a model (TS `getSelectableLevels`):
    /// an off-only model has no thinking surface.
    pub(crate) fn selectable_levels(model: &Model) -> Vec<ModelThinkingLevel> {
        let levels = get_supported_thinking_levels(model);
        if levels.len() == 1 && levels[0] == ModelThinkingLevel::Off {
            return Vec::new();
        }
        levels
    }

    /// Seed the default effort for every model with a thinking surface (TS
    /// `getEffort`, resolved eagerly so rendering stays pure).
    fn resolve_effort_defaults(&mut self) {
        let initial = self
            .initial_thinking_level
            .unwrap_or(ModelThinkingLevel::Off);
        for model in &self.all_models {
            let levels = Self::selectable_levels(model);
            if levels.is_empty() {
                continue;
            }
            let key = Self::model_key_provider(&model.provider, &model.id);
            if self.effort_levels.contains_key(&key) {
                continue;
            }
            let stored = self.effort_levels.get(&key).copied();
            let level = match stored {
                Some(level) if levels.contains(&level) => level,
                _ => {
                    let level = if levels.contains(&initial) {
                        initial
                    } else {
                        clamp_thinking_level(model, initial)
                    };
                    if levels.contains(&level) {
                        level
                    } else {
                        levels[0]
                    }
                }
            };
            self.effort_levels.insert(key, level);
        }
    }

    /// The resolved effort for a model (its seeded or user-edited level).
    pub(crate) fn effort_of(&self, model: &Model) -> Option<ModelThinkingLevel> {
        if Self::selectable_levels(model).is_empty() {
            return None;
        }
        self.effort_levels
            .get(&Self::model_key_provider(&model.provider, &model.id))
            .copied()
    }

    /// Move the model's effort one level (`direction` ±1, wrapping; TS
    /// `adjustEffort`). Returns whether the effort changed.
    fn adjust_effort(&mut self, model: &Model, direction: isize) -> bool {
        let levels = Self::selectable_levels(model);
        if levels.is_empty() {
            return false;
        }
        let key = Self::model_key_provider(&model.provider, &model.id);
        let current = self.effort_of(model).unwrap_or(levels[0]);
        let index = levels
            .iter()
            .position(|level| *level == current)
            .unwrap_or(0);
        let len = levels.len() as isize;
        let next = (((index as isize + direction) % len) + len) % len;
        let next_level = levels[next as usize];
        self.effort_levels.insert(key, next_level);
        self.edited_effort
            .insert(Self::model_key_provider(&model.provider, &model.id));
        true
    }

    fn is_current(&self, model: &Model) -> bool {
        self.current.as_ref().is_some_and(|current| {
            current.provider == model.provider && current.model_id == model.id
        })
    }

    pub(crate) fn is_configured(&self, model: &Model) -> bool {
        self.configured_providers.contains(&model.provider)
    }

    pub(crate) fn model_at(&self, index: usize) -> Option<&Model> {
        self.all_models.get(index)
    }

    fn key_at(&self, index: usize) -> String {
        self.all_models
            .get(index)
            .map(|model| Self::model_key_provider(&model.provider, &model.id))
            .unwrap_or_default()
    }

    /// The `provider/id` key (TS `modelsAreEqual`'s format).
    pub(crate) fn model_key_provider(provider: &str, id: &str) -> String {
        format!("{provider}/{id}")
    }

    pub(crate) fn search_cursor(&self) -> usize {
        self.search.cursor()
    }

    pub(crate) fn effort_layout(&self, start: usize, end: usize) -> EffortLayout {
        /// TS constant: wide detail columns must fit "Cached input".
        const EFFORT_NAME_COLUMN_MAX: usize = 30;
        const EFFORT_NAME_COLUMN_MIN: usize = 12;
        /// Arrow slots and the spaces around the squares and label.
        const ARROWS_AND_GAPS: usize = 6;

        let empty = EffortLayout {
            name_column: 0,
            square_slots: 0,
            gap: 0,
            label_width: 0,
            show_label: false,
            show_cluster: false,
        };
        let reasoning: Vec<&Model> = (start..end)
            .filter_map(|index| {
                let model_index = self.filtered.get(index).copied()?;
                self.all_models.get(model_index)
            })
            .filter(|model| !Self::selectable_levels(model).is_empty())
            .collect();
        if reasoning.is_empty() {
            return empty;
        }
        let width = self.render_width;
        let mut max_trailing_width = 0;
        for index in start..end {
            let Some(model_index) = self.filtered.get(index).copied() else {
                continue;
            };
            let Some(model) = self.all_models.get(model_index) else {
                continue;
            };
            let segments = self.trailing_segments(model);
            let refs: Vec<crate::menu_panel::MenuSegment> = segments
                .iter()
                .map(|segment| crate::menu_panel::MenuSegment::muted(segment))
                .collect();
            max_trailing_width =
                max_trailing_width.max(crate::menu_panel::trailing_width(&refs, width));
        }
        let available = width.saturating_sub(2 + max_trailing_width + 2).max(1);

        let max_name_column = reasoning
            .iter()
            .map(|model| crate::width::str_width(&model.name))
            .max()
            .unwrap_or(0)
            .min(EFFORT_NAME_COLUMN_MAX);
        let square_slots = reasoning
            .iter()
            .map(|model| {
                Self::selectable_levels(model)
                    .iter()
                    .filter(|level| **level != ModelThinkingLevel::Off)
                    .count()
            })
            .max()
            .unwrap_or(0);
        let cluster_width = square_slots;
        // Fixed label cell sized to the longest supported level name, so
        // changing the selected level never changes the cluster span.
        let label_width = reasoning
            .iter()
            .flat_map(|model| Self::selectable_levels(model))
            .map(|level| crate::width::str_width(level.wire_name()))
            .max()
            .unwrap_or(0);
        // Sit the cluster near the row's horizontal center, clamped between
        // the name column and the trailing zone.
        let place = |name_column: usize, show_label: bool| {
            let span = cluster_width + if show_label { label_width + 5 } else { 4 };
            let desired = (width / 2)
                .saturating_sub(span / 2)
                .saturating_sub(2 + name_column);
            let gap = desired
                .min(available.saturating_sub(name_column + span))
                .max(1);
            EffortLayout {
                name_column,
                square_slots,
                gap,
                label_width,
                show_label,
                show_cluster: true,
            }
        };
        if max_name_column + cluster_width + label_width + ARROWS_AND_GAPS <= available {
            return place(max_name_column, true);
        }
        let label_name_column =
            available.saturating_sub(cluster_width + label_width + ARROWS_AND_GAPS);
        if label_name_column >= EFFORT_NAME_COLUMN_MIN {
            return place(max_name_column.min(label_name_column), true);
        }
        if max_name_column + cluster_width + ARROWS_AND_GAPS <= available {
            return place(max_name_column, false);
        }
        let cluster_name_column = available.saturating_sub(cluster_width + ARROWS_AND_GAPS);
        if cluster_name_column >= EFFORT_NAME_COLUMN_MIN {
            return place(max_name_column.min(cluster_name_column), false);
        }
        empty
    }

    /// The trailing segments of one row (TS `getTrailingSegments`):
    /// `current`, `require sign in`, then the provider.
    pub(crate) fn trailing_segments(&self, model: &Model) -> Vec<String> {
        let mut segments: Vec<String> = Vec::new();
        if self.is_current(model) {
            segments.push("current".to_string());
        }
        if !self.is_configured(model) {
            segments.push("require sign in".to_string());
        }
        segments.push(model.provider.clone());
        segments
    }
}

impl ModelPicker {
    /// Dispatch `/model [search]`: open the picker with `current` checked
    /// and `search` as the prefilled filter. TS `handleModelCommand` always
    /// opens the menu — an empty catalog renders the empty panel (the
    /// no-match row), never a note.
    pub(crate) fn open(options: ModelPickerOptions, search: &str) -> ModelCommandOutcome {
        let mut picker = ModelPicker::new(options);
        let search = search.trim();
        if !search.is_empty() {
            picker.set_query(search);
        }
        ModelCommandOutcome::Open(Box::new(picker))
    }

    /// A bracketed paste into the search field (TS `Input.handleInput`
    /// paste branch: newlines stripped, tabs expanded).
    pub fn paste(&mut self, text: &str) {
        let previous = self.search.value().to_string();
        self.search.paste(text);
        if self.search.value() != previous {
            self.navigated_into_list = false;
            let query = self.search.value().to_string();
            self.filter_models(&query);
        }
    }

    /// Prefill the filter (`/model <search>`; TS opens the selector with
    /// the search term applied), the caret at the search's end so typing
    /// extends it.
    pub fn set_query(&mut self, query: &str) {
        self.search.prefill(query);
        self.filter_models(query);
    }
}
