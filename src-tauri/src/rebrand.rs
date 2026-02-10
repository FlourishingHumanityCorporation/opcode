use chrono::Utc;
use std::fs;
use std::path::{Path, PathBuf};

fn legacy_targets(home: &Path) -> Vec<PathBuf> {
    vec![
        home.join(".opcode"),
        home.join(".opcode-terminal-debug"),
        home.join(".opcode-usage-debug.log"),
        home.join("Library/LaunchAgents/com.opcode.web.plist"),
        home.join("Library/LaunchAgents/com.opcode.tailscaled-userspace.plist"),
        home.join("Library/Logs/opcode-web"),
    ]
}

pub fn archive_legacy_opcode_state() {
    let Some(home) = dirs::home_dir() else {
        tracing::warn!("Unable to resolve home directory for legacy archive check");
        return;
    };

    let legacy_root = home.join(".codeinterfacex").join("legacy");
    let marker_path = legacy_root.join(".opcode-archive-v1.complete");

    if marker_path.exists() {
        return;
    }

    let existing_targets: Vec<PathBuf> = legacy_targets(&home)
        .into_iter()
        .filter(|path| path.exists())
        .collect();

    if existing_targets.is_empty() {
        if let Err(err) = fs::create_dir_all(&legacy_root) {
            tracing::warn!("Failed to create legacy archive directory: {}", err);
            return;
        }

        if let Err(err) = fs::write(&marker_path, "no legacy opcode state found\n") {
            tracing::warn!("Failed to write legacy archive marker: {}", err);
        }
        return;
    }

    let stamp = Utc::now().format("%Y%m%d-%H%M%S");
    let archive_dir = legacy_root.join(format!("opcode-{}", stamp));
    if let Err(err) = fs::create_dir_all(&archive_dir) {
        tracing::warn!("Failed to create legacy archive destination: {}", err);
        return;
    }

    for source in existing_targets {
        let Some(file_name) = source.file_name() else {
            tracing::warn!("Skipping legacy path without file name: {}", source.display());
            continue;
        };

        let destination = archive_dir.join(file_name);
        match fs::rename(&source, &destination) {
            Ok(()) => {
                tracing::info!(
                    source = %source.display(),
                    destination = %destination.display(),
                    "Archived legacy opcode state"
                );
            }
            Err(err) => {
                tracing::warn!(
                    source = %source.display(),
                    destination = %destination.display(),
                    "Failed to archive legacy opcode state: {}",
                    err
                );
            }
        }
    }

    let marker_contents = format!(
        "archived_at={}\narchive_dir={}\n",
        Utc::now().to_rfc3339(),
        archive_dir.display()
    );
    if let Err(err) = fs::write(&marker_path, marker_contents) {
        tracing::warn!("Failed to write legacy archive marker: {}", err);
    }
}
