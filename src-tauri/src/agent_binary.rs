use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};
use std::sync::LazyLock;
use std::time::{Duration, Instant};
use tokio::sync::{Mutex, Notify};
use wait_timeout::ChildExt;

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

const DISCOVERY_CACHE_TTL: Duration = Duration::from_secs(30);
const DISCOVERY_COMMAND_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Debug, Clone)]
struct ProviderDiscoveryCacheEntry {
    checked_at: Instant,
    result: Option<AgentInstallation>,
}

#[derive(Debug, Default)]
struct ProviderDiscoveryCacheState {
    entries: HashMap<String, ProviderDiscoveryCacheEntry>,
    in_flight: HashSet<String>,
}

static PROVIDER_DISCOVERY_CACHE: LazyLock<Mutex<ProviderDiscoveryCacheState>> =
    LazyLock::new(|| Mutex::new(ProviderDiscoveryCacheState::default()));
static PROVIDER_DISCOVERY_NOTIFY: LazyLock<Notify> = LazyLock::new(Notify::new);

/// Discover all available CLI coding agents on the system.
///
/// Uses per-provider cache/single-flight logic to avoid process storms when
/// multiple UI surfaces ask for runtime status concurrently.
pub async fn discover_all_agents(app_handle: &tauri::AppHandle) -> Vec<AgentInstallation> {
    let mut agents = Vec::new();

    if let Some(claude) = discover_agent(app_handle, "claude").await {
        agents.push(claude);
    }

    for agent_def in KNOWN_AGENTS {
        if let Some(agent) = discover_agent(app_handle, agent_def.id).await {
            agents.push(agent);
        }
    }

    agents
}

/// Discover a single provider binary with cache and single-flight protection.
pub async fn discover_agent(
    app_handle: &tauri::AppHandle,
    provider_id: &str,
) -> Option<AgentInstallation> {
    let provider_key = provider_id.trim().to_ascii_lowercase();
    if provider_key.is_empty() {
        return None;
    }

    loop {
        let mut cache = PROVIDER_DISCOVERY_CACHE.lock().await;

        if let Some(entry) = cache.entries.get(&provider_key) {
            if entry.checked_at.elapsed() < DISCOVERY_CACHE_TTL {
                return entry.result.clone();
            }
        }

        if cache.in_flight.contains(&provider_key) {
            let wait_for_refresh = PROVIDER_DISCOVERY_NOTIFY.notified();
            drop(cache);
            wait_for_refresh.await;
            continue;
        }

        cache.in_flight.insert(provider_key.clone());
        drop(cache);

        let app = app_handle.clone();
        let provider_for_task = provider_key.clone();
        let discovered = match tokio::task::spawn_blocking(move || {
            discover_agent_sync(&app, &provider_for_task)
        })
        .await
        {
            Ok(agent) => agent,
            Err(e) => {
                tracing::warn!("Agent discovery task failed for '{}': {}", provider_key, e);
                None
            }
        };

        let mut cache = PROVIDER_DISCOVERY_CACHE.lock().await;
        cache.entries.insert(
            provider_key.clone(),
            ProviderDiscoveryCacheEntry {
                checked_at: Instant::now(),
                result: discovered.clone(),
            },
        );
        cache.in_flight.remove(&provider_key);
        drop(cache);
        PROVIDER_DISCOVERY_NOTIFY.notify_waiters();

        return discovered;
    }
}

/// Synchronous implementation of single-provider discovery.
fn discover_agent_sync(
    app_handle: &tauri::AppHandle,
    provider_id: &str,
) -> Option<AgentInstallation> {
    if provider_id == "claude" {
        return match crate::claude_binary::find_claude_binary(app_handle) {
            Ok(path) => {
                let version = get_agent_version(&path, "--version");
                let installation = AgentInstallation {
                    provider_id: "claude".to_string(),
                    binary_path: path.clone(),
                    version,
                    source: "claude_binary".to_string(),
                };
                tracing::info!("Discovered Claude at: {}", path);
                Some(installation)
            }
            Err(e) => {
                tracing::warn!("Claude not found: {}", e);
                None
            }
        };
    }

    let Some(agent_def) = KNOWN_AGENTS
        .iter()
        .find(|candidate| candidate.id == provider_id)
    else {
        tracing::debug!("Unknown provider '{}' requested for discovery", provider_id);
        return None;
    };

    for cmd_name in agent_def.commands {
        if let Some(installation) = try_find_agent(agent_def.id, cmd_name, agent_def.version_flag) {
            tracing::info!(
                "Discovered {} at: {} (version: {:?})",
                agent_def.id, installation.binary_path, installation.version
            );
            return Some(installation);
        }
    }

    None
}

/// Try to find an agent binary using `which` (Unix) or `where` (Windows).
fn try_find_agent(
    provider_id: &str,
    command: &str,
    version_flag: &str,
) -> Option<AgentInstallation> {
    let which_cmd = if cfg!(target_os = "windows") {
        "where"
    } else {
        "which"
    };

    tracing::debug!(
        "Looking for {} via '{} {}'",
        provider_id, which_cmd, command
    );

    match run_command_with_timeout(which_cmd, &[command]) {
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
                    tracing::warn!("Binary path does not exist: {}", resolved_path);
                    return None;
                }
            }

            if !validate_agent_binary(provider_id, &resolved_path) {
                tracing::warn!(
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
        "goose" => match run_command_with_timeout(binary_path, &["--help"]) {
            Ok(output) => {
                let text = String::from_utf8_lossy(&output.stdout).to_lowercase();
                text.contains("an ai agent") || text.contains("goose run [options]")
            }
            Err(_) => false,
        },
        // `opencode` has a unique binary name in practice; skip `--help` probing.
        // This avoids expensive startup checks and duplicate subprocess fan-out.
        "opencode" => true,
        _ => true,
    }
}

/// Get the version of an agent by running its version command.
fn get_agent_version(binary_path: &str, version_flag: &str) -> Option<String> {
    match run_command_with_timeout(binary_path, &[version_flag]) {
        Ok(output) if output.status.success() => {
            crate::claude_binary::extract_version_from_output(&output.stdout)
        }
        Ok(output) => {
            // Some tools output version to stderr
            crate::claude_binary::extract_version_from_output(&output.stderr)
        }
        Err(e) => {
            tracing::debug!("Failed to get version for {}: {}", binary_path, e);
            None
        }
    }
}

fn run_command_with_timeout(program: &str, args: &[&str]) -> Result<Output, String> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn '{}': {}", program, e))?;

    let status = match child.wait_timeout(DISCOVERY_COMMAND_TIMEOUT) {
        Ok(Some(status)) => status,
        Ok(None) => {
            tracing::warn!(
                "Discovery command timed out after {:?}: {} {}",
                DISCOVERY_COMMAND_TIMEOUT,
                program,
                args.join(" ")
            );
            let _ = child.kill();
            let _ = child.wait();
            return Err("Timed out".to_string());
        }
        Err(e) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("Failed to wait for '{}': {}", program, e));
        }
    };

    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    if let Some(mut handle) = child.stdout.take() {
        let _ = handle.read_to_end(&mut stdout);
    }
    if let Some(mut handle) = child.stderr.take() {
        let _ = handle.read_to_end(&mut stderr);
    }

    Ok(Output {
        status,
        stdout,
        stderr,
    })
}
