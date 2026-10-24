//! Recovery of a picked batch when the engine panics outside persistence.
use super::*;

#[tokio::test]
async fn shutdown_with_engine_panic_preserves_only_the_unaccepted_batch_tail() {
    shutdown_preserves_picked_batch(UserRowBoundary::AfterFirstPanic).await;
}
