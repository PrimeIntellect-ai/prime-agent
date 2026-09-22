//! Paste-marker behavior tests: ports of the TS `editor.test.ts`
//! "Paste marker atomic behavior" and paste-snapshot suites.

use super::*;
use wrap::{segment_with_markers, word_wrap_line};

fn ed() -> Editor {
    Editor::new()
}

fn paste_with_marker(e: &mut Editor, lines: usize) {
    let text = "line\n".repeat(lines);
    let text = text.trim_end().to_string();
    e.handle_paste(&text);
}

/// Length of the first marker in the editor text (TS `markerLength`).
fn marker_len(e: &Editor) -> usize {
    let text = e.get_text();
    let start = text.find("[paste #").expect("marker text");
    let end = text[start..].find(']').expect("marker end") + start + 1;
    text[start..end].chars().count()
}

fn cursor(e: &Editor) -> (usize, usize) {
    e.get_cursor()
}

#[test]
fn marker_is_a_single_unit_for_the_right_arrow() {
    let mut e = ed();
    e.handle_input("A");
    paste_with_marker(&mut e, 20);
    e.handle_input("B");
    let m = marker_len(&e);

    e.handle_input("home");
    assert_eq!(cursor(&e), (0, 0));
    e.handle_input("right");
    assert_eq!(cursor(&e), (0, 1));
    e.handle_input("right");
    assert_eq!(cursor(&e), (0, 1 + m), "the marker is crossed whole");
    e.handle_input("right");
    assert_eq!(cursor(&e), (0, 2 + m));
}

#[test]
fn marker_is_a_single_unit_for_the_left_arrow() {
    let mut e = ed();
    e.handle_input("A");
    paste_with_marker(&mut e, 20);
    e.handle_input("B");
    let m = marker_len(&e);
    assert_eq!(cursor(&e), (0, 2 + m));

    e.handle_input("left");
    assert_eq!(cursor(&e), (0, 1 + m), "the marker is crossed whole");
    e.handle_input("left");
    assert_eq!(cursor(&e), (0, 1));
    e.handle_input("left");
    assert_eq!(cursor(&e), (0, 0));
}

#[test]
fn marker_is_a_single_unit_for_backspace() {
    let mut e = ed();
    e.handle_input("A");
    paste_with_marker(&mut e, 20);
    e.handle_input("B");

    e.handle_input("home");
    e.handle_input("right");
    e.handle_input("right");
    assert_eq!(cursor(&e), (0, 1 + marker_len(&e)));
    e.handle_input("backspace");
    assert_eq!(e.get_text(), "AB", "the marker is deleted whole");
    assert_eq!(cursor(&e), (0, 1));
}

#[test]
fn marker_is_a_single_unit_for_forward_delete() {
    let mut e = ed();
    e.handle_input("A");
    paste_with_marker(&mut e, 20);
    e.handle_input("B");

    e.handle_input("home");
    e.handle_input("right");
    e.handle_input("delete");
    assert_eq!(e.get_text(), "AB", "the marker is deleted whole");
    assert_eq!(cursor(&e), (0, 1));
}

#[test]
fn marker_is_a_single_unit_for_word_movement() {
    let mut e = ed();
    e.handle_input("X");
    e.handle_input(" ");
    paste_with_marker(&mut e, 20);
    e.handle_input(" ");
    e.handle_input("Y");
    let m = marker_len(&e);

    e.handle_input("home");
    e.handle_input("alt+right");
    assert_eq!(cursor(&e), (0, 1));
    e.handle_input("alt+right");
    assert_eq!(cursor(&e), (0, 2 + m), "the marker is crossed whole");
}

#[test]
fn undo_restores_marker_after_backspace_deletion() {
    let mut e = ed();
    e.handle_input("A");
    paste_with_marker(&mut e, 20);
    e.handle_input("B");
    let text_before = e.get_text();
    let content = e.get_expanded_text();

    e.handle_input("home");
    e.handle_input("right");
    e.handle_input("right");
    e.handle_input("backspace");
    assert_eq!(e.get_text(), "AB");

    e.handle_input("ctrl+-");
    assert_eq!(e.get_text(), text_before);
    assert_eq!(e.get_expanded_text(), content, "the registry restores too");
}

#[test]
fn multiple_markers_in_the_same_line_stay_atomic() {
    let mut e = ed();
    paste_with_marker(&mut e, 20);
    e.handle_input(" ");
    paste_with_marker(&mut e, 30);
    let first = marker_len(&e);
    let text = e.get_text();
    let second = {
        let second_start = text.rfind("[paste #").expect("second marker");
        text[second_start..].chars().count()
    };

    e.handle_input("home");
    e.handle_input("right");
    assert_eq!(cursor(&e), (0, first));
    e.handle_input("right");
    assert_eq!(cursor(&e), (0, first + 1));
    e.handle_input("right");
    assert_eq!(cursor(&e), (0, first + 1 + second));
}

#[test]
fn typed_marker_like_text_is_not_atomic() {
    let mut e = ed();
    // The chars-shaped head avoids typing "+" before the term-keys lane's
    // literal-plus decode fix lands; the shape is the same for the
    // atomicity property under test.
    let fake_marker = "[paste #99 500 chars]";
    for ch in fake_marker.chars() {
        e.handle_input(&ch.to_string());
    }
    assert_eq!(e.get_text(), fake_marker);

    e.handle_input("home");
    e.handle_input("right");
    assert_eq!(cursor(&e), (0, 1), "an unregistered marker moves by char");
}

#[test]
fn oversized_marker_never_exceeds_the_render_width() {
    // (before, pasted lines, after, width) — TS `overflowCases`.
    let cases: [(&str, usize, &str, usize); 3] = [
        ("", 47, "", 8),
        (&"b".repeat(35), 27, "bbbb", 54),
        (&format!(" {}", "b".repeat(35)), 27, "bbbb", 54),
    ];
    for (before, lines, after, width) in cases {
        let mut e = ed();
        for ch in before.chars() {
            e.handle_input(&ch.to_string());
        }
        paste_with_marker(&mut e, lines);
        for ch in after.chars() {
            e.handle_input(&ch.to_string());
        }
        assert!(marker_len(&e) > 0);
        for line in e.layout_text(width) {
            assert!(
                crate::width::str_width(&line.text) <= width,
                "line exceeds width {width}: {:?}",
                line.text
            );
        }
    }
}

#[test]
fn snap_to_marker_start_when_navigating_down_into_it() {
    let mut e = ed();
    e.set_text("12345678901234567890\n\nhello ");
    e.handle_paste(&"x".repeat(2000));
    assert!(matches!(e.handle_paste(""), PasteDisposition::Inline));
    let _ = e.layout_text(80);

    e.handle_input("up");
    e.handle_input("up");
    e.handle_input("home");
    for _ in 0..10 {
        e.handle_input("right");
    }
    assert_eq!(cursor(&e), (0, 10));

    e.handle_input("down");
    assert_eq!(cursor(&e), (1, 0));
    e.handle_input("down");
    assert_eq!(cursor(&e), (2, 6), "the cursor snaps to the marker start");
}

#[test]
fn expanded_content_survives_to_submit() {
    let mut e = ed();
    let pasted_text = (0..10)
        .map(|index| format!("line {}", index + 1))
        .chain(std::iter::once("tokens $1 $2 $& $$ $` $' end".to_string()))
        .collect::<Vec<_>>()
        .join("\n");

    e.handle_paste(&pasted_text);
    assert!(e.get_text().starts_with("[paste #"));
    assert_eq!(e.get_expanded_text(), pasted_text);

    e.handle_input("enter");
    let events = e.take_events();
    let submitted = events
        .iter()
        .find_map(|event| match event {
            EditorEvent::Submitted(text) => Some(text.clone()),
            _ => None,
        })
        .expect("submit event");
    assert_eq!(submitted, pasted_text, "the send ships the full content");
}

#[test]
fn paste_snapshot_round_trips_between_editors() {
    let pasted_text = (0..11)
        .map(|i| format!("line {}", i + 1))
        .collect::<Vec<_>>()
        .join("\n");
    let mut source = ed();
    source.handle_paste(&pasted_text);
    let marker_text = source.get_text();
    let snapshot = source.get_paste_snapshot();

    let mut restored = ed();
    restored.set_text(&marker_text);
    restored.restore_paste_snapshot(snapshot);
    assert!(marker_text.starts_with("[paste #"));
    assert_eq!(restored.get_expanded_text(), pasted_text);
}

#[test]
fn undo_restores_paste_snapshot_state() {
    let original_text = (0..11)
        .map(|i| format!("original {}", i + 1))
        .collect::<Vec<_>>()
        .join("\n");
    let restored_text = (0..12)
        .map(|i| format!("restored {}", i + 1))
        .collect::<Vec<_>>()
        .join("\n");

    let mut e = ed();
    e.handle_paste(&original_text);
    let original_marker = e.get_text();

    let mut restored_source = ed();
    restored_source.handle_paste(&restored_text);
    e.set_text(&restored_source.get_text());
    e.restore_paste_snapshot(restored_source.get_paste_snapshot());
    assert_eq!(e.get_expanded_text(), restored_text);

    e.handle_input("ctrl+-");
    assert_eq!(e.get_text(), original_marker);
    assert_eq!(e.get_expanded_text(), original_text);
}

#[test]
fn only_well_formed_registered_markers_expand() {
    let mut e = ed();
    paste_with_marker(&mut e, 20); // registers [paste #1]
    let content = paste_content(&e, 1);

    // Edited look-alikes, an unregistered id, and a longer id whose head
    // contains `#1` all stay literal; the three well-formed registered
    // shapes expand (TS builds one regex per registered id, so
    // `[paste #1` never swallows the head of `[paste #10]`).
    e.set_text("[paste #1 junk] [paste #10] [paste #1] [paste #1 +5 lines] [paste #1 12 chars]");
    assert_eq!(
        e.get_expanded_text(),
        format!("[paste #1 junk] [paste #10] {content} {content} {content}"),
    );
}

fn paste_content(e: &Editor, id: usize) -> String {
    e.get_paste_snapshot()
        .pastes
        .into_iter()
        .find(|(pid, _)| *pid == id)
        .map(|(_, content)| content)
        .expect("registered paste")
}

#[test]
fn oversized_marker_re_wraps_visually_and_wrap_resumes_after_it() {
    // TS `wordWrapLine` atomic cases: the marker stays one logical segment
    // but re-wraps visually at grapheme granularity, and wrapping resumes
    // normally after it (all through the editor's marker-aware
    // segmentation).
    let marker = "[paste #1 +20 lines]";
    let line = format!("A{marker}B");
    let segments = segment_with_markers(&line, &|_| true);
    let chunks = word_wrap_line(&line, 10, Some(segments));
    let texts: Vec<&str> = chunks.iter().map(|c| c.text.as_str()).collect();
    assert_eq!(texts, vec!["A", "[paste #1 ", "+20 lines]", "B"]);

    let line = format!("{marker} hello world");
    let segments = segment_with_markers(&line, &|_| true);
    let chunks = word_wrap_line(&line, 10, Some(segments));
    let texts: Vec<&str> = chunks.iter().map(|c| c.text.as_str()).collect();
    assert_eq!(texts, vec!["[paste #1 ", "+20 lines]", " hello ", "world"]);
}
