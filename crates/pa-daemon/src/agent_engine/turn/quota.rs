//! The quota-park machinery (moved with its concern): the park
//! policies, the resume-job lifecycle, the wake recovery, and the
//! durable park/resume entries.
use super::{
    AgentSessionEngine, QuotaParkState, QUOTA_WAKE_MAX_RETRIES, QUOTA_WAKE_RETRY_DELAY_MS,
};

impl AgentSessionEngine {
    /// The quota-park policy from settings
    /// (`retry.provider.waitForUsage`; TS #2375).
    pub(in crate::agent_engine) fn park_policy(
        &self,
    ) -> pa_core::session_engine::provider_park::ProviderParkPolicy {
        pa_core::settings::SettingsManager::create(self.cwd(), &self.config.agent_dir)
            .get_provider_park_policy()
    }

    /// True while the session is parked waiting out a provider-reported
    /// usage reset (TS `session.isQuotaParked`).
    pub fn is_quota_parked(&self) -> bool {
        self.quota_park
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .is_some()
    }

    /// Create the durable one-shot wake that resumes a parked session: a
    /// `quota-resume` cron job in the session's own artifacts whose
    /// prompt is the resume marker (TS `_createQuotaResumeJob`). The
    /// scheduler fires it into the session's follow-up lane, so the wake
    /// survives worker restarts and passivated sessions. Best effort:
    /// `None` when no wake can be armed (outside a daemon worker there is
    /// no scheduler — the park then declines and the give-up stands).
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
        // Re-arm the scheduler so the armed job gets a live timer (the
        // same post-mutation seam the kernel heartbeat controllers use;
        // `drop_queued: false` keeps the queued-fire withdrawal a no-op).
        if let Some(hook) = &wiring.mutation_hook {
            let mutation = pa_core::session_engine::host_requests::RlmHeartbeatMutation {
                job: job.clone(),
                drop_queued: false,
            };
            hook(mutation).await;
        }
        Some(job.id)
    }

    /// Cancel a park's pending wake job (TS `_resolveQuotaResumeJob`'s
    /// cancel arm): a completed (fired) job stays — rewriting it would
    /// hide that the wake landed.
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
            let _ = wiring.store.cancel(job_id, crate::util::now_ms());
        }
    }

    /// The park callback the retry chain consults at its give-up (the
    /// quota-park seam, TS #2375): a quota-classified failure with a
    /// provider-reported reset beyond the quick-retry wait cap parks the
    /// session until the reset and auto-resumes there. Returns the
    /// parked status for the chain's `final_error`, or `None` to keep
    /// the give-up (not quota-classified, no reset, park disabled,
    /// park budget spent, or no wake can be armed).
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
        // Only a quota failure can park; a non-quota give-up keeps the
        // immediate abort (TS parks only from the wait path's `usage`
        // arm).
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
                // A live park whose wake is still armed owns the resume:
                // this turn ends without consuming a park or rescheduling
                // (TS `_parkForQuotaReset`'s already-parked arm). A
                // vanished wake (a user cancel in `/cron`) is rebuilt so
                // the park still wakes.
                let (resume_at_ms, job_id) = if wake_armed {
                    (park.resume_at_ms, park.job_id.clone())
                } else {
                    let rebuilt = self.create_quota_resume_job(park.resume_at_ms).await?;
                    (park.resume_at_ms, Some(rebuilt))
                };
                if park.job_id != job_id {
                    // A vanished wake is rebuilt without consuming a park
                    // (TS `_restoreQuotaWakeJob`'s rebuild arm — the
                    // replacement entry records the new job so the next
                    // restore reuses it).
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
                    // A failed replacement write surfaces as a log:
                    // the rebuilt wake exists, so the restart's stale-park
                    // arms still own the recovery.
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
            // The wake already fired (its probe failed or never settled):
            // the decision below re-parks at the newly reported reset, or
            // — with no reset — re-arms a short bounded probe (TS
            // `_recoverQuotaParkWake`); a spent budget or a disabled park
            // ends the episode's stale park exactly like the TS abort
            // arm (the give-up it replaced stands).
        }
        // The park decision (pure): disabled / budget spent decline, a
        // reset parks until it (plus grace), capped at the policy bound.
        let parks_used = existing.as_ref().map_or(0, |park| park.park_count);
        let resume_after_ms = match provider_park_decision(parks_used, reset_ms, &policy) {
            ProviderParkDecision::Park { resume_after_ms } => resume_after_ms,
            ProviderParkDecision::None {
                reason: NoParkReason::NoReset,
            } => {
                let park = existing.filter(|park| park.resume_at_ms <= now_ms)?;
                // The wake fired but its probe could not re-park (no
                // reported reset): re-arm one short probe, bounded so a
                // park that can never wake ends instead of parking
                // forever (TS `_recoverQuotaParkWake`).
                return self.recover_quota_park_wake(park, &error).await;
            }
            ProviderParkDecision::None {
                reason: NoParkReason::Disabled | NoParkReason::ParkBudget,
            } => {
                let park = existing.filter(|park| park.resume_at_ms <= now_ms)?;
                // A stale park whose episode ended here: its wake
                // already fired, so nothing else would resume it (TS
                // abort arm's stale-park clear).
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
        // replacement (`_cancelQuotaParkWake(existing)` runs for a stale
        // park AND for one whose scheduled job has not fired yet), so an
        // expired park's lagging job can never race the replacement into
        // a second marker turn.
        if let Some(job_id) = existing.as_ref().and_then(|park| park.job_id.as_deref()) {
            self.cancel_quota_resume_job(job_id);
        }
        // Arm the durable wake first: without a wake the park would be a
        // silent death, so a failed job creation declines the park.
        let job_id = self.create_quota_resume_job(resume_at_ms).await?;
        let park_count = parks_used + 1;
        // The durable park record gates the park exactly like the wake:
        // TS's appendCustomEntry throws on a failed persist (the append
        // rolls back and the park path never reports success), so a
        // failed session-file write cancels the wake and declines the
        // park — the give-up stands instead of a live park a restart
        // would silently lose.
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

    /// Wake re-arm for a park whose wake was consumed without resuming
    /// and whose failure reported no reset (TS `_recoverQuotaParkWake`):
    /// one short retry at `QUOTA_WAKE_RETRY_DELAY_MS`, bounded by
    /// [`QUOTA_WAKE_MAX_RETRIES`]; a park that can never wake is dropped
    /// (its resume entry records the drop) and the give-up stands.
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
        // The re-armed wake needs a replacement entry (TS
        // `_recoverQuotaParkWake` appends one so a restart reads the
        // replacement wake instead of the spent one; it carries no
        // provider field, like the TS). TS's appendCustomEntry throws on
        // a failed persist, so a failed write cancels the re-armed wake
        // and drops the park — the give-up stands.
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
            // The spent park cannot stay live without a wake (nothing
            // would ever resume it): the episode ends here and the
            // give-up stands.
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

    /// Record a park's resume (or drop) transition (TS
    /// `QUOTA_RESUME_CUSTOM_ENTRY_TYPE`'s outcome field).
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
        // TS's appendCustomEntry throws on a failed persist; the resume
        // path's live clear still stands (the quota IS back — keeping the
        // park armed after a successful model call would be wrong), so
        // the failure surfaces as a log and the restart's stale-park arms
        // own the recovery (the spent park entry cannot restore a live
        // park without a wake).
        if let Err(write_error) = session.append_custom_entry(
            pa_core::session_engine::provider_park::PROVIDER_QUOTA_RESUME_ENTRY,
            Some(serde_json::json!({ "outcome": outcome })),
        ) {
            eprintln!(
                "pa-daemon: quota resume entry write failed (outcome {outcome}): {write_error}"
            );
        }
    }

    /// Whether the park's wake job is still scheduled (Active) in the
    /// session's artifacts.
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

    /// Record the parked transition in the session log (TS
    /// `QUOTA_PARK_CUSTOM_ENTRY_TYPE`), so a restart restores the park
    /// count and the wake. Async (the park callback runs inside the
    /// retry chain's `block_on`, where a nested `block_on` would panic).
    /// The persistence handle is a parameter: the park callback writes
    /// through the installed session, the build-time restore through the
    /// built one (the installed slot is still empty while it runs).
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

    /// The installed session's persistence handle (the park callback's
    /// write path).
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
    /// the park (cancelling any pending wake), record the resumed
    /// transition, and — unless this success WAS the wake probe — queue
    /// the resume marker so the interrupted task continues right away
    /// (TS `_completeQuotaParkResume`).
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
        // Early resume: the quota returned before the wake, so the
        // interrupted task continues now (TS queues the marker through
        // `_queuePreparedPrompt`; this port admits it through the
        // worker's goal-admission lane, the existing follow-up
        // admission seam).
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
                    // The quota-resume marker is a synthetic admission, not
                    // a minted continuation: no pending guard exists.
                    goal_update: None,
                    pending_handle: None,
                },
            ));
        }
    }
}
