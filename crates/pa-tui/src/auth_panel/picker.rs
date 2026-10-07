//! The team picker: TS `PrimeTeamSelectorComponent` — the mounted picker state (the search
//! field over the personal-first rows) and its drive (the fuzzy filter, the row parts, and
//! the pick).

use super::{
    fuzzy_filter, scrub_controls, Line, PrimeTeamOption, PrimeTeamPick, SearchInput, Span,
};

/// The mounted team picker: the search field over the personal-first rows.
#[derive(Debug)]
pub(super) struct PrimeTeamPicker {
    /// The team rows; the personal account rides first as its own row.
    pub(super) teams: Vec<PrimeTeamOption>,
    /// The stored selection's team id; `None` marks the personal account current.
    pub(super) current: Option<String>,
    pub(super) search: SearchInput,
    /// Indices over the full row list (0 = personal, i + 1 = teams[i]).
    pub(super) filtered: Vec<usize>,
    pub(super) selected: usize,
}

/// One trailing cell of a team row: a muted detail or the "current" marker.
pub(super) enum PickerSegment {
    Muted(String),
    Current,
}

impl PrimeTeamPicker {
    /// The fuzzy filter over the full row list; a fresh query resets the cursor to the first
    /// row.
    pub(super) fn refilter(&mut self) {
        let query = self.search.value().to_string();
        let rows = self.teams.len() + 1;
        self.filtered = if query.is_empty() {
            (0..rows).collect()
        } else {
            fuzzy_filter(&(0..rows).collect::<Vec<_>>(), &query, |row| {
                self.search_text(*row)
            })
        };
        self.selected = 0;
    }

    /// The personal account or the team's name, slug, role, and id.
    fn search_text(&self, row: usize) -> String {
        if row == 0 {
            return "personal account".to_string();
        }
        match self.teams.get(row - 1) {
            Some(team) => format!(
                "{} {} {} {}",
                team.name,
                team.slug.clone().unwrap_or_default(),
                team.role.clone().unwrap_or_default(),
                team.team_id
            ),
            None => String::new(),
        }
    }

    /// The row's primary and trailing cells: the name with the slug/role detail, "personal
    /// account" for the personal row, and the "current" marker on the stored selection.
    pub(super) fn row_parts(&self, row: usize) -> (Line, Vec<PickerSegment>) {
        if row == 0 {
            let mut trailing = vec![PickerSegment::Muted("personal account".to_string())];
            if self.current.is_none() {
                trailing.push(PickerSegment::Current);
            }
            return (vec![Span::raw("Personal")], trailing);
        }
        let Some(team) = self.teams.get(row - 1) else {
            return (Vec::new(), Vec::new());
        };
        // The team fields are provider-supplied: the same control character hygiene every
        // daemon-supplied row carries.
        let name = scrub_controls(&team.name);
        let role = team.role.as_deref().map_or_else(
            || "member".to_string(),
            |role| scrub_controls(role).to_lowercase(),
        );
        let detail = match &team.slug {
            Some(slug) => format!("slug: {}, role: {role}", scrub_controls(slug)),
            None => format!("role: {role}"),
        };
        let mut trailing = vec![PickerSegment::Muted(detail)];
        if self.current.as_deref() == Some(team.team_id.as_str()) {
            trailing.push(PickerSegment::Current);
        }
        (vec![Span::raw(name)], trailing)
    }

    /// Confirm on the selected row: the personal row answers the personal account, a team row
    /// answers the team; an empty filter selects nothing.
    pub(super) fn pick(&self) -> Option<PrimeTeamPick> {
        let row = *self.filtered.get(self.selected)?;
        Some(if row == 0 {
            PrimeTeamPick::PersonalAccount
        } else {
            let team = self.teams.get(row - 1)?;
            PrimeTeamPick::Team(team.clone())
        })
    }
}
