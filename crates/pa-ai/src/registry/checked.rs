//! The registry owns reasoning preflight for every public dispatch route.
//!
//! Facade calls use the fallible methods to preserve immediate errors. Public
//! `Arc<dyn Provider>` calls use the same methods and return a terminal error stream.
//! Provider serializers receive validated history and do not repeat the preflight.
use std::sync::Arc;

use super::Provider;
use crate::event_stream::{
    create_assistant_message_event_stream, initial_assistant_message, AssistantMessageEvent,
    AssistantMessageEventStream,
};
use crate::providers::reasoning_replay::validate_reasoning_replay;
use crate::types::{
    Context, ErrorStopReason, Model, SimpleStreamOptions, StopReason, StreamOptions,
};
use crate::utils_inner::ProviderError;

pub(crate) struct CheckedProvider {
    inner: Arc<dyn Provider>,
}

impl CheckedProvider {
    pub(super) fn new(inner: Arc<dyn Provider>) -> Self {
        Self { inner }
    }

    fn validate(&self, model: &Model, context: &Context) -> Result<(), ProviderError> {
        if model.api != self.inner.api() {
            return Err(ProviderError::Message(format!(
                "Registered provider API {} does not match model API {}. Choose the provider registered for this model's API.",
                self.inner.api(), model.api,
            )));
        }
        validate_reasoning_replay(model, context).map_err(ProviderError::Message)
    }

    pub(crate) fn stream_checked(
        &self,
        model: &Model,
        context: &Context,
        options: Option<&StreamOptions>,
    ) -> Result<AssistantMessageEventStream, ProviderError> {
        self.validate(model, context)?;
        Ok(self.inner.stream(model, context, options))
    }

    pub(crate) fn stream_simple_checked(
        &self,
        model: &Model,
        context: &Context,
        options: Option<&SimpleStreamOptions>,
    ) -> Result<AssistantMessageEventStream, ProviderError> {
        self.validate(model, context)?;
        Ok(self.inner.stream_simple(model, context, options))
    }
}

impl Provider for CheckedProvider {
    fn api(&self) -> &str {
        self.inner.api()
    }

    fn stream(
        &self,
        model: &Model,
        context: &Context,
        options: Option<&StreamOptions>,
    ) -> AssistantMessageEventStream {
        self.stream_checked(model, context, options)
            .unwrap_or_else(|error| rejected_stream(model, &error))
    }

    fn stream_simple(
        &self,
        model: &Model,
        context: &Context,
        options: Option<&SimpleStreamOptions>,
    ) -> AssistantMessageEventStream {
        self.stream_simple_checked(model, context, options)
            .unwrap_or_else(|error| rejected_stream(model, &error))
    }
}

fn rejected_stream(model: &Model, error: &ProviderError) -> AssistantMessageEventStream {
    let (writer, reader) = create_assistant_message_event_stream();
    let mut output = initial_assistant_message(&model.api, &model.provider, &model.id);
    output.stop_reason = StopReason::Error;
    output.error_message = Some(error.to_string());
    writer.push(AssistantMessageEvent::Error {
        reason: ErrorStopReason::Error,
        error: output.clone(),
    });
    writer.end(Some(output));
    reader
}
