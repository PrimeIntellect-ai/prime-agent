//! Parity verifier: parse the real catalog payload (a byte-faithful
//! snapshot of the `PrimeIntellect-ai/prime-agent-catalog`
//! `models/catalog.v1.json` aggregate — headers stripped, prime-inference
//! excluded, provider/id sorted; refresh with `scripts/generate-catalog-fixture.py`)
//! against the strict schema and transport pinning. Real data, real scale:
//! 1,197 entries across 31 providers, 0 skipped.

use pa_models::pinning::{parse_provider_model_catalog, PinnedTemplates};
use pa_models::schema::{parse_model_catalog, InvalidEntries};
use pa_models::transports;
use serde_json::Value;

const FIXTURE: &str = include_str!("fixtures/catalog.v1.json");

fn fixture() -> Value {
    serde_json::from_str(FIXTURE).expect("fixture parses")
}

#[test]
fn parses_the_real_payload_with_zero_failures() {
    let parsed =
        parse_model_catalog(&fixture(), InvalidEntries::Reject).expect("real payload parses");
    let providers: std::collections::BTreeSet<&str> =
        parsed.models.iter().map(|m| m.provider.as_str()).collect();
    assert_eq!(parsed.models.len(), 1197, "the full catalog aggregate");
    assert_eq!(providers.len(), 31, "31 providers");
    // No entry ever carries headers from catalog data.
    assert!(parsed.models.iter().all(|model| model.headers.is_none()));
}

#[test]
fn every_real_entry_survives_transport_pinning() {
    let pinned = parse_provider_model_catalog(&fixture(), &PinnedTemplates::from_compiled())
        .expect("pinned");
    assert_eq!(
        pinned.len(),
        1197,
        "real catalog data selects only compiled transports"
    );
    let headers = pinned
        .iter()
        .filter(|model| model.headers.is_some())
        .count();
    assert!(headers > 0, "template headers are applied at parse time");
}

#[test]
fn passes_the_packer_gates() {
    // The build lane's gate: >= 42 distinct (provider, api, baseUrl) tuples.
    let parsed = parse_model_catalog(&fixture(), InvalidEntries::Reject).unwrap();
    let tuples: std::collections::HashSet<(&str, &str, &str)> = parsed
        .models
        .iter()
        .map(|m| (m.provider.as_str(), m.api.as_str(), m.base_url.as_str()))
        .collect();
    assert!(tuples.len() >= 42, "packer gate: >=42 transport tuples");
    // Compiled table agrees entry-by-entry with the fixture's tuples.
    let compiled: std::collections::HashSet<(String, String, String)> =
        transports::compiled_models()
            .iter()
            .map(|m| (m.provider.clone(), m.api.clone(), m.base_url.clone()))
            .collect();
    assert!(
        parsed.models.iter().all(|m| compiled.contains(&(
            m.provider.clone(),
            m.api.clone(),
            m.base_url.clone()
        ))),
        "fixture is compiled-transport-shaped"
    );
}

#[test]
fn skip_invalid_keeps_the_real_payload_whole() {
    let parsed = parse_model_catalog(&fixture(), InvalidEntries::SkipInvalid).expect("skip mode");
    assert_eq!(parsed.models.len(), 1197, "no real entry is skipped");
}
