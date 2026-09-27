//! PKCE pair generation (TS `packages/ai/src/utils/oauth/pkce.ts`):
//! a random 43-character verifier and its S256 challenge. The
//! Anthropic flow uses it for the authorization-code exchange (the
//! Codex flow keeps its own copy; TS duplicates the helper per
//! module the same way).

use base64::Engine as _;
use rand::Rng;
use sha2::{Digest, Sha256};

/// A PKCE pair: the verifier is the token-exchange secret, the
/// challenge travels in the authorization URL.
pub fn generate_pkce() -> (String, String) {
    let verifier = base64url(&random_bytes(32));
    let challenge = base64url(Sha256::digest(verifier.as_bytes()).as_slice());
    (verifier, challenge)
}

fn random_bytes(len: usize) -> Vec<u8> {
    let mut bytes = vec![0u8; len];
    rand::thread_rng().fill(&mut bytes[..]);
    bytes
}

fn base64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// TS `generatePKCE`: a 43-character URL-safe verifier whose S256
    /// challenge is deterministic over it.
    #[test]
    fn the_verifier_and_challenge_have_the_ts_shape() {
        let (verifier, challenge) = generate_pkce();
        assert_eq!(verifier.len(), 43, "32 bytes base64url-encoded");
        assert!(!verifier.contains(['+', '/', '=']));
        let expected = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(Sha256::digest(verifier.as_bytes()).as_slice());
        assert_eq!(challenge, expected);
        // A fresh pair is a fresh secret (TS `crypto.getRandomValues`).
        assert_ne!(verifier, generate_pkce().0);
    }
}
