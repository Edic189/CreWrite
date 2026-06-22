//! CreWrite backend library.
//!
//! `main.rs` is a thin shim that calls [`run`]. Keeping the app in a library
//! crate is the Tauri v2 convention and lets the modules be unit-tested.

mod commands;
mod compile;
mod config;
mod error;
mod export;
mod git;
mod index;
mod markdown;
mod state;
mod vault;
mod watcher;

use state::AppState;
use tauri::Emitter;

/// Build and run the Tauri application.
///
/// # Panics
/// Panics only on unrecoverable startup failure (e.g. a malformed
/// `tauri.conf.json`), which is a developer error rather than runtime state.
pub fn run() {
    tauri::Builder::default()
        // Native dialogs (folder picker for vault selection).
        .plugin(tauri_plugin_dialog::init())
        // Open external links (http/mailto) in the system browser.
        .plugin(tauri_plugin_opener::init())
        // Thread-safe, app-wide vault session.
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::select_vault,
            commands::open_vault,
            commands::read_vault_tree,
            commands::read_note,
            commands::write_note,
            commands::create_note,
            commands::create_folder,
            commands::rename_entry,
            commands::delete_entry,
            commands::render_markdown,
            commands::toggle_task,
            commands::refresh_index,
            commands::get_graph,
            commands::get_backlinks,
            commands::get_tags,
            commands::notes_with_tag,
            commands::resolve_link,
            commands::compile_folder,
            commands::get_last_vault,
            commands::get_recent_vaults,
            commands::get_settings,
            commands::set_settings,
            commands::app_info,
            commands::export_documents,
            commands::export_mermaid_sources,
            commands::git_status,
            commands::git_init,
            commands::git_commit,
            commands::git_discard,
        ])
        // Save-before-quit: don't let the window close until the frontend has
        // flushed any pending (debounced) edit. We prevent the close, ask the
        // frontend to save, and it then calls `destroy()` to close for real.
        // A fallback timer force-closes if the frontend never acknowledges, so
        // a broken UI can't trap the user.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.emit("app://before-close", ());
                let window = window.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(3));
                    let _ = window.destroy();
                });
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running CreWrite");
}
