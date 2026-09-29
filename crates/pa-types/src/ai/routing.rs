//! The provider routing family: the `OpenRouter` routing preferences with
//! their sort/max-price/threshold types, and the Vercel gateway routing.
use super::{Deserialize, JsNumber, Serialize};

/// `OpenRouter` provider routing preferences (`provider` request field).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenRouterRouting {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allow_fallbacks: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub require_parameters: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_collection: Option<DataCollection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub zdr: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enforce_distillable_text: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub only: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ignore: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quantizations: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sort: Option<OpenRouterSort>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_price: Option<OpenRouterMaxPrice>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preferred_min_throughput: Option<OpenRouterThreshold>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preferred_max_latency: Option<OpenRouterThreshold>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DataCollection {
    Deny,
    Allow,
}

/// `OpenRouter` sort strategy: a string metric or a partitioned object.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum OpenRouterSort {
    Metric(String),
    Detailed {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        by: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        partition: Option<String>,
    },
}

/// `OpenRouter` price cap, with string-or-number fields as in the upstream API.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenRouterMaxPrice {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<NumOrString>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completion: Option<NumOrString>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<NumOrString>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audio: Option<NumOrString>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request: Option<NumOrString>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum NumOrString {
    Num(JsNumber),
    Str(String),
}

/// `OpenRouter` percentile threshold: a scalar or a percentile map.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum OpenRouterThreshold {
    Scalar(JsNumber),
    Percentiles {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        p50: Option<JsNumber>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        p75: Option<JsNumber>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        p90: Option<JsNumber>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        p99: Option<JsNumber>,
    },
}

/// Vercel AI Gateway routing preferences.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VercelGatewayRouting {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub only: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order: Option<Vec<String>>,
}
