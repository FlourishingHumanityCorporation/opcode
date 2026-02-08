use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::OnceLock;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderCapability {
    pub provider_id: String,
    pub supports_continue: bool,
    pub supports_resume: bool,
    pub supports_reasoning_effort: bool,
    pub model_strategy: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderCommandKind {
    Execute,
    Continue,
    Resume,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderStreamAdapter {
    ClaudeJson,
    CodexJson,
    TextWrapped,
}

#[derive(Debug, Clone)]
pub struct ProviderCommandRequest {
    pub kind: ProviderCommandKind,
    pub prompt: String,
    pub model: String,
    pub session_id: Option<String>,
    pub reasoning_effort: Option<String>,
}

pub type BuildCommandArgsFn = fn(&ProviderCommandRequest) -> Result<Vec<String>, String>;

#[derive(Clone, Copy)]
pub struct ProviderRuntimeDescriptor {
    pub provider_id: &'static str,
    pub stream_adapter: ProviderStreamAdapter,
    pub capabilities: ProviderCapabilityDef,
    pub build_args: BuildCommandArgsFn,
}

#[derive(Clone, Copy)]
pub struct ProviderCapabilityDef {
    pub supports_continue: bool,
    pub supports_resume: bool,
    pub supports_reasoning_effort: bool,
    pub model_strategy: &'static str,
}

impl ProviderRuntimeDescriptor {
    pub fn capability(&self) -> ProviderCapability {
        ProviderCapability {
            provider_id: self.provider_id.to_string(),
            supports_continue: self.capabilities.supports_continue,
            supports_resume: self.capabilities.supports_resume,
            supports_reasoning_effort: self.capabilities.supports_reasoning_effort,
            model_strategy: self.capabilities.model_strategy.to_string(),
        }
    }
}

pub fn append_optional_model_arg(args: &mut Vec<String>, model: &str) {
    let trimmed = model.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("default") {
        return;
    }

    args.extend_from_slice(&["--model".to_string(), trimmed.to_string()]);
}

pub fn sanitize_reasoning_effort(reasoning_effort: Option<&str>) -> Option<&'static str> {
    match reasoning_effort
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_ascii_lowercase)
    {
        Some(value) => match value.as_str() {
            "none" => Some("none"),
            "minimal" => Some("minimal"),
            "low" => Some("low"),
            "medium" => Some("medium"),
            "high" => Some("high"),
            "xhigh" => Some("xhigh"),
            _ => None,
        },
        None => None,
    }
}

static REGISTRY: OnceLock<HashMap<&'static str, ProviderRuntimeDescriptor>> = OnceLock::new();

fn provider_registry() -> &'static HashMap<&'static str, ProviderRuntimeDescriptor> {
    REGISTRY.get_or_init(|| {
        let descriptors = [
            crate::providers::claude::descriptor(),
            crate::providers::codex::descriptor(),
            crate::providers::gemini::descriptor(),
            crate::providers::aider::descriptor(),
            crate::providers::goose::descriptor(),
            crate::providers::opencode::descriptor(),
        ];

        let mut runtimes = HashMap::new();
        for descriptor in descriptors {
            runtimes.insert(descriptor.provider_id, descriptor);
        }
        runtimes
    })
}

pub fn get_provider_runtime(provider_id: &str) -> Option<&'static ProviderRuntimeDescriptor> {
    provider_registry().get(provider_id)
}

pub fn list_provider_capabilities() -> Vec<ProviderCapability> {
    let mut capabilities = provider_registry()
        .values()
        .map(ProviderRuntimeDescriptor::capability)
        .collect::<Vec<_>>();
    capabilities.sort_by(|left, right| left.provider_id.cmp(&right.provider_id));
    capabilities
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_contains_expected_providers() {
        let ids = list_provider_capabilities()
            .into_iter()
            .map(|capability| capability.provider_id)
            .collect::<Vec<_>>();
        assert!(ids.contains(&"claude".to_string()));
        assert!(ids.contains(&"codex".to_string()));
        assert!(ids.contains(&"gemini".to_string()));
        assert!(ids.contains(&"aider".to_string()));
        assert!(ids.contains(&"goose".to_string()));
        assert!(ids.contains(&"opencode".to_string()));
    }

    #[test]
    fn sanitize_reasoning_effort_filters_invalid_values() {
        assert_eq!(sanitize_reasoning_effort(Some("xhigh")), Some("xhigh"));
        assert_eq!(sanitize_reasoning_effort(Some("banana")), None);
        assert_eq!(sanitize_reasoning_effort(Some("")), None);
    }
}
