//! Provider auth recovery: the seam the retry chains consult on an
//! auth-class failure — the engine force-refreshes the stored OAuth
//! credential and rebinds the request target before the one quick retry
//! re-issues, and ends the turn with the re-login sentence when the grant
//! is rejected (SANCTIONED DIVERGENCE, operator ruling 2026-10-07, the
//! revoked-codex-session outage: TS fails the turn on a server-side
//! credential rejection; the codex CLI's token-expired handling is the
//! reference behavior).

use std::future::Future;
use std::pin::Pin;

use pa_agent::types::AssistantMessage;

/// Resolution of one auth-recovery consultation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthRecoveryOutcome {
    /// Nothing changed the credential the retry would carry (no stored
    /// OAuth grant, an env or config key, a superseded selection): the
    /// quick retry re-issues inside the ordinary retry budget only.
    Continue,
    /// The retry will carry a credential the failed attempt never served
    /// (a forced exchange refreshed the stored grant, or a re-login
    /// outran the stale target): the one auth retry may spend past the
    /// ordinary budget rather than waste the fresh grant.
    NewCredential,
    /// The grant is dead — the refresh was rejected; the sentence is the
    /// final turn error.
    ReLoginRequired(String),
}

/// The boxed recovery future: the engine's force-refresh runs its
/// blocking token exchange off the async runtime.
pub type AuthRecoveryFuture = Pin<Box<dyn Future<Output = AuthRecoveryOutcome> + Send>>;

/// The retry chains consult this on an auth-class failure: `Continue`
/// lets the quick retry proceed inside the ordinary budget, `NewCredential`
/// re-issues with the changed credential (one retry past a spent budget),
/// `ReLoginRequired` ends the turn with the returned sentence.
pub type AuthRecoveryCallback<'a> = &'a mut dyn FnMut(&AssistantMessage) -> AuthRecoveryFuture;
