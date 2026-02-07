use log::{debug, info, warn};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Command;

/// Represents a discovered CLI agent installation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentInstallation {
    /// Provider identifier (e.g., "claude", "codex", "gemini")
    pub provider_id: String,
    /// Full path to the binary (or just the command name if found via PATH)
    pub binary_path: String,
    /// Version string if available
    pub version: Option<String>,
    /// How the binary was discovered (e.g., "which", "homebrew", "PATH")
    pub source: String,
}

/// Agent definition used for discovery
struct AgentDef {
    id: &'static str,
    /// Binary names to search for (first match wins)
    commands: &'static [&'static str],
    /// Version flag (most CLIs use --version)
    version_flag: &'static str,
}

const KNOWN_AGENTS: &[AgentDef] = &[
    AgentDef {
        id: "codex",
        commands: &["codex"],
        version_flag: "--version",
    },
    AgentDef {
        id: "gemini",
        commands: &["gemini"],
        version_flag: "--version",
    },
    AgentDef {
        id: "aider",
        commands: &["aider"],
        version_flag: "--version",
    },
    AgentDef {
        id: "goose",
        commands: &["goose", "block-goose"],
        version_flag: "--version",
    },
    AgentDef {
        id: "opencode",
        commands: &["opencode"],
        version_flag: "--version",
    },
];

/// Discover all available CLI coding agents on the system (async).
///
/// Wraps the synchronous `which`/`--version` calls in `spawn_blocking`
/// to avoid blocking the Tokio async runtime.
pub async fn discover_all_agents(app_handle: &tauri::AppHandle) -> Vec<AgentInstallation> {
    let app = app_handle.clone();
    tokio::task::spawn_blocking(move || discover_all_agents_sync(&app))
        .await
        .unwrap_or_default()
}

/// Synchronous implementation of agent discovery.
fn discover_all_agents_sync(app_handle: &tauri::AppHandle) -> Vec<AgentInstallation> {
    let mut agents = Vec::new();

    // 1. Discover Claude via existing module (most thorough discovery)
    match crate::claude_binary::find_claude_binary(app_handle) {
        Ok(path) => {
            let version = get_agent_version(&path, "--version");
            agents.push(AgentInstallation {
                provider_id: "claude".to_string(),
                binary_path: path.clone(),
                version,
                source: "claude_binary".to_string(),
            });
            info!("Discovered Claude at: {}", path);
        }
        Err(e) => {
            warn!("Claude not found: {}", e);
        }
    }

    // 2. Discover other agents via which/where
    for agent_def in KNOWN_AGENTS {
        for cmd_name in agent_def.commands {
            if let Some(installation) = try_find_agent(agent_def.id, cmd_name, agent_def.version_flag) {
                info!(
                    "Discovered {} at: {} (version: {:?})",
                    agent_def.id, installation.binary_path, installation.version
                );
                agents.push(installation);
                break; // Found this agent, skip alternative command names
            }
        }
    }

    agents
}

/// Try to find an agent binary using `which` (Unix) or `where` (Windows).
fn try_find_agent(provider_id: &str, command: &str, version_flag: &str) -> Option<AgentInstallation> {
    let which_cmd = if cfg!(target_os = "windows") {
        "where"
    } else {
        "which"
    };

    debug!("Looking for {} via '{} {}'", provider_id, which_cmd, command);

    match Command::new(which_cmd).arg(command).output() {
        Ok(output) if output.status.success() => {
            let path = String::from_utf8_lossy(&output.stdout)
                .lines()
                .next()
                .unwrap_or("")
                .trim()
                .to_string();

            if path.is_empty() {
                return None;
            }

            // Handle aliased output on zsh: "cmd: aliased to /path/to/cmd"
            let resolved_path = if path.contains("aliased to") {
                path.split("aliased to")
                    .nth(1)
                    .map(|s| s.trim().to_string())
                    .unwrap_or(path)
            } else {
                path
            };

            // Verify the path exists (if it's an absolute path)
            if resolved_path.starts_with('/') || resolved_path.starts_with('\\') {
                let path_buf = PathBuf::from(&resolved_path);
                if !path_buf.exists() {
                    warn!("Binary path does not exist: {}", resolved_path);
                    return None;
                }
            }

            if !validate_agent_binary(provider_id, &resolved_path) {
                warn!(
                    "Ignoring '{}' binary at '{}' because it does not match expected provider CLI",
                    provider_id, resolved_path
                );
                return None;
            }

            let version = get_agent_version(&resolved_path, version_flag);

            Some(AgentInstallation {
                provider_id: provider_id.to_string(),
                binary_path: resolved_path,
                version,
                source: which_cmd.to_string(),
            })
        }
        _ => None,
    }
}

fn validate_agent_binary(provider_id: &str, binary_path: &str) -> bool {
    match provider_id {
        // Avoid false-positive detection for the unrelated DB migration `goose` CLI.
        "goose" => match Command::new(binary_path).arg("--help").output() {
            Ok(output) => {
                let text = String::from_utf8_lossy(&output.stdout).to_lowercase();
                text.contains("an ai agent") || text.contains("goose run [options]")
            }
            Err(_) => false,
        },
        "opencode" => match Command::new(binary_path).arg("--help").output() {
            Ok(output) => {
                let text = String::from_utf8_lossy(&output.stdout).to_lowercase();
                text.contains("opencode run")
            }
            Err(_) => false,
        },
        _ => true,
    }
}

/// Get the version of an agent by running its version command.
fn get_agent_version(binary_path: &str, version_flag: &str) -> Option<String> {
    match Command::new(binary_path).arg(version_flag).output() {
        Ok(output) if output.status.success() => {
            crate::claude_binary::extract_version_from_output(&output.stdout)
        }
        Ok(output) => {
            // Some tools output version to stderr
            crate::claude_binary::extract_version_from_output(&output.stderr)
        }
        Err(e) => {
            debug!("Failed to get version for {}: {}", binary_path, e);
            None
        }
    }
}
