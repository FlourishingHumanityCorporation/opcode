// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

// Declare modules
pub mod agent_binary;
pub mod checkpoint;
pub mod claude_binary;
pub mod commands;
pub mod mobile_sync;
pub mod process;
pub mod providers;
pub mod usage_index;
pub mod web_server;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
