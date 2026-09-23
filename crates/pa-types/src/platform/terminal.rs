//! Tty line-discipline verification (the platform wall for the dying-
//! surface restore).
//!
//! crossterm's `disable_raw_mode` restores the termios its *first*
//! `enable_raw_mode` saved and swallows every error, so a forced exit can
//! still leave the tty raw two ways: the saved "original" was itself raw
//! (the process started on a tty a killed previous run never restored,
//! so crossterm adopted that state as the baseline), or the restore
//! write failed silently under load. The live report - a forced exit
//! left the shell echoing `;`-coded sequences on every keypress until
//! `stty sane` - is exactly that state. Lives here because pa-tui
//! depends on pa-types alone and opts into the workspace `unsafe_code`
//! forbid (the process-suspend precedent).

use std::fs::File;
use std::io;
use std::os::unix::io::AsRawFd;

/// The classic control characters `stty sane` restores (Linux
/// defaults): a poisoned tty may carry zeroes here, and canonical
/// editing depends on them (`VERASE`, `VEOF`, ...).
#[cfg(unix)]
const SANE_CONTROL_CHARS: [(usize, u8); 12] = [
    (libc::VINTR, 3),
    (libc::VQUIT, 28),
    (libc::VERASE, 127),
    (libc::VKILL, 21),
    (libc::VEOF, 4),
    (libc::VSTART, 17),
    (libc::VSTOP, 19),
    (libc::VSUSP, 26),
    (libc::VREPRINT, 18),
    (libc::VWERASE, 23),
    (libc::VLNEXT, 22),
    (libc::VMIN, 1),
];

/// The outcome of a cooked-tty verification.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TtyCooked {
    /// The tty already reads cooked; nothing changed.
    AlreadyCooked,
    /// The tty read raw and the sane reconstruction was applied.
    Repaired,
    /// No tty or no termios access: nothing to verify (the headless
    /// harness, a dead terminal).
    Unavailable,
}

/// Whether the attrs describe a cooked tty: canonical input and echo -
/// the two flags a raw leak takes away.
#[cfg(unix)]
fn cooked(attrs: &libc::termios) -> bool {
    attrs.c_lflag & (libc::ICANON | libc::ECHO) == (libc::ICANON | libc::ECHO)
}

/// Rebuild a sane cooked mode in place (the `stty sane` recipe): the
/// line discipline on, signal characters live, echo with erase
/// rendering, and the classic control characters restored.
#[cfg(unix)]
fn make_sane(attrs: &mut libc::termios) {
    attrs.c_iflag &=
        !(libc::IGNBRK | libc::BRKINT | libc::PARMRK | libc::ISTRIP | libc::INLCR | libc::IGNCR);
    attrs.c_iflag |= libc::ICRNL | libc::IXON;
    attrs.c_oflag &= !(libc::OCRNL | libc::OLCUC | libc::OFILL);
    attrs.c_oflag |= libc::OPOST | libc::ONLCR;
    attrs.c_lflag &= !(libc::ECHONL | libc::ECHOCTL);
    attrs.c_lflag |=
        libc::ISIG | libc::ICANON | libc::ECHO | libc::ECHOE | libc::ECHOK | libc::IEXTEN;
    for (index, value) in SANE_CONTROL_CHARS {
        attrs.c_cc[index] = value;
    }
}

/// The process tty (`/dev/tty`, stdin when no controlling terminal
/// exists - the restore path must still be able to repair the pane it
/// owns).
#[cfg(unix)]
fn tty() -> Option<File> {
    match File::open("/dev/tty") {
        Ok(tty) => Some(tty),
        Err(_) => File::open("/proc/self/fd/0").ok(),
    }
}

/// Verify the process tty and repair a raw state: the force-quit
/// restore already ran its best-effort `disable_raw_mode`, so a raw
/// read here means the saved original was poisoned or the restore write
/// failed - the sane reconstruction applies directly.
#[cfg(unix)]
pub fn ensure_cooked_tty() -> TtyCooked {
    let Some(tty) = tty() else {
        return TtyCooked::Unavailable;
    };
    let fd = tty.as_raw_fd();
    let mut attrs: libc::termios = unsafe { std::mem::zeroed() };
    // SAFETY: `tcgetattr` only reads the line discipline into `attrs`;
    // the fd is the freshly opened process tty.
    if unsafe { libc::tcgetattr(fd, &mut attrs) } != 0 {
        return TtyCooked::Unavailable;
    }
    if cooked(&attrs) {
        return TtyCooked::AlreadyCooked;
    }
    make_sane(&mut attrs);
    // SAFETY: `tcsetattr` applies the reconstructed `attrs` to the
    // caller's own tty; the recipe matches the `stty sane` set.
    if unsafe { libc::tcsetattr(fd, libc::TCSANOW, &attrs) } != 0 {
        let _ = io::Write::write_all(
            &mut io::stderr(),
            b"Prime Agent: a raw terminal could not be repaired.\n",
        );
        return TtyCooked::Unavailable;
    }
    TtyCooked::Repaired
}

#[cfg(not(unix))]
pub fn ensure_cooked_tty() -> TtyCooked {
    TtyCooked::Unavailable
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn attrs_with(lflag: libc::tcflag_t) -> libc::termios {
        libc::termios {
            c_iflag: 0,
            c_oflag: 0,
            c_cflag: 0,
            c_lflag: lflag,
            c_line: 0,
            c_cc: [0; libc::NCCS],
            c_ispeed: 0,
            c_ospeed: 0,
        }
    }

    /// A tty missing either canonical input or echo reads as not
    /// cooked - the exact state the live report described.
    #[test]
    fn cooked_requires_icanon_and_echo() {
        assert!(!cooked(&attrs_with(0)));
        assert!(!cooked(&attrs_with(libc::ICANON)));
        assert!(!cooked(&attrs_with(libc::ECHO)));
        assert!(cooked(&attrs_with(libc::ICANON | libc::ECHO)));
    }

    /// The repair rebuilds the `stty sane` mode from any poisoned
    /// baseline: the line discipline, echo, and the classic control
    /// characters all return.
    #[test]
    fn sane_restores_the_line_discipline_and_control_chars() {
        let mut attrs = attrs_with(0);
        attrs.c_iflag = libc::IGNCR | libc::ISTRIP;
        make_sane(&mut attrs);
        assert!(cooked(&attrs));
        assert_eq!(attrs.c_iflag & libc::ICRNL, libc::ICRNL);
        assert_eq!(
            attrs.c_oflag & (libc::OPOST | libc::ONLCR),
            libc::OPOST | libc::ONLCR
        );
        assert_eq!(attrs.c_lflag & libc::ISIG, libc::ISIG);
        assert_eq!(attrs.c_cc[libc::VERASE], 127);
        assert_eq!(attrs.c_cc[libc::VEOF], 4);
        assert_eq!(attrs.c_cc[libc::VMIN], 1);
        // Sane never turns ECHOCTL on (stty sane leaves it off).
        assert_eq!(attrs.c_lflag & libc::ECHOCTL, 0);
    }
}
