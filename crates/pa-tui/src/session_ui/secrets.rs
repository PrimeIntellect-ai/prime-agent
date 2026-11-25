//! The `/secrets` view: open it, route its keys, and run the
//! add-a-custom-secret flow on the inline auth panel (the value prompt is
//! masked). The supervisor owns the secrets; every change answers with
//! the new list.
use super::{
    key_event_to_id, picker_viewport_rows, AgentView, DaemonCommand, Duration, KeyEvent, Map,
    Overlay, Result, SessionUi, UI_REQUEST_TIMEOUT_MS,
};
use crate::auth_panel::{AuthPanelRequest, PastePromptTone, PasteStyle};
use crate::secrets_view::{NewBotSecret, SecretsView, SecretsViewAction};

/// The header answer: `Bearer` and `Basic` set `Authorization` with that
/// scheme; anything else is a header name that gets the bare value.
fn header_format(answer: &str) -> (String, Option<String>) {
    let answer = answer.trim();
    if answer.eq_ignore_ascii_case("bearer") {
        ("Authorization".to_string(), Some("Bearer".to_string()))
    } else if answer.eq_ignore_ascii_case("basic") {
        ("Authorization".to_string(), Some("Basic".to_string()))
    } else {
        (answer.to_string(), None)
    }
}

/// Ask for the four fields on the panel. `None` when a prompt is cancelled.
async fn collect(panel: &crate::auth_panel::AuthPanelHandle) -> Option<NewBotSecret> {
    let ask = |prompt: &'static str| {
        panel.paste_prompt(prompt, PastePromptTone::Text, PasteStyle::Visible)
    };
    let name = ask("Secret name (letters, digits, and _):").await?;
    let host = ask("HTTPS host (api.example.com, or *.example.com for one label):").await?;
    let (header, scheme) =
        header_format(&ask("Header: Bearer, Basic (user:password), or a header name:").await?);
    let value = panel
        .paste_prompt(
            "Value (stored on this Mac, never shown again):",
            PastePromptTone::Text,
            PasteStyle::Masked,
        )
        .await?;
    Some(NewBotSecret {
        name,
        host,
        header,
        scheme,
        value,
    })
}

impl SessionUi {
    /// `/secrets`: open the view over the supervisor's list.
    pub(crate) async fn handle_secrets_command(
        &mut self,
        resolved: &pa_types::slash_commands::ResolvedSlashCommand,
        view: &mut AgentView,
    ) -> Result<()> {
        if !resolved.args.trim().is_empty() {
            self.error_row("Usage: /secrets", view);
            return Ok(());
        }
        view.editor.set_text("");
        self.secrets_request(
            view,
            DaemonCommand::ListBotSecrets {
                id: None,
                rest: Map::default(),
            },
        )
        .await;
        self.track_menu_opened("secrets", "command");
        Ok(())
    }

    /// Send one secrets command and show its answer in the view (opening
    /// it when closed). A failure keeps the view and shows the error.
    async fn secrets_request(&mut self, view: &mut AgentView, command: DaemonCommand) {
        let request = self
            .bounded_request(Duration::from_millis(UI_REQUEST_TIMEOUT_MS), command)
            .await;
        match request {
            Ok(data) => match view.overlay.as_mut() {
                Some(Overlay::Secrets(secrets)) => secrets.apply(&data),
                _ => {
                    view.overlay = Some(Overlay::Secrets(SecretsView::from_response(
                        &data,
                        picker_viewport_rows(view.terminal_rows()),
                    )));
                }
            },
            Err(error) => self.error_row(&format!("/secrets: {error:#}"), view),
        }
        self.dirty = true;
    }

    /// One key press while the view is open.
    pub(crate) async fn handle_secrets_view_key(
        &mut self,
        key: KeyEvent,
        view: &mut AgentView,
    ) -> Result<()> {
        let Some(id) = key_event_to_id(&key) else {
            return Ok(());
        };
        let action = match view.overlay.as_mut() {
            Some(Overlay::Secrets(secrets)) => {
                Some(secrets.handle_key(&id, view.editor.keybindings()))
            }
            _ => None,
        };
        match action {
            Some(SecretsViewAction::None) | None => {}
            Some(SecretsViewAction::Cancel) => view.overlay = None,
            Some(SecretsViewAction::Toggle { name, inject }) => {
                let command = DaemonCommand::SetBotSecretInject {
                    id: None,
                    name,
                    inject,
                    rest: Map::default(),
                };
                self.secrets_request(view, command).await;
            }
            Some(SecretsViewAction::Remove { name }) => {
                let command = DaemonCommand::RemoveBotSecret {
                    id: None,
                    name,
                    rest: Map::default(),
                };
                self.secrets_request(view, command).await;
            }
            Some(SecretsViewAction::Add) => {
                // The panel owns the frame while it asks; the view comes back with the answer.
                let panel = crate::auth_panel::AuthPanelHandle::new(self.auth_panel_notes.clone());
                let mut dialog = crate::auth_panel::AuthPanel::new("Add a bot secret".to_string());
                dialog.set_cancel_signal(panel.cancel_signal());
                view.overlay = Some(Overlay::AuthPanel(dialog));
                tokio::spawn(async move {
                    let secret = collect(&panel).await;
                    panel.send(AuthPanelRequest::BotSecretSettled { secret });
                });
            }
        }
        self.dirty = true;
        Ok(())
    }

    /// The add flow settled: store the secret (a cancel just reopens the view).
    pub(crate) async fn finish_bot_secret(
        &mut self,
        secret: Option<NewBotSecret>,
        view: &mut AgentView,
    ) {
        view.close_overlay_if(|overlay| matches!(overlay, Overlay::AuthPanel(_)));
        let added = secret.as_ref().map(|secret| secret.name.clone());
        let command = match secret {
            Some(secret) => DaemonCommand::AddBotSecret {
                id: None,
                name: secret.name,
                host: secret.host,
                header: secret.header,
                scheme: secret.scheme,
                value: secret.value,
                rest: Map::default(),
            },
            None => DaemonCommand::ListBotSecrets {
                id: None,
                rest: Map::default(),
            },
        };
        self.secrets_request(view, command).await;
        if let (Some(name), Some(Overlay::Secrets(secrets))) = (added, view.overlay.as_mut()) {
            secrets.select(&name);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::header_format;

    #[test]
    fn the_header_answer_picks_the_scheme() {
        assert_eq!(
            header_format(" bearer "),
            ("Authorization".to_string(), Some("Bearer".to_string()))
        );
        assert_eq!(
            header_format("Basic"),
            ("Authorization".to_string(), Some("Basic".to_string()))
        );
        assert_eq!(header_format("X-Api-Key"), ("X-Api-Key".to_string(), None));
    }
}
