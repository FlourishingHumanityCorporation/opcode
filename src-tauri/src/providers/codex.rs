use crate::providers::runtime::{
    sanitize_reasoning_effort, ProviderCapabilityDef, ProviderCommandRequest,
    ProviderRuntimeDescriptor, ProviderStreamAdapter,
};

fn build_args(request: &ProviderCommandRequest) -> Result<Vec<String>, String> {
    let mut args = vec![
        "exec".to_string(),
        "--json".to_string(),
        request.prompt.clone(),
    ];

    let claude_models = ["default", "sonnet", "opus", "haiku", "claude"];
    if !request.model.is_empty()
        && !claude_models
            .iter()
            .any(|value| request.model.to_ascii_lowercase().contains(value))
    {
        args.extend_from_slice(&["--model".to_string(), request.model.clone()]);
    }

    if let Some(effort) = sanitize_reasoning_effort(request.reasoning_effort.as_deref()) {
        args.extend(["-c".to_string(), format!("model_reasoning_effort=\"{}\"", effort)]);
    } else if request.reasoning_effort.is_some() {
        tracing::warn!(
            "Ignoring invalid codex reasoning effort: {:?}",
            request.reasoning_effort
        );
    }

    Ok(args)
}

pub fn descriptor() -> ProviderRuntimeDescriptor {
    ProviderRuntimeDescriptor {
        provider_id: "codex",
        stream_adapter: ProviderStreamAdapter::CodexJson,
        capabilities: ProviderCapabilityDef {
            supports_continue: false,
            supports_resume: false,
            supports_reasoning_effort: true,
            model_strategy: "flag_optional",
        },
        build_args,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::runtime::ProviderCommandKind;

    #[test]
    fn build_args_includes_reasoning_effort_when_valid() {
        let args = build_args(&ProviderCommandRequest {
            kind: ProviderCommandKind::Execute,
            prompt: "Refactor this module".to_string(),
            model: "gpt-5.3-codex".to_string(),
            session_id: None,
            reasoning_effort: Some("xhigh".to_string()),
        })
        .expect("codex args should build");

        assert!(args.contains(&"-c".to_string()));
        assert!(args.contains(&"model_reasoning_effort=\"xhigh\"".to_string()));
    }

    #[test]
    fn build_args_ignores_invalid_reasoning_effort() {
        let args = build_args(&ProviderCommandRequest {
            kind: ProviderCommandKind::Execute,
            prompt: "Refactor this module".to_string(),
            model: "gpt-5.3-codex".to_string(),
            session_id: None,
            reasoning_effort: Some("banana".to_string()),
        })
        .expect("codex args should build");

        assert!(!args
            .iter()
            .any(|arg| arg.contains("model_reasoning_effort")));
    }
}
