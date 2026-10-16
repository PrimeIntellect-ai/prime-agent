# pa-ai

Provider APIs and model registry.

## Scope
Provider trait + per-provider streaming clients (anthropic, openai-completions/responses, google, bedrock, mistral, azure, prime-inference), model registry/resolution, usage accounting, stream-failure retry, provider-error shapes (per-SDK user-facing texts, diagnostic error names, connection-error profiles), bedrock transport selection (h2c prior-knowledge HTTP/2 cleartext, h2-preferred TLS ALPN, the http1 AWS_BEDROCK_FORCE_HTTP1/proxy mode), overflow handling, JSON repair parsing, faux provider for tests.

Reasoning replay preflight belongs to registry dispatch: both facade calls and the publicly returned `Arc<dyn Provider>` use the same checked provider. Unsupported history returns an explicit error before provider serialization, authentication or HTTP; serializers do not repeat that preflight.

## Non-goals
No agent loop, no tool execution, no session state, no UI. Receives/returns `pa-types` messages.

## Public API
`Provider` trait, `ProviderRegistry`, model lookup/resolution, faux provider. `utils::tls::http_client_builder` lets caller-owned HTTP transports apply the shared extra-CA trust configuration. Per-provider internals are `pub(crate)`.

## Depends on
pa-types (one-way).
