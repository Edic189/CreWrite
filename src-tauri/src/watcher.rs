//! Filesystem watcher that mirrors external `.md` changes into the UI.
//!
//! When a vault is opened we spawn a recursive `notify` watcher on its root.
//! Each raw event is translated into a small, frontend-friendly payload and
//! emitted on the `vault://changed` Tauri event channel. The frontend listens
//! and refreshes the tree / reloads the open note as appropriate.
//!
//! Phase 1 forwards raw events (lightly filtered to Markdown + directories).
//! A debouncer (`notify-debouncer-full`) is the natural Phase 2 upgrade to
//! coalesce the editor-save event storms some OSes produce.

use std::path::{Path, PathBuf};

use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::error::AppError;
use crate::vault::{is_markdown, to_relative};

/// Event name the frontend subscribes to.
pub const CHANGE_EVENT: &str = "vault://changed";

/// What kind of change happened, normalized across platforms.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ChangeKind {
    Created,
    Modified,
    Removed,
    /// Rename/move or anything we can't cleanly classify — the UI should
    /// treat this as "refresh the tree to be safe".
    Other,
}

/// Payload emitted to the frontend on each relevant filesystem change.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeEvent {
    pub kind: ChangeKind,
    /// Vault-relative, forward-slash paths affected by this event.
    pub paths: Vec<String>,
}

/// Map a `notify` event kind onto our normalized enum.
fn classify(kind: &EventKind) -> ChangeKind {
    match kind {
        EventKind::Create(_) => ChangeKind::Created,
        EventKind::Modify(notify::event::ModifyKind::Name(_)) => ChangeKind::Other,
        EventKind::Modify(_) => ChangeKind::Modified,
        EventKind::Remove(_) => ChangeKind::Removed,
        _ => ChangeKind::Other,
    }
}

/// Keep only paths that the UI cares about: Markdown files and directories.
/// Directory entries pass even without an extension so folder create/delete
/// still refreshes the tree.
fn relevant_paths(root: &Path, event: &Event) -> Vec<String> {
    event
        .paths
        .iter()
        .filter(|p| is_markdown(p) || p.extension().is_none())
        .filter_map(|p| to_relative(root, p))
        .collect()
}

/// Start watching `root` recursively, emitting [`ChangeEvent`]s on `app`.
///
/// Returns the live watcher; the caller must keep it alive (we store it in
/// [`crate::state::VaultSession`]). Dropping it stops the watch.
pub fn spawn(app: AppHandle, root: &Path) -> Result<RecommendedWatcher, AppError> {
    // Owned copy moved into the event closure (runs on notify's own thread).
    let root_owned: PathBuf = root.to_path_buf();

    let mut watcher = RecommendedWatcher::new(
        move |res: notify::Result<Event>| match res {
            Ok(event) => {
                let paths = relevant_paths(&root_owned, &event);
                if paths.is_empty() {
                    return;
                }
                let payload = ChangeEvent {
                    kind: classify(&event.kind),
                    paths,
                };
                // If emit fails the window is likely gone; nothing to recover.
                let _ = app.emit(CHANGE_EVENT, payload);
            }
            Err(e) => {
                eprintln!("[watcher] error: {e}");
            }
        },
        Config::default(),
    )
    .map_err(|e| AppError::Watcher(e.to_string()))?;

    watcher
        .watch(root, RecursiveMode::Recursive)
        .map_err(|e| AppError::Watcher(e.to_string()))?;

    Ok(watcher)
}
