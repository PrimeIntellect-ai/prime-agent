//! The `/model` picker's catalog surface: serve the current validated
//! snapshot instantly, refresh in the background (TS daemon-mode
//! `get_model_catalog` → `session.modelRegistry.refreshModelCatalog`, with
//! the operator-sanctioned no-stall divergence).
//!
//! TS awaits the refresh inside the request (`refreshProviderCatalog(false)`
//! interval-gated + `refreshAvailableModels`' entitlement refresh), so a
//! first picker open after a daemon boot — or past the hourly window —
//! waits on the fetch (bounded by the 5 s catalog timeout) before the
//! catalog lands. This port returns the current validated chain snapshot
//! — disk cache → bundled → compiled, never a network request, cold start
//! included — and runs the SAME refresh in a background task. When the
//! refresh changes what this worker would answer, it broadcasts
//! `model_catalog_changed` (Rust-only extension over the TS daemon-mode
//! protocol): clients re-fetch — instant, from the now-warm caches — and
//! an open picker folds the catalog through its stable update path, so
//! the selected row never flickers. An unchanged refresh (the hourly
//! gate, a failure, identical data) stays silent, so event → re-fetch →
//! gated refresh terminates.
//!
//! Refresh schedule (TS `model-registry.ts` port): every catalog request
//! spawns the interval-gated `PickerOpen` refresh; the hourly loop and the
//! startup refresh are the supervisor's; a login or logout that changed the
//! Prime Inference credential scope (the client process writes auth.json —
//! the split-process port of `authStorage.onChange` → forced
//! `scheduleCatalogRefresh`) forces the `AuthChange` refresh immediately.

use std::sync::Arc;

use serde_json::{json, Value};

use crate::protocol::{response_success, DaemonResponse};
use crate::worker::{OutboundFrame, Worker};

impl Worker {
    /// `get_model_catalog`: the full catalog and the providers with
    /// configured auth, from the current validated snapshot — never a
    /// network request on the response path — with the refresh running in
    /// the background (see the module docs for the divergence from TS's
    /// awaited `refreshModelCatalog`).
    pub(crate) async fn handle_get_model_catalog(&self) -> DaemonResponse {
        if let Err(response) = self.require_created("get_model_catalog") {
            return response;
        }
        let agent_dir = self.config.agent_dir.clone();
        let models_json = agent_dir.join("models.json");
        let mut registry = pa_core::models::ModelRegistry::create(
            pa_core::auth::AuthStorage::create(&agent_dir),
            models_json.clone(),
        );
        // The on-disk private authorization (fingerprint-checked): the
        // validated current view of the account's private models, no
        // network. A stale or absent cache simply gates private models
        // out of the instant snapshot; the background refresh re-lands
        // them.
        registry.load_private_authorization_from_cache();
        let available = registry
            .get_available()
            .into_iter()
            .cloned()
            .collect::<Vec<_>>();
        let served = catalog_payload(&registry, &available);
        // The refresh trigger: an observed Prime Inference credential-scope
        // change forces the refresh (a login or logout wrote auth.json);
        // anything else keeps the hourly gate. The observation consumes
        // the current scope, so one auth change forces exactly once.
        let credentials = pa_core::models::prime_credentials_for_dir(&agent_dir);
        let catalog = pa_core::models::catalog_for(Some(&models_json));
        let trigger = if catalog.credentials_changed(credentials.as_ref()) {
            pa_models::RefreshTrigger::AuthChange
        } else {
            pa_models::RefreshTrigger::PickerOpen
        };
        self.spawn_catalog_refresh(trigger, served.clone());
        response_success(None, "get_model_catalog", Some(served))
    }

    /// The background catalog refresh (the daemon `create` path's
    /// fire-and-forget refresh shape): the same awaited chain the TS
    /// request runs — reload, gated-or-forced fetches, the private-model
    /// entitlements — settled off the response path. A refresh that
    /// changes the served snapshot broadcasts `model_catalog_changed`;
    /// failures keep the last-good snapshot (the caches' contract) and
    /// stay silent.
    fn spawn_catalog_refresh(&self, trigger: pa_models::RefreshTrigger, served: Value) {
        let agent_dir = self.config.agent_dir.clone();
        let events = Arc::clone(&self.events);
        tokio::spawn(async move {
            let auth = pa_core::auth::AuthStorage::create(&agent_dir);
            let mut registry =
                pa_core::models::ModelRegistry::create(auth, agent_dir.join("models.json"));
            let available = registry
                .refresh_available_models_with_trigger(trigger)
                .await;
            let refreshed = catalog_payload(&registry, &available);
            if refreshed != served {
                events.send(OutboundFrame::model_catalog_changed());
            }
        });
    }
}

/// The wire payload of one catalog snapshot (TS `refreshModelCatalog`'s
/// `{models, configuredProviders}`): the full catalog minus private Prime
/// Inference models the current credentials do not authorize, plus the
/// sorted providers with configured auth. Both the served response and the
/// post-refresh comparison use it, so the broadcast fires exactly when the
/// answer would change.
fn catalog_payload(
    registry: &pa_core::models::ModelRegistry,
    available: &[pa_types::ai::Model],
) -> Value {
    let mut providers: Vec<String> = available
        .iter()
        .map(|model| model.provider.clone())
        .collect();
    providers.sort();
    providers.dedup();
    let available_keys: std::collections::HashSet<String> = available
        .iter()
        .map(|model| format!("{}/{}", model.provider, model.id))
        .collect();
    // The catalog keeps every model except private Prime Inference models
    // the current credentials do not authorize.
    let models: Vec<Value> = registry
        .get_all()
        .iter()
        .filter(|model| {
            !pa_core::models::is_private_prime_inference_model(model)
                || available_keys.contains(&format!("{}/{}", model.provider, model.id))
        })
        .map(|model| serde_json::to_value(model).unwrap_or(Value::Null))
        .collect();
    json!({
        "models": models,
        "configuredProviders": providers,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worker::WorkerConfig;
    use serde_json::json;
    use std::collections::VecDeque;
    use std::path::{Path, PathBuf};
    use std::sync::Mutex;
    use std::time::{Duration, Instant};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// NOTE on ambient credentials: like the pa-core live-catalog verifiers,
    /// these tests pin the Prime Inference scope through the temp agent
    /// dir's auth.json — an ambient `PRIME_API_KEY` in the test process
    /// would win over the stored credential (environment before stored,
    /// by design) and change the resolved scope. The CI env is clean.
    /// Nothing here leaves loopback.

    /// One scripted answer: raw bytes, or a gate the test releases.
    enum Answer {
        Raw(Vec<u8>),
        Gate(tokio::sync::oneshot::Receiver<Vec<u8>>),
    }

    /// A scripted loopback HTTP server for the two catalog fetch layers
    /// (the pa-models `tests/common` pattern): every request head is
    /// recorded (headers included), answers come from a shared queue —
    /// the last raw answer repeats when the queue drains, and a gate
    /// parks its request until the test releases it.
    struct CatalogServer {
        port: u16,
        requests: Arc<Mutex<Vec<String>>>,
        answers: Arc<Mutex<VecDeque<Answer>>>,
    }

    impl CatalogServer {
        async fn start(answers: Vec<Answer>) -> Self {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
                .await
                .expect("bind mock catalog server");
            let port = listener.local_addr().unwrap().port();
            let requests = Arc::new(Mutex::new(Vec::new()));
            let answers = Arc::new(Mutex::new(VecDeque::from(answers)));
            let server_requests = Arc::clone(&requests);
            let server_answers = Arc::clone(&answers);
            tokio::spawn(async move {
                loop {
                    let Ok((socket, _)) = listener.accept().await else {
                        return;
                    };
                    let requests = Arc::clone(&server_requests);
                    let answers = Arc::clone(&server_answers);
                    tokio::spawn(async move {
                        let mut socket = socket;
                        let mut buffer = [0u8; 8_192];
                        let mut read = 0usize;
                        loop {
                            let Ok(n) = socket.read(&mut buffer[read..]).await else {
                                return;
                            };
                            if n == 0 {
                                return;
                            }
                            read += n;
                            if buffer[..read].windows(4).any(|w| w == b"\r\n\r\n") {
                                break;
                            }
                            if read == buffer.len() {
                                break;
                            }
                        }
                        let head = String::from_utf8_lossy(&buffer[..read]).to_string();
                        requests.lock().expect("request log").push(head);
                        let answer = answers.lock().expect("answer queue").pop_front();
                        let response = match answer {
                            Some(Answer::Raw(bytes)) => bytes,
                            Some(Answer::Gate(receiver)) => match receiver.await {
                                Ok(bytes) => bytes,
                                Err(_) => status(500, "Gate Closed"),
                            },
                            None => status(500, "Drained"),
                        };
                        let _ = socket.write_all(&response).await;
                        let _ = socket.flush().await;
                    });
                }
            });
            Self {
                port,
                requests,
                answers,
            }
        }

        fn url(&self, path: &str) -> String {
            format!("http://127.0.0.1:{}{path}", self.port)
        }

        fn recorded_requests(&self) -> Vec<String> {
            self.requests.lock().expect("request log").clone()
        }

        fn push(&self, answer: Answer) {
            self.answers.lock().expect("answer queue").push_back(answer);
        }

        fn request_count(&self) -> usize {
            self.requests.lock().expect("request log").len()
        }
    }

    fn ok_json(body: String) -> Vec<u8> {
        format!(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{body}",
            body.len()
        )
        .into_bytes()
    }

    fn status(code: u16, reason: &str) -> Vec<u8> {
        format!("HTTP/1.1 {code} {reason}\r\ncontent-length: 0\r\n\r\n").into_bytes()
    }

    /// A gate the test releases later (the held-open catalog fetch).
    fn gate() -> (tokio::sync::oneshot::Sender<Vec<u8>>, Answer) {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        (sender, Answer::Gate(receiver))
    }

    /// One provider-catalog aggregate entry riding a compiled transport
    /// tuple (the pinning invariant keeps fetched entries to compiled
    /// transports; probe ids must stay outside the compiled catalog).
    fn catalog_aggregate(ids: &[&str]) -> String {
        let anthropic = pa_models::transports::compiled_models()
            .iter()
            .find(|model| model.provider == "anthropic")
            .expect("compiled anthropic tuple")
            .clone();
        let models: Vec<Value> = ids
            .iter()
            .map(|id| {
                json!({
                    "id": id,
                    "name": id,
                    "api": anthropic.api,
                    "provider": anthropic.provider,
                    "baseUrl": anthropic.base_url,
                    "reasoning": false,
                    "input": ["text"],
                    "cost": {"input": 1.0, "output": 1.0, "cacheRead": 0.0, "cacheWrite": 0.0},
                    "contextWindow": 128_000,
                    "maxTokens": 4_096,
                })
            })
            .collect();
        serde_json::to_string(&json!({"schemaVersion": 1, "models": models})).unwrap()
    }

    /// The Prime Inference `/models` payload: every compiled entry (the
    /// coverage gate needs them) plus one full-specs public marker the
    /// compiled catalog provably lacks, so a landed refresh visibly
    /// changes the served catalog. Private ids are filtered from the
    /// public snapshot (the private-model entitlements ride the
    /// private-authorization fetch's own payload).
    fn pi_snapshot_payload(marker: &str) -> String {
        let mut data: Vec<Value> = pa_models::transports::prime_inference_offline_entries()
            .iter()
            .map(|model| {
                json!({
                    "id": model.id,
                    "display_name": model.name,
                    "pricing": {
                        "input_usd_per_mtok": model.cost.input.as_f64(),
                        "output_usd_per_mtok": model.cost.output.as_f64(),
                    },
                    "specs": {
                        "context_window": model.context_window,
                        "max_output_tokens": model.max_tokens,
                        "supports_reasoning": model.reasoning,
                        "modalities": {"input": ["text"], "output": ["text"]},
                    },
                })
            })
            .collect();
        data.push(json!({
            "id": marker,
            "display_name": marker,
            "pricing": {"input_usd_per_mtok": 1.0, "output_usd_per_mtok": 2.0},
            "specs": {
                "context_window": 200_000,
                "max_output_tokens": 32_768,
                "supports_reasoning": true,
                "modalities": {"input": ["text"], "output": ["text"]},
            },
        }));
        serde_json::to_string(&json!({"data": data})).unwrap()
    }

    /// The private-model entitlement payload: full-specs entries for
    /// exactly the ids the account is authorized for.
    fn private_payload(ids: &[&str]) -> String {
        let data: Vec<Value> = ids
            .iter()
            .map(|id| {
                json!({
                    "id": id,
                    "display_name": id,
                    "pricing": {"input_usd_per_mtok": 1.0, "output_usd_per_mtok": 2.0},
                    "specs": {
                        "context_window": 200_000,
                        "max_output_tokens": 32_768,
                        "supports_reasoning": true,
                        "modalities": {"input": ["text"], "output": ["text"]},
                    },
                })
            })
            .collect();
        serde_json::to_string(&json!({"data": data})).unwrap()
    }

    fn write_auth_json(agent_dir: &Path, api_key: &str, team_id: &str) {
        std::fs::write(
            agent_dir.join("auth.json"),
            json!({
                "prime-inference": {
                    "type": "api_key",
                    "key": api_key,
                    "primeTeam": {"teamId": team_id, "name": "Catalog Team"}
                }
            })
            .to_string(),
        )
        .expect("write auth.json");
    }

    fn write_models_json(agent_dir: &Path) {
        std::fs::create_dir_all(agent_dir).expect("agent dir");
        std::fs::write(
            agent_dir.join("models.json"),
            json!({
                "providers": {
                    "prime-inference": {
                        "api": "openai-completions",
                        "baseUrl": "http://127.0.0.1:9/v1",
                        "apiKey": "sk-catalog-worker",
                        "models": [
                            {"id": "mock-1", "name": "Mock 1", "api": "openai-completions",
                             "baseUrl": "http://127.0.0.1:9/v1", "contextWindow": 128000,
                             "maxTokens": 4096}
                        ]
                    }
                }
            })
            .to_string(),
        )
        .expect("write models.json");
    }

    /// The hermetic fixture: a temp agent dir (auth + models.json), both
    /// fetch layers aimed at the scripted server (empty bundled dir, so
    /// the compiled fallback is the cold base), an installed
    /// process-shared catalog, and a created worker. The daemon `create`
    /// path's own fire-and-forget refresh warms the caches against the
    /// server's initial answers; the fixture returns once that refresh
    /// has fully settled (its last write is the private-authorization
    /// cache), so every later fetch count is deterministic.
    struct Fixture {
        dir: PathBuf,
        agent_dir: PathBuf,
        server: CatalogServer,
        worker: Arc<Worker>,
        events: tokio::sync::broadcast::Receiver<Arc<OutboundFrame>>,
    }

    async fn fixture(create_answers: Vec<Answer>) -> Fixture {
        let dir = std::env::temp_dir().join(format!(
            "pa-model-catalog-refresh-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let agent_dir = dir.join("agent");
        write_models_json(&agent_dir);
        write_auth_json(&agent_dir, "sk-account-a", "team-a");
        let server = CatalogServer::start(create_answers).await;
        let bundled_dir = dir.join("bundled");
        std::fs::create_dir_all(&bundled_dir).expect("bundled dir");
        let catalog = pa_models::ModelCatalog::with_urls(
            Some(agent_dir.join("models")),
            Some(bundled_dir),
            &server.url("/catalog"),
            &server.url("/api/v1"),
        );
        pa_core::models::install_catalog(&agent_dir.join("models.json"), Arc::new(catalog));
        let config = WorkerConfig {
            socket_path: dir.join("worker.sock"),
            supervisor_socket_path: PathBuf::new(),
            token: "token".to_string(),
            worker_instance_id: String::new(),
            active_session_id: "catalog-session".to_string(),
            agent_dir: agent_dir.clone(),
            recovery_journal_path: dir.join("recovery.jsonl"),
            telemetry_disabled: None,
            script: Some(json!({ "responses": ["ack"] })),
        };
        let worker = Arc::new(Worker::new(config, None));
        let events = worker.events.subscribe();
        let created = worker
            .dispatch(
                "create",
                &json!({ "noSession": true, "cwd": dir.to_string_lossy() }),
            )
            .await;
        assert!(created.success, "create failed: {created:?}");
        // The create path's background refresh settles when its last
        // write lands (the private-authorization cache, written by the
        // refresh's final step).
        let private_cache = agent_dir.join("prime-inference-private-models.json");
        let deadline = Instant::now() + Duration::from_secs(30);
        while !private_cache.exists() {
            assert!(
                Instant::now() < deadline,
                "the create-path refresh never settled; requests so far: {:?}",
                server.recorded_requests()
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        Fixture {
            dir,
            agent_dir,
            server,
            worker,
            events,
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    /// The initial answers for the create-path refresh (key sk-account-a,
    /// team team-a): the v1 catalog aggregate, the team-a snapshot (with
    /// the team-a private entitlement), and the matching authorization.
    fn create_phase_answers() -> Vec<Answer> {
        vec![
            Answer::Raw(ok_json(catalog_aggregate(&["probe-v1"]))),
            Answer::Raw(ok_json(pi_snapshot_payload("live/team-a-marker"))),
            Answer::Raw(ok_json(private_payload(&["internal/team-a-private"]))),
        ]
    }

    async fn get_model_catalog(worker: &Worker, session: &str) -> Value {
        let response = worker
            .dispatch("get_model_catalog", &json!({ "activeSessionId": session }))
            .await;
        assert!(response.success, "get_model_catalog failed: {response:?}");
        response.data.expect("catalog payload")
    }

    fn has_model(payload: &Value, id: &str) -> bool {
        payload["models"]
            .as_array()
            .expect("models array")
            .iter()
            .any(|model| model["id"] == id)
    }

    /// Whether a `model_catalog_changed` frame arrives within `bound`
    /// (other frames pass through and do not count): the negative-assert
    /// seam — a spurious broadcast lands inside the bound, an honestly
    /// silent refresh simply lets the bound elapse.
    async fn catalog_changed_within(
        events: &mut tokio::sync::broadcast::Receiver<Arc<OutboundFrame>>,
        bound: Duration,
    ) -> bool {
        tokio::time::timeout(bound, async {
            loop {
                match events.recv().await {
                    Ok(frame) if frame.outbound_type == "model_catalog_changed" => return true,
                    Ok(_) => continue,
                    Err(_) => return false,
                }
            }
        })
        .await
        .unwrap_or(false)
    }

    /// Await the next `model_catalog_changed` frame (other frames pass
    /// through; a bounded deadline replaces any fixed wait).
    async fn await_catalog_changed(
        events: &mut tokio::sync::broadcast::Receiver<Arc<OutboundFrame>>,
    ) {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .expect("model_catalog_changed never landed");
            match tokio::time::timeout(remaining, events.recv()).await {
                Ok(Ok(frame)) if frame.outbound_type == "model_catalog_changed" => return,
                Ok(Ok(_)) => continue,
                Ok(Err(error)) => panic!("event stream error: {error}"),
                Err(_) => panic!("model_catalog_changed never landed"),
            }
        }
    }

    /// A picker open returns the current validated snapshot without
    /// waiting on the fetch (the held-open gate proves the response path
    /// never blocks on the network), and the auth-change forced refresh
    /// lands in the background: the event fires, and the next open serves
    /// the fresh catalog — the new account's marker and private model,
    /// never the old account's (scope-keyed views; the refreshed requests
    /// carry the new credentials).
    #[tokio::test]
    async fn picker_open_returns_instantly_and_the_auth_change_refresh_lands() {
        let mut fixture = fixture(create_phase_answers()).await;
        // A login switched the account (key + team) between the create
        // path's warm-up and this picker open: the scope observation seeds
        // from the stored snapshot's scope and detects the change.
        write_auth_json(&fixture.agent_dir, "sk-account-b", "team-b");
        let (release, held) = gate();
        fixture.server.push(held);
        fixture.server.push(Answer::Raw(ok_json(pi_snapshot_payload(
            "live/team-b-marker",
        ))));
        fixture
            .server
            .push(Answer::Raw(ok_json(private_payload(&[]))));
        let requests_before = fixture.server.request_count();

        let started = Instant::now();
        let served = get_model_catalog(&fixture.worker, "catalog-session").await;
        // The response returned while the catalog fetch was still held:
        // the response path never touched the network. It serves the
        // current validated snapshot — the warm public view; the new
        // account's credentialed entries land only with the refresh.
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "the picker-open response waited on the fetch"
        );
        assert!(has_model(&served, "mock-1"), "the custom models.json entry");
        assert!(has_model(&served, "probe-v1"), "the warm provider catalog");
        // The account switch never serves the old account's credentialed
        // view: the Prime Inference snapshot is scope-keyed, so the marker
        // and the private entitlement are absent from the instant
        // response — and the new account's view has not landed yet (the
        // refresh holds at the gate).
        assert!(!has_model(&served, "live/team-a-marker"));
        assert!(!has_model(&served, "live/team-b-marker"));
        assert!(!has_model(&served, "internal/team-a-private"));

        // Release the held fetch: the background refresh lands the new
        // account's catalog and broadcasts the change.
        let _ = release.send(ok_json(catalog_aggregate(&["probe-v1", "probe-v2"])));
        await_catalog_changed(&mut fixture.events).await;
        let fresh = get_model_catalog(&fixture.worker, "catalog-session").await;
        assert!(
            has_model(&fresh, "probe-v2"),
            "the refreshed provider catalog"
        );
        assert!(has_model(&fresh, "live/team-b-marker"));
        // The old account's view never serves the new scope: the marker
        // and the private entitlement are gone the moment the scope moved.
        assert!(!has_model(&fresh, "live/team-a-marker"));
        assert!(!has_model(&fresh, "internal/team-a-private"));
        // The refreshed requests carried the new credentials only. The
        // team header carries the account's EFFECTIVE team — an ambient
        // `PRIME_TEAM_ID` pins it (the production pin, set on the fleet
        // VMs), otherwise the stored team-b header rides — and the old
        // account's team never rides a refreshed fetch.
        let pinned_team = std::env::var("PRIME_TEAM_ID")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let expected_team = pinned_team.as_deref().unwrap_or("team-b");
        let heads = fixture.server.recorded_requests();
        assert!(heads.len() > requests_before, "the forced refresh fetched");
        let refreshed_heads = &heads[requests_before..];
        let auth_headers: Vec<&str> = refreshed_heads
            .iter()
            .filter_map(|head| {
                head.lines()
                    .find(|line| line.to_ascii_lowercase().starts_with("authorization:"))
            })
            .collect();
        assert!(
            !auth_headers.is_empty(),
            "the credentialed fetches exist in the refreshed log"
        );
        assert!(
            auth_headers
                .iter()
                .all(|header| header.contains("Bearer sk-account-b")),
            "no old credentials leak into the refreshed fetches: {auth_headers:?}"
        );
        assert!(
            refreshed_heads
                .iter()
                .any(|head| head.contains(&format!("X-Prime-Team-ID: {expected_team}"))),
            "the private fetch rode the new effective team header ({expected_team}): {refreshed_heads:?}"
        );
        assert!(
            refreshed_heads
                .iter()
                .all(|head| !head.contains("X-Prime-Team-ID: team-a")),
            "the old account's team never rides the refreshed fetches: {refreshed_heads:?}"
        );
    }

    /// Repeat picker opens inside the hourly window stay gated: no new
    /// fetches, no event (the served snapshot is already current), so the
    /// event -> re-fetch -> refresh cycle terminates.
    #[tokio::test]
    async fn repeat_opens_inside_the_gate_add_no_fetches_and_stay_silent() {
        let mut fixture = fixture(create_phase_answers()).await;
        let requests_before = fixture.server.request_count();
        for _ in 0..3 {
            let served = get_model_catalog(&fixture.worker, "catalog-session").await;
            assert!(has_model(&served, "probe-v1"));
            assert!(has_model(&served, "live/team-a-marker"));
        }
        // No fetch left the worker: the hourly gate held for every open
        // (the create-path refresh armed it).
        assert_eq!(
            fixture.server.request_count(),
            requests_before,
            "repeat opens stayed gated"
        );
        // And nothing broadcast: the served snapshot never changed. A
        // spurious broadcast (the event loop this test guards) lands
        // inside the bound; an honestly gated refresh lets it elapse.
        assert!(
            !catalog_changed_within(&mut fixture.events, Duration::from_millis(250)).await,
            "a gated refresh must not broadcast model_catalog_changed"
        );
    }

    /// A refresh whose every layer fails keeps the last-good snapshot and
    /// stays silent: the failures retain the caches, the served payload
    /// is unchanged, so no event fires and the next open still serves the
    /// warm catalog.
    #[tokio::test]
    async fn refresh_failure_keeps_the_last_good_catalog_and_stays_silent() {
        let mut fixture = fixture(create_phase_answers()).await;
        write_auth_json(&fixture.agent_dir, "sk-account-c", "team-c");
        for _ in 0..3 {
            fixture
                .server
                .push(Answer::Raw(status(500, "Catalog Down")));
        }
        let served = get_model_catalog(&fixture.worker, "catalog-session").await;
        // The instant snapshot still serves the validated public view; the
        // changed scope isolates the old account's credentialed entries
        // (scope-keyed snapshot, fingerprint-matched entitlements).
        assert!(has_model(&served, "probe-v1"));
        assert!(!has_model(&served, "live/team-a-marker"));
        assert!(!has_model(&served, "internal/team-a-private"));

        // The forced refresh consumed its three failures; the deadline is
        // on the request log, not on a fixed sleep.
        let deadline = Instant::now() + Duration::from_secs(30);
        while fixture.server.request_count() < 3 + 3 {
            assert!(
                Instant::now() < deadline,
                "the failed refresh never ran; requests: {:?}",
                fixture.server.recorded_requests()
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(
            !catalog_changed_within(&mut fixture.events, Duration::from_millis(250)).await,
            "a failed refresh keeps the served snapshot and must stay silent"
        );
        let after = get_model_catalog(&fixture.worker, "catalog-session").await;
        assert!(has_model(&after, "probe-v1"), "last-good retained");
        assert!(!has_model(&after, "internal/team-a-private"));
    }
}
