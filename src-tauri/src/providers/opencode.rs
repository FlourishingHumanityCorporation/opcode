use crate::providers::runtime::{
    append_optional_model_arg, ProviderCapabilityDef, ProviderCommandRequest,
    ProviderRuntimeDescriptor, ProviderStreamAdapter,
};

fn build_args(request: &ProviderCommandRequest) -> Result<Vec<String>, String> {
    let mut args = vec!["run".to_string(), request.prompt.clone()];
    append_optional_model_arg(&mut args, &request.model);
    Ok(args)
}

pub fn descriptor() -> ProviderRuntimeDescriptor {
    ProviderRuntimeDescriptor {
        provider_id: "opencode",
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
