//! Vault domain logic: everything that knows how a "vault" (a plain folder of
//! `.md` files) is laid out on disk.
//!
//! This module is intentionally free of any Tauri types so it can be unit
//! tested in isolation. The `commands` layer is the only place that bridges
//! these functions to the frontend.

pub mod fs_ops;
pub mod tree;

use std::path::{Component, Path, PathBuf};

use crate::error::{AppError, AppResult};

/// Resolve a frontend-supplied *relative* path against the vault `root`,
/// guaranteeing the result stays inside the vault.
///
/// Frontend paths are always relative to the vault root and use forward
/// slashes. We reject any component that could escape the vault (`..`, root
/// prefixes, Windows drive/UNC prefixes) *before* touching the filesystem, so
/// this is safe even for paths that don't exist yet (needed for create ops).
pub fn resolve_in_vault(root: &Path, relative: &str) -> AppResult<PathBuf> {
    let trimmed = relative.trim();
    if trimmed.is_empty() {
        return Err(AppError::InvalidPath("path is empty".into()));
    }

    // Normalize separators so a single check works cross-platform.
    let normalized = trimmed.replace('\\', "/");
    let mut resolved = root.to_path_buf();

    for component in Path::new(&normalized).components() {
        match component {
            // A normal path segment — the only kind we allow.
            Component::Normal(seg) => resolved.push(seg),
            // Ignore a leading "./".
            Component::CurDir => continue,
            // Anything else (.., /, C:\, \\server) is an escape attempt.
            Component::ParentDir
            | Component::RootDir
            | Component::Prefix(_) => {
                return Err(AppError::PathOutsideVault(relative.to_string()));
            }
        }
    }

    // Defense in depth: if the path already exists, canonicalize and re-check
    // that it really lives under the (canonicalized) root. This catches
    // symlinks that point outside the vault.
    if let (Ok(canon_root), Ok(canon_target)) = (root.canonicalize(), resolved.canonicalize()) {
        if !canon_target.starts_with(&canon_root) {
            return Err(AppError::PathOutsideVault(relative.to_string()));
        }
    }

    Ok(resolved)
}

/// Convert an absolute path under `root` back into a forward-slash relative
/// path suitable for the frontend. Returns `None` if `path` is not under root.
pub fn to_relative(root: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    let s = rel
        .components()
        .filter_map(|c| match c {
            Component::Normal(seg) => seg.to_str(),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/");
    Some(s)
}

/// Whether a path points at a Markdown file (by extension, case-insensitive).
pub fn is_markdown(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase),
        Some(ref ext) if ext == "md" || ext == "markdown"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_parent_traversal() {
        let root = Path::new("/tmp/vault");
        assert!(resolve_in_vault(root, "../secret.md").is_err());
        assert!(resolve_in_vault(root, "notes/../../etc/passwd").is_err());
    }

    #[test]
    fn rejects_absolute_paths() {
        let root = Path::new("/tmp/vault");
        assert!(resolve_in_vault(root, "/etc/passwd").is_err());
    }

    #[test]
    fn accepts_nested_relative() {
        let root = Path::new("/tmp/vault");
        let p = resolve_in_vault(root, "a/b/c.md").unwrap();
        assert_eq!(p, Path::new("/tmp/vault/a/b/c.md"));
    }

    #[test]
    fn strips_leading_current_dir() {
        let root = Path::new("/tmp/vault");
        let p = resolve_in_vault(root, "./note.md").unwrap();
        assert_eq!(p, Path::new("/tmp/vault/note.md"));
    }
}
