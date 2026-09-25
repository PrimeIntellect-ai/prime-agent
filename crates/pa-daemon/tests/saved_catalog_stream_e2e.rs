//! The saved-catalog stream is per-file DURING the scan (TS
//! `listSessionsFromDir`'s `onSession`/`onProgress` per file): the rows
//! reach the client while the scan still has work left - a grown store's
//! first row lands long before the scan's final response, instead of one
//! post-scan burst (the operator's whole-catalog wait the entry anchor's
//! loading hold rode). The stream is mtime-newest-first (the metadata
//! pass precedes the folds), so the newest session is the FIRST frame.
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant, SystemTime};

struct Daemon {
    child: Child,
    #[allow(dead_code)]
    socket: PathBuf,
}

impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[allow(clippy::zombie_processes)]
fn spawn_daemon(socket: &std::path::Path, agent_dir: &std::path::Path) -> Daemon {
    let binary = env!("CARGO_BIN_EXE_pa-daemon");
    let child = Command::new(binary)
        .arg("supervisor")
        .arg("--socket")
        .arg(socket)
        .arg("--agent-dir")
        .arg(agent_dir)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .env(
            pa_daemon::worker::WORKER_SUPERVISOR_LOST_EXIT_MS_ENV,
            "15000",
        )
        .spawn()
        .expect("spawn pa-daemon supervisor");
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if socket.exists() {
            return Daemon {
                child,
                socket: socket.to_path_buf(),
            };
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("supervisor socket never appeared");
}

struct Client {
    reader: BufReader<UnixStream>,
    writer: UnixStream,
}

impl Client {
    fn connect(socket: &std::path::Path) -> Self {
        let stream = UnixStream::connect(socket).expect("connect supervisor");
        let write_stream = stream.try_clone().expect("clone socket");
        let mut client = Client {
            reader: BufReader::new(stream),
            writer: write_stream,
        };
        let _ = client.read_line(); // daemon_hello
        client
    }

    fn send_command(&mut self, id: &str, command: serde_json::Value) {
        let value = serde_json::json!({
            "type": "command",
            "id": id,
            "protocol": { "name": "prime-agent.daemon", "version": 7 },
            "command": command,
        });
        let mut line = serde_json::to_string(&value).expect("serialize command");
        line.push('\n');
        self.writer.write_all(line.as_bytes()).expect("send");
        self.writer.flush().expect("flush");
    }

    fn read_line(&mut self) -> serde_json::Value {
        let mut line = String::new();
        let deadline = Instant::now() + Duration::from_secs(20);
        self.reader
            .get_mut()
            .set_read_timeout(Some(Duration::from_millis(100)))
            .expect("set timeout");
        loop {
            line.clear();
            match self.reader.read_line(&mut line) {
                Ok(0) => panic!("supervisor closed the connection"),
                Ok(_) if line.trim().is_empty() => {}
                Ok(_) => {
                    return serde_json::from_str(line.trim()).expect("parse response line");
                }
                Err(error) => {
                    assert!(
                        Instant::now() < deadline,
                        "timed out waiting for supervisor line: {error}"
                    );
                }
            }
        }
    }
}

/// One valid saved-session fixture: a version-3 header, a display name,
/// one user/assistant exchange, and a stamped mtime (the scan order key).
fn write_fixture(
    dir: &Path,
    id: &str,
    name: &str,
    grown_lines: usize,
    modified: SystemTime,
) -> PathBuf {
    let path = dir.join(format!("{id}.jsonl"));
    let mut content = format!(
        "{{\"type\":\"session\",\"version\":3,\"id\":\"{id}\",\"timestamp\":\"2024-01-01T00:00:00.000Z\",\"cwd\":\"/tmp\",\"rlmDepth\":0}}\n"
    );
    content.push_str(&format!(
        "{{\"type\":\"session_info\",\"id\":\"{id}-info\",\"timestamp\":\"2024-01-01T00:00:00.000Z\",\"name\":\"{name}\"}}\n"
    ));
    content.push_str(&format!(
        "{{\"type\":\"message\",\"id\":\"{id}-mu\",\"timestamp\":\"2024-01-01T00:00:00.000Z\",\"message\":{{\"role\":\"user\",\"content\":\"run the drill\",\"timestamp\":0}}}}\n"
    ));
    for index in 0..grown_lines {
        content.push_str(&format!(
            "{{\"type\":\"message\",\"id\":\"{id}-m{index}a\",\"timestamp\":\"2024-01-01T00:00:01.000Z\",\"message\":{{\"role\":\"assistant\",\"content\":[{{\"type\":\"text\",\"text\":\"{}\"}}],\"provider\":\"p\",\"model\":\"m\",\"timestamp\":{}}}}}\n",
            "grown line of transcript text ".repeat(6),
            index as u64
        ));
    }
    std::fs::write(&path, content).expect("write fixture");
    let file = std::fs::File::options()
        .write(true)
        .open(&path)
        .expect("open for mtime");
    file.set_times(
        std::fs::FileTimes::new()
            .set_modified(modified)
            .set_accessed(modified),
    )
    .expect("stamp mtime");
    path
}

/// The streamed catalog lands DURING the scan, not as one post-scan burst:
/// with a directory of small newest files and one grown oldest file, the
/// FIRST `session_list_item` frame must arrive well before the final
/// response (the grown file's fold is the scan's tail). The batched form
/// writes every frame after the scan, where the first item and the
/// response arrive together - the ratio catches it without a wall-clock
/// budget (self-calibrating against the machine's speed).
#[test]
fn the_saved_catalog_streams_per_file_during_the_scan() {
    // The scan's head: small newest-first rows (the stream's first
    // frames), one per file, stamped in increasing recency so the mtime
    // order is deterministic (the newest is first). SMALL_FILES, the
    // grown file, and one INVALID file: the gate skips it without a
    // row, so the per-row progress never names its slot.
    const SMALL_FILES: usize = 30;
    let dir = tempfile::TempDir::new().expect("temp dir");
    let agent_dir = dir.path().join("agent");
    let sessions_dir = agent_dir.join("sessions");
    std::fs::create_dir_all(&sessions_dir).expect("sessions dir");

    // The scan's tail: one grown file (its fold is the dominant cost),
    // stamped the OLDEST so the mtime order scans it LAST.
    let base = SystemTime::now() - Duration::from_hours(24);
    write_fixture(&sessions_dir, "grown-store", "grown store", 60_000, base);
    for index in 0..SMALL_FILES {
        write_fixture(
            &sessions_dir,
            &format!("alpha-{index:02}"),
            &format!("alpha row {index:02}"),
            0,
            base + Duration::from_secs(60 + index as u64),
        );
    }
    // An invalid .jsonl (a parseable non-session first record): the scan
    // skips it without a fold, so no row streams for it.
    std::fs::write(
        sessions_dir.join("foreign.jsonl"),
        "{\"type\":\"message\",\"id\":\"x\"}\n",
    )
    .expect("write the invalid file");

    let socket = dir.path().join("daemon.sock");
    let _daemon = spawn_daemon(&socket, &agent_dir);
    let mut client = Client::connect(&socket);

    let started = Instant::now();
    client.send_command(
        "s1",
        serde_json::json!({ "type": "list_saved_sessions", "cwd": "/tmp" }),
    );

    let mut first_item: Option<Duration> = None;
    let mut items = 0usize;
    let mut progress = 0usize;
    let mut progress_reached: Option<(u64, u64)> = None;
    let mut response_at: Option<Duration> = None;
    let mut sessions: Option<Vec<serde_json::Value>> = None;
    while response_at.is_none() {
        let line = client.read_line();
        match line.get("type").and_then(serde_json::Value::as_str) {
            Some("session_list_item") => {
                assert_eq!(
                    line.get("command").and_then(serde_json::Value::as_str),
                    Some("list_saved_sessions")
                );
                if first_item.is_none() {
                    first_item = Some(started.elapsed());
                }
                items += 1;
                if items == 1 {
                    // The stream starts with the newest row (the scan
                    // order is decided by the metadata pass before any
                    // fold): the entry anchor's row is the FIRST frame.
                    let name = line["session"]["name"]
                        .as_str()
                        .unwrap_or_default()
                        .to_string();
                    assert_eq!(
                        name, "alpha row 29",
                        "the first streamed row is the newest session: {line}"
                    );
                }
            }
            Some("session_list_progress") => {
                progress += 1;
                let loaded = line["loaded"].as_u64().unwrap_or_default();
                let total = line["total"].as_u64().unwrap_or_default();
                let reached = progress_reached.unwrap_or((0, 0));
                if loaded >= reached.0 {
                    progress_reached = Some((loaded, total));
                }
            }
            Some("response") => {
                assert_eq!(
                    line.get("command").and_then(serde_json::Value::as_str),
                    Some("list_saved_sessions")
                );
                assert_eq!(line["success"], true, "list failed: {line}");
                response_at = Some(started.elapsed());
                sessions = line["data"]["sessions"].as_array().cloned();
            }
            _ => {}
        }
    }

    let first_item = first_item.expect("at least one session_list_item frame");
    let response_at = response_at.expect("the final response");
    let sessions = sessions.expect("the response carries the sessions");

    // The full catalog arrived: every VALID row as a streamed item and
    // in the terminal response (the invalid file streams neither), with
    // per-file progress frames and a completion frame that reaches the
    // scan's file total (the per-row progress lands short when the
    // invalid file yields no row).
    assert_eq!(items, SMALL_FILES + 1, "every row streamed as an item");
    assert!(
        progress >= SMALL_FILES,
        "the per-file progress frames streamed"
    );
    assert_eq!(
        sessions.len(),
        SMALL_FILES + 1,
        "the final response carries the whole catalog (the invalid file stays out)"
    );
    let (reached_loaded, reached_total) =
        progress_reached.expect("at least one progress frame streamed");
    assert_eq!(
        reached_total,
        (SMALL_FILES + 2) as u64,
        "the progress totals count the directory's files (valid and invalid)"
    );
    assert_eq!(
        reached_loaded, reached_total,
        "the completion frame names the scan's end: loaded reaches the total even though the invalid file streams no row"
    );

    // The decisive assertion: the first streamed row landed well before
    // the scan finished (the grown file's fold is the response's tail). A
    // post-scan burst delivers the first item and the response together
    // (the ratio sits at ~1); per-file streaming delivers the newest rows
    // while the grown file still folds (the ratio sits near zero).
    assert!(
        first_item.as_millis() * 3 < response_at.as_millis().max(1),
        "the first streamed row landed at {first_item:?} but the response at {response_at:?}: the catalog streamed after the whole scan, not per file"
    );
}
