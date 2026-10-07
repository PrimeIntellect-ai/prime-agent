//! JavaScript number semantics for the cloud wire's integer fields (TS
//! `Number.isInteger` / `JSON.parse`): JSON may spell an integer `1`,
//! `1.0`, or `1e0`, and literals beyond 2^53 round through `f64` exactly
//! like `JSON.parse`. The typed fields are `u64`, so deserialization
//! normalizes the JS-parsed number into it; an integral JS number above
//! 2^64 - 2^11 (the largest double `u64` holds) has no typed home and
//! fails the typed parse with [`TYPED_U64_DOMAIN_EXPECTED`] — the TS side
//! keeps it as a plain number. The value is never saturated or wrapped;
//! the corpus records the TS side accepting these (`divergentParses`) and
//! the golden test pins this exact rejection.

use serde::Deserialize;
use serde_json::Number;

/// The largest integral `f64` that still fits `u64`: 2^64 - 2^11 (the
/// next double up is exactly 2^64, which `u64` cannot hold).
const MAX_JS_U64: f64 = 18_446_744_073_709_549_568.0;

/// True for the numbers TS `Number.isInteger` accepts: finite, no
/// fractional part (`-0` counts).
pub(super) fn is_js_integer(number: f64) -> bool {
    number.is_finite() && number.fract() == 0.0
}

/// The `u64` a JS engine holds for `number`, when it is an integral
/// `JSON.parse` result that fits. Literals beyond 2^53 round through
/// `f64` first, so the result is exactly what the TS side stores.
#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)] // in-range integral doubles cast exactly
pub(super) fn js_u64(number: &Number) -> Option<u64> {
    let value = number.as_f64()?;
    if !is_js_integer(value) || !(0.0..=MAX_JS_U64).contains(&value) {
        return None;
    }
    Some(value as u64)
}

/// The stable expected-phrase of the typed rejection: integral JS numbers
/// above the `u64` wire domain fail the typed parse with this message,
/// never a TS problem string, so the port's own bound is unmistakable.
pub(super) const TYPED_U64_DOMAIN_EXPECTED: &str = "an integer within the u64 wire domain";

/// Fails a typed parse with one problem for every JS number the `u64`
/// wire fields cannot hold.
fn expect_js_u64<E>(number: &Number) -> Result<u64, E>
where
    E: serde::de::Error,
{
    js_u64(number).ok_or_else(|| {
        E::invalid_value(
            serde::de::Unexpected::Other("a non-integer or u64-overflowing JavaScript number"),
            &TYPED_U64_DOMAIN_EXPECTED,
        )
    })
}

/// `#[serde(deserialize_with)]` for one required `u64` wire field.
pub(super) fn deserialize_u64<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    expect_js_u64(&Number::deserialize(deserializer)?)
}

/// `#[serde(deserialize_with)]` for one optional `u64` wire field.
pub(super) fn deserialize_option_u64<'de, D>(deserializer: D) -> Result<Option<u64>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    match Option::<Number>::deserialize(deserializer)? {
        None => Ok(None),
        Some(number) => expect_js_u64(&number).map(Some),
    }
}
