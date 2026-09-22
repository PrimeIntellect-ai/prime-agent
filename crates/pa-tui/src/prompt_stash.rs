//! Client-owned prompt stash store (TS `prompt-stash-state.ts`): the
//! per-session editor-draft stash one TUI process shares across its chat
//! views.
//!
//! A draft left behind on a session switch belongs to the session it was
//! typed in. The store keeps it (the marker text plus the pasted images its
//! markers reference) keyed by the session's stable id; a chat that opens
//! that session again finds it and puts it back into the editor. A session
//! that already holds an unrestored draft keeps it queued behind the new
//! head, so a chain of switches never drops an older draft.

use std::collections::HashMap;

use crate::editor::EditorPasteSnapshot;
use crate::image_load::LoadedImage;

/// One stashed editor draft: the marker text plus the collapsed-paste and
/// image registries its markers reference (TS `PromptStash`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PromptStash {
    /// The editor text, `[paste #N ...]` and `[image #N]` markers
    /// included.
    pub text: String,
    /// The collapsed pastes the text's markers reference (TS
    /// `pasteSnapshot`, captured by `snapshotPromptStashFrom`): without
    /// it a restored draft's paste markers would stay literal instead of
    /// expanding on submit.
    pub paste_snapshot: Option<EditorPasteSnapshot>,
    /// The referenced images, in marker order, keyed by marker id.
    pub images: Vec<(u64, LoadedImage)>,
    /// The auto-stash of a session switch: restored into the editor the
    /// next time the session's chat opens (TS `restoreOnOpen`).
    pub restore_on_open: bool,
}

/// One session's stash state (TS `PromptStashState`): the head draft plus
/// the drafts queued behind it. Only the head can be restored on open; a
/// restore pops it and promotes the queue's next draft to the head.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct PromptStashState {
    /// The restore candidate (TS `stash`).
    pub stash: Option<PromptStash>,
    /// The older drafts queued behind the head (TS `queuedStashes`).
    pub queued_stashes: Vec<PromptStash>,
}

impl PromptStashState {
    /// Whether the state holds no draft at all (the release condition).
    pub(crate) fn is_empty(&self) -> bool {
        self.stash.is_none() && self.queued_stashes.is_empty()
    }

    /// Stash `draft` as the session's head: an existing unrestored head
    /// (and its queue) lines up behind it, keeping its own restore
    /// semantics (TS `stashDraftForAgentsView`).
    pub fn stash_draft_head(&mut self, draft: PromptStash) {
        let mut ordered = Vec::with_capacity(self.queued_stashes.len() + 1);
        if let Some(existing) = self.stash.take() {
            ordered.push(existing);
        }
        ordered.append(&mut self.queued_stashes);
        self.stash = Some(draft);
        self.queued_stashes = ordered;
    }

    /// Take the head draft when it is a restore-on-open auto-stash,
    /// promoting the next queued draft to the head (TS
    /// `restorePromptStashIfEditorEmpty`'s queue shift). The caller owns
    /// the editor-empty condition.
    pub fn take_head_restore_on_open(&mut self) -> Option<PromptStash> {
        if !self
            .stash
            .as_ref()
            .is_some_and(|stash| stash.restore_on_open)
        {
            return None;
        }
        let head = self.stash.take();
        self.stash = if self.queued_stashes.is_empty() {
            None
        } else {
            Some(self.queued_stashes.remove(0))
        };
        head
    }
}

/// The per-process store (TS `ClientPromptStashStore`): each chat binds the
/// state of the session it renders; a binding that ends up empty releases
/// with it. Entry identity is the map slot, so a release can only drop the
/// state the binding created — never a draft another view stashed.
#[derive(Debug, Default)]
pub struct PromptStashStore {
    states: HashMap<String, PromptStashState>,
}

impl PromptStashStore {
    /// The state of `session_id`, created empty on first touch (TS
    /// `forSession`).
    pub(crate) fn for_session(&mut self, session_id: &str) -> &mut PromptStashState {
        self.states.entry(session_id.to_string()).or_default()
    }

    /// Release `session_id` when its state is empty (TS `release`): a
    /// session holding drafts keeps them for the next view that binds it.
    pub(crate) fn release(&mut self, session_id: &str) {
        if self
            .states
            .get(session_id)
            .is_some_and(PromptStashState::is_empty)
        {
            self.states.remove(session_id);
        }
    }

    /// How many sessions hold stash state (verifier surface).
    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.states.len()
    }

    /// Whether no session holds stash state (verifier surface).
    #[cfg(test)]
    pub fn is_empty(&self) -> bool {
        self.states.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn image(tag: &str) -> LoadedImage {
        LoadedImage {
            data: tag.to_string(),
            mime_type: "image/png".to_string(),
        }
    }

    fn draft(text: &str, restore_on_open: bool) -> PromptStash {
        PromptStash {
            text: text.to_string(),
            paste_snapshot: None,
            images: Vec::new(),
            restore_on_open,
        }
    }

    #[test]
    fn for_session_creates_once_and_release_drops_only_empty() {
        let mut store = PromptStashStore::default();
        {
            let state = store.for_session("a");
            assert!(state.is_empty());
        }
        store.release("a");
        assert!(store.is_empty(), "an empty state releases");

        store.for_session("a").stash = Some(draft("typed draft", true));
        store.release("a");
        assert_eq!(store.len(), 1, "a session holding a draft keeps it");

        {
            let state = store.for_session("b");
            state.queued_stashes.push(draft("queued", false));
        }
        store.release("b");
        assert_eq!(
            store.len(),
            2,
            "a session holding only queued drafts keeps them"
        );
    }

    #[test]
    fn stash_draft_head_queues_the_existing_stash_behind_it() {
        let mut store = PromptStashStore::default();
        let state = store.for_session("a");
        state.stash = Some(draft("manual draft", false));
        state.queued_stashes.push(draft("older queued", false));
        state.stash_draft_head(draft("typed draft", true));

        assert_eq!(
            state.stash.as_ref().map(|stash| stash.text.as_str()),
            Some("typed draft")
        );
        assert!(state.stash.as_ref().unwrap().restore_on_open);
        assert_eq!(
            state
                .queued_stashes
                .iter()
                .map(|stash| stash.text.as_str())
                .collect::<Vec<_>>(),
            vec!["manual draft", "older queued"]
        );
    }

    #[test]
    fn restore_pops_the_head_and_promotes_the_queue() {
        let mut store = PromptStashStore::default();
        let state = store.for_session("a");
        state.stash = Some(draft("second visit draft", true));
        state.queued_stashes.push(draft("first visit draft", true));
        state.queued_stashes.push(draft("oldest", true));

        let restored = state.take_head_restore_on_open().expect("head restores");
        assert_eq!(restored.text, "second visit draft");
        assert_eq!(
            state.stash.as_ref().map(|stash| stash.text.as_str()),
            Some("first visit draft")
        );
        assert_eq!(state.queued_stashes.len(), 1);

        // A non-auto stash never restores on open.
        let manual = state.take_head_restore_on_open();
        assert!(manual.is_some(), "the promoted head is also an auto-stash");
        state.stash = Some(draft("manual draft", false));
        assert!(state.take_head_restore_on_open().is_none());
        assert!(state.stash.is_some(), "the manual stash stays");
    }

    #[test]
    fn stashed_images_round_trip_through_the_state() {
        let mut store = PromptStashStore::default();
        let state = store.for_session("a");
        let stash = PromptStash {
            text: "look at [image #7]".to_string(),
            paste_snapshot: None,
            images: vec![(7, image("bytes"))],
            restore_on_open: true,
        };
        state.stash = Some(stash.clone());

        let restored = state.take_head_restore_on_open().expect("head restores");
        assert_eq!(restored, stash, "the whole draft round-trips");
        assert!(state.is_empty(), "the popped draft leaves nothing behind");
    }

    #[test]
    fn stashed_paste_snapshot_round_trips_with_the_text() {
        // TS `PromptStash.pasteSnapshot`: a collapsed draft keeps its
        // id/content registry through the stash, so the restored marker
        // still expands on submit.
        let mut store = PromptStashStore::default();
        let state = store.for_session("a");
        let content = (0..20)
            .map(|i| format!("line {i}"))
            .collect::<Vec<_>>()
            .join("\n");
        state.stash = Some(PromptStash {
            text: "[paste #1 +20 lines]".to_string(),
            paste_snapshot: Some(EditorPasteSnapshot {
                pastes: vec![(1, content.clone())],
                paste_counter: 1,
            }),
            images: Vec::new(),
            restore_on_open: true,
        });

        let restored = state.take_head_restore_on_open().expect("head restores");
        let snapshot = restored.paste_snapshot.expect("the registry travels");
        assert_eq!(snapshot.pastes, vec![(1, content)]);
        assert_eq!(snapshot.paste_counter, 1);
    }
}
