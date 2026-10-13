//! The quota-park machinery: the park policies, the resume-job lifecycle,
//! the wake recovery, and the durable park/resume entries.
use super::{
    AgentSessionEngine, QuotaParkState, QUOTA_WAKE_MAX_RETRIES, QUOTA_WAKE_RETRY_DELAY_MS,
};

impl AgentSessionEngine {
    /// The quota-park policy from settings (`retry.provider.waitForUsage`).
    pub(in crate::agent_engine) fn park_policy(
        &self,
    ) -> pa_core::session_engine::provider_park::ProviderParkPolicy {
        pa_core::settings::SettingsManager::create(self.cwd(), &self.config.agent_dir)
            .get_provider_park_policy()
    }

    /// True while the session is parked waiting out a provider-reported usage reset.
    pub fn is_quota_parked(&self) -> bool {
        self.quota_park
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .is_some()
    }

    /// Create the durable one-shot wake that resumes a parked session: a
    /// `quota-resume` cron job whose prompt is the resume marker. `None` when
    /// no wake can be armed.
    pub(in crate::agent_engine) async fn create_quota_resume_job(
        &self,
        resume_at_ms: u64,
    ) -> Option<String> {
        let wiring = self.cron_wiring()?;
        let binding = self.kernel_cron_binding()?;
        let schedule_text = format!(
            "at {}",
            pa_core::session::manager::format_iso(resume_at_ms as i64)
        );
        let job = wiring
            .store
            .create(&pa_core::cron::store::CreateAgentCronJobInput {
                active_session_id: binding.active_session_id.clone(),
                session_id: binding.session_id.clone(),
                session_file: binding.session_file.clone(),
                cwd: binding.cwd.clone(),
                source: Some("quota_resume".to_string()),
                label: Some(
                    pa_core::session_engine::provider_park::QUOTA_RESUME_CRON_LABEL.to_string(),
                ),
                prompt: pa_core::session_engine::provider_park::QUOTA_RESUME_MARKER_TEXT
                    .to_string(),
                schedule_text,
                now: Some(crate::util::now_ms()),
                ..Default::default()
            })
            .ok()?;
        // Re-arm the scheduler so the armed job gets a live timer
        // (`drop_queued: false` keeps the queued-fire withdrawal a no-op).
        if let Some(hook) = &wiring.mutation_hook {
            let mutation = pa_core::session_engine::host_requests::RlmHeartbeatMutation {
                job: job.clone(),
                drop_queued: false,
            };
            hook(mutation).await;
        }
        Some(job.id)
    }

    /// Cancel a park's pending wake job; a completed (fired) job stays.
    pub(super) fn cancel_quota_resume_job(&self, job_id: &str) {
        let Some(wiring) = self.cron_wiring() else {
            return;
        };
        let matches_job = wiring
            .store
            .list()
            .iter()
            .any(|job| job.id == job_id && job.status == pa_core::cron::JobStatus::Active);
        if matches_job {
            if let Err(error) = wiring.store.cancel(job_id, crate::util::now_ms()) {
                eprintln!("failed to cancel quota resume job: {error}");
            }
        }
    }

    /// The park callback the retry chain consults at its give-up: a quota
    /// failure with a reported reset parks the session until the reset.
    /// Returns the parked status for the chain's `final_error`, or `None` to
    /// keep the give-up.
    pub(in crate::agent_engine) async fn park_for_quota_reset(
        &self,
        message: &pa_agent::types::AssistantMessage,
        abort: &str,
    ) -> Option<pa_core::session_engine::provider_park::ProviderParkOutcome> {
        use pa_core::session_engine::provider_park::{
            is_quota_block_failure, provider_park_decision, quota_failure_reset_ms,
            quota_parked_final_error, NoParkReason, ProviderParkDecision, ProviderParkOutcome,
        };
        let error = message
            .error_message
            .as_deref()
            .unwrap_or("unknown error")
            .to_string();
        // Only a quota failure can park; a non-quota give-up keeps the immediate abort.
        if !is_quota_block_failure(message) {
            return None;
        }
        let reset_ms = quota_failure_reset_ms(message);
        let policy = self.park_policy();
        let existing = self
            .quota_park
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        let now_ms = crate::util::now_ms();
        if let Some(park) = &existing {
            let wake_armed = park
                .job_id
                .as_deref()
                .is_some_and(|job_id| self.quota_wake_job_active(job_id));
            if park.resume_at_ms > now_ms {
                // A live park whose wake is still armed owns the resume; a vanished
                // wake (a `/cron` cancel) is rebuilt.
                let (resume_at_ms, job_id) = if wake_armed {
                    (park.resume_at_ms, park.job_id.clone())
                } else {
                    let rebuilt = self.create_quota_resume_job(park.resume_at_ms).await?;
                    (park.resume_at_ms, Some(rebuilt))
                };
                if park.job_id != job_id {
                    // A vanished wake is rebuilt without consuming a park.
                    *self
                        .quota_park
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner) =
                        Some(QuotaParkState {
                            park_count: park.park_count,
                            resume_at_ms,
                            job_id: job_id.clone(),
                            wake_retries: park.wake_retries,
                        });
                    // A failed replacement write surfaces as a log (the
                    // restart's stale-park arms own the recovery).
                    if let Err(write_error) = self
                        .append_quota_park_entry(
                            self.installed_persistence().await,
                            resume_at_ms,
                            park.park_count,
                            job_id.as_deref(),
                            Some(message.provider.as_str()),
                        )
                        .await
                    {
                        eprintln!(
                            "pa-daemon: quota park wake-rebuild entry write failed: {write_error}"
                        );
                    }
                }
                let resume_at_iso = pa_core::session::manager::format_iso(resume_at_ms as i64);
                return Some(ProviderParkOutcome {
                    status_message: format!(
                        "Session is parked until {resume_at_iso} waiting for the provider usage reset; this turn ended without a retry: {error}",
                    ),
                });
            }
            // The wake already fired: the decision below re-parks at the newly
            // reported reset, or — with no reset — re-arms a short bounded probe.
        }
        // The park decision (pure): disabled/budget-spent decline; a reset
        // parks until it, capped at the policy bound.
        let parks_used = existing.as_ref().map_or(0, |park| park.park_count);
        let resume_after_ms = match provider_park_decision(parks_used, reset_ms, &policy) {
            ProviderParkDecision::Park { resume_after_ms } => resume_after_ms,
            ProviderParkDecision::None {
                reason: NoParkReason::NoReset,
            } => {
                let park = existing.filter(|park| park.resume_at_ms <= now_ms)?;
                // The wake fired but its probe could not re-park: re-arm one short
                // bounded probe.
                return self.recover_quota_park_wake(park, &error).await;
            }
            ProviderParkDecision::None {
                reason: NoParkReason::Disabled | NoParkReason::ParkBudget,
            } => {
                let park = existing.filter(|park| park.resume_at_ms <= now_ms)?;
                // A stale park whose episode ended here: its wake already fired.
                if let Some(job_id) = &park.job_id {
                    self.cancel_quota_resume_job(job_id);
                }
                *self
                    .quota_park
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
                return None;
            }
        };
        let resume_at_ms = now_ms.saturating_add(resume_after_ms);
        // TS always cancels the existing wake before arming the
        // replacement, so a lagging job can never race the replacement
        // into a second marker turn.
        if let Some(job_id) = existing.as_ref().and_then(|park| park.job_id.as_deref()) {
            self.cancel_quota_resume_job(job_id);
        }
        // Arm the durable wake first: a failed job creation declines the park.
        let job_id = self.create_quota_resume_job(resume_at_ms).await?;
        let park_count = parks_used + 1;
        // The durable park record gates the park exactly like the wake: a
        // failed write cancels the wake and declines the park.
        if let Err(write_error) = self
            .append_quota_park_entry(
                self.installed_persistence().await,
                resume_at_ms,
                park_count,
                Some(job_id.as_str()),
                Some(message.provider.as_str()),
            )
            .await
        {
            self.cancel_quota_resume_job(&job_id);
            eprintln!(
                "pa-daemon: quota park entry write failed, the park is declined: {write_error}"
            );
            return None;
        }
        let state = QuotaParkState {
            park_count,
            resume_at_ms,
            job_id: Some(job_id.clone()),
            wake_retries: existing.as_ref().map_or(0, |park| park.wake_retries),
        };
        *self
            .quota_park
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(state);
        Some(ProviderParkOutcome {
            status_message: quota_parked_final_error(abort, resume_at_ms, &error),
        })
    }

    /// Wake re-arm for a park whose wake was consumed without resuming and
    /// whose failure reported no reset: one short bounded retry; a park that
    /// can never wake is dropped.
    async fn recover_quota_park_wake(
        &self,
        park: QuotaParkState,
        error: &str,
    ) -> Option<pa_core::session_engine::provider_park::ProviderParkOutcome> {
        let retries = park.wake_retries + 1;
        if retries > QUOTA_WAKE_MAX_RETRIES {
            if let Some(job_id) = &park.job_id {
                self.cancel_quota_resume_job(job_id);
            }
            self.append_quota_resume_entry("wake-error").await;
            *self
                .quota_park
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
            return None;
        }
        let resume_at_ms = crate::util::now_ms().saturating_add(QUOTA_WAKE_RETRY_DELAY_MS);
        let job_id = self.create_quota_resume_job(resume_at_ms).await?;
        // The re-armed wake needs a replacement entry (it carries no provider
        // field): a failed write cancels the re-armed wake and drops the park.
        if let Err(write_error) = self
            .append_quota_park_entry(
                self.installed_persistence().await,
                resume_at_ms,
                park.park_count,
                Some(job_id.as_str()),
                None,
            )
            .await
        {
            self.cancel_quota_resume_job(&job_id);
            eprintln!(
                "pa-daemon: quota park entry write failed, the re-armed wake is dropped: {write_error}"
            );
            // The spent park cannot stay live without a wake.
            *self
                .quota_park
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
            return None;
        }
        let state = QuotaParkState {
            park_count: park.park_count,
            resume_at_ms,
            job_id: Some(job_id.clone()),
            wake_retries: retries,
        };
        *self
            .quota_park
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(state);
        let resume_at_iso = pa_core::session::manager::format_iso(resume_at_ms as i64);
        Some(pa_core::session_engine::provider_park::ProviderParkOutcome {
            status_message: format!(
                "Session is parked until {resume_at_iso} waiting for the provider usage reset; this turn ended without a retry: {error}"
            ),
        })
    }

    /// Record a park's resume (or drop) transition.
    pub(super) async fn append_quota_resume_entry(&self, outcome: &str) {
        let persistence = self
            .session
            .lock()
            .await
            .as_ref()
            .map(|engine| engine.session.shared_persistence());
        let Some(persistence) = persistence else {
            return;
        };
        let mut session = persistence.lock().await;
        // The resume path's live clear still stands (the quota IS back),
        // so a failed write surfaces as a log; the restart's arms own
        // the recovery.
        if let Err(write_error) = session.append_custom_entry(
            pa_core::session_engine::provider_park::PROVIDER_QUOTA_RESUME_ENTRY,
            Some(serde_json::json!({ "outcome": outcome })),
        ) {
            eprintln!(
                "pa-daemon: quota resume entry write failed (outcome {outcome}): {write_error}"
            );
        }
    }

    pub(in crate::agent_engine) fn quota_wake_job_active(&self, job_id: &str) -> bool {
        let Some(wiring) = self.cron_wiring() else {
            return false;
        };
        wiring
            .store
            .list()
            .iter()
            .any(|job| job.id == job_id && job.status == pa_core::cron::JobStatus::Active)
    }

    /// Record the parked transition in the session log, so a restart
    /// restores the park count and the wake. The persistence handle is a
    /// parameter: the callback writes through the installed session, the
    /// build-time restore through the built one.
    pub(in crate::agent_engine) async fn append_quota_park_entry(
        &self,
        persistence: Option<
            std::sync::Arc<tokio::sync::Mutex<pa_core::session::manager::SessionManager>>,
        >,
        resume_at_ms: u64,
        park_count: u32,
        job_id: Option<&str>,
        provider: Option<&str>,
    ) -> std::io::Result<()> {
        let data = serde_json::json!({
            "resumeAt": pa_core::session::manager::format_iso(resume_at_ms as i64),
            "parkCount": park_count,
            "jobId": job_id,
            "provider": provider,
        });
        let Some(persistence) = persistence else {
            return Ok(());
        };
        let mut session = persistence.lock().await;
        session
            .append_custom_entry(
                pa_core::session_engine::provider_park::PROVIDER_QUOTA_PARK_ENTRY,
                Some(data),
            )
            .map(|_| ())
    }

    async fn installed_persistence(
        &self,
    ) -> Option<std::sync::Arc<tokio::sync::Mutex<pa_core::session::manager::SessionManager>>> {
        self.session
            .lock()
            .await
            .as_ref()
            .map(|engine| engine.session.shared_persistence())
    }

    /// A parked session completed a model call: the quota is back. Clear
    /// the park, record the resume, and — unless this success WAS the wake
    /// probe — queue the marker.
    pub(in crate::agent_engine) async fn resume_quota_park(&self, wake_probe: bool) {
        let park = self
            .quota_park
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        let Some(park) = park else {
            return;
        };
        if let Some(job_id) = &park.job_id {
            self.cancel_quota_resume_job(job_id);
        }
        let outcome = if wake_probe { "wake" } else { "early" };
        self.append_quota_resume_entry(outcome).await;
        if wake_probe {
            return;
        }
        // Early resume: the interrupted task continues now (this port
        // admits the marker through the goal-admission lane).
        if let Some(sink) = self
            .goal_admission_sink
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
        {
            sink(crate::engine::GoalTurnEndWork::Continuation(
                crate::engine::GoalContinuation {
                    request: crate::engine::PromptRequest {
                        message: pa_core::session_engine::provider_park::QUOTA_RESUME_MARKER_TEXT
                            .to_string(),
                        images: Vec::new(),
                        source: "user".to_string(),
                        agent_message_id: None,
                        custom_message: None,
                        batch: Vec::new(),
                    },
                    // A synthetic admission, not a minted continuation: no pending guard.
                    goal_update: None,
                    pending_handle: None,
                },
            ));
        }
    }
}
