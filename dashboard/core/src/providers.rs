//! The voice providers the dashboard knows, with where each one's key comes from.

use serde::Serialize;
use serde_json::Value;

/// Providers `screenpilot voices --provider <id>` accepts.
pub const VOICE_PROVIDERS: [&str; 5] = ["edge", "local", "command", "elevenlabs", "gemini"];
/// Providers that need a key, i.e. that `screenpilot secret` accepts.
pub const SECRET_PROVIDERS: [&str; 2] = ["elevenlabs", "gemini"];
/// Providers that have a base URL, i.e. that `screenpilot endpoint` accepts.
pub const ENDPOINT_PROVIDERS: [&str; 2] = ["elevenlabs", "gemini"];

/// The public host of a provider, shown by the "Default" choice. The CLI owns the real value
/// (`src/voice/endpoint.ts`); this only fills the field so Save has something to send.
pub fn default_base_url(id: &str) -> &'static str {
    match id {
        "elevenlabs" => "https://api.elevenlabs.io",
        "gemini" => "https://generativelanguage.googleapis.com",
        _ => "",
    }
}

/// One provider's entry of `screenpilot endpoint status`.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct EndpointInfo {
    /// The address in use; empty when the saved or env value is invalid (see `error`).
    pub base_url: String,
    /// Where it comes from: "env", "file" or "default".
    pub source: String,
    pub error: Option<String>,
}

/// `status` is the JSON of `screenpilot endpoint status`:
/// `{"elevenlabs": {"baseUrl": "...", "source": "env"|"file"|"default"} | {"error": "..."}, ...}`.
/// None when the provider's entry is missing or unreadable (an older CLI), so the UI hides it.
pub fn parse_endpoint_status(status: &Value, id: &str) -> Option<EndpointInfo> {
    let entry = status.get(id)?;
    if let Some(error) = entry.get("error").and_then(Value::as_str) {
        // A bad value in the environment still wins over the file, so it cannot be fixed here.
        let source = if error.contains(&format!("{}_BASE_URL", id.to_uppercase())) {
            "env"
        } else {
            "file"
        };
        return Some(EndpointInfo {
            base_url: String::new(),
            source: source.into(),
            error: Some(error.to_string()),
        });
    }
    let base_url = entry.get("baseUrl")?.as_str()?;
    let source = entry
        .get("source")
        .and_then(Value::as_str)
        .filter(|s| ["env", "file", "default"].contains(s))?;
    Some(EndpointInfo {
        base_url: base_url.to_string(),
        source: source.into(),
        error: None,
    })
}

#[derive(Serialize, Debug, PartialEq)]
pub struct ProviderInfo {
    pub id: &'static str,
    pub label: &'static str,
    pub needs_key: bool,
    /// Where the key comes from: "env", "file" or null (not set, or not needed).
    pub key: Option<String>,
    /// The base URL, for providers that have one and when the CLI could tell.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<EndpointInfo>,
}

const STATIC: [(&str, &str, bool); 5] = [
    ("edge", "Edge (free web voices)", false),
    ("local", "Local models (offline)", false),
    ("command", "Your own command", false),
    ("elevenlabs", "ElevenLabs", true),
    ("gemini", "Gemini", true),
];

/// `status` is the JSON of `screenpilot secret status`: `{"elevenlabs": "env"|"file"|null, ...}`.
/// Without it (the CLI could not run) every key shows as not set.
/// `endpoints` is the JSON of `screenpilot endpoint status`; without it no base URL shows.
pub fn merge_providers(status: Option<&Value>, endpoints: Option<&Value>) -> Vec<ProviderInfo> {
    STATIC
        .iter()
        .map(|&(id, label, needs_key)| {
            let key = status
                .and_then(|s| s.get(id))
                .and_then(Value::as_str)
                .filter(|k| *k == "env" || *k == "file")
                .map(str::to_string);
            ProviderInfo {
                id,
                label,
                needs_key,
                key: if needs_key { key } else { None },
                endpoint: endpoints
                    .filter(|_| ENDPOINT_PROVIDERS.contains(&id))
                    .and_then(|e| parse_endpoint_status(e, id)),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn merges_status_into_the_static_list() {
        let list = merge_providers(Some(&json!({"elevenlabs": "env", "gemini": null})), None);
        let ids: Vec<_> = list.iter().map(|p| p.id).collect();
        assert_eq!(
            ids,
            vec!["edge", "local", "command", "elevenlabs", "gemini"]
        );
        assert_eq!(list[3].key.as_deref(), Some("env"));
        assert_eq!(list[4].key, None);
        assert!(list[3].needs_key && list[4].needs_key && !list[0].needs_key);
    }

    #[test]
    fn unknown_values_and_missing_status_mean_not_set() {
        let list = merge_providers(Some(&json!({"elevenlabs": "weird", "edge": "env"})), None);
        assert!(list.iter().all(|p| p.key.is_none()));
        assert!(merge_providers(None, None).iter().all(|p| p.key.is_none()));
    }

    #[test]
    fn serializes_to_the_api_shape() {
        let v = serde_json::to_value(&merge_providers(Some(&json!({"gemini": "file"})), None)[4])
            .unwrap();
        assert_eq!(
            v,
            json!({"id": "gemini", "label": "Gemini", "needs_key": true, "key": "file"})
        );
    }

    #[test]
    fn parses_the_endpoint_status() {
        let status = json!({
            "elevenlabs": {"baseUrl": "https://api.eu.residency.elevenlabs.io", "source": "file"},
            "gemini": {"baseUrl": "https://generativelanguage.googleapis.com", "source": "default"}
        });
        assert_eq!(
            parse_endpoint_status(&status, "elevenlabs"),
            Some(EndpointInfo {
                base_url: "https://api.eu.residency.elevenlabs.io".into(),
                source: "file".into(),
                error: None
            })
        );
        assert_eq!(
            parse_endpoint_status(&status, "gemini").unwrap().source,
            "default"
        );
        assert_eq!(parse_endpoint_status(&status, "edge"), None);
    }

    #[test]
    fn a_bad_value_is_an_error_entry_and_env_errors_are_read_only() {
        let status = json!({
            "elevenlabs": {"error": "Bad elevenlabs base URL from ELEVENLABS_BASE_URL: \"x\" is not a web address"},
            "gemini": {"error": "Bad gemini base URL from providers.gemini.baseUrl in /h/voices.json: nope"}
        });
        let eleven = parse_endpoint_status(&status, "elevenlabs").unwrap();
        assert_eq!(
            (eleven.source.as_str(), eleven.base_url.as_str()),
            ("env", "")
        );
        assert!(eleven.error.unwrap().contains("not a web address"));
        let gemini = parse_endpoint_status(&status, "gemini").unwrap();
        assert_eq!(gemini.source, "file");
        assert!(gemini.error.is_some());
    }

    #[test]
    fn unreadable_endpoint_entries_are_hidden() {
        for bad in [
            json!([]),
            json!({"gemini": {"baseUrl": "https://x", "source": "weird"}}),
            json!({"gemini": {"source": "file"}}),
            json!({"gemini": {"baseUrl": 3, "source": "file"}}),
            json!({"gemini": null}),
        ] {
            assert_eq!(parse_endpoint_status(&bad, "gemini"), None, "{bad}");
        }
    }

    #[test]
    fn merges_endpoints_only_into_providers_that_have_one() {
        let endpoints = json!({
            "elevenlabs": {"baseUrl": "https://api.elevenlabs.io", "source": "default"},
            "edge": {"baseUrl": "https://x", "source": "file"}
        });
        let list = merge_providers(None, Some(&endpoints));
        assert!(list[0].endpoint.is_none(), "edge has no base URL");
        assert_eq!(
            list[3].endpoint.as_ref().map(|e| e.source.as_str()),
            Some("default")
        );
        assert!(list[4].endpoint.is_none(), "gemini entry missing");
        assert_eq!(
            default_base_url("gemini"),
            "https://generativelanguage.googleapis.com"
        );
    }
}
