#[cfg(all(unix, feature = "event-stream"))]
pub use unix::waker::Waker;
#[cfg(all(windows, feature = "event-stream"))]
pub use windows::waker::Waker;

#[cfg(unix)]
pub(crate) mod unix;
#[cfg(windows)]
pub(crate) mod windows;
