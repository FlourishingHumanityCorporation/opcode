use crate::providers::runtime::{
    append_optional_model_arg, ProviderCapabilityDef, ProviderCommandRequest,
    ProviderRuntimeDescriptor, ProviderStreamAdapter,
};

fn build_args(request: &ProviderCommandRequest) -> Result<Vec<String>, String> {
    let mut args = vec![
        "--message".to_string(),
        request.prompt.clone(),
        "--yes".to_string(),
    ];
    append_optional_model_arg(&mut args, &request.model);
    Ok(args)
}

pub fn descriptor() -> ProviderRuntimeDescriptor {
    ProviderRuntimeDescriptor {
        provider_id: "aider",
        stream_adapter: ProviderStreamAdapter::TextWrapped,
        capabilities: ProviderCapabilityDef {
            supports_continue: false,
            supports_resume: false,
            supports_reasoning_effort: false,
            model_strategy: "flag_optional",
        },
        build_args,
    }
}
