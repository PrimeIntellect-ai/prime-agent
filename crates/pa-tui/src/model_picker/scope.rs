//! The picker's scope concern: the session's scoped keys against the catalog,
//! the active-list swap behind Alt+S, and the selection rule a scope change
//! re-applies.

use super::ModelPicker;

/// The active list: the session's scoped entries or the full catalog; the picker opens `Scoped`
/// while the session holds scoped models and the toggle key swaps.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ModelScope {
    All,
    Scoped,
}

impl ModelPicker {
    /// The scope row's active side (the adoption event's `scoped` value).
    pub(crate) fn scoped_side(&self) -> bool {
        matches!(self.scope, ModelScope::Scoped)
    }

    /// Whether the session holds a scope (the toggle only runs then; TS keys it off the session's
    /// list, never off what the loaded catalog resolves: an unresolvable snapshot still scopes, and
    /// a refresh that empties the positions never strands the scoped side).
    pub(crate) fn has_scoped_models(&self) -> bool {
        !self.scoped_models.is_empty()
    }

    /// Re-map the scoped keys against the loaded catalog: an entry missing from
    /// the loaded catalog is not listed, and one a later refresh brings appears.
    pub(crate) fn resolve_scope_positions(&mut self) {
        self.scoped_positions = self
            .scoped_models
            .iter()
            .filter_map(|key| {
                self.all_models
                    .iter()
                    .position(|model| Self::model_key_provider(&model.provider, &model.id) == *key)
            })
            .collect();
    }

    /// The active list as `all_models` positions: the scoped entries in the
    /// session's scope order when scoped, else the whole catalog.
    pub(super) fn active_indices(&self) -> Vec<usize> {
        match self.scope {
            ModelScope::All => (0..self.all_models.len()).collect(),
            ModelScope::Scoped => self.scoped_positions.clone(),
        }
    }

    /// The current model re-selects inside the filtered active list, else the top.
    pub(super) fn select_current_or_top(&mut self) {
        self.selected = self
            .filtered
            .iter()
            .position(|&index| self.is_current(&self.all_models[index]))
            .unwrap_or(0);
    }
}
