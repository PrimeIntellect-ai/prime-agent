//! The in-sandbox bot relay exits when either side of the link closes:
//! the guest connection (while its stdin stays open, as the exec channel
//! never closes it), or its stdin (the Mac dropped the link).
#![cfg(unix)]

use std::io::ErrorKind;
use std::os::unix::net::{UnixListener, UnixStream};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

fn fail(relay: &mut Child, reason: &str) -> ! {
    let _ = relay.kill();
    let _ = relay.wait();
    panic!("{reason}");
}

/// Start the relay against a fresh guest socket and accept its connection.
fn connected_relay(dir: &std::path::Path) -> (Child, UnixStream) {
    let socket = dir.join("guest.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    listener.set_nonblocking(true).unwrap();
    let mut relay = Command::new(env!("CARGO_BIN_EXE_prime-agent"))
        .arg("relay")
        .env(pa_daemon::bots::relay::BRIDGE_SOCKET_ENV, &socket)
        .env("HOME", dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .spawn()
        .expect("spawn the relay");
    let deadline = Instant::now() + Duration::from_secs(10);
    let guest = loop {
        match listener.accept() {
            Ok((guest, _)) => break guest,
            Err(error) if error.kind() == ErrorKind::WouldBlock && Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(error) => fail(&mut relay, &format!("the relay never connected: {error}")),
        }
    };
    (relay, guest)
}

fn wait_for_exit(relay: &mut Child) {
    let deadline = Instant::now() + Duration::from_secs(10);
    let status = loop {
        if let Some(status) = relay.try_wait().expect("poll the relay") {
            break status;
        }
        if Instant::now() >= deadline {
            fail(relay, "the relay outlived its link");
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    assert!(status.success(), "{status}");
}

#[test]
fn the_relay_exits_when_the_guest_closes_its_connection() {
    let dir = tempfile::tempdir().unwrap();
    let (mut relay, guest) = connected_relay(dir.path());
    // Held open and never written until the relay exits, like the exec
    // channel's stdin pipe.
    let stdin = relay.stdin.take();
    drop(guest);
    wait_for_exit(&mut relay);
    drop(stdin);
}

#[test]
fn the_relay_exits_when_its_stdin_closes() {
    let dir = tempfile::tempdir().unwrap();
    let (mut relay, guest) = connected_relay(dir.path());
    drop(relay.stdin.take());
    wait_for_exit(&mut relay);
    drop(guest);
}
