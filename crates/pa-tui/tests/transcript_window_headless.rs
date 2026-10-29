//! The transcript window against a paging mock: anchored scrolling through older
//! pages, and a bounded resident run.
#![cfg(unix)]
// Casts: bounded fixture arithmetic.
#![allow(
    clippy::too_many_lines,
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap
)]

mod support;

use std::collections::HashSet;
use std::io::{BufRead, BufReader};
use std::os::unix::net::UnixListener;
use std::sync::{Arc, Mutex};

use pa_tui::interactive::{
    run_interactive, HeadlessPlan, HeadlessStep, InteractiveOptions, SessionSelection, UiMode,
};
use serde_json::{json, Value};

use support::{options, write_json};

const TAIL: usize = 300;
/// The window's page size and resident chunk count (the bound under test).
const CHUNK: usize = 256;
const RESIDENT_CHUNKS: usize = 8;
/// Enough history above the tail that a climb to the top evicts resident chunks.
const MESSAGES: usize = TAIL + (RESIDENT_CHUNKS + 3) * CHUNK;
/// Paced batches that cover the whole session (about 13 messages per page at `HEIGHT`).
const CLIMB: usize = MESSAGES / 12;
const LEAF: &str = "leaf";
const GAP_ROW: &str = "Loading newer history";
const WHEEL_UP: &str = "\x1b[<64;10;10M";
const HEIGHT: u16 = 50;

fn entry_id(index: usize) -> String {
    format!("e{index:05}")
}

fn index_of(id: &str) -> usize {
    id[1..].parse().expect("entry id")
}

fn message(index: usize) -> Value {
    let text = format!("msg-{index:05} row");
    if index.is_multiple_of(2) {
        json!({ "role": "user", "content": text, "timestamp": index })
    } else {
        json!({ "role": "assistant", "content": [{ "type": "text", "text": text }], "timestamp": index })
    }
}

/// How the mock serves pages.
#[derive(Clone, Copy, Default)]
struct Paging {
    /// Never answer newer pages (`from: start` with an `after` cursor).
    hold_newer: bool,
    /// Never answer older pages (`from: end` with a `before` cursor).
    hold_older: bool,
    /// After a `reload`, every page answers this late.
    slow_after_reload_ms: u64,
    /// After a `reload`, the old branch anchor is gone (a navigation or fork).
    branch_changed_after_reload: bool,
}

/// The paging daemon: `MESSAGES` rows, a `TAIL`-row attach, and pages served by id.
struct MockSupervisor {
    listener: UnixListener,
    paging: Paging,
    pages: Arc<Mutex<Vec<Value>>>,
}

impl MockSupervisor {
    fn serve(self) {
        let (stream, _) = self.listener.accept().expect("accept");
        let mut writer = stream.try_clone().expect("clone mock socket");
        let mut reader = BufReader::new(stream);
        write_json(
            &mut writer,
            &json!({
                "type": "daemon_hello",
                "protocol": { "name": "prime-agent.daemon", "version": 7 },
                "serverCapabilities": [], "clientId": "mock",
            }),
        );
        let mut line = String::new();
        let mut reloaded = false;
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            let Ok(envelope) = serde_json::from_str::<Value>(line.trim()) else {
                continue;
            };
            let id = envelope["id"].as_str().unwrap_or_default().to_string();
            let command = envelope["command"].clone();
            let kind = command["type"].as_str().unwrap_or_default().to_string();
            let data = match kind.as_str() {
                "attach" => attach_data(),
                "reload" => {
                    reloaded = true;
                    json!({})
                }
                "get_messages" => {
                    let page = command["page"].clone();
                    self.pages.lock().unwrap().push(page.clone());
                    let paging = self.paging;
                    if paging.hold_newer && page["from"] == "start" && page.get("after").is_some() {
                        continue;
                    }
                    if paging.hold_older && page["from"] == "end" && page.get("before").is_some() {
                        continue;
                    }
                    if reloaded {
                        std::thread::sleep(std::time::Duration::from_millis(
                            paging.slow_after_reload_ms,
                        ));
                        if paging.branch_changed_after_reload
                            && command.get("historyLeafId").is_some()
                        {
                            write_json(
                                &mut writer,
                                &json!({ "type": "response", "id": id, "command": kind, "success": false, "error": "History branch changed" }),
                            );
                            continue;
                        }
                    }
                    page_data(&page)
                }
                "get_session_stats" => json!({
                    "contextUsage": { "tokens": 1200, "contextWindow": 200_000 }, "cost": 0.01,
                }),
                _ => json!({}),
            };
            write_json(
                &mut writer,
                &json!({ "type": "response", "id": id, "command": kind, "success": true, "data": data }),
            );
        }
    }
}

fn attach_data() -> Value {
    json!({
        "protocol": { "name": "prime-agent.daemon", "version": 7 },
        "activeSessionId": "s1",
        "snapshot": {
            "activeSessionId": "s1",
            "summary": { "id": "s1", "cwd": "/tmp" },
            "state": {
                "activeSessionId": "s1", "cwd": "/tmp", "sessionId": "sess-1",
                "sessionName": "window probe", "model": "faux-1", "isStreaming": false,
                "isCompacting": false, "leafId": LEAF,
                "sessionActions": { "queuedCount": 0, "steering": [], "followUps": [] },
            },
            "messages": (MESSAGES - TAIL..MESSAGES).map(message).collect::<Vec<_>>(),
            "historyBeforeEntryId": entry_id(MESSAGES - TAIL),
            "lastEventSequence": 0,
            "lastEventCursor": null,
        },
        "replay": { "status": "complete", "toSequence": 0 },
        "lastEventSequence": 0,
        "lastEventCursor": null,
        "client": { "id": "mock", "capabilities": [] },
    })
}

fn page_data(page: &Value) -> Value {
    let limit = page["limit"].as_u64().expect("page limit") as usize;
    let cursor = |key: &str| page.get(key).and_then(Value::as_str).map(index_of);
    let (start, end, more) = if page["from"] == "end" {
        let end = cursor("before").unwrap_or(MESSAGES);
        let start = end.saturating_sub(limit);
        (start, end, start > 0)
    } else {
        let start = cursor("after").map_or(0, |after| after + 1);
        let until = cursor("until").unwrap_or(MESSAGES);
        let end = (start + limit).min(until);
        (start, end, end < until)
    };
    json!({
        "messages": (start..end).map(message).collect::<Vec<_>>(),
        "firstEntryId": (start < end).then(|| entry_id(start)),
        "lastEntryId": (start < end).then(|| entry_id(end - 1)),
        "more": more,
        "historyLeafId": LEAF,
    })
}

fn run(paging: Paging, steps: Vec<HeadlessStep>) -> (Vec<String>, Vec<Value>) {
    std::env::remove_var("TMUX");
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("tui.sock");
    let pages = Arc::new(Mutex::new(Vec::new()));
    let supervisor = MockSupervisor {
        listener: UnixListener::bind(&socket).expect("bind mock socket"),
        paging,
        pages: Arc::clone(&pages),
    };
    let handle = std::thread::spawn(move || supervisor.serve());
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    let plan = HeadlessPlan {
        steps,
        width: 100,
        height: HEIGHT,
    };
    let outcome = runtime
        .block_on(run_interactive(
            InteractiveOptions {
                session: SessionSelection::Attach("s1".to_string()),
                ..options(socket)
            },
            UiMode::Headless(plan),
        ))
        .expect("interactive run");
    handle.join().expect("mock supervisor finished");
    let pages = pages.lock().unwrap().clone();
    (outcome.frames, pages)
}

fn key(code: crossterm::event::KeyCode) -> HeadlessStep {
    HeadlessStep::Key(crossterm::event::KeyEvent::new(
        code,
        crossterm::event::KeyModifiers::NONE,
    ))
}

/// `(row, message index)` for every marker line of a frame, top to bottom.
fn marker_rows(frame: &str) -> Vec<(usize, usize)> {
    frame
        .lines()
        .enumerate()
        .filter_map(|(row, line)| {
            let at = line.find("msg-")?;
            Some((row, line[at + 4..at + 9].parse().ok()?))
        })
        .collect()
}

const ROWS_PER_MESSAGE: isize = 3;

/// The transcript row at the frame's top, from its marker lines above any gap row
/// (which must agree). The first message has no leading spacer, so it is skipped.
fn transcript_row(frame: &str) -> isize {
    let gap = frame
        .lines()
        .position(|line| line.contains(GAP_ROW))
        .unwrap_or(usize::MAX);
    let rows: Vec<isize> = marker_rows(frame)
        .into_iter()
        .filter(|(row, index)| *row < gap && *index > 0)
        .map(|(row, index)| index as isize * ROWS_PER_MESSAGE - row as isize)
        .collect();
    assert!(
        rows.windows(2).all(|pair| pair[0] == pair[1]),
        "every message renders as {ROWS_PER_MESSAGE} rows:\n{frame}"
    );
    rows[0]
}

/// The content's move between consecutive frames, in rows (positive: it moved down).
/// A chunk landing above or evicted below must never move it, so every move is one
/// scroll step.
fn moves(frames: &[String]) -> Vec<(usize, isize)> {
    frames
        .windows(2)
        .enumerate()
        .map(|(index, pair)| (index, transcript_row(&pair[0]) - transcript_row(&pair[1])))
        .collect()
}

fn top_marker(frame: &str) -> Option<usize> {
    marker_rows(frame).first().map(|(_, index)| *index)
}

/// Paced steps: the plan pauses after each batch so arrived pages apply between
/// batches, as they do between a user's keystrokes.
fn paced(batch: &[HeadlessStep], batches: usize) -> Vec<HeadlessStep> {
    let mut steps = vec![HeadlessStep::WaitRender {
        needle: format!("msg-{:05}", MESSAGES - 1),
        timeout_ms: 5_000,
    }];
    for _ in 0..batches {
        steps.extend(batch.iter().cloned());
        steps.push(HeadlessStep::WaitMs(30));
    }
    steps
}

#[test]
fn scrolling_up_through_older_pages_keeps_the_viewport_anchored() {
    let mut batch: Vec<HeadlessStep> = (0..5)
        .map(|_| HeadlessStep::Mouse(WHEEL_UP.to_string()))
        .collect();
    batch.push(key(crossterm::event::KeyCode::PageUp));
    let (frames, pages) = run(Paging::default(), paced(&batch, CLIMB));
    let reached_top = frames
        .iter()
        .position(|frame| top_marker(frame) == Some(0))
        .unwrap_or_else(|| {
            panic!(
                "scrolling never reached the first message: {}",
                frames.last().map_or("", String::as_str)
            )
        });
    assert!(
        pages.iter().filter(|page| page["from"] == "end").count() >= (MESSAGES - TAIL) / CHUNK,
        "the climb loaded the history in older pages: {pages:?}"
    );
    let mut page_rows = None;
    for (index, moved) in moves(&frames[1..reached_top]) {
        if moved != 3 {
            let page = *page_rows.get_or_insert(moved);
            assert_eq!(
                moved,
                page,
                "frame {}: the content moved by neither a wheel step nor a page:\n{}\n---\n{}",
                index + 1,
                frames[index + 1],
                frames[index + 2]
            );
        }
    }
    assert!(page_rows.is_some(), "the plan paged as well as wheeled");
}

#[test]
fn the_resident_run_stays_bounded_and_refills_on_return() {
    // Climb to the session top, then descend with newer pages held: the rows still
    // resident below the top end at the gap row after at most the resident chunks.
    let mut up = paced(&[key(crossterm::event::KeyCode::PageUp)], CLIMB);
    up.extend(
        paced(&[key(crossterm::event::KeyCode::PageDown)], CLIMB)
            .into_iter()
            .skip(1),
    );
    let (frames, _) = run(
        Paging {
            hold_newer: true,
            ..Paging::default()
        },
        up,
    );
    let top = frames
        .iter()
        .position(|frame| top_marker(frame) == Some(0))
        .unwrap_or_else(|| {
            panic!(
                "paging up never reached the first message: {}",
                frames.last().map_or("", String::as_str)
            )
        });
    let gap = frames[top..]
        .iter()
        .find(|frame| frame.contains(GAP_ROW))
        .unwrap_or_else(|| {
            panic!(
                "descending from the top never reached the evicted rows: {}",
                frames.last().map_or("", String::as_str)
            )
        });
    let gap_row = gap.lines().position(|line| line.contains(GAP_ROW)).unwrap();
    let resident_end = marker_rows(gap)
        .into_iter()
        .filter(|(row, _)| *row < gap_row)
        .map(|(_, index)| index)
        .max()
        .expect("resident rows above the gap row");
    assert!(
        resident_end < CHUNK * RESIDENT_CHUNKS,
        "the resident run below the top holds at most {RESIDENT_CHUNKS} chunks, \
         but reached msg-{resident_end:05}:\n{gap}"
    );

    // Unheld, the descent refetches the evicted rows: every message renders on the way
    // back down, in order, without a skip.
    // The climb ends with the top key, so the descent starts from a top-anchored window.
    let mut steps = paced(&[key(crossterm::event::KeyCode::PageUp)], CLIMB);
    steps.push(HeadlessStep::ScrollTop);
    steps.extend(
        paced(&[key(crossterm::event::KeyCode::PageDown)], CLIMB)
            .into_iter()
            .skip(1),
    );
    let (frames, pages) = run(Paging::default(), steps);
    let top = frames
        .iter()
        .position(|frame| top_marker(frame) == Some(0))
        .expect("the climb reached the first message");
    let bottom = frames
        .iter()
        .rposition(|frame| !frame.contains(&format!("msg-{:05}", MESSAGES - 1)))
        .expect("the descent passed above the tail");
    let descent = moves(&frames[top..bottom]);
    let page = descent
        .first()
        .map(|(_, moved)| *moved)
        .expect("the descent paged");
    for (index, moved) in descent {
        assert_eq!(
            moved,
            page,
            "frame {}: a page down moved the content by {moved}, not one page ({page}):\n{}\n---\n{}",
            top + index,
            frames[top + index],
            frames[top + index + 1]
        );
    }
    let last = frames.last().expect("frames rendered");
    assert!(
        !last.contains(GAP_ROW) && last.contains(&format!("msg-{:05}", MESSAGES - 1)),
        "the descent ends at the tail with the gap closed:\n{last}"
    );
    let mut seen = HashSet::new();
    for frame in &frames[top..] {
        seen.extend(marker_rows(frame).into_iter().map(|(_, index)| index));
    }
    let missing: Vec<usize> = (0..MESSAGES)
        .filter(|index| !seen.contains(index))
        .collect();
    assert!(
        missing.is_empty(),
        "the descent skipped messages: {missing:?}"
    );
    assert!(
        pages
            .iter()
            .any(|page| page["from"] == "start" && page.get("after").is_some()),
        "rows evicted on the way up were refetched on the way down: {pages:?}"
    );
}

/// Climb into the older chunks, then `/reload`: the transcript is replaced from the daemon
/// while every page answers slowly.
fn reload_from_mid_history(paging: Paging) -> (usize, Vec<String>) {
    let mut steps = paced(&[key(crossterm::event::KeyCode::PageUp)], 40);
    steps.push(HeadlessStep::WaitMs(300));
    steps.push(HeadlessStep::Type("/reload".to_string()));
    steps.push(key(crossterm::event::KeyCode::Enter));
    steps.push(HeadlessStep::WaitRender {
        needle: "Reloaded".to_string(),
        timeout_ms: 10_000,
    });
    let (frames, _) = run(paging, steps);
    let typed = frames
        .iter()
        .position(|frame| frame.contains("/reload"))
        .expect("the reload command was typed");
    let reader = top_marker(&frames[typed]).expect("the reader's rows before the reload");
    assert!(
        reader < MESSAGES - TAIL,
        "the climb reached the older chunks (msg-{reader:05})"
    );
    for frame in &frames[typed..] {
        assert!(
            !marker_rows(frame).is_empty(),
            "the transcript rows stayed rendered through the replace:\n{frame}"
        );
    }
    (reader, frames[typed..].to_vec())
}

#[test]
fn a_transcript_replace_keeps_a_mid_history_reader_on_their_entry() {
    let (reader, frames) = reload_from_mid_history(Paging {
        slow_after_reload_ms: 600,
        ..Paging::default()
    });
    let last = frames.last().expect("frames rendered");
    assert_eq!(
        top_marker(last),
        Some(reader),
        "the reader stays on msg-{reader:05} after the replace:\n{last}"
    );
}

#[test]
fn a_transcript_replace_onto_another_branch_follows_the_tail() {
    let (_, frames) = reload_from_mid_history(Paging {
        branch_changed_after_reload: true,
        ..Paging::default()
    });
    let last = frames.last().expect("frames rendered");
    assert!(
        last.contains(&format!("msg-{:05}", MESSAGES - 1)),
        "the reader's place left the branch, so the view follows the tail:\n{last}"
    );
}

#[test]
fn an_older_page_in_flight_marks_the_top_of_the_resident_rows() {
    let (frames, _) = run(
        Paging {
            hold_older: true,
            ..Paging::default()
        },
        paced(&[key(crossterm::event::KeyCode::PageUp)], 40),
    );
    let last = frames.last().expect("frames rendered");
    let marker = last
        .lines()
        .position(|line| line.contains("Loading older history"))
        .unwrap_or_else(|| panic!("no loading marker at the top of the rows:\n{last}"));
    assert!(
        marker_rows(last).iter().all(|(row, _)| *row > marker)
            && top_marker(last) == Some(MESSAGES - TAIL),
        "the marker stands above the stale first resident row:\n{last}"
    );
}
