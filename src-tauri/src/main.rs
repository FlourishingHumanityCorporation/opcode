// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agent_binary;
mod checkpoint;
mod claude_binary;
mod commands;
mod mobile_sync;
mod process;
mod providers;
mod usage_index;

use checkpoint::state::CheckpointState;
use commands::agents::{
    check_provider_runtime, cleanup_finished_processes, create_agent, delete_agent, execute_agent,
    export_agent, export_agent_to_file, fetch_github_agent_content, fetch_github_agents, get_agent,
    get_agent_run, get_agent_run_with_real_time_metrics, get_claude_binary_path,
    get_live_session_output, get_session_output, get_session_status, import_agent,
    import_agent_from_file, import_agent_from_github, init_database, kill_agent_session,
    list_agent_runs, list_agent_runs_with_metrics, list_agents, list_claude_installations,
    list_running_sessions, load_agent_session_history, set_claude_binary_path,
    stream_session_output, update_agent, AgentDb,
};
use commands::claude::{
    check_auto_checkpoint, check_claude_version, cleanup_old_checkpoints,
    clear_checkpoint_manager, create_checkpoint,
    create_project, find_claude_md_files,
    fork_from_checkpoint, get_checkpoint_diff, get_checkpoint_settings,
    get_checkpoint_state_stats, get_claude_settings,
    get_home_directory, get_hooks_config, get_project_sessions, get_recently_modified_files,
    get_session_timeline, get_system_prompt, list_checkpoints, list_detected_agents,
    list_directory_contents, list_projects, load_provider_session_history,
    open_provider_session, read_claude_md_file, restore_checkpoint,
    save_claude_md_file, save_clipboard_image_attachment, save_claude_settings, save_system_prompt,
    search_files, track_checkpoint_message, track_session_messages, update_checkpoint_settings,
    update_hooks_config, validate_hook_command,
};
use commands::agent_session::{
    continue_agent_session, execute_agent_session, list_provider_capabilities,
    resume_agent_session,
};
use commands::hot_refresh::{
    hot_refresh_start, hot_refresh_stop, hot_refresh_update_paths, HotRefreshWatcherState,
};
use commands::provider_session::{
    cancel_provider_session, continue_provider_session, execute_provider_session,
    get_provider_session_output, list_running_provider_sessions, resume_provider_session,
    ProviderSessionProcessState,
};
use commands::diagnostics::{open_external_terminal, run_session_startup_probe};
use commands::mcp::{
    mcp_add, mcp_add_from_claude_desktop, mcp_add_json, mcp_get, mcp_get_server_status, mcp_list,
    mcp_read_project_config, mcp_remove, mcp_reset_project_choices, mcp_save_project_config,
    mcp_serve, mcp_test_connection,
};

use commands::proxy::{apply_proxy_settings, get_proxy_settings, save_proxy_settings};
use commands::storage::{
    storage_delete_row, storage_execute_sql, storage_insert_row, storage_list_tables,
    storage_find_legacy_workspace_state, storage_read_table, storage_reset_database,
    storage_update_row,
};
use commands::title::generate_local_terminal_title;
use commands::terminal::{
    close_embedded_terminal, get_embedded_terminal_debug_snapshot, resize_embedded_terminal,
    start_embedded_terminal, write_embedded_terminal_input, write_terminal_incident_bundle,
    EmbeddedTerminalState,
};
use commands::usage::{
    cancel_usage_index_sync, get_session_stats, get_usage_by_date_range, get_usage_details,
    get_usage_index_status, get_usage_stats, start_usage_index_sync,
};
use process::ProcessRegistryState;
use rusqlite::params;
use std::sync::Mutex;
use tauri::{LogicalSize, Manager, Size, WindowEvent};
use usage_index::UsageIndexState;

#[cfg(target_os = "macos")]
use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial};

const WINDOW_WIDTH_KEY: &str = "window_width";
const WINDOW_HEIGHT_KEY: &str = "window_height";

#[cfg(debug_assertions)]
fn ensure_dev_server_reachable() -> Result<(), String> {
    let host = std::env::var("TAURI_DEV_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = 1420_u16;
    let max_attempts = 40_u32;
    let retry_delay = std::time::Duration::from_millis(250);

    for attempt in 1..=max_attempts {
        match std::net::TcpStream::connect((host.as_str(), port)) {
            Ok(stream) => {
                drop(stream);
                log::info!(
                    "Dev server reachable at http://{}:{} (attempt {}/{})",
                    host,
                    port,
                    attempt,
                    max_attempts
                );
                return Ok(());
            }
            Err(err) => {
                if attempt == max_attempts {
                    return Err(format!(
                        "Dev server not reachable at http://{}:{} after {} attempts: {}",
                        host, port, max_attempts, err
                    ));
                }
                std::thread::sleep(retry_delay);
            }
        }
    }

    Err(format!(
        "Dev server not reachable at http://{}:{}",
        host, port
    ))
}

fn load_persisted_window_size(conn: &rusqlite::Connection) -> Option<(f64, f64)> {
    let width = conn
        .query_row(
            "SELECT value FROM app_settings WHERE key = ?1",
            params![WINDOW_WIDTH_KEY],
            |row| row.get::<_, String>(0),
        )
        .ok()?
        .parse::<f64>()
        .ok()?;

    let height = conn
        .query_row(
            "SELECT value FROM app_settings WHERE key = ?1",
            params![WINDOW_HEIGHT_KEY],
            |row| row.get::<_, String>(0),
        )
        .ok()?
        .parse::<f64>()
        .ok()?;

    // Guard against invalid/corrupt values.
    if width < 100.0 || height < 100.0 {
        return None;
    }

    Some((width, height))
}

fn persist_window_size(app: &tauri::AppHandle, width: u32, height: u32) {
    if width == 0 || height == 0 {
        return;
    }

    let db = app.state::<AgentDb>();
    let Ok(conn) = db.0.lock() else {
        log::warn!("Failed to lock database while saving window size");
        return;
    };

    if let Err(err) = conn.execute(
        "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?1, ?2)",
        params![WINDOW_WIDTH_KEY, width.to_string()],
    ) {
        log::warn!("Failed to persist window width: {}", err);
    }

    if let Err(err) = conn.execute(
        "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?1, ?2)",
        params![WINDOW_HEIGHT_KEY, height.to_string()],
    ) {
        log::warn!("Failed to persist window height: {}", err);
    }
}

fn main() {
    // Initialize logger
    env_logger::init();

    #[cfg(debug_assertions)]
    if let Err(err) = ensure_dev_server_reachable() {
        log::error!("{}", err);
        eprintln!("{}", err);
        std::process::exit(1);
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            // Initialize agents database
            let conn = init_database(&app.handle()).expect("Failed to initialize agents database");

            // Load and apply proxy settings from the database
            let (proxy_settings, persisted_window_size) = {
                // Directly query proxy settings from the database
                let mut settings = commands::proxy::ProxySettings::default();
                let keys = [
                    ("proxy_enabled", "enabled"),
                    ("proxy_http", "http_proxy"),
                    ("proxy_https", "https_proxy"),
                    ("proxy_no", "no_proxy"),
                    ("proxy_all", "all_proxy"),
                ];

                for (db_key, field) in keys {
                    if let Ok(value) = conn.query_row(
                        "SELECT value FROM app_settings WHERE key = ?1",
                        rusqlite::params![db_key],
                        |row| row.get::<_, String>(0),
                    ) {
                        match field {
                            "enabled" => settings.enabled = value == "true",
                            "http_proxy" => {
                                settings.http_proxy = Some(value).filter(|s| !s.is_empty())
                            }
                            "https_proxy" => {
                                settings.https_proxy = Some(value).filter(|s| !s.is_empty())
                            }
                            "no_proxy" => {
                                settings.no_proxy = Some(value).filter(|s| !s.is_empty())
                            }
                            "all_proxy" => settings.all_proxy = Some(value).filter(|s| !s.is_empty()),
                            _ => {}
                        }
                    }
                }

                log::info!("Loaded proxy settings: enabled={}", settings.enabled);
                (settings, load_persisted_window_size(&conn))
            };

            // Apply the proxy settings
            apply_proxy_settings(&proxy_settings);
            app.manage(AgentDb(Mutex::new(conn)));

            // Initialize checkpoint state
            let checkpoint_state = CheckpointState::new();

            // Set the Claude directory path
            if let Ok(claude_dir) = dirs::home_dir()
                .ok_or_else(|| "Could not find home directory")
                .and_then(|home| {
                    let claude_path = home.join(".claude");
                    claude_path
                        .canonicalize()
                        .map_err(|_| "Could not find ~/.claude directory")
                })
            {
                let state_clone = checkpoint_state.clone();
                tauri::async_runtime::spawn(async move {
                    state_clone.set_claude_dir(claude_dir).await;
                });
            }

            app.manage(checkpoint_state);

            // Initialize process registry
            app.manage(ProcessRegistryState::default());
            app.manage(EmbeddedTerminalState::default());

            // Initialize provider session process state
            app.manage(ProviderSessionProcessState::default());
            app.manage(UsageIndexState::default());
            app.manage(HotRefreshWatcherState::default());
            let mobile_sync_state = mobile_sync::MobileSyncServiceState::new("0.0.0.0", 8091);
            app.manage(mobile_sync_state.clone());
            mobile_sync::bootstrap_mobile_sync(app.handle().clone(), mobile_sync_state);

            // Restore previous main window size if available.
            if let Some((width, height)) = persisted_window_size {
                if let Some(window) = app.get_webview_window("main") {
                    if let Err(err) = window.set_size(Size::Logical(LogicalSize::new(width, height)))
                    {
                        log::warn!("Failed to restore persisted window size: {}", err);
                    }
                }
            }

            // Persist the current size when the main window is closing.
            let app_handle = app.handle().clone();
            if let Some(window) = app.get_webview_window("main") {
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { .. } = event {
                        if let Some(window) = app_handle.get_webview_window("main") {
                            let is_maximized = window.is_maximized().unwrap_or(false);
                            let is_fullscreen = window.is_fullscreen().unwrap_or(false);
                            if is_maximized || is_fullscreen {
                                return;
                            }

                            match window.inner_size() {
                                Ok(size) => persist_window_size(&app_handle, size.width, size.height),
                                Err(err) => {
                                    log::warn!("Failed to read window size for persistence: {}", err)
                                }
                            }
                        }
                    }
                });
            }

            // Apply window vibrancy with rounded corners on macOS
            #[cfg(target_os = "macos")]
            {
                let window = app.get_webview_window("main").unwrap();

                // Try different vibrancy materials that support rounded corners
                let materials = [
                    NSVisualEffectMaterial::UnderWindowBackground,
                    NSVisualEffectMaterial::WindowBackground,
                    NSVisualEffectMaterial::Popover,
                    NSVisualEffectMaterial::Menu,
                    NSVisualEffectMaterial::Sidebar,
                ];

                let mut applied = false;
                for material in materials.iter() {
                    if apply_vibrancy(&window, *material, None, Some(12.0)).is_ok() {
                        applied = true;
                        break;
                    }
                }

                if !applied {
                    // Fallback without rounded corners
                    apply_vibrancy(
                        &window,
                        NSVisualEffectMaterial::WindowBackground,
                        None,
                        None,
                    )
                    .expect("Failed to apply any window vibrancy");
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Claude & Project Management
            list_projects,
            create_project,
            get_project_sessions,
            get_home_directory,
            get_claude_settings,
            open_provider_session,
            get_system_prompt,
            check_claude_version,
            save_system_prompt,
            save_claude_settings,
            find_claude_md_files,
            read_claude_md_file,
            save_claude_md_file,
            save_clipboard_image_attachment,
            load_provider_session_history,
            execute_provider_session,
            continue_provider_session,
            resume_provider_session,
            cancel_provider_session,
            list_running_provider_sessions,
            get_provider_session_output,
            list_directory_contents,
            search_files,
            get_recently_modified_files,
            get_hooks_config,
            update_hooks_config,
            validate_hook_command,
            // Checkpoint Management
            create_checkpoint,
            restore_checkpoint,
            list_checkpoints,
            fork_from_checkpoint,
            get_session_timeline,
            update_checkpoint_settings,
            get_checkpoint_diff,
            track_checkpoint_message,
            track_session_messages,
            check_auto_checkpoint,
            cleanup_old_checkpoints,
            get_checkpoint_settings,
            clear_checkpoint_manager,
            get_checkpoint_state_stats,
            // Agent Management
            list_agents,
            create_agent,
            update_agent,
            delete_agent,
            get_agent,
            execute_agent,
            check_provider_runtime,
            list_provider_capabilities,
            list_agent_runs,
            get_agent_run,
            list_agent_runs_with_metrics,
            get_agent_run_with_real_time_metrics,
            list_running_sessions,
            kill_agent_session,
            get_session_status,
            cleanup_finished_processes,
            get_session_output,
            get_live_session_output,
            stream_session_output,
            load_agent_session_history,
            get_claude_binary_path,
            set_claude_binary_path,
            list_claude_installations,
            export_agent,
            export_agent_to_file,
            import_agent,
            import_agent_from_file,
            fetch_github_agents,
            fetch_github_agent_content,
            import_agent_from_github,
            // Usage & Analytics
            get_usage_stats,
            get_usage_by_date_range,
            get_usage_details,
            get_session_stats,
            get_usage_index_status,
            start_usage_index_sync,
            cancel_usage_index_sync,
            // MCP (Model Context Protocol)
            mcp_add,
            mcp_list,
            mcp_get,
            mcp_remove,
            mcp_add_json,
            mcp_add_from_claude_desktop,
            mcp_serve,
            mcp_test_connection,
            mcp_reset_project_choices,
            mcp_get_server_status,
            mcp_read_project_config,
            mcp_save_project_config,
            // Storage Management
            storage_list_tables,
            storage_read_table,
            storage_update_row,
            storage_delete_row,
            storage_insert_row,
            storage_execute_sql,
            storage_find_legacy_workspace_state,
            storage_reset_database,
            // Slash Commands
            commands::slash_commands::slash_commands_list,
            commands::slash_commands::slash_command_get,
            commands::slash_commands::slash_command_save,
            commands::slash_commands::slash_command_delete,
            // Proxy Settings
            get_proxy_settings,
            save_proxy_settings,
            // Multi-Provider Agent Commands
            list_detected_agents,
            execute_agent_session,
            continue_agent_session,
            resume_agent_session,
            open_external_terminal,
            run_session_startup_probe,
            start_embedded_terminal,
            write_embedded_terminal_input,
            resize_embedded_terminal,
            close_embedded_terminal,
            generate_local_terminal_title,
            get_embedded_terminal_debug_snapshot,
            write_terminal_incident_bundle,
            mobile_sync::mobile_sync_get_status,
            mobile_sync::mobile_sync_set_enabled,
            mobile_sync::mobile_sync_set_public_host,
            mobile_sync::mobile_sync_publish_snapshot,
            mobile_sync::mobile_sync_publish_events,
            mobile_sync::mobile_sync_start_pairing,
            mobile_sync::mobile_sync_list_devices,
            mobile_sync::mobile_sync_revoke_device,
            hot_refresh_start,
            hot_refresh_stop,
            hot_refresh_update_paths,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
