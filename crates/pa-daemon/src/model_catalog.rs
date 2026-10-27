//! The `/model` picker's catalog surface: serve the current validated
//! snapshot instantly and refresh in the background (a deliberate
//! divergence from TS, which awaits the refresh inside the request); a
//! changed snapshot broadcasts `model_catalog_changed`.

use std::sync::atomic::Ordering;
use std::sync::Arc;

use serde_json::{json, Value};

use crate::protocol::{response_success, DaemonResponse};
use crate::worker::{OutboundFrame, Worker};

/// Concurrent picker opens share one in-flight refresh; a later open
/// starts another fetch even if the last snapshot was fetched recently.
#[derive(Default)]
pub(crate) struct RefreshGate {
    in_flight: std::sync::atomic::AtomicBool,
    auth_change_queued: std::sync::atomic::AtomicBool,
}

impl Worker {
    /// `get_model_catalog` returns a validated snapshot immediately.
    /// Explicit picker opens (or omitted `refresh`, for existing callers)
    /// fetch both catalogs in the background; `refresh:false` only reads
    /// (including event re-reads).
    pub(crate) fn handle_get_model_catalog(&self, payload: &Value) -> DaemonResponse {
        if let Err(response) = self.require_created("get_model_catalog") {
            return response;
        }
        let agent_dir = self.config.agent_dir.clone();
        let models_json = agent_dir.join("models.json");
        let registry = pa_core::models::ModelRegistry::create(
            pa_core::auth::AuthStorage::create(&agent_dir),
            models_json.clone(),
        );
        let available = registry
            .get_available()
            .into_iter()
            .cloned()
            .collect::<Vec<_>>();
        let served = catalog_payload(&registry, &available);
        let credentials = pa_core::models::prime_credentials_for_dir(&agent_dir);
        let catalog = pa_core::models::catalog_for(Some(&models_json));
        let scope_changed = catalog.credentials_changed(credentials.as_ref());
        if scope_changed
            || payload
                .get("refresh")
                .and_then(Value::as_bool)
                .unwrap_or(true)
        {
            let trigger = if scope_changed {
                pa_core::models::RefreshTrigger::AuthChange
            } else {
                pa_core::models::RefreshTrigger::PickerOpen
            };
            self.spawn_catalog_refresh(trigger, served.clone());
        }
        response_success(None, "get_model_catalog", Some(served))
    }

    /// The background catalog refresh: the same awaited chain the TS
    /// request runs, settled off the response path; failures keep the
    /// last-good snapshot and stay silent.
    fn spawn_catalog_refresh(&self, trigger: pa_core::models::RefreshTrigger, served: Value) {
        let gate = std::sync::Arc::clone(&self.model_catalog_refresh_gate);
        if gate.in_flight.swap(true, Ordering::SeqCst) {
            // A scope change cannot be satisfied by the old account's
            // in-flight fetch. Re-arm once using the current credentials.
            if trigger == pa_core::models::RefreshTrigger::AuthChange {
                gate.auth_change_queued.store(true, Ordering::SeqCst);
            }
            return;
        }
        let agent_dir = self.config.agent_dir.clone();
        let events = Arc::clone(&self.events);
        tokio::spawn(async move {
            let mut baseline = served;
            let mut trigger = trigger;
            loop {
                let auth = pa_core::auth::AuthStorage::create(&agent_dir);
                let mut registry =
                    pa_core::models::ModelRegistry::create(auth, agent_dir.join("models.json"));
                let available = registry
                    .refresh_available_models_with_trigger(trigger)
                    .await;
                let refreshed = catalog_payload(&registry, &available);
                if refreshed != baseline {
                    events.send(OutboundFrame::model_catalog_changed());
                }
                baseline = refreshed;
                gate.in_flight.store(false, Ordering::SeqCst);
                if !gate.auth_change_queued.swap(false, Ordering::SeqCst) {
                    return;
                }
                if gate.in_flight.swap(true, Ordering::SeqCst) {
                    return;
                }
                // The prior fetch may have used pre-login credentials.
                trigger = pa_core::models::RefreshTrigger::AuthChange;
            }
        });
    }
}

/// The wire payload of one catalog snapshot: the full catalog minus
/// unauthorized private Prime Inference models, plus sorted providers.
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
    // Canonical (provider, id) order: the private-models append comes from
    // a HashMap iteration, so identical sets would serialize differently.
    let mut entries: Vec<&pa_types::ai::Model> = registry
        .get_all()
        .iter()
        .filter(|model| {
            !pa_core::models::is_private_prime_inference_model(model)
                || available_keys.contains(&format!("{}/{}", model.provider, model.id))
        })
        .collect();
    entries.sort_by(|a, b| (&a.provider, &a.id).cmp(&(&b.provider, &b.id)));
    let models: Vec<Value> = entries
        .into_iter()
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

    // NOTE on ambient credentials: these tests pin the Prime Inference
    // scope through the temp agent dir's auth.json — an ambient
    // `PRIME_API_KEY` would win over the stored credential and change
    // the resolved scope.

    /// One scripted answer: raw bytes, or a gate the test releases.
    enum Answer {
        Raw(Vec<u8>),
        Gate(tokio::sync::oneshot::Receiver<Vec<u8>>),
    }

    /// Route answers by request path: the provider and PI fetch run in
    /// parallel, so their request arrival order must not select payloads.
    struct CatalogServer {
        port: u16,
        requests: Arc<Mutex<Vec<String>>>,
        provider_answers: Arc<Mutex<VecDeque<Answer>>>,
        pi_answers: Arc<Mutex<VecDeque<Answer>>>,
    }

    impl CatalogServer {
        async fn start(provider_answers: Vec<Answer>, pi_answers: Vec<Answer>) -> Self {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
                .await
                .expect("bind mock catalog server");
            let port = listener.local_addr().unwrap().port();
            let requests = Arc::new(Mutex::new(Vec::new()));
            let provider_answers = Arc::new(Mutex::new(VecDeque::from(provider_answers)));
            let pi_answers = Arc::new(Mutex::new(VecDeque::from(pi_answers)));
            let server_requests = Arc::clone(&requests);
            let server_provider_answers = Arc::clone(&provider_answers);
            let server_pi_answers = Arc::clone(&pi_answers);
            tokio::spawn(async move {
                loop {
                    let Ok((socket, _)) = listener.accept().await else {
                        return;
                    };
                    let requests = Arc::clone(&server_requests);
                    let provider_answers = Arc::clone(&server_provider_answers);
                    let pi_answers = Arc::clone(&server_pi_answers);
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
                        requests.lock().expect("request log").push(head.clone());
                        let answer = if head.starts_with("GET /catalog ") {
                            provider_answers
                                .lock()
                                .expect("provider answers")
                                .pop_front()
                        } else if head.starts_with("GET /api/v1/models ") {
                            pi_answers.lock().expect("PI answers").pop_front()
                        } else {
                            None
                        };
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
                provider_answers,
                pi_answers,
            }
        }

        fn url(&self, path: &str) -> String {
            format!("http://127.0.0.1:{}{path}", self.port)
        }

        fn recorded_requests(&self) -> Vec<String> {
            self.requests.lock().expect("request log").clone()
        }

        fn push_provider(&self, answer: Answer) {
            self.provider_answers
                .lock()
                .expect("provider answers")
                .push_back(answer);
        }

        fn push_pi(&self, answer: Answer) {
            self.pi_answers
                .lock()
                .expect("PI answers")
                .push_back(answer);
        }

        fn request_count(&self) -> usize {
            self.requests.lock().expect("request log").len()
        }
    }

    fn ok_json(body: &str) -> Vec<u8> {
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
    /// tuple (probe ids must stay outside the compiled catalog).
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

    /// The Prime Inference `/models` payload: compiled public routes plus
    /// a public marker, and the authenticated private IDs for this account.
    fn pi_snapshot_payload(marker: &str, private: &[&str]) -> String {
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
        let private_data: Value = serde_json::from_str(&private_payload(private)).unwrap();
        data.extend(
            private_data["data"]
                .as_array()
                .expect("private entries")
                .clone(),
        );
        serde_json::to_string(&json!({"data": data})).unwrap()
    }

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

    /// A private route with the live reasoning controls the gateway reports.
    fn reasoning_private_payload(marker: &str, id: &str) -> String {
        let mut payload: Value =
            serde_json::from_str(&pi_snapshot_payload(marker, &[id])).expect("snapshot");
        let item = payload["data"]
            .as_array_mut()
            .expect("entries")
            .last_mut()
            .expect("private route");
        item["supported_parameters"] = json!([
            "max_tokens",
            "temperature",
            "tools",
            "tool_choice",
            "reasoning",
            "reasoning_effort"
        ]);
        item["reasoning"] = json!({
            "supported_efforts": ["none", "low", "high", "max"],
            "default_effort": "high"
        });
        payload.to_string()
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
                             "baseUrl": "http://127.0.0.1:9/v1", "contextWindow": 128_000,
                             "maxTokens": 4096}
                        ]
                    }
                }
            })
            .to_string(),
        )
        .expect("write models.json");
    }

    /// The hermetic fixture: a temp agent dir, both fetch layers aimed at
    /// the scripted server, a process-shared catalog, and a created
    /// worker. Returns once the create-path refresh has fully settled,
    /// so later fetch counts are deterministic.
    struct Fixture {
        dir: PathBuf,
        agent_dir: PathBuf,
        server: CatalogServer,
        worker: Arc<Worker>,
        events: tokio::sync::broadcast::Receiver<Arc<OutboundFrame>>,
    }

    async fn fixture((provider_answers, pi_answers): (Vec<Answer>, Vec<Answer>)) -> Fixture {
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
        let server = CatalogServer::start(provider_answers, pi_answers).await;
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
        // The create path's background refresh publishes the authenticated
        // scoped snapshot; wait for that observable write, not a fixed delay.
        let scoped_cache = agent_dir.join("models/prime-inference-models-cache.json");
        let deadline = Instant::now() + Duration::from_secs(30);
        let provider_cache = agent_dir.join("models/provider-model-catalog.v1.json");
        while !scoped_cache.exists() || !provider_cache.exists() {
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
    /// team team-a): the v1 provider aggregate and one authenticated PI
    /// snapshot with the team's private entitlement.
    fn create_phase_answers() -> (Vec<Answer>, Vec<Answer>) {
        (
            vec![Answer::Raw(ok_json(&catalog_aggregate(&["probe-v1"])))],
            vec![Answer::Raw(ok_json(&pi_snapshot_payload(
                "live/team-a-marker",
                &["internal/team-a-private"],
            )))],
        )
    }

    async fn get_model_catalog(worker: &Worker, session: &str, refresh: bool) -> Value {
        let response = worker
            .dispatch(
                "get_model_catalog",
                &json!({ "activeSessionId": session, "refresh": refresh }),
            )
            .await;
        assert!(response.success, "get_model_catalog failed: {response:?}");
        response.data.expect("catalog payload")
    }

    async fn await_refresh_settled(worker: &Worker) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while worker
            .model_catalog_refresh_gate
            .in_flight
            .load(Ordering::SeqCst)
        {
            assert!(Instant::now() < deadline, "catalog refresh did not settle");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    fn has_model(payload: &Value, id: &str) -> bool {
        payload["models"]
            .as_array()
            .expect("models array")
            .iter()
            .any(|model| model["id"] == id)
    }

    /// The payload's models are in canonical (provider, id) order: the
    /// served and refreshed snapshots are compared verbatim.
    fn assert_canonical_models_order(payload: &Value) {
        let models = payload["models"].as_array().expect("models array");
        let keys: Vec<(String, String)> = models
            .iter()
            .map(|model| {
                (
                    model["provider"].as_str().unwrap_or_default().to_string(),
                    model["id"].as_str().unwrap_or_default().to_string(),
                )
            })
            .collect();
        let mut sorted = keys.clone();
        sorted.sort();
        assert_eq!(keys, sorted, "the payload's models are canonically ordered");
    }

    /// Whether a `model_catalog_changed` frame arrives within `bound`
    /// (other frames pass through): the negative-assert seam.
    async fn catalog_changed_within(
        events: &mut tokio::sync::broadcast::Receiver<Arc<OutboundFrame>>,
        bound: Duration,
    ) -> bool {
        tokio::time::timeout(bound, async {
            loop {
                match events.recv().await {
                    Ok(frame) if frame.outbound_type == "model_catalog_changed" => return true,
                    Ok(_) => {}
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
                Ok(Ok(_)) => {}
                Ok(Err(error)) => panic!("event stream error: {error}"),
                Err(error) => panic!("model_catalog_changed never landed: {error}"),
            }
        }
    }

    #[tokio::test]
    async fn picker_open_returns_instantly_and_the_auth_change_refresh_lands() {
        let mut fixture = fixture(create_phase_answers()).await;
        write_auth_json(&fixture.agent_dir, "sk-account-b", "team-b");
        let (release, held) = gate();
        fixture.server.push_provider(held);
        fixture
            .server
            .push_pi(Answer::Raw(ok_json(&pi_snapshot_payload(
                "live/team-b-marker",
                &["internal/team-b-private"],
            ))));
        let requests_before = fixture.server.request_count();

        let started = Instant::now();
        let served = get_model_catalog(&fixture.worker, "catalog-session", true).await;
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "picker waited on fetch"
        );
        assert!(has_model(&served, "probe-v1"));
        assert!(!has_model(&served, "live/team-a-marker"));
        assert!(!has_model(&served, "internal/team-a-private"));
        let _ = release.send(ok_json(&catalog_aggregate(&["probe-v1", "probe-v2"])));
        await_catalog_changed(&mut fixture.events).await;
        let fresh = get_model_catalog(&fixture.worker, "catalog-session", false).await;
        assert!(has_model(&fresh, "probe-v2"));
        assert!(has_model(&fresh, "live/team-b-marker"));
        assert!(has_model(&fresh, "internal/team-b-private"));
        assert!(!has_model(&fresh, "internal/team-a-private"));
        assert_canonical_models_order(&fresh);
        let heads = fixture.server.recorded_requests();
        assert_eq!(heads.len() - requests_before, 2);
        let team = std::env::var("PRIME_TEAM_ID")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "team-b".into());
        assert!(heads[requests_before..].iter().any(|head| {
            head.contains("Bearer sk-account-b")
                && head.to_ascii_lowercase().contains(&format!(
                    "x-prime-team-id: {}",
                    team.trim().to_ascii_lowercase()
                ))
        }));
    }

    #[tokio::test]
    async fn concurrent_opens_coalesce_into_one_refresh() {
        let fixture = fixture(create_phase_answers()).await;
        let (release_provider, held_provider) = gate();
        let (release_pi, held_pi) = gate();
        fixture.server.push_provider(held_provider);
        fixture.server.push_pi(held_pi);
        let before = fixture.server.request_count();
        let (first, second, third) = tokio::join!(
            get_model_catalog(&fixture.worker, "catalog-session", true),
            get_model_catalog(&fixture.worker, "catalog-session", true),
            get_model_catalog(&fixture.worker, "catalog-session", true),
        );
        assert_eq!(first, second);
        assert_eq!(second, third);
        let deadline = Instant::now() + Duration::from_secs(10);
        while fixture.server.request_count() < before + 2 {
            assert!(
                Instant::now() < deadline,
                "both remote fetches did not start"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(fixture.server.request_count() - before, 2);
        let _ = release_provider.send(ok_json(&catalog_aggregate(&["probe-v1"])));
        let _ = release_pi.send(ok_json(&pi_snapshot_payload(
            "live/team-a-marker",
            &["internal/team-a-private"],
        )));
        await_refresh_settled(&fixture.worker).await;
        let settled = get_model_catalog(&fixture.worker, "catalog-session", false).await;
        assert_eq!(settled, first, "the responses were warm snapshots");
        assert_eq!(fixture.server.request_count() - before, 2);
    }

    #[tokio::test]
    async fn omitted_refresh_preserves_existing_client_fetch_behavior() {
        let fixture = fixture(create_phase_answers()).await;
        fixture
            .server
            .push_provider(Answer::Raw(ok_json(&catalog_aggregate(&[
                "probe-v1",
                "legacy-client-refresh",
            ]))));
        fixture
            .server
            .push_pi(Answer::Raw(ok_json(&pi_snapshot_payload(
                "live/team-a-marker",
                &["internal/team-a-private"],
            ))));
        let response = fixture
            .worker
            .dispatch(
                "get_model_catalog",
                &json!({"activeSessionId": "catalog-session"}),
            )
            .await;
        assert!(response.success);
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let snapshot = get_model_catalog(&fixture.worker, "catalog-session", false).await;
            if has_model(&snapshot, "legacy-client-refresh") {
                break;
            }
            assert!(Instant::now() < deadline, "omitted refresh never fetched");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    #[tokio::test]
    async fn same_key_team_entitlement_revoke_lands_on_next_picker_open() {
        let mut fixture = fixture(create_phase_answers()).await;
        fixture
            .server
            .push_provider(Answer::Raw(ok_json(&catalog_aggregate(&["probe-v1"]))));
        fixture
            .server
            .push_pi(Answer::Raw(ok_json(r#"{"data": []}"#)));
        let before = get_model_catalog(&fixture.worker, "catalog-session", true).await;
        assert!(has_model(&before, "internal/team-a-private"));
        await_catalog_changed(&mut fixture.events).await;
        let revoked = get_model_catalog(&fixture.worker, "catalog-session", false).await;
        assert!(!has_model(&revoked, "internal/team-a-private"));
        assert!(!has_model(&revoked, "live/team-a-marker"));
        assert!(has_model(&revoked, "probe-v1"));
    }

    #[tokio::test]
    async fn auth_change_during_inflight_refresh_rearms_for_the_new_account() {
        let fixture = fixture(create_phase_answers()).await;
        let (release_a, held_a) = gate();
        fixture
            .server
            .push_provider(Answer::Raw(ok_json(&catalog_aggregate(&["probe-v1"]))));
        fixture.server.push_pi(held_a);
        let before = fixture.server.request_count();
        let first = get_model_catalog(&fixture.worker, "catalog-session", true).await;
        assert!(has_model(&first, "internal/team-a-private"));
        let deadline = Instant::now() + Duration::from_secs(10);
        while fixture.server.request_count() < before + 2 {
            assert!(Instant::now() < deadline, "account A refresh never started");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        write_auth_json(&fixture.agent_dir, "sk-account-b", "team-b");
        fixture
            .server
            .push_provider(Answer::Raw(ok_json(&catalog_aggregate(&["probe-v1"]))));
        fixture
            .server
            .push_pi(Answer::Raw(ok_json(&pi_snapshot_payload(
                "live/team-b-marker",
                &["internal/team-b-private"],
            ))));
        let switched = get_model_catalog(&fixture.worker, "catalog-session", false).await;
        assert!(!has_model(&switched, "internal/team-a-private"));
        let _ = release_a.send(ok_json(&pi_snapshot_payload(
            "live/team-a-marker",
            &["internal/team-a-private"],
        )));
        let deadline = Instant::now() + Duration::from_secs(10);
        while fixture.server.request_count() < before + 4 {
            assert!(
                Instant::now() < deadline,
                "queued account B refresh never started"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        await_refresh_settled(&fixture.worker).await;
        let fresh = get_model_catalog(&fixture.worker, "catalog-session", false).await;
        assert!(has_model(&fresh, "internal/team-b-private"));
        assert!(!has_model(&fresh, "internal/team-a-private"));
    }

    #[tokio::test]
    async fn every_explicit_open_refetches_both_catalogs_but_event_reads_do_not() {
        let mut fixture = fixture(create_phase_answers()).await;
        let before = fixture.server.request_count();
        for iteration in 0..2 {
            let provider_marker = format!("probe-new-{iteration}");
            let pi_marker = format!("live/new-{iteration}");
            fixture
                .server
                .push_provider(Answer::Raw(ok_json(&catalog_aggregate(&[
                    "probe-v1",
                    &provider_marker,
                ]))));
            fixture
                .server
                .push_pi(Answer::Raw(ok_json(&pi_snapshot_payload(
                    &pi_marker,
                    &["internal/team-a-private"],
                ))));
            let served = get_model_catalog(&fixture.worker, "catalog-session", true).await;
            assert!(has_model(&served, "internal/team-a-private"));
            await_catalog_changed(&mut fixture.events).await;
            let fresh = get_model_catalog(&fixture.worker, "catalog-session", false).await;
            assert!(has_model(&fresh, &provider_marker));
            assert!(has_model(&fresh, &pi_marker));
            assert_eq!(fixture.server.request_count() - before, 2 * (iteration + 1));
        }
        let read_before = fixture.server.request_count();
        let _ = get_model_catalog(&fixture.worker, "catalog-session", false).await;
        assert_eq!(fixture.server.request_count(), read_before);
    }

    /// Live private route reasoning controls survive a scoped cache write
    /// and fresh registry read (child sessions see the same model shape).
    #[tokio::test]
    async fn a_private_route_with_declared_reasoning_serves_addressable_levels() {
        let answers = (
            vec![Answer::Raw(ok_json(&catalog_aggregate(&["probe-v1"])))],
            vec![Answer::Raw(ok_json(&reasoning_private_payload(
                "live/team-a-marker",
                "internal/team-a-private",
            )))],
        );
        let fixture = fixture(answers).await;
        let served = get_model_catalog(&fixture.worker, "catalog-session", false).await;
        assert_canonical_models_order(&served);
        let model = served["models"]
            .as_array()
            .expect("models array")
            .iter()
            .find(|model| model["id"] == "internal/team-a-private")
            .expect("the authorized private route");
        assert_eq!(model["compat"]["supportsReasoningEffort"], true);
        assert_eq!(model["thinkingLevelMap"]["high"], "high");
        assert_eq!(model["thinkingLevelMap"]["low"], "low");
        assert_eq!(model["thinkingLevelMap"]["max"], "max");
        assert_eq!(model["thinkingLevelMap"]["off"], "none");
    }

    #[tokio::test]
    async fn malformed_authenticated_payload_preserves_private_entitlement() {
        let mut fixture = fixture(create_phase_answers()).await;
        let (release, held) = gate();
        fixture
            .server
            .push_provider(Answer::Raw(ok_json(&catalog_aggregate(&["probe-v1"]))));
        fixture.server.push_pi(held);
        let before = fixture.server.request_count();
        let served = get_model_catalog(&fixture.worker, "catalog-session", true).await;
        assert!(has_model(&served, "internal/team-a-private"));
        let deadline = Instant::now() + Duration::from_secs(10);
        while fixture.server.request_count() < before + 2 {
            assert!(Instant::now() < deadline, "PI fetch did not start");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let _ = release.send(ok_json(r#"{"data": {"not": "an array"}}"#));
        await_refresh_settled(&fixture.worker).await;
        assert!(!catalog_changed_within(&mut fixture.events, Duration::from_millis(50)).await);
        let after = get_model_catalog(&fixture.worker, "catalog-session", false).await;
        assert!(has_model(&after, "internal/team-a-private"));
    }

    #[tokio::test]
    async fn refresh_failure_keeps_the_last_good_catalog_and_stays_silent() {
        let mut fixture = fixture(create_phase_answers()).await;
        write_auth_json(&fixture.agent_dir, "sk-account-c", "team-c");
        fixture
            .server
            .push_pi(Answer::Raw(status(500, "Catalog Down")));
        fixture
            .server
            .push_provider(Answer::Raw(status(500, "Catalog Down")));
        let served = get_model_catalog(&fixture.worker, "catalog-session", true).await;
        assert!(has_model(&served, "probe-v1"));
        assert!(!has_model(&served, "live/team-a-marker"));
        assert!(!has_model(&served, "internal/team-a-private"));
        let deadline = Instant::now() + Duration::from_secs(10);
        while fixture.server.request_count() < 4 {
            assert!(Instant::now() < deadline, "failed fetches never started");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        await_refresh_settled(&fixture.worker).await;
        assert!(!catalog_changed_within(&mut fixture.events, Duration::from_millis(50)).await);
        let after = get_model_catalog(&fixture.worker, "catalog-session", false).await;
        assert!(has_model(&after, "probe-v1"));
        assert!(!has_model(&after, "internal/team-a-private"));
    }
}
