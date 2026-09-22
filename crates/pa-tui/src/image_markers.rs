//! Image-marker handling for the input editor.
//!
//! Pasted images are represented in the editor as `[image #N]` markers
//! while the bytes are held in a registry keyed by N. The markers present
//! in the submitted text decide which images are attached to the prompt,
//! so deleting a marker drops its image and restoring it (undo, history)
//! brings it back as long as the bytes are still in the registry.
//!
//! The contract is the TS interactive mode's `image-markers.ts`.

use std::collections::{BTreeMap, BTreeSet};

use fancy_regex::Regex;
use std::sync::LazyLock;

static IMAGE_MARKER_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\[image #(\d+)\]").expect("valid marker regex"));

/// The marker text inserted into the editor for pasted image `id`.
pub fn format_image_marker(id: u64) -> String {
    format!("[image #{id}]")
}

/// Marker ids that appear in `text`, in order of appearance.
pub fn image_marker_ids(text: &str) -> Vec<u64> {
    IMAGE_MARKER_REGEX
        .captures_iter(text)
        .filter_map(|captures| {
            let captures = captures.ok()?;
            captures
                .get(1)?
                .as_str()
                .parse::<u64>()
                .ok()
                .filter(|id| *id < (1u64 << 53))
        })
        .collect()
}

/// Images from `pending` whose marker still appears in `text`, in paste
/// order (the map's insertion order). Each image is returned at most once
/// even if its marker is duplicated in the text.
pub fn collect_marked_images<'a, T>(
    pending: &'a BTreeMap<u64, T>,
    text: &str,
) -> Vec<(u64, &'a T)> {
    if pending.is_empty() {
        return Vec::new();
    }
    let present: BTreeSet<u64> = image_marker_ids(text).into_iter().collect();
    pending
        .iter()
        .filter(|(id, _)| present.contains(id))
        .map(|(id, image)| (*id, image))
        .collect()
}

/// Evict oldest entries (insertion order) from `images` until the total of
/// `size_of` is within `max_bytes`. Ids in `keep` are never evicted, so an
/// image whose marker is still live retains its bytes even if that holds
/// the total above the cap.
pub fn evict_images_to_budget<T>(
    images: &mut BTreeMap<u64, T>,
    size_of: impl Fn(&T) -> usize,
    max_bytes: usize,
    keep: &BTreeSet<u64>,
) {
    let mut total: usize = images.values().map(&size_of).sum();
    for key in images.keys().copied().collect::<Vec<_>>() {
        if total <= max_bytes {
            break;
        }
        if keep.contains(&key) {
            continue;
        }
        if let Some(value) = images.get(&key) {
            total = total.saturating_sub(size_of(value));
        }
        images.remove(&key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marker_format_round_trips() {
        assert_eq!(format_image_marker(3), "[image #3]");
        assert_eq!(
            image_marker_ids("a [image #1] b [image #2] [image #1]"),
            vec![1, 2, 1]
        );
        assert!(image_marker_ids("no markers").is_empty());
        // Non-numeric and unsafe-integer ids are not markers.
        assert!(image_marker_ids("[image #x] [image #1.5]").is_empty());
    }

    #[test]
    fn collect_returns_pending_images_in_paste_order_once() {
        let mut pending = BTreeMap::new();
        pending.insert(2, "second");
        pending.insert(1, "first");
        pending.insert(3, "dropped");
        let collected =
            collect_marked_images(&pending, "text [image #1] more [image #2] [image #1]");
        assert_eq!(collected, vec![(1, &"first"), (2, &"second")]);
        assert!(collect_marked_images(&pending, "").is_empty());
    }

    #[test]
    fn eviction_respects_keep_set_and_budget() {
        let mut images = BTreeMap::new();
        images.insert(1, 100);
        images.insert(2, 100);
        images.insert(3, 100);
        let mut keep = BTreeSet::new();
        keep.insert(3);
        evict_images_to_budget(&mut images, |v| *v, 250, &keep);
        // 300 > 250: oldest (1) evicts; 2 and 3 stay (3 is kept, 200 <= 250).
        assert_eq!(images.keys().copied().collect::<Vec<_>>(), vec![2, 3]);
    }

    #[test]
    fn eviction_can_keep_total_above_cap_when_all_are_live() {
        let mut images = BTreeMap::new();
        images.insert(1, 1000);
        let keep: BTreeSet<u64> = [1].into_iter().collect();
        evict_images_to_budget(&mut images, |v| *v, 10, &keep);
        assert_eq!(images.len(), 1);
    }
}
