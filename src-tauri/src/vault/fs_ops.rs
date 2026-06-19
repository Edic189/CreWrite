//! Filesystem CRUD primitives for notes and folders.
//!
//! Every function takes the already-validated vault `root` plus a frontend
//! relative path, runs it through [`resolve_in_vault`] for safety, and then
//! performs the operation with path-tagged error handling.

use std::path::Path;

use super::{is_markdown, resolve_in_vault};
use crate::error::{AppError, AppResult};

/// Read the UTF-8 contents of a Markdown note.
pub fn read_note(root: &Path, relative: &str) -> AppResult<String> {
    let path = resolve_in_vault(root, relative)?;
    if !is_markdown(&path) {
        return Err(AppError::NotMarkdown(relative.to_string()));
    }
    if !path.is_file() {
        return Err(AppError::NotFound(format!("note '{relative}' does not exist")));
    }
    std::fs::read_to_string(&path).map_err(|e| AppError::io(&path, e))
}

/// Write (create or overwrite) a Markdown note's contents.
///
/// Parent directories are created as needed so the UI can save a note into a
/// folder that the user just typed in a "new note" dialog.
pub fn write_note(root: &Path, relative: &str, content: &str) -> AppResult<()> {
    let path = resolve_in_vault(root, relative)?;
    if !is_markdown(&path) {
        return Err(AppError::NotMarkdown(relative.to_string()));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| AppError::io(parent, e))?;
    }
    std::fs::write(&path, content).map_err(|e| AppError::io(&path, e))
}

/// Create a new, empty Markdown note. Fails if it already exists so we never
/// silently clobber the user's work.
pub fn create_note(root: &Path, relative: &str) -> AppResult<()> {
    let path = resolve_in_vault(root, relative)?;
    if !is_markdown(&path) {
        return Err(AppError::NotMarkdown(relative.to_string()));
    }
    if path.exists() {
        return Err(AppError::InvalidPath(format!(
            "'{relative}' already exists"
        )));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| AppError::io(parent, e))?;
    }
    std::fs::write(&path, "").map_err(|e| AppError::io(&path, e))
}

/// Create a new folder (and any missing ancestors) inside the vault.
pub fn create_folder(root: &Path, relative: &str) -> AppResult<()> {
    let path = resolve_in_vault(root, relative)?;
    std::fs::create_dir_all(&path).map_err(|e| AppError::io(&path, e))
}

/// Rename/move a note or folder within the vault.
pub fn rename_entry(root: &Path, from: &str, to: &str) -> AppResult<()> {
    let from_path = resolve_in_vault(root, from)?;
    let to_path = resolve_in_vault(root, to)?;
    if !from_path.exists() {
        return Err(AppError::NotFound(format!("'{from}' does not exist")));
    }
    if to_path.exists() {
        return Err(AppError::InvalidPath(format!("'{to}' already exists")));
    }
    if let Some(parent) = to_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| AppError::io(parent, e))?;
    }
    std::fs::rename(&from_path, &to_path).map_err(|e| AppError::io(&to_path, e))
}

/// "Delete" a note or folder by moving it to the operating-system Trash
/// (recoverable via Finder/Explorer "Put Back"). Uses the `trash` crate.
pub fn delete_entry(root: &Path, relative: &str) -> AppResult<()> {
    let path = resolve_in_vault(root, relative)?;
    if !path.exists() {
        return Err(AppError::NotFound(format!("'{relative}' does not exist")));
    }
    trash::delete(&path).map_err(|e| AppError::io(&path, std::io::Error::other(e.to_string())))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Unique per call so parallel tests never share (and clobber) a directory.
    fn tmp_vault() -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU32, Ordering};
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "crewrite-test-{}-{}",
            std::process::id(),
            n
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn create_read_write_roundtrip() {
        let root = tmp_vault();
        create_note(&root, "sub/hello.md").unwrap();
        assert_eq!(read_note(&root, "sub/hello.md").unwrap(), "");
        write_note(&root, "sub/hello.md", "# Hi").unwrap();
        assert_eq!(read_note(&root, "sub/hello.md").unwrap(), "# Hi");
        let _ = std::fs::remove_dir_all(&root);
        // Note: delete is intentionally NOT exercised here — it now moves to the
        // OS Trash, and unit tests shouldn't pollute the developer's Trash.
    }

    #[test]
    fn delete_missing_errors() {
        // The error path doesn't touch the OS Trash, so it's safe to test.
        let root = tmp_vault();
        assert!(delete_entry(&root, "ghost.md").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_non_markdown() {
        let root = tmp_vault();
        assert!(create_note(&root, "notes.txt").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }
}
