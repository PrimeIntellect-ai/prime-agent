//! Shared domain and wire types for Prime Agent.
//!
//! This crate is the serde port of the TypeScript wire and domain contracts:
//!
//! - [`ai`]: the model-facing message surface from `packages/ai/src/types.ts`
//!   (content blocks, messages, usage, stop reasons, stream events, models, tools).
//!
//! # Lossless round-trips
//!
//! Every wire struct carries a `#[serde(flatten)] rest: JsonMap` catch-all so
//! fields the typed structs do not model yet are preserved on serialize. The
//! round-trip contract used throughout the tests is: parse a JSON line into a
//! typed value, serialize it back, and require the re-parsed JSON to equal the
//! original parsed JSON.

pub mod ai;
pub mod daemon;
pub mod extension_rpc;
pub mod goal;
pub mod platform;
pub mod session;
pub mod skill_blocks;
pub mod slash_commands;
pub mod themes;
pub mod usage;

use serde::{Deserialize, Serialize};

/// JSON object map used for opaque payloads and unknown-field catch-alls.
pub type JsonMap = serde_json::Map<String, serde_json::Value>;

/// An f64 that (de)serializes with JavaScript `JSON.stringify` number parity.
///
/// TypeScript numbers are f64 and `JSON.stringify` prints integral values
/// without a fractional part (`0`, not `0.0`). Rust's `f64` serialization
/// always prints `0.0`, which would change the JSON bytes and break lossless
/// round-trips against TS-produced files. This newtype prints integral values
/// as integers and everything else via the shortest f64 representation.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct JsNumber(pub f64);

impl JsNumber {
    pub fn as_f64(self) -> f64 {
        self.0
    }
}

impl From<f64> for JsNumber {
    fn from(v: f64) -> Self {
        JsNumber(v)
    }
}

impl From<i64> for JsNumber {
    fn from(v: i64) -> Self {
        JsNumber(v as f64)
    }
}

impl From<u64> for JsNumber {
    fn from(v: u64) -> Self {
        JsNumber(v as f64)
    }
}

impl Serialize for JsNumber {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let v = self.0;
        if v.is_finite() && v.fract() == 0.0 && v.abs() < 9.007_199_254_740_992e15 {
            serializer.serialize_i64(v as i64)
        } else {
            serializer.serialize_f64(v)
        }
    }
}

impl<'de> Deserialize<'de> for JsNumber {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct V;
        impl serde::de::Visitor<'_> for V {
            type Value = JsNumber;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("a JSON number")
            }
            fn visit_u64<E: serde::de::Error>(self, v: u64) -> Result<Self::Value, E> {
                Ok(JsNumber(v as f64))
            }
            fn visit_i64<E: serde::de::Error>(self, v: i64) -> Result<Self::Value, E> {
                Ok(JsNumber(v as f64))
            }
            fn visit_f64<E: serde::de::Error>(self, v: f64) -> Result<Self::Value, E> {
                Ok(JsNumber(v))
            }
        }
        deserializer.deserialize_any(V)
    }
}
