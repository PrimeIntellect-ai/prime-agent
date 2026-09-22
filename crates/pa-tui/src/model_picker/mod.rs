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
    /// The effort a fresh selection starts from (TS `thinkingLevel`).
    pub thinking_level: Option<ModelThinkingLevel>,
    /// The viewport height the list sizes itself against (already the TS
    /// `getRows` value: one row less than the dock's row budget).
    pub viewport_rows: usize,
}

/// Match quality for the scored search (TS `ModelSearchMatchQuality`;
/// lower sorts first).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum MatchQuality {
    ExactShortId,
    ExactFullId,
    PrefixOrToken,
    Fuzzy,
}

/// One scored search match.
struct SearchMatch {
    quality: MatchQuality,
    score: f64,
}

/// TS `normalizeModelSearchText`: lowercase, drop separator runs.
fn normalize_search_text(value: &str) -> String {
    value
        .to_lowercase()
        .chars()
        .filter(|c| !matches!(c, ' ' | '\t' | '-' | '_' | '.' | ':' | '/'))
        .collect()
}

/// The search fields of one item (TS `getModelSearchFields`).
fn search_fields(model: &Model) -> (String, Vec<String>, Vec<String>) {
    let short_id = model.id.rsplit('/').next().unwrap_or(&model.id).to_string();
    let full_ids = vec![model.id.clone(), format!("{}/{}", model.provider, model.id)];
    let mut all = vec![short_id.clone()];
    all.extend(full_ids.iter().cloned());
    all.push(model.name.clone());
    all.push(model.provider.clone());
    (short_id, full_ids, all)
}

/// TS `getBestFuzzyScore`: every token must fuzzy-match some field; the
/// score is the sum of each token's best field.
fn best_fuzzy_score(query_tokens: &[String], fields: &[String]) -> Option<f64> {
    let mut total = 0.0;
    for token in query_tokens {
        // Every token must match some field; the score is each token's best.
        let mut best: Option<f64> = None;
        for field in fields {
            if let Some(score) = crate::fuzzy::fuzzy_match(token, field) {
                best = Some(match best {
                    Some(current) if current <= score => current,
                    _ => score,
                });
            }
        }
        let best = best?;
        total += best;
    }
    Some(total)
}

/// TS `scoreModelSearch`.
fn score_model_search(model: &Model, query: &str) -> Option<SearchMatch> {
    let query_tokens: Vec<String> = query.split_whitespace().map(str::to_string).collect();
    let normalized_query = normalize_search_text(query);
    let normalized_tokens: Vec<String> = query_tokens
        .iter()
        .map(|token| normalize_search_text(token))
        .filter(|token| !token.is_empty())
        .collect();
    if normalized_query.is_empty() || normalized_tokens.is_empty() {
        return None;
    }

    let (short_id, full_ids, all) = search_fields(model);
    if normalize_search_text(&short_id) == normalized_query {
        return Some(SearchMatch {
            quality: MatchQuality::ExactShortId,
            score: 0.0,
        });
    }
    if full_ids
        .iter()
        .any(|field| normalize_search_text(field) == normalized_query)
    {
        return Some(SearchMatch {
            quality: MatchQuality::ExactFullId,
            score: 0.0,
        });
    }

    let normalized_fields: Vec<String> = all
        .iter()
        .map(|field| normalize_search_text(field))
        .collect();
    let field_tokens: Vec<String> = all
        .iter()
        .flat_map(|field| field.split([' ', '/', '_', '-']).map(normalize_search_text))
        .filter(|token| !token.is_empty())
        .collect();
    let fuzzy_score = best_fuzzy_score(&normalized_tokens, &normalized_fields);
    let is_prefix_or_token = normalized_tokens.iter().all(|token| {
        normalized_fields
            .iter()
            .any(|field| field.starts_with(token))
            || field_tokens.iter().any(|field| field.starts_with(token))
    });
    match fuzzy_score {
        Some(score) if is_prefix_or_token => Some(SearchMatch {
            quality: MatchQuality::PrefixOrToken,
            score,
        }),
        Some(score) => Some(SearchMatch {
            quality: MatchQuality::Fuzzy,
            score,
        }),
        None => None,
    }
}

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
}

impl ModelPicker {
    /// Build the picker: sort the catalog, resolve the per-model effort
    /// defaults, then show everything unfiltered.
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
        };
        picker.load_models(options.models);
        let query = picker.search.value().to_string();
        picker.filter_models(&query);
        picker
    }

    /// The active filter query.
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
    /// `updateResponsiveLayout`, inline shape).
    pub(crate) fn list_layout(&self) -> usize {
        let detail_rows = if self.render_width >= 58 { 4 } else { 5 };
        let detail_rows = if self.viewport_rows >= 5 + detail_rows {
            detail_rows
        } else {
            0
        };
        crate::menu_panel::menu_list_layout(
            Some(self.viewport_rows),
            8,
            self.filtered.len(),
            3 + detail_rows,
            1,
        )
    }

    pub(crate) fn detail_rows(&self) -> usize {
        let detail_rows = if self.render_width >= 58 { 4 } else { 5 };
        if self.viewport_rows >= 5 + detail_rows {
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

    /// The provider-sorted catalog (TS `sortModels`): configured providers
    /// first, signed-in Prime Inference pinned, the current model leading,
    /// then the recent-use rank, the provider name, `featured`, and the
    /// numeric id compare.
    fn load_models(&mut self, models: Vec<Model>) {
        let mut models = models;
        models.sort_by(|a, b| self.compare(a, b));
        self.all_models = models;
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
    /// pin, match quality, score, currency, recent rank, and key. The
    /// selection resets to the top only when the query changed.
    fn filter_models(&mut self, query: &str) {
        let query_changed = query != self.last_query;
        self.last_query = query.to_string();
        if !query.trim().is_empty() {
            let mut matches: Vec<(usize, SearchMatch)> = self
                .all_models
                .iter()
                .enumerate()
                .filter_map(|(index, model)| {
                    score_model_search(model, query).map(|match_| (index, match_))
                })
                .collect();
            let configured = |model: &Model| self.configured_providers.contains(&model.provider);
            let pinned =
                |model: &Model| model.provider == PRIME_INFERENCE_PROVIDER_ID && configured(model);
            matches.sort_by(|(a_index, a_match), (b_index, b_match)| {
                let a = &self.all_models[*a_index];
                let b = &self.all_models[*b_index];
                use std::cmp::Ordering;
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
                if a_match.score != b_match.score {
                    return a_match
                        .score
                        .partial_cmp(&b_match.score)
                        .unwrap_or(Ordering::Equal);
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
        } else {
            self.filtered = (0..self.all_models.len()).collect();
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

    fn model_key_provider(provider: &str, id: &str) -> String {
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
            let refs: Vec<&str> = segments.iter().map(String::as_str).collect();
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
    /// the search term applied).
    pub fn set_query(&mut self, query: &str) {
        self.search.set_value(query);
        self.filter_models(query);
    }
}

/// Numeric-aware string compare: digit runs compare by value, everything
/// else by characters (`localeCompare` with `numeric: true`).
fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    fn split_run(text: &str) -> Option<(&str, bool)> {
        let first = text.chars().next()?;
        let is_digit = first.is_ascii_digit();
        let end = text
            .char_indices()
            .find(|(_, c)| c.is_ascii_digit() != is_digit)
            .map(|(index, _)| index)
            .unwrap_or(text.len());
        Some((&text[..end], is_digit))
    }
    let mut a_rest = a;
    let mut b_rest = b;
    loop {
        match (split_run(a_rest), split_run(b_rest)) {
            (None, None) => return std::cmp::Ordering::Equal,
            (None, Some(_)) => return std::cmp::Ordering::Less,
            (Some(_), None) => return std::cmp::Ordering::Greater,
            (Some((a_run, a_digits)), Some((b_run, b_digits))) => {
                if a_digits && b_digits {
                    let a_trim = a_run.trim_start_matches('0');
                    let b_trim = b_run.trim_start_matches('0');
                    let order = match a_trim.len().cmp(&b_trim.len()) {
                        std::cmp::Ordering::Equal => a_trim.cmp(b_trim),
                        other => other,
                    };
                    if order != std::cmp::Ordering::Equal {
                        return order;
                    }
                } else {
                    let order = a_run.cmp(b_run);
                    if order != std::cmp::Ordering::Equal {
                        return order;
                    }
                }
                a_rest = &a_rest[a_run.len()..];
                b_rest = &b_rest[b_run.len()..];
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keybindings::KeybindingsManager;
    use crate::theme::{ColorMode, Theme};

    fn theme() -> Theme {
        Theme::builtin("prime", ColorMode::TrueColor)
    }

    fn kb() -> KeybindingsManager {
        KeybindingsManager::new()
    }

    /// One catalog model with explicit cost and an optional thinking map.
    fn model(provider: &str, id: &str, name: &str, reasoning: bool, map: Option<&str>) -> Model {
        serde_json::from_value(serde_json::json!({
            "id": id, "name": name, "api": "openai-completions", "provider": provider,
            "baseUrl": "https://example.invalid/v1", "reasoning": reasoning,
            "thinkingLevelMap": map.map(|m| serde_json::from_str::<serde_json::Value>(m).unwrap()),
            "input": ["text"],
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
            "contextWindow": 128000, "maxTokens": 4096,
        }))
        .expect("mock model deserializes")
    }

    /// The fable map: low..max on, off/minimal off.
    fn fable_map() -> &'static str {
        r#"{"off": null, "minimal": null, "low": "low", "medium": "medium", "high": "high", "xhigh": "xhigh", "max": "max"}"#
    }

    /// A reasoning model whose only on-level is high.
    fn high_only_map() -> &'static str {
        r#"{"minimal": null, "low": null, "medium": null, "high": "high", "xhigh": null, "max": null}"#
    }

    /// The 4.6 map: low..max on except xhigh.
    fn opus_map() -> &'static str {
        r#"{"minimal": null, "low": "low", "medium": "medium", "high": "high", "xhigh": null, "max": "max"}"#
    }

    /// A battery-shaped catalog: the mock-1 current model plus the featured
    /// Claude ladder.
    fn battery_catalog() -> Vec<Model> {
        vec![
            model("prime-inference", "mock-1", "Mock 1", false, None),
            model(
                "prime-inference",
                "anthropic/claude-fable-5",
                "Claude Fable 5",
                true,
                Some(fable_map()),
            ),
            model(
                "prime-inference",
                "anthropic/claude-haiku-4.5",
                "Claude Haiku 4.5",
                true,
                Some(high_only_map()),
            ),
            model(
                "prime-inference",
                "anthropic/claude-opus-4.6",
                "Claude Opus 4.6",
                true,
                Some(opus_map()),
            ),
            model(
                "prime-inference",
                "anthropic/claude-opus-4.7",
                "Claude Opus 4.7",
                true,
                Some(opus_map()),
            ),
            model(
                "prime-inference",
                "anthropic/claude-opus-4.8",
                "Claude Opus 4.8",
                true,
                Some(opus_map()),
            ),
            model(
                "prime-inference",
                "anthropic/claude-sonnet-4.5",
                "Claude Sonnet 4.5",
                true,
                Some(high_only_map()),
            ),
            model(
                "prime-inference",
                "anthropic/claude-sonnet-4.6",
                "Claude Sonnet 4.6",
                true,
                Some(opus_map()),
            ),
            model(
                "prime-inference",
                "deepseek/deepseek-v4",
                "Deepseek V4",
                false,
                None,
            ),
        ]
    }

    fn current() -> CurrentModel {
        CurrentModel {
            provider: "prime-inference".to_string(),
            model_id: "mock-1".to_string(),
        }
    }

    fn configured() -> HashSet<String> {
        ["prime-inference".to_string()].into_iter().collect()
    }

    fn picker_options(catalog: Vec<Model>) -> ModelPickerOptions {
        ModelPickerOptions {
            models: catalog,
            current: Some(current()),
            configured_providers: configured(),
            recent_models: Vec::new(),
            thinking_level: Some(ModelThinkingLevel::Medium),
            viewport_rows: 19,
        }
    }

    /// Rendered frame rows as trimmed plain text (tmux-capture shape).
    fn frame_text(picker: &mut ModelPicker) -> Vec<String> {
        picker
            .render(&theme(), 120, &kb())
            .iter()
            .map(|line| {
                line.iter()
                    .map(|span| span.content.as_str())
                    .collect::<String>()
            })
            .map(|row| row.trim_end().to_string())
            .collect()
    }

    /// The frame matches the TS inline menu panel row for row (the f17
    /// model-selector capture geometry: bordered search field, `›` rows
    /// with the effort cluster centered at columns 54/62, trailing flush
    /// right, scroll indicator, price detail, key hint).
    /// The frame matches the TS inline menu panel row for row (the f17
    /// model-selector capture geometry): bordered search field, `›` rows
    /// with the effort cluster centered (squares at column 54, label at
    /// 62), trailing flush right, scroll indicator, price detail, key hint.
    #[test]
    fn renders_the_ts_inline_panel_shape() {
        let mut picker = ModelPicker::new(picker_options(battery_catalog()));
        let rows = frame_text(&mut picker);
        let border = "\u{2500}".repeat(120);
        assert_eq!(rows[0], border, "top rule");
        assert_eq!(rows[2], border, "bottom rule");
        // The search field: prompt, caret cell, dim placeholder.
        assert_eq!(rows[1], " >  Search models");
        // The current model leads, marked `current \u{b7} provider`, no
        // effort cluster (no thinking surface); the trailing sits flush
        // right.
        assert_eq!(
            rows[3],
            format!(
                "\u{203a} Mock 1{}current \u{b7} prime-inference",
                " ".repeat(87)
            )
        );
        // The effort cluster: name cell (17), centered gap (33), arrow
        // slots, squares, label cell (6), then the trailing provider.
        let effort_row = |name: &str, squares: &str, label: &str| {
            let name_pad = " ".repeat(17 - name.chars().count());
            let label_pad = " ".repeat(6 - label.chars().count());
            format!(
                "  {name}{name_pad}{}  {squares}   {label}{label_pad}{}prime-inference",
                " ".repeat(33),
                " ".repeat(37),
            )
        };
        assert_eq!(
            rows[4],
            effort_row(
                "Claude Fable 5",
                "\u{25a0}\u{25a0}\u{25a1}\u{25a1}\u{25a1}",
                "medium"
            )
        );
        assert_eq!(
            rows[5],
            effort_row("Claude Haiku 4.5", "\u{25a0}    ", "high")
        );
        assert_eq!(
            rows[6],
            effort_row(
                "Claude Opus 4.6",
                "\u{25a0}\u{25a0}\u{25a1}\u{25a1} ",
                "medium"
            )
        );
        // The scroll indicator counts the whole catalog.
        assert_eq!(rows[11], "  (1/9)");
        // The price detail block: blank, labels with the trailing unit,
        // values, blank.
        assert_eq!(rows[12], "");
        assert_eq!(
            rows[13],
            format!(
                " Input{}Cached input{}Output {}$ / 1M tokens",
                " ".repeat(34 - 5),
                " ".repeat(34 - 12),
                " ".repeat(34 - 6),
            )
        );
        assert_eq!(
            rows[14],
            format!(" $0{}$0{}$0", " ".repeat(32), " ".repeat(32))
        );
        assert_eq!(rows[15], "");
        // The key hint.
        assert_eq!(
            rows[16],
            " \u{2191}/\u{2193} model \u{b7} \u{2190}/\u{2192} effort \u{b7} Enter select \u{b7} Esc close"
        );
    }

    #[test]
    fn the_current_model_leads_and_matches_only_by_provider_and_id() {
        let picker = ModelPicker::new(picker_options(battery_catalog()));
        let model = picker.selected_model().expect("selection");
        assert_eq!(model.id, "mock-1");
        assert_eq!(picker.selected_index(), 0);
    }

    #[test]
    fn enter_applies_the_selection() {
        let mut picker = ModelPicker::new(picker_options(battery_catalog()));
        assert_eq!(
            picker.handle_key("enter", &kb()),
            ModelPickerAction::Apply(Box::new(ModelSelectionApplied {
                provider: "prime-inference".to_string(),
                model_id: "mock-1".to_string(),
                effort: None,
            }))
        );
    }

    #[test]
    fn typed_filter_selects_the_match_and_enter_applies_it() {
        let mut picker = ModelPicker::new(picker_options(battery_catalog()));
        picker.set_query("haiku");
        assert_eq!(picker.query(), "haiku");
        assert_eq!(
            picker.handle_key("enter", &kb()),
            ModelPickerAction::Apply(Box::new(ModelSelectionApplied {
                provider: "prime-inference".to_string(),
                model_id: "anthropic/claude-haiku-4.5".to_string(),
                effort: None,
            }))
        );
    }

    #[test]
    fn typing_into_the_picker_filters_and_resets_the_selection() {
        let mut picker = ModelPicker::new(picker_options(battery_catalog()));
        for character in "mock".chars() {
            assert_eq!(
                picker.handle_key(&character.to_string(), &kb()),
                ModelPickerAction::None
            );
        }
        assert_eq!(picker.query(), "mock");
        assert_eq!(
            picker.handle_key("enter", &kb()),
            ModelPickerAction::Apply(Box::new(ModelSelectionApplied {
                provider: "prime-inference".to_string(),
                model_id: "mock-1".to_string(),
                effort: None,
            }))
        );
    }

    #[test]
    fn escape_and_ctrl_c_cancel() {
        let mut picker = ModelPicker::new(picker_options(battery_catalog()));
        assert_eq!(
            picker.handle_key("escape", &kb()),
            ModelPickerAction::Cancel
        );
        assert_eq!(
            picker.handle_key("ctrl+c", &kb()),
            ModelPickerAction::Cancel
        );
    }

    #[test]
    fn navigation_wraps_and_enter_applies_the_moved_selection() {
        let mut picker = ModelPicker::new(picker_options(battery_catalog()));
        assert_eq!(picker.handle_key("up", &kb()), ModelPickerAction::None);
        // Wrapped to the bottom of the list.
        assert_eq!(
            picker.handle_key("enter", &kb()),
            ModelPickerAction::Apply(Box::new(ModelSelectionApplied {
                provider: "prime-inference".to_string(),
                model_id: "deepseek/deepseek-v4".to_string(),
                effort: None,
            }))
        );
        let mut picker = ModelPicker::new(picker_options(battery_catalog()));
        picker.handle_key("down", &kb());
        assert_eq!(
            picker.handle_key("enter", &kb()),
            ModelPickerAction::Apply(Box::new(ModelSelectionApplied {
                provider: "prime-inference".to_string(),
                model_id: "anthropic/claude-fable-5".to_string(),
                effort: None,
            }))
        );
    }

    #[test]
    fn left_right_adjust_the_selected_effort_and_enter_carries_it() {
        let mut picker = ModelPicker::new(picker_options(battery_catalog()));
        // Move onto a reasoning model; its seeded effort is medium.
        picker.handle_key("down", &kb());
        // The empty filter keeps arrows on the effort cluster.
        assert_eq!(picker.handle_key("left", &kb()), ModelPickerAction::None);
        let model = picker.selected_model().expect("selection").clone();
        assert_eq!(picker.effort_of(&model), Some(ModelThinkingLevel::Low));
        assert_eq!(
            picker.handle_key("enter", &kb()),
            ModelPickerAction::Apply(Box::new(ModelSelectionApplied {
                provider: "prime-inference".to_string(),
                model_id: "anthropic/claude-fable-5".to_string(),
                effort: Some("low".to_string()),
            }))
        );
    }

    #[test]
    fn a_nonempty_filter_keeps_arrows_on_the_search_cursor() {
        let mut picker = ModelPicker::new(picker_options(battery_catalog()));
        for character in "claude fable".chars() {
            picker.handle_key(&character.to_string(), &kb());
        }
        // The caret sits at the field's end: left moves the caret inside
        // the text, not the effort cluster or the picker.
        assert_eq!(picker.handle_key("left", &kb()), ModelPickerAction::None);
        assert_eq!(picker.query(), "claude fable");
        // Home walks the caret to the field's start; a further left acts
        // like Esc (TS `shouldTreatAsBack`: back only at column 0).
        assert_eq!(picker.handle_key("home", &kb()), ModelPickerAction::None);
        assert_eq!(picker.handle_key("left", &kb()), ModelPickerAction::Cancel);
    }

    #[test]
    fn unconfigured_providers_mark_require_sign_in_and_sort_last() {
        let catalog = vec![
            model("prime-inference", "mock-1", "Mock 1", false, None),
            model(
                "other",
                "unconfigured-model",
                "Unconfigured Model",
                false,
                None,
            ),
        ];
        let mut options = picker_options(catalog);
        options.current = None;
        let mut picker = ModelPicker::new(options);
        let rows = frame_text(&mut picker);
        // Configured providers first, unconfigured rows carry the sign-in
        // marking in their trailing cluster.
        assert!(rows
            .iter()
            .any(|row| row.contains("require sign in \u{b7} other")));
        assert!(rows.iter().any(|row| row.contains("Mock 1")));
    }

    #[test]
    fn update_state_keeps_the_selection_on_the_surviving_model() {
        let mut picker = ModelPicker::new(picker_options(battery_catalog()));
        picker.handle_key("down", &kb());
        let mut catalog = battery_catalog();
        // The refresh drops one model and adds another.
        catalog.pop();
        catalog.push(model(
            "prime-inference",
            "new/model",
            "New Model",
            false,
            None,
        ));
        picker.update_state(Some(current()), catalog, configured());
        let selected = picker.selected_model().expect("selection").clone();
        assert_eq!(selected.id, "anthropic/claude-fable-5");
    }

    #[test]
    fn the_effort_seed_clamps_to_the_model_levels() {
        let catalog = vec![
            model("prime-inference", "mock-1", "Mock 1", false, None),
            model(
                "prime-inference",
                "anthropic/claude-haiku-4.5",
                "Claude Haiku 4.5",
                true,
                Some(high_only_map()),
            ),
        ];
        let picker = ModelPicker::new(picker_options(catalog));
        let haiku = picker.model_at(1).expect("catalog").clone();
        // Medium clamps up to the only supported level.
        assert_eq!(picker.effort_of(&haiku), Some(ModelThinkingLevel::High));
    }

    #[test]
    fn paging_moves_by_the_visible_window() {
        let mut catalog = battery_catalog();
        for extra in 0..20 {
            catalog.push(model(
                "prime-inference",
                &format!("extra/{extra}"),
                "Extra",
                false,
                None,
            ));
        }
        let mut options = picker_options(catalog);
        options.current = None;
        let mut picker = ModelPicker::new(options);
        assert_eq!(
            picker.handle_key("pageDown", &kb()),
            ModelPickerAction::None
        );
        assert_eq!(picker.selected_index(), picker.visible_items());
    }

    #[test]
    fn the_sorted_order_matches_the_ts_chain() {
        // A provider-configured model outranks an unconfigured one; the
        // current model leads; featured models lead within a provider; ids
        // compare numerically.
        let catalog = vec![
            model("other", "b-model", "B", false, None),
            model("prime-inference", "z-model-2", "Z2", false, None),
            model("prime-inference", "z-model-10", "Z10", false, None),
            model("prime-inference", "mock-1", "Mock 1", false, None),
        ];
        let mut options = picker_options(catalog);
        options.current = Some(current());
        let picker = ModelPicker::new(options);
        let ids: Vec<&str> = picker
            .all_models
            .iter()
            .map(|model| model.id.as_str())
            .collect();
        assert_eq!(ids, vec!["mock-1", "z-model-2", "z-model-10", "b-model",]);
    }

    #[test]
    fn an_empty_catalog_opens_the_empty_panel() {
        // TS `handleModelCommand` opens the menu regardless: an empty
        // catalog renders the bordered field and the no-match row.
        let ModelCommandOutcome::Open(mut picker) =
            ModelPicker::open(picker_options(Vec::new()), "");
        let rows = frame_text(&mut picker);
        assert_eq!(rows[1], " >  Search models");
        assert!(rows.iter().any(|row| row == "No matching models"));
    }

    #[test]
    fn dispatch_opens_the_picker_with_the_prefilled_search() {
        let ModelCommandOutcome::Open(picker) =
            ModelPicker::open(picker_options(battery_catalog()), " haiku ");
        assert_eq!(picker.query(), "haiku");
    }

    #[test]
    fn a_query_with_no_matches_renders_the_no_matching_row() {
        let mut picker = ModelPicker::new(picker_options(battery_catalog()));
        picker.set_query("zzz-no-match");
        let rows = frame_text(&mut picker);
        assert!(rows.iter().any(|row| row == "No matching models"));
    }

    #[test]
    fn paste_edits_the_filter_like_the_ts_input() {
        let mut picker = ModelPicker::new(picker_options(battery_catalog()));
        picker.paste("mock-1");
        assert_eq!(picker.query(), "mock-1");
        assert_eq!(
            picker.handle_key("enter", &kb()),
            ModelPickerAction::Apply(Box::new(ModelSelectionApplied {
                provider: "prime-inference".to_string(),
                model_id: "mock-1".to_string(),
                effort: None,
            }))
        );
    }
}
