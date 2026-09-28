//! Scratch launch-storm characterization driver (lane evidence, NOT a
//! shipped test): fires N concurrent `create` commands at a fresh
//! supervisor and records per-launch latency and outcome, so the
//! launch-path phase trace (`PA_DAEMON_LAUNCH_TRACE`) can say which
//! budget leg a wedged launch died in. Knobs (env): `PA_STORM_N`
//! concurrency (default 4), `PA_STORM_BUDGET_MS` worker-connect budget
//! (default 90000), `PA_STORM_ITERS` iterations (default 1),
//! `PA_STORM_OUT` persistent artifact root (default /tmp/pa-storm).
#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

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
fn spawn_daemon(socket: &Path, agent_dir: &Path, budget_ms: u64) -> Daemon {
    let child = Command::new(env!("CARGO_BIN_EXE_pa-daemon"))
        .arg("supervisor")
        .arg("--socket")
        .arg(socket)
        .arg("--agent-dir")
        .arg(agent_dir)
        .stdout(Stdio::null())
        .stderr(Stdio::from(std::fs::File::create(agent_dir.join("supervisor.stderr")).expect("stderr file")))
        .env("PA_DAEMON_DEBUG", "1")
        .env("PA_DAEMON_LAUNCH_TRACE", "1")
        .env(pa_daemon::worker::WORKER_SUPERVISOR_LOST_EXIT_MS_ENV, "3000")
        .env("PA_DAEMON_WORKER_CONNECT_TIMEOUT_MS", budget_ms.to_string())
        .spawn()
        .expect("spawn pa-daemon supervisor");
    let deadline = Instant::now() + Duration::from_secs(60);
    while Instant::now() < deadline {
        if UnixStream::connect(socket).is_ok() {
            return Daemon { child, socket: socket.to_path_buf() };
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("supervisor socket never came up");
}

struct Client {
    reader: BufReader<UnixStream>,
    writer: UnixStream,
}

impl Client {
    fn connect(socket: &Path) -> Client {
        let deadline = Instant::now() + Duration::from_secs(20);
        let stream = loop {
            match UnixStream::connect(socket) {
                Ok(stream) => break stream,
                Err(_) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(error) => panic!("connect supervisor: {error}"),
            }
        };
        let writer = stream.try_clone().expect("clone socket");
        let mut client = Client { reader: BufReader::new(stream), writer };
        let hello = client.read_line();
        assert_eq!(hello["type"], "daemon_hello", "hello: {hello}");
        client
    }

    fn send_command(&mut self, id: &str, command: Value) {
        let envelope = json!({
            "type": "command",
            "id": id,
            "protocol": { "name": "prime-agent.daemon", "version": 7 },
            "command": command,
        });
        let mut line = serde_json::to_string(&envelope).expect("serialize");
        line.push('\n');
        self.writer.write_all(line.as_bytes()).expect("send");
        self.writer.flush().expect("flush");
    }

    fn read_line(&mut self) -> Value {
        let mut line = String::new();
        let deadline = Instant::now() + Duration::from_secs(120);
        self.reader.get_mut().set_read_timeout(Some(Duration::from_millis(100))).expect("timeout");
        loop {
            line.clear();
            match self.reader.read_line(&mut line) {
                Ok(0) => panic!("supervisor closed the connection"),
                Ok(_) if line.trim().is_empty() => {}
                Ok(_) => return serde_json::from_str(line.trim()).expect("parse"),
                Err(error) => {
                    assert!(Instant::now() < deadline, "read_line timeout: {error}");
                }
            }
        }
    }

    fn read_response(&mut self, id: &str) -> Value {
        let deadline = Instant::now() + Duration::from_secs(400);
        loop {
            assert!(Instant::now() < deadline, "no response for {id}");
            let line = self.read_line();
            if line.get("id").and_then(Value::as_str) == Some(id) {
                return line;
            }
        }
    }
}

fn write_script(dir: &Path) -> PathBuf {
    let script = dir.join("script.json");
    std::fs::write(
        &script,
        json!({ "responses": [ { "text": "storm answer", "delayMs": 30 } ] }).to_string(),
    )
    .expect("write script");
    script
}

struct LaunchOutcome {
    id: String,
    latency_ms: u128,
    ok: bool,
    error: String,
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn launch_storm_probe() {
    let n: usize = std::env::var("PA_STORM_N").ok().and_then(|v| v.parse().ok()).unwrap_or(4);
    let budget_ms: u64 = std::env::var("PA_STORM_BUDGET_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(90_000);
    let iters: usize = std::env::var("PA_STORM_ITERS").ok().and_then(|v| v.parse().ok()).unwrap_or(1);
    let out_root = PathBuf::from(std::env::var("PA_STORM_OUT").unwrap_or_else(|_| "/tmp/pa-storm".to_string()));
    std::fs::create_dir_all(&out_root).expect("out root");
    let mut total_ok = 0usize;
    let mut total_fail = 0usize;
    for iter in 0..iters {
        let iter_dir = out_root.join(format!("iter-{iter:03}"));
        std::fs::create_dir_all(&iter_dir).expect("iter dir");
        let agent_dir = iter_dir.join("agent");
        std::fs::create_dir_all(&agent_dir).expect("agent dir");
        let socket = iter_dir.join("daemon.sock");
        let _daemon = spawn_daemon(&socket, &agent_dir, budget_ms);
        let script = write_script(&iter_dir);
        let start = Instant::now();
        let mut handles = Vec::new();
        for i in 0..n {
            let script = script.clone();
            let socket = socket.clone();
            let iter_dir = iter_dir.clone();
            handles.push(std::thread::spawn(move || {
                let t0 = Instant::now();
                let id = format!("c{i}");
                let cwd = iter_dir.join(format!("w{i}"));
                std::fs::create_dir_all(&cwd).expect("worker cwd");
                let session_dir = iter_dir.join(format!("s{i}"));
                std::fs::create_dir_all(&session_dir).expect("session dir");
                // One independent connection per create, the link's shape:
                // the spawn admission dials a fresh connection per command.
                let mut client = Client::connect(&socket);
                client.send_command(&id, json!({
                    "type": "create",
                    "config": {
                        "cwd": cwd.to_string_lossy(),
                        "sessionDir": session_dir.to_string_lossy(),
                        "model": "scripted/faux-1",
                        "script": script.to_string_lossy(),
                    },
                }));
                let response = client.read_response(&id);
                LaunchOutcome {
                    id,
                    latency_ms: t0.elapsed().as_millis(),
                    ok: response["success"] == json!(true),
                    error: response
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                }
            }));
        }
        let mut outcomes = Vec::new();
        for handle in handles {
            outcomes.push(handle.join().expect("storm thread"));
        }
        let iter_ms = start.elapsed().as_millis();
        let ok = outcomes.iter().filter(|o| o.ok).count();
        let fail = outcomes.len() - ok;
        total_ok += ok;
        total_fail += fail;
        let latencies: Vec<String> = outcomes.iter().map(|o| format!("{}ms/{}", o.latency_ms, if o.ok { "ok" } else { "FAIL" })).collect();
        println!("STORM iter={iter} n={n} budget_ms={budget_ms} ok={ok} fail={fail} wall={iter_ms}ms lat=[{}]", latencies.join(", "));
        for outcome in &outcomes {
            if !outcome.ok {
                println!("STORM_FAIL_DETAIL iter={iter} id={} latency_ms={} error={}", outcome.id, outcome.latency_ms, outcome.error);
            }
        }
    }
    println!("STORM_DONE n={n} budget_ms={budget_ms} iters={iters} ok={total_ok} fail={total_fail}");
    // The driver is characterization evidence: a launch failure is the
    // finding, not a driver bug, so the test always exits green and the
    // summary line carries the outcome.
}
