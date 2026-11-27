//! The three-way harness merge the bot global-harness sync rides.
//!
//! [`merge_harness_states`] folds an owner state (this machine's global
//! harness) and a guest state (a bot's copy) against the versions both
//! sides agreed on at their last sync. The rules keep the sync safe in
//! both directions: a bot's new entries travel to the owner, an owner's
//! deletions never resurrect from a stale bot copy, and a concurrent
//! edit resolves by version, then recency, then the owner.

use std::collections::{BTreeMap, BTreeSet};

use super::{
    empty_harness_state, kind_from_name, HarnessEntry, HarnessRefinementEvent, HarnessState,
    RefinementKind,
};

/// How many refinement events a merged state keeps (the newest ones). The
/// in-state history has no writer-side cap; repeated syncs cannot grow it
/// (the union is by id), so this only bounds one merge of two long,
/// divergent histories.
const MAX_SYNCED_REFINEMENTS: usize = 500;

/// Merge `owner` and `guest` against `base_versions`, the entry versions
/// of the guest file at its last sync. Deterministic: entries iterate in
/// `BTreeMap` order, and every tie-break ends at the owner.
///
/// Per entry:
///
/// - only in the guest, not in the base: a new bot-authored entry, kept;
/// - only in the guest, in the base: deleted on the owner, dropped;
/// - only in the owner, not in the base: a new owner entry, kept;
/// - only in the owner, in the base: deleted on the guest, the owner wins;
/// - in both and equal: kept;
/// - in both, one side changed since the base: the changed side wins;
/// - in both, both changed: the higher `version` wins, then the newer
///   `updated_at`, then the owner.
#[must_use]
pub fn merge_harness_states(
    owner: &HarnessState,
    guest: &HarnessState,
    base_versions: &BTreeMap<(RefinementKind, String), u64>,
) -> HarnessState {
    let mut merged = empty_harness_state();
    merged.schema = owner.schema.max(guest.schema);
    // A deserialized state may carry only some kind maps, so the merge
    // walks the kinds either side names and never indexes a missing one.
    let kinds: BTreeSet<RefinementKind> = owner
        .entries
        .keys()
        .chain(guest.entries.keys())
        .copied()
        .collect();
    let no_entries = BTreeMap::new();
    for kind_key in kinds {
        let owner_entries = owner.entries.get(&kind_key).unwrap_or(&no_entries);
        let guest_entries = guest.entries.get(&kind_key).unwrap_or(&no_entries);
        let ids: BTreeSet<&String> = owner_entries.keys().chain(guest_entries.keys()).collect();
        for id in ids {
            let base = base_versions.get(&(kind_key, id.clone())).copied();
            let kept = match (owner_entries.get(id), guest_entries.get(id)) {
                (Some(owner_entry), Some(guest_entry)) => Some(concurrent_winner(
                    owner_entry,
                    guest_entry,
                    base.unwrap_or(0),
                )),
                // Deleted on the guest: the owner wins.
                (Some(owner_entry), None) => Some(owner_entry),
                // Deleted on the owner when the base knew it; a new
                // bot-authored entry otherwise.
                (None, Some(guest_entry)) => base.is_none().then_some(guest_entry),
                (None, None) => None,
            };
            if let Some(entry) = kept {
                merged
                    .entries
                    .entry(kind_key)
                    .or_default()
                    .insert(id.clone(), entry.clone());
            }
        }
    }
    merged.refinements = merged_refinements(&owner.refinements, &guest.refinements);
    merged
}

/// The entry both sides keep when they both hold it: an equal pair stays,
/// a one-sided change travels, and a concurrent edit tie-breaks by
/// version, then recency, then the owner. A side whose version is at or
/// below the base did not change the entry, so a stale copy rolling an
/// entry back never wins on its own.
fn concurrent_winner<'a>(
    owner: &'a HarnessEntry,
    guest: &'a HarnessEntry,
    base: u64,
) -> &'a HarnessEntry {
    if owner == guest {
        return owner;
    }
    match (owner.version > base, guest.version > base) {
        (true, false) => owner,
        (false, true) => guest,
        // Both changed (or neither did, with diverged content): the
        // version, then the timestamp, then the owner decides.
        _ if owner.version != guest.version => {
            if owner.version > guest.version {
                owner
            } else {
                guest
            }
        }
        _ => {
            if owner_newer(owner, guest) {
                owner
            } else {
                guest
            }
        }
    }
}

/// Whether `owner`'s `updated_at` beats `guest`'s. Parsed RFC 3339
/// timestamps order by instant, so an offset like `-08:00` is never a
/// string prefix comparison.
fn owner_newer(owner: &HarnessEntry, guest: &HarnessEntry) -> bool {
    match (
        rfc3339_nanos(&owner.updated_at),
        rfc3339_nanos(&guest.updated_at),
    ) {
        (Some(owner_at), Some(guest_at)) => owner_at >= guest_at,
        // An unparseable stamp loses to a parseable one; two equally
        // unreadable stamps leave the win with the owner.
        (Some(_) | None, None) => true,
        (None, Some(_)) => false,
    }
}

/// The refinement histories as one union by event id (the owner's copy of
/// a shared id wins), sorted by `created_at` and capped at
/// [`MAX_SYNCED_REFINEMENTS`] newest events.
fn merged_refinements(
    owner: &[HarnessRefinementEvent],
    guest: &[HarnessRefinementEvent],
) -> Vec<HarnessRefinementEvent> {
    let mut by_id: BTreeMap<&str, HarnessRefinementEvent> = owner
        .iter()
        .map(|event| (event.id.as_str(), event.clone()))
        .collect();
    for event in guest {
        by_id
            .entry(event.id.as_str())
            .or_insert_with(|| event.clone());
    }
    let mut events: Vec<HarnessRefinementEvent> = by_id.into_values().collect();
    events.sort_by(|left, right| {
        rfc3339_nanos(&left.created_at)
            .cmp(&rfc3339_nanos(&right.created_at))
            .then_with(|| left.id.cmp(&right.id))
    });
    let over = events.len().saturating_sub(MAX_SYNCED_REFINEMENTS);
    events.drain(..over);
    events
}

/// Every entry's version, keyed by kind and id: the map a sync records as
/// its base.
#[must_use]
pub fn entry_versions(state: &HarnessState) -> BTreeMap<(RefinementKind, String), u64> {
    state
        .entries
        .iter()
        .flat_map(|(kind, entries)| {
            entries
                .iter()
                .map(move |(id, entry)| ((*kind, id.clone()), entry.version))
        })
        .collect()
}

/// The kind a recorded base key names. Unknown names read as subagent,
/// like the state loader's own fallback.
#[must_use]
pub fn kind_from_key_name(name: &str) -> RefinementKind {
    kind_from_name(name)
}

/// Epoch nanoseconds of an RFC 3339 timestamp, or `None` when it does
/// not parse. Handles the shapes both harness writers emit: `Z` and
/// numeric `±HH:MM` offsets, and fractional seconds of any length. The
/// fraction keeps nanosecond precision, so the tie-break can order two
/// edits inside one millisecond (the kernel writes microseconds).
fn rfc3339_nanos(stamp: &str) -> Option<i64> {
    let bytes = stamp.as_bytes();
    if bytes.len() < 20
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || (bytes[10] != b'T' && bytes[10] != b' ')
        || bytes[13] != b':'
        || bytes[16] != b':'
    {
        return None;
    }
    let year: i64 = stamp.get(0..4)?.parse().ok()?;
    let month = stamp.get(5..7)?.parse::<u32>().ok()?;
    let day = stamp.get(8..10)?.parse::<u32>().ok()?;
    let hour = stamp.get(11..13)?.parse::<u32>().ok()?;
    let minute = stamp.get(14..16)?.parse::<u32>().ok()?;
    let second = stamp.get(17..19)?.parse::<u32>().ok()?;
    let mut rest = &stamp[19..];
    let mut nanos: i64 = 0;
    if let Some(fraction) = rest.strip_prefix('.') {
        let digits: &str = fraction
            .split_once(|byte: char| !byte.is_ascii_digit())
            .map_or(fraction, |(digits, _)| digits);
        if digits.is_empty() {
            return None;
        }
        let mut scaled = [b'0'; 9];
        for (slot, digit) in scaled.iter_mut().zip(digits.as_bytes()) {
            *slot = *digit;
        }
        nanos = String::from_utf8_lossy(&scaled).parse::<i64>().ok()?;
        rest = &rest[1 + digits.len()..];
    }
    let offset_secs = match rest.as_bytes().first() {
        Some(b'Z' | b'z') if rest.len() == 1 => 0,
        Some(sign @ (b'+' | b'-')) => {
            let offset = rest.get(1..6)?;
            let offset_hours = offset.get(0..2)?.parse::<i64>().ok()?;
            let offset_minutes = offset.get(3..5)?.parse::<i64>().ok()?;
            if offset.as_bytes().get(2) != Some(&b':') || offset_hours > 23 || offset_minutes > 59 {
                return None;
            }
            let magnitude = offset_hours * 3_600 + offset_minutes * 60;
            if *sign == b'-' {
                -magnitude
            } else {
                magnitude
            }
        }
        _ => return None,
    };
    if !(1..=12).contains(&month) || day == 0 || day > 31 || hour > 23 || minute > 59 || second > 59
    {
        return None;
    }
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let days_in_month = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        _ => 28,
    };
    if day > days_in_month {
        return None;
    }
    let days = days_from_civil(year, month, day);
    let secs = days * 86_400 + i64::from(hour) * 3_600 + i64::from(minute) * 60 + i64::from(second)
        - offset_secs;
    // Nanoseconds overflow i64 past the year 2262; such a stamp reads as
    // undatable instead of wrapping.
    secs.checked_mul(1_000_000_000)?.checked_add(nanos)
}

/// Days from 1970-01-01 (Howard Hinnant's civil algorithm, the one every
/// crate here already carries).
fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year.rem_euclid(400);
    let month_prime = i64::from((month + 9) % 12);
    let day_of_year = (153 * month_prime + 2) / 5 + i64::from(day) - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str, version: u64, updated_at: &str) -> HarnessEntry {
        HarnessEntry {
            id: id.to_string(),
            kind: RefinementKind::Memory,
            title: format!("Entry {id}"),
            content: format!("content of {id} v{version}"),
            path: "general".to_string(),
            scope: Some(super::super::HarnessScope::Global),
            reference: serde_json::Map::default(),
            arguments: serde_json::Map::default(),
            metadata: serde_json::Map::default(),
            source: "test".to_string(),
            created_at: "2026-01-01T00:00:00.000Z".to_string(),
            updated_at: updated_at.to_string(),
            version,
        }
    }

    fn state(entries: &[(&str, u64, &str)]) -> HarnessState {
        let mut state = empty_harness_state();
        for (id, version, updated_at) in entries {
            state
                .entries
                .get_mut(&RefinementKind::Memory)
                .unwrap()
                .insert(id.to_string(), entry(id, *version, updated_at));
        }
        state
    }

    fn base(entries: &[(&str, u64)]) -> BTreeMap<(RefinementKind, String), u64> {
        entries
            .iter()
            .map(|(id, version)| ((RefinementKind::Memory, id.to_string()), *version))
            .collect()
    }

    fn merged_entry<'a>(merged: &'a HarnessState, id: &str) -> Option<&'a HarnessEntry> {
        merged.entries[&RefinementKind::Memory].get(id)
    }

    #[test]
    fn a_new_bot_entry_is_kept_and_an_owner_deletion_drops_it() {
        // New on the bot: kept.
        let owner = state(&[]);
        let guest = state(&[("bot-new", 1, "2026-02-01T00:00:00.000Z")]);
        let merged = merge_harness_states(&owner, &guest, &base(&[]));
        assert!(merged_entry(&merged, "bot-new").is_some());

        // The base knew it and the owner deleted it: dropped, never
        // resurrected from a stale bot copy.
        let merged = merge_harness_states(&owner, &guest, &base(&[("bot-new", 1)]));
        assert!(merged_entry(&merged, "bot-new").is_none());
    }

    #[test]
    fn a_new_owner_entry_is_kept_and_a_guest_deletion_loses_to_the_owner() {
        let owner = state(&[("owner-new", 1, "2026-02-01T00:00:00.000Z")]);
        let guest = state(&[]);
        // New on the owner: kept and pushed to the guest.
        let merged = merge_harness_states(&owner, &guest, &base(&[]));
        assert!(merged_entry(&merged, "owner-new").is_some());
        // The base knew it and the guest deleted it: the owner wins.
        let merged = merge_harness_states(&owner, &guest, &base(&[("owner-new", 1)]));
        assert!(merged_entry(&merged, "owner-new").is_some());
    }

    #[test]
    fn equal_entries_stay_and_a_one_sided_change_travels() {
        let equal = ("shared", 2, "2026-02-01T00:00:00.000Z");
        let owner = state(&[equal]);
        let guest = state(&[equal]);
        let merged = merge_harness_states(&owner, &guest, &base(&[("shared", 2)]));
        assert_eq!(
            merged_entry(&merged, "shared"),
            merged_entry(&owner, "shared")
        );

        // Only the owner changed since the base: the owner's edit wins.
        let owner_edit = state(&[("shared", 3, "2026-03-01T00:00:00.000Z")]);
        let merged = merge_harness_states(&owner_edit, &guest, &base(&[("shared", 2)]));
        assert_eq!(merged_entry(&merged, "shared").unwrap().version, 3);

        // Only the guest changed since the base: the bot's edit wins.
        let guest_edit = state(&[("shared", 4, "2026-03-02T00:00:00.000Z")]);
        let merged = merge_harness_states(&owner, &guest_edit, &base(&[("shared", 2)]));
        assert_eq!(merged_entry(&merged, "shared").unwrap().version, 4);
    }

    #[test]
    fn a_concurrent_edit_takes_the_higher_version_then_the_newer_stamp_then_the_owner() {
        let owner = state(&[("shared", 5, "2026-03-01T00:00:00.000Z")]);
        let guest = state(&[("shared", 6, "2026-02-01T00:00:00.000Z")]);

        // Higher version wins, whatever the stamps say.
        let merged = merge_harness_states(&owner, &guest, &base(&[("shared", 2)]));
        assert_eq!(merged_entry(&merged, "shared").unwrap().version, 6);

        // Equal versions: the newer RFC 3339 instant wins. The guest's
        // stamp is the later instant, written with a non-UTC offset.
        let owner = state(&[("shared", 5, "2026-03-01T23:00:00.000Z")]);
        let guest = state(&[("shared", 5, "2026-03-01T16:00:00.000-08:00")]);
        let merged = merge_harness_states(&owner, &guest, &base(&[("shared", 2)]));
        assert_eq!(
            merged_entry(&merged, "shared").unwrap().updated_at,
            "2026-03-01T16:00:00.000-08:00"
        );

        // Equal versions and instants: the owner wins.
        let owner = state(&[("shared", 5, "2026-03-01T23:00:00.000Z")]);
        let guest = state(&[("shared", 5, "2026-03-01T23:00:00.000+00:00")]);
        let merged = merge_harness_states(&owner, &guest, &base(&[("shared", 2)]));
        assert_eq!(
            merged_entry(&merged, "shared").unwrap().updated_at,
            "2026-03-01T23:00:00.000Z"
        );
    }

    #[test]
    fn refinement_histories_union_by_id_and_sort_by_created_at() {
        let mut owner = state(&[]);
        owner.refinements = vec![
            HarnessRefinementEvent {
                id: "r-old".to_string(),
                trigger: "old".to_string(),
                changes: vec![],
                evidence: String::new(),
                outcome: String::new(),
                created_at: "2026-01-01T00:00:00.000Z".to_string(),
            },
            HarnessRefinementEvent {
                id: "r-shared".to_string(),
                trigger: "owner copy".to_string(),
                changes: vec![],
                evidence: String::new(),
                outcome: String::new(),
                created_at: "2026-02-01T00:00:00.000Z".to_string(),
            },
        ];
        let mut guest = state(&[]);
        guest.refinements = vec![
            HarnessRefinementEvent {
                id: "r-shared".to_string(),
                trigger: "guest copy".to_string(),
                changes: vec![],
                evidence: String::new(),
                outcome: String::new(),
                created_at: "2026-02-01T00:00:00.000Z".to_string(),
            },
            HarnessRefinementEvent {
                id: "r-new".to_string(),
                trigger: "new".to_string(),
                changes: vec![],
                evidence: String::new(),
                outcome: String::new(),
                created_at: "2026-03-01T00:00:00.000Z".to_string(),
            },
        ];
        let merged = merge_harness_states(&owner, &guest, &base(&[]));
        let ids: Vec<&str> = merged
            .refinements
            .iter()
            .map(|event| event.id.as_str())
            .collect();
        assert_eq!(ids, ["r-old", "r-shared", "r-new"]);
        // A shared id keeps the owner's copy.
        assert_eq!(merged.refinements[1].trigger, "owner copy");
    }

    #[test]
    fn merged_refinements_cap_keeps_the_newest() {
        let mut owner = state(&[]);
        for index in 0..MAX_SYNCED_REFINEMENTS {
            owner.refinements.push(HarnessRefinementEvent {
                id: format!("owner-{index}"),
                trigger: String::new(),
                changes: vec![],
                evidence: String::new(),
                outcome: String::new(),
                created_at: "2026-01-01T00:00:00.000Z".to_string(),
            });
        }
        let mut guest = state(&[]);
        guest.refinements.push(HarnessRefinementEvent {
            id: "newest".to_string(),
            trigger: String::new(),
            changes: vec![],
            evidence: String::new(),
            outcome: String::new(),
            created_at: "2026-06-01T00:00:00.000Z".to_string(),
        });
        let merged = merged_refinements(&owner.refinements, &guest.refinements);
        assert_eq!(merged.len(), MAX_SYNCED_REFINEMENTS);
        assert_eq!(merged.last().unwrap().id, "newest");
        assert_eq!(merged[0].id, "owner-1");
    }

    #[test]
    fn rfc3339_parses_offsets_and_fractions_by_instant() {
        // The same instant in three spellings.
        let zulu = rfc3339_nanos("2026-03-01T23:00:00.000Z").unwrap();
        assert_eq!(zulu, rfc3339_nanos("2026-03-01T23:00:00Z").unwrap());
        assert_eq!(
            zulu,
            rfc3339_nanos("2026-03-01T23:00:00.000+00:00").unwrap()
        );
        assert_eq!(
            zulu,
            rfc3339_nanos("2026-03-01T15:00:00.000-08:00").unwrap()
        );
        // Microsecond fractions keep their full precision.
        assert_eq!(
            rfc3339_nanos("2026-03-01T23:00:00.878719+00:00").unwrap() % 1_000_000_000,
            878_719_000
        );
        // Two stamps inside one millisecond order by their fraction.
        assert!(
            rfc3339_nanos("2026-03-01T23:00:00.000400Z").unwrap()
                > rfc3339_nanos("2026-03-01T23:00:00.000300Z").unwrap()
        );
        // A smaller local hour behind an offset is a later instant:
        // 15:00 at -08:00 is 23:00 UTC, past 20:00 UTC. A raw string
        // compare would order "15:00..." before "20:00...".
        assert!(
            rfc3339_nanos("2026-03-01T20:00:00Z").unwrap()
                < rfc3339_nanos("2026-03-01T15:00:00-08:00").unwrap()
        );
        // Junk and impossible dates read as undatable.
        for bad in [
            "",
            "not a stamp",
            "2026-03-01",
            "2026-02-30T00:00:00Z",
            "2026-03-01T25:00:00Z",
            "2026-03-01T00:00:00+25:00",
            "2026-03-01T00:00:00UTC",
        ] {
            assert!(rfc3339_nanos(bad).is_none(), "{bad} must not parse");
        }
        // A space separator parses, like the sibling parsers.
        assert_eq!(rfc3339_nanos("2026-03-01 23:00:00Z").unwrap(), zulu);
    }

    #[test]
    fn a_guest_copy_below_the_base_version_never_rolls_the_owner_back() {
        // The base holds version 3; the owner still runs 3; the guest
        // file is an older checkpoint at 2. The stale copy must not win.
        let owner = state(&[("shared", 3, "2026-03-01T00:00:00.000Z")]);
        let guest = state(&[("shared", 2, "2026-03-02T00:00:00.000Z")]);
        let merged = merge_harness_states(&owner, &guest, &base(&[("shared", 3)]));
        assert_eq!(merged_entry(&merged, "shared").unwrap().version, 3);
    }

    #[test]
    fn a_partial_guest_state_merges_without_panicking() {
        // A deserialized state may carry no kind maps at all; the merge
        // walks the kinds either side names instead of indexing them.
        let owner = state(&[("a", 1, "2026-01-01T00:00:00.000Z")]);
        let guest = HarnessState {
            schema: 1,
            entries: BTreeMap::new(),
            refinements: Vec::new(),
        };
        let merged = merge_harness_states(&owner, &guest, &base(&[]));
        assert!(merged_entry(&merged, "a").is_some());
        // A partial owner state is just as welcome.
        let merged = merge_harness_states(&guest, &owner, &base(&[]));
        assert!(merged_entry(&merged, "a").is_some());
    }

    #[test]
    fn equal_versions_order_by_sub_millisecond_stamps() {
        // Both sides edited the same base version; the guest's stamp is
        // 100 microseconds newer, a difference a millisecond truncation
        // would erase.
        let owner = state(&[("shared", 5, "2026-03-01T23:00:00.000300Z")]);
        let guest = state(&[("shared", 5, "2026-03-01T23:00:00.000400Z")]);
        let merged = merge_harness_states(&owner, &guest, &base(&[("shared", 2)]));
        assert_eq!(
            merged_entry(&merged, "shared").unwrap().updated_at,
            "2026-03-01T23:00:00.000400Z"
        );
    }

    #[test]
    fn entry_versions_key_every_entry_by_kind_and_id() {
        let state = state(&[
            ("a", 1, "2026-01-01T00:00:00.000Z"),
            ("b", 4, "2026-01-01T00:00:00.000Z"),
        ]);
        let versions = entry_versions(&state);
        assert_eq!(
            versions.get(&(RefinementKind::Memory, "a".to_string())),
            Some(&1)
        );
        assert_eq!(
            versions.get(&(RefinementKind::Memory, "b".to_string())),
            Some(&4)
        );
        assert_eq!(kind_from_key_name("skill"), RefinementKind::Skill);
    }
}
