//! The voice providers the dashboard knows, with where each one's key comes from.

use serde::Serialize;
use serde_json::Value;

/// Providers `screenpilot voices --provider <id>` accepts.
pub const VOICE_PROVIDERS: [&str; 5] = ["edge", "local", "command", "elevenlabs", "gemini"];
/// Providers that need a key, i.e. that `screenpilot secret` accepts.
pub const SECRET_PROVIDERS: [&str; 2] = ["elevenlabs", "gemini"];

#[derive(Serialize, Debug, PartialEq)]
pub struct ProviderInfo {
    pub id: &'static str,
    pub label: &'static str,
    pub needs_key: bool,
    /// Where the key comes from: "env", "file" or null (not set, or not needed).
    pub key: Option<String>,
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
pub fn merge_providers(status: Option<&Value>) -> Vec<ProviderInfo> {
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
        let list = merge_providers(Some(&json!({"elevenlabs": "env", "gemini": null})));
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
        let list = merge_providers(Some(&json!({"elevenlabs": "weird", "edge": "env"})));
        assert!(list.iter().all(|p| p.key.is_none()));
        assert!(merge_providers(None).iter().all(|p| p.key.is_none()));
    }

    #[test]
    fn serializes_to_the_api_shape() {
        let v =
            serde_json::to_value(&merge_providers(Some(&json!({"gemini": "file"})))[4]).unwrap();
        assert_eq!(
            v,
            json!({"id": "gemini", "label": "Gemini", "needs_key": true, "key": "file"})
        );
    }
}
