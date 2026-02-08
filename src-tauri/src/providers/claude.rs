use crate::providers::runtime::{
    append_optional_model_arg, ProviderCapabilityDef, ProviderCommandKind, ProviderCommandRequest,
    ProviderRuntimeDescriptor, ProviderStreamAdapter,
};

fn build_args(request: &ProviderCommandRequest) -> Result<Vec<String>, String> {
    let mut args = Vec::new();

    match request.kind {
        ProviderCommandKind::Execute => {
            args.push("-p".to_string());
            args.push(request.prompt.clone());
        }
        ProviderCommandKind::Continue => {
            args.push("-c".to_string());
            args.push("-p".to_string());
            args.push(request.prompt.clone());
        }
        ProviderCommandKind::Resume => {
            let session_id = request
                .session_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "Missing provider session id for resume".to_string())?;
            args.extend_from_slice(&[
                "--resume".to_string(),
                session_id.to_string(),
                "-p".to_string(),
                request.prompt.clone(),
            ]);
        }
    }

    append_optional_model_arg(&mut args, &request.model);
    args.extend_from_slice(&[
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
        "--dangerously-skip-permissions".to_string(),
    ]);

    Ok(args)
}

pub fn descriptor() -> ProviderRuntimeDescriptor {
    ProviderRuntimeDescriptor {
        provider_id: "claude",
        stream_adapter: ProviderStreamAdapter::ClaudeJson,
        capabilities: ProviderCapabilityDef {
            supports_continue: true,
            supports_resume: true,
            supports_reasoning_effort: false,
            model_strategy: "flag_optional",
        },
        build_args,
    }
}
