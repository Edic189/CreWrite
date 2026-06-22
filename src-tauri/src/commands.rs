//! Tauri command layer — the bridge between the frontend `invoke(...)` calls
//! and the pure vault logic in [`crate::vault`].
//!
//! These functions are thin: validate the session, delegate to `fs_ops`/`tree`,
//! and shape the response. All errors flow back as serialized [`AppError`].

use std::collections::HashMap;
use std::path::PathBuf;

use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::compile;
use crate::config;
use crate::error::{AppError, AppResult};
use crate::export;
use crate::git;
use crate::index::{self, GraphData, NoteRef, TagCount};
use crate::markdown::{self, RenderedNote};
use crate::state::AppState;
use crate::vault::{fs_ops, tree};
use crate::watcher;

/// Everything the frontend needs to render a freshly-opened vault.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultInfo {
    /// Absolute path of the vault root (for display / window title).
    pub root: String,
    /// The full recursive file tree.
    pub tree: tree::FileNode,
}

/// Open the native folder picker, set it as the active vault, start watching
/// it, and return its tree. Returns `Ok(None)` if the user cancels the dialog.
#[tauri::command]
pub async fn select_vault(
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<Option<VaultInfo>> {
    // The dialog plugin marshals this to the platform's main/UI thread itself.
    let picked = app.dialog().file().blocking_pick_folder();

    let Some(folder) = picked else {
        return Ok(None); // User cancelled — not an error.
    };

    // `FilePath` -> `PathBuf`. On desktop this is always a real path.
    let root: PathBuf = folder
        .into_path()
        .map_err(|e| AppError::InvalidPath(e.to_string()))?;

    let info = open_vault_at(&app, &state, root)?;
    Ok(Some(info))
}

/// Open a vault at an explicit path (e.g. "recent vaults" / restore on launch).
#[tauri::command]
pub async fn open_vault(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> AppResult<VaultInfo> {
    open_vault_at(&app, &state, PathBuf::from(path))
}

/// Shared open logic: canonicalize, build tree, start watcher, store session.
fn open_vault_at(app: &AppHandle, state: &State<'_, AppState>, root: PathBuf) -> AppResult<VaultInfo> {
    if !root.is_dir() {
        return Err(AppError::NotFound(format!(
            "'{}' is not a directory",
            root.display()
        )));
    }
    // Canonicalize so all later boundary checks compare against a stable root.
    let root = root.canonicalize().map_err(|e| AppError::io(&root, e))?;

    let file_tree = tree::build_tree(&root)?;
    let vault_index = index::build(&root)?;
    let watcher = watcher::spawn(app.clone(), &root)?;
    state.open(root.clone(), watcher, vault_index)?;
    config::record_vault(app, &root); // remember for auto-reopen / recents

    Ok(VaultInfo {
        root: root.to_string_lossy().into_owned(),
        tree: file_tree,
    })
}

/// Re-read and return the current vault tree (e.g. after a watcher event).
#[tauri::command]
pub async fn read_vault_tree(state: State<'_, AppState>) -> AppResult<tree::FileNode> {
    state.with_root(|root| tree::build_tree(root))
}

/// Read a Markdown note's contents.
#[tauri::command]
pub async fn read_note(state: State<'_, AppState>, path: String) -> AppResult<String> {
    state.with_root(|root| fs_ops::read_note(root, &path))
}

/// Save a Markdown note's contents (creating parents if needed).
#[tauri::command]
pub async fn write_note(
    state: State<'_, AppState>,
    path: String,
    content: String,
) -> AppResult<()> {
    state.with_root(|root| fs_ops::write_note(root, &path, &content))
}

/// Create a new, empty note.
#[tauri::command]
pub async fn create_note(state: State<'_, AppState>, path: String) -> AppResult<tree::FileNode> {
    let tree = state.with_root(|root| {
        fs_ops::create_note(root, &path)?;
        tree::build_tree(root)
    })?;
    state.refresh_index()?;
    Ok(tree)
}

/// Create a new folder.
#[tauri::command]
pub async fn create_folder(state: State<'_, AppState>, path: String) -> AppResult<tree::FileNode> {
    // No notes change, so the link/tag index is unaffected — skip the rescan.
    state.with_root(|root| {
        fs_ops::create_folder(root, &path)?;
        tree::build_tree(root)
    })
}

/// Rename/move a note or folder.
#[tauri::command]
pub async fn rename_entry(
    state: State<'_, AppState>,
    from: String,
    to: String,
) -> AppResult<tree::FileNode> {
    let tree = state.with_root(|root| {
        fs_ops::rename_entry(root, &from, &to)?;
        tree::build_tree(root)
    })?;
    state.refresh_index()?;
    Ok(tree)
}

/// Delete a note or folder.
#[tauri::command]
pub async fn delete_entry(state: State<'_, AppState>, path: String) -> AppResult<tree::FileNode> {
    let tree = state.with_root(|root| {
        fs_ops::delete_entry(root, &path)?;
        tree::build_tree(root)
    })?;
    state.refresh_index()?;
    Ok(tree)
}

/// Render raw note text (the live editor buffer) into sanitized HTML plus
/// parsed frontmatter, resolving `[[wikilinks]]` against the vault index.
/// Operates on the supplied `content` (not disk) so unsaved edits preview.
#[tauri::command]
pub async fn render_markdown(
    state: State<'_, AppState>,
    content: String,
) -> AppResult<RenderedNote> {
    state.with_index(|index| Ok(markdown::render(&content, |target| index.resolve(target))))
}

/// Toggle the `index`-th task-list checkbox in `content`, returning the updated
/// text. Stateless — the frontend persists the result like any other edit.
#[tauri::command]
pub async fn toggle_task(content: String, index: usize) -> AppResult<String> {
    markdown::toggle_task(&content, index)
        .ok_or_else(|| AppError::NotFound(format!("no task at index {index}")))
}

/// Rebuild the cached link/tag index from disk (after edits/external changes).
#[tauri::command]
pub async fn refresh_index(state: State<'_, AppState>) -> AppResult<()> {
    state.refresh_index()
}

/// The note-relationship graph (nodes + edges) for the Graph View.
#[tauri::command]
pub async fn get_graph(state: State<'_, AppState>) -> AppResult<GraphData> {
    state.with_index(|index| Ok(index.graph()))
}

/// Notes that link to `path` (backlinks panel).
#[tauri::command]
pub async fn get_backlinks(state: State<'_, AppState>, path: String) -> AppResult<Vec<NoteRef>> {
    state.with_index(|index| Ok(index.backlinks(&path)))
}

/// Tag census across the vault (sorted by count).
#[tauri::command]
pub async fn get_tags(state: State<'_, AppState>) -> AppResult<Vec<TagCount>> {
    state.with_index(|index| Ok(index.tags()))
}

/// Notes carrying a given tag.
#[tauri::command]
pub async fn notes_with_tag(state: State<'_, AppState>, tag: String) -> AppResult<Vec<NoteRef>> {
    state.with_index(|index| Ok(index.notes_with_tag(&tag)))
}

/// Resolve a raw wikilink target to a note path, if one exists.
#[tauri::command]
pub async fn resolve_link(state: State<'_, AppState>, target: String) -> AppResult<Option<String>> {
    state.with_index(|index| Ok(index.resolve(&target)))
}

/// The last-opened vault path (to auto-reopen on launch), if it still exists.
#[tauri::command]
pub async fn get_last_vault(app: AppHandle) -> AppResult<Option<String>> {
    Ok(config::last_vault(&app))
}

/// Recently-opened vaults that still exist, most-recent first.
#[tauri::command]
pub async fn get_recent_vaults(app: AppHandle) -> AppResult<Vec<String>> {
    Ok(config::recent_vaults(&app))
}

/// The current user settings.
#[tauri::command]
pub async fn get_settings(app: AppHandle) -> AppResult<config::Settings> {
    Ok(config::settings(&app))
}

/// Persist updated user settings.
#[tauri::command]
pub async fn set_settings(app: AppHandle, settings: config::Settings) -> AppResult<()> {
    config::set_settings(&app, settings);
    Ok(())
}

/// App version + config-file location, for the Settings → About section.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    version: String,
    config_path: Option<String>,
}

#[tauri::command]
pub async fn app_info(app: AppHandle) -> AppResult<AppInfo> {
    Ok(AppInfo {
        version: app.package_info().version.to_string(),
        config_path: config::config_path(&app),
    })
}

/// Export notes to `format` ("docx" | "pdf"), converted in-process (no external
/// tools). Opens a native Save dialog (single/combined) or a folder picker
/// (one-per-note). Returns the number of files written, or `None` if cancelled.
#[tauri::command]
pub async fn export_documents(
    app: AppHandle,
    state: State<'_, AppState>,
    scope: String,
    path: String,
    combine: bool,
    strip_frontmatter: bool,
    format: String,
    images: HashMap<String, String>,
) -> AppResult<Option<u32>> {
    let docs = state
        .with_root(|root| export::gather(root, &scope, &path, combine, strip_frontmatter))?;
    // Decode the webview-rendered Mermaid PNGs (base64) keyed by diagram source.
    use base64::Engine as _;
    let images: HashMap<String, Vec<u8>> = images
        .into_iter()
        .filter_map(|(src, b64)| {
            base64::engine::general_purpose::STANDARD
                .decode(b64.as_bytes())
                .ok()
                .map(|bytes| (src, bytes))
        })
        .collect();
    let ext = if format == "pdf" { "pdf" } else { "docx" };
    let filter = if ext == "pdf" { "PDF" } else { "Word document" };

    if docs.len() == 1 {
        let Some(file) = app
            .dialog()
            .file()
            .add_filter(filter, &[ext])
            .set_file_name(format!("{}.{ext}", docs[0].name))
            .blocking_save_file()
        else {
            return Ok(None);
        };
        let out = file.into_path().map_err(|e| AppError::InvalidPath(e.to_string()))?;
        let bytes = export::convert(&docs[0].content, ext, &images)?;
        std::fs::write(&out, bytes).map_err(|e| AppError::io(&out, e))?;
        Ok(Some(1))
    } else {
        let Some(folder) = app.dialog().file().blocking_pick_folder() else {
            return Ok(None);
        };
        let dir = folder.into_path().map_err(|e| AppError::InvalidPath(e.to_string()))?;
        let mut count = 0;
        for doc in &docs {
            let safe = doc.name.replace(['/', '\\'], "_");
            let bytes = export::convert(&doc.content, ext, &images)?;
            std::fs::write(dir.join(format!("{safe}.{ext}")), bytes)
                .map_err(|e| AppError::io(&dir, e))?;
            count += 1;
        }
        Ok(Some(count))
    }
}

/// Git state of the current vault (is-repo, change counts) for the sidebar panel.
#[tauri::command]
pub async fn git_status(state: State<'_, AppState>) -> AppResult<git::GitStatus> {
    state.with_root(git::status)
}

/// Initialize a Git repository at the vault root.
#[tauri::command]
pub async fn git_init(state: State<'_, AppState>) -> AppResult<git::GitStatus> {
    state.with_root(|root| {
        git::init(root)?;
        git::status(root)
    })
}

/// Stage all changes and commit them with `message`. Returns the new status.
#[tauri::command]
pub async fn git_commit(state: State<'_, AppState>, message: String) -> AppResult<git::GitStatus> {
    let msg = if message.trim().is_empty() { "Update notes" } else { message.trim() };
    state.with_root(|root| {
        git::commit_all(root, msg)?;
        git::status(root)
    })
}

/// Discard all uncommitted changes (restore the working tree to the last commit).
#[tauri::command]
pub async fn git_discard(state: State<'_, AppState>) -> AppResult<git::GitStatus> {
    state.with_root(|root| {
        git::discard(root)?;
        git::status(root)
    })
}

/// The trimmed source of every unique ```mermaid block in the export set, so the
/// frontend can render each to a PNG (in the webview) and pass them back to
/// `export_documents` for embedding.
#[tauri::command]
pub async fn export_mermaid_sources(
    state: State<'_, AppState>,
    scope: String,
    path: String,
    combine: bool,
    strip_frontmatter: bool,
) -> AppResult<Vec<String>> {
    let docs = state
        .with_root(|root| export::gather(root, &scope, &path, combine, strip_frontmatter))?;
    Ok(export::mermaid_sources(&docs))
}

/// Compile every note under `dir` (recursive) into a single Markdown file at
/// `output` (frontmatter stripped, each note prefixed with an `# H1` of its
/// filename). Returns the refreshed tree.
#[tauri::command]
pub async fn compile_folder(
    state: State<'_, AppState>,
    dir: String,
    output: String,
) -> AppResult<tree::FileNode> {
    let tree = state.with_root(|root| {
        let compiled = compile::compile_folder(root, &dir, &output)?;
        fs_ops::write_note(root, &output, &compiled)?;
        tree::build_tree(root)
    })?;
    state.refresh_index()?; // a new note now exists
    Ok(tree)
}
