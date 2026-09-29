//! The fullscreen image-fallback guard (TS `withFullscreenImageFallback`).
//!
//! The guard is the frame-composition seam TS uses to force image
//! components to their textual fallback while a fullscreen frame repaints;
//! the transcript's image rows are always fallback-only metadata rows in
//! this port (the render-path skip, the image-heavy session-open fix,
//! removed the placement machinery), so the guard is the composition
//! boundary the cache keys and frame sites share — kept for the TS
//! parity contract and any future surface that places graphics.

use std::cell::Cell;

thread_local! {
    /// The fullscreen compose guard (TS module-level `fullscreenFallback`).
    static FULLSCREEN_FALLBACK: Cell<bool> = const { Cell::new(false) };
}

/// Run `render` with image graphics disabled (TS `withFullscreenImageFallback`):
/// the fullscreen frame composition forces every image to its textual
/// fallback. The previous state is restored even when `render` panics.
pub fn with_fullscreen_image_fallback<T>(render: impl FnOnce() -> T) -> T {
    FULLSCREEN_FALLBACK.with(|flag| {
        let previous = flag.get();
        flag.set(true);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(render));
        flag.set(previous);
        match result {
            Ok(value) => value,
            Err(payload) => std::panic::resume_unwind(payload),
        }
    })
}

/// Whether image graphics are currently suppressed by the fullscreen
/// compose guard.
pub fn fullscreen_image_fallback_active() -> bool {
    FULLSCREEN_FALLBACK.with(Cell::get)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_guard_restores_its_previous_state_even_across_a_panic() {
        assert!(!fullscreen_image_fallback_active());
        with_fullscreen_image_fallback(|| {
            assert!(fullscreen_image_fallback_active());
            std::panic::catch_unwind(|| {
                // a panicking inner render must not leak the flag
                panic!("inner render fails");
            })
            .ok();
            assert!(fullscreen_image_fallback_active());
        });
        assert!(!fullscreen_image_fallback_active());
    }

    #[test]
    fn nested_guards_restore_the_outer_state() {
        with_fullscreen_image_fallback(|| {
            with_fullscreen_image_fallback(|| {
                assert!(fullscreen_image_fallback_active());
            });
            assert!(fullscreen_image_fallback_active());
        });
        assert!(!fullscreen_image_fallback_active());
    }
}
