#[cfg(feature = "use-dev-tty")]
pub(crate) mod tty;

#[cfg(not(feature = "use-dev-tty"))]
pub(crate) mod mio;

#[cfg(feature = "use-dev-tty")]
pub use self::tty::Waker;

#[cfg(not(feature = "use-dev-tty"))]
pub use self::mio::Waker;
