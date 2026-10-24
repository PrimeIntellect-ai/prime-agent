//! The daemon worker's kernel-notice seams (bash completions and factory
//! progress): the notice types, the validation, and the handler
//! registration live in pa-core (`session_engine::bash_notices`); the
//! worker keeps its queue-lane sinks here.

use pa_core::kernel::shared::HostRequestHandlers;

use crate::agent_engine::AgentSessionEngine;

impl AgentSessionEngine {
    /// Wire the worker's kernel-notice queue seams (called once at
    /// construction, before the first session build reads them).
    ///
    /// # Panics
    ///
    /// Panics when a sink mutex is poisoned (a holder panicked while
    /// holding the notice or consumed-sink lock).
    pub fn set_kernel_notice_sinks(
        &self,
        notice: crate::engine::KernelNoticeSink,
        consumed: crate::engine::BashConsumedSink,
    ) {
        *self
            .kernel_notice_sink
            .lock()
            .expect("kernel notice sink lock") = Some(notice);
        *self
            .bash_consumed_sink
            .lock()
            .expect("bash consumed sink lock") = Some(consumed);
    }

    /// The `bash.completed`/`bash.consumed`/`factory.progress` kernel host
    /// handlers. Registered only when both seams are wired — no worker queue
    /// leaves the requests honestly unavailable.
    pub(crate) fn register_kernel_notice_host_handlers(&self, handlers: &mut HostRequestHandlers) {
        let Some(notice) = self
            .kernel_notice_sink
            .lock()
            .expect("kernel notice sink lock")
            .clone()
        else {
            return;
        };
        let Some(consumed) = self
            .bash_consumed_sink
            .lock()
            .expect("bash consumed sink lock")
            .clone()
        else {
            return;
        };
        pa_core::session_engine::bash_notices::register_kernel_notice_host_handlers(
            notice, consumed, handlers,
        );
    }
}

/// Map one promoted inline bash job's completion onto the kernel notice
/// lane's shape (`[bash-done pid:N exit:M]`): the same
/// `KernelNotice::bash_completion` the `bash.completed` host handler
/// validates and admits. The promoted job's spill path rides along: the
/// model cannot re-read the process (it lived in the dispatch task), so
/// the spill file is the only durable output and the row must name it.
/// `None` when the promoted job has no pid (the operations backend did
/// not report one — such jobs never detach; see the bash tool).
pub(crate) fn auto_background_to_bash_completion(
    completion: &pa_agent::auto_background::AutoBackgroundCompletion,
) -> Option<pa_core::session_engine::bash_notices::KernelNotice> {
    let pid = completion.pid?;
    Some(
        pa_core::session_engine::bash_notices::KernelNotice::bash_completion(
            pid,
            &completion.command,
            i64::from(completion.exit_code.unwrap_or(-1)),
            completion.full_output_path.as_deref(),
            completion.status.as_deref(),
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn promoted_completions_map_onto_the_bash_done_lane() {
        let completion = pa_agent::auto_background::AutoBackgroundCompletion {
            pid: Some(4321),
            exit_code: Some(0),
            command: "sleep 61".to_string(),
            output: String::new(),
            full_output_path: Some("/tmp/spill/bash-4321.out".to_string()),
            status: None,
        };
        let notice = auto_background_to_bash_completion(&completion).expect("pid known");
        // The promoted job rides the existing bash-done shape PLUS the
        // spill pointer (the process is gone; the spill is the output).
        assert_eq!(
            notice.row.content.text().as_str(),
            "[bash-done pid:4321 exit:0]\n\nCommand: \"sleep 61\"\n\nOutput: /tmp/spill/bash-4321.out"
        );
        assert!(auto_background_to_bash_completion(
            &pa_agent::auto_background::AutoBackgroundCompletion {
                pid: None,
                exit_code: None,
                command: String::new(),
                output: String::new(),
                full_output_path: None,
                status: None,
            }
        )
        .is_none());
    }
}
