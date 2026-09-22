//! Short deterministic hash used for tool-call id normalization.
//! Ported from `packages/ai/src/utils/hash.ts` (must match TS output exactly).

#[allow(dead_code)] // used by tool-call id normalization in upcoming providers
pub fn short_hash(input: &str) -> String {
    let mut h1: u32 = 0xdeadbeef;
    let mut h2: u32 = 0x41c6ce57;
    for ch in input.encode_utf16() {
        // Math.imul semantics: wrapping 32-bit multiply.
        h1 = (h1 ^ ch as u32).wrapping_mul(2654435761);
        h2 = (h2 ^ ch as u32).wrapping_mul(1597334677);
    }
    h1 =
        ((h1 ^ (h1 >> 16)).wrapping_mul(2246822507)) ^ ((h2 ^ (h2 >> 13)).wrapping_mul(3266489909));
    h2 =
        ((h2 ^ (h2 >> 16)).wrapping_mul(2246822507)) ^ ((h1 ^ (h1 >> 13)).wrapping_mul(3266489909));
    format_radix(h2, 36) + &format_radix(h1, 36)
}

fn format_radix(mut value: u32, radix: u32) -> String {
    let mut result = Vec::new();
    loop {
        let digit = value % radix;
        result.push(std::char::from_digit(digit, radix).unwrap());
        value /= radix;
        if value == 0 {
            break;
        }
    }
    result.into_iter().rev().collect()
}

#[cfg(test)]
mod tests {
    use super::short_hash;

    #[test]
    fn matches_ts_reference() {
        // Derived from running shortHash in the TS reference implementation.
        assert_eq!(short_hash(""), "k4n83c7h0j2b");
        assert_eq!(short_hash("abc"), "y0biex7f9bbh");
        assert_eq!(short_hash("call_123|item_456"), "9b5zes1cwdux1");
        assert_eq!(short_hash("toolcall:0"), "1nlso9v7di2pi");
    }
}
