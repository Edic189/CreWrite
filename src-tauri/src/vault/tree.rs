//! Recursive directory → `FileNode` tree construction.
//!
//! The tree only surfaces folders and Markdown files (`.md`/`.markdown`).
//! Hidden entries (dot-files) and well-known noise directories are skipped so
//! the file explorer stays focused on notes.

use std::path::Path;

use serde::Serialize;

use super::{is_markdown, to_relative};
use crate::error::{AppError, AppResult};

/// Guard against pathological symlink loops / absurdly deep trees.
const MAX_DEPTH: usize = 32;

/// One entry in the vault explorer. Files have an empty `children` vec.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileNode {
    /// Display name (final path segment).
    pub name: String,
    /// Forward-slash path relative to the vault root. Empty string == root.
    pub path: String,
    /// `true` for directories.
    pub is_dir: bool,
    /// Child nodes, dirs-first then alphabetical. Empty for files.
    pub children: Vec<FileNode>,
}

/// Directory names we never descend into.
fn is_ignored_dir(name: &str) -> bool {
    matches!(name, ".git" | ".obsidian" | "node_modules" | ".trash")
}

/// Build the full vault tree rooted at `root`. The returned node represents the
/// vault folder itself (with an empty `path`).
pub fn build_tree(root: &Path) -> AppResult<FileNode> {
    let name = root
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("vault")
        .to_string();

    let children = read_children(root, root, 0)?;
    Ok(FileNode {
        name,
        path: String::new(),
        is_dir: true,
        children,
    })
}

/// Collect every Markdown file in the vault as a flat list of vault-relative,
/// forward-slash paths (sorted). Shares the tree's ignore rules. Used by the
/// link/tag index, which needs a flat scan rather than a nested structure.
pub fn collect_files(root: &Path) -> AppResult<Vec<String>> {
    let mut out = Vec::new();
    collect_into(root, root, 0, &mut out)?;
    out.sort();
    Ok(out)
}

fn collect_into(root: &Path, dir: &Path, depth: usize, out: &mut Vec<String>) -> AppResult<()> {
    if depth >= MAX_DEPTH {
        return Ok(());
    }
    let entries = std::fs::read_dir(dir).map_err(|e| AppError::io(dir, e))?;
    for entry in entries {
        let entry = entry.map_err(|e| AppError::io(dir, e))?;
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if name.starts_with('.') {
            continue;
        }
        let file_type = entry.file_type().map_err(|e| AppError::io(&path, e))?;
        if file_type.is_dir() {
            if !is_ignored_dir(name) {
                collect_into(root, &path, depth + 1, out)?;
            }
        } else if file_type.is_file() && is_markdown(&path) {
            if let Some(rel) = to_relative(root, &path) {
                out.push(rel);
            }
        }
    }
    Ok(())
}

/// Read the children of `dir`, recursing into subdirectories.
fn read_children(root: &Path, dir: &Path, depth: usize) -> AppResult<Vec<FileNode>> {
    if depth >= MAX_DEPTH {
        return Ok(Vec::new());
    }

    let entries = std::fs::read_dir(dir).map_err(|e| AppError::io(dir, e))?;
    let mut nodes: Vec<FileNode> = Vec::new();

    for entry in entries {
        let entry = entry.map_err(|e| AppError::io(dir, e))?;
        let path = entry.path();

        let file_name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            // Skip non-UTF-8 names rather than failing the whole tree.
            None => continue,
        };

        // Hide dot-files/dot-dirs and known noise.
        if file_name.starts_with('.') {
            continue;
        }

        // `file_type()` avoids an extra stat and doesn't follow symlinks.
        let file_type = entry.file_type().map_err(|e| AppError::io(&path, e))?;

        if file_type.is_dir() {
            if is_ignored_dir(&file_name) {
                continue;
            }
            let rel = to_relative(root, &path).unwrap_or_default();
            let children = read_children(root, &path, depth + 1)?;
            nodes.push(FileNode {
                name: file_name,
                path: rel,
                is_dir: true,
                children,
            });
        } else if file_type.is_file() && is_markdown(&path) {
            let rel = to_relative(root, &path).unwrap_or_default();
            nodes.push(FileNode {
                name: file_name,
                path: rel,
                is_dir: false,
                children: Vec::new(),
            });
        }
        // Symlinks and non-markdown files are intentionally ignored.
    }

    sort_nodes(&mut nodes);
    Ok(nodes)
}

/// Folders first, then files; each group case-insensitively alphabetical.
fn sort_nodes(nodes: &mut [FileNode]) {
    nodes.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
}
